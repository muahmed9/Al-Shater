import { sb }            from '../core/supabase.js';
import { Config }        from '../core/config.js';
import { customerState } from '../core/state.js';
import { sanitize, isValidIraqiPhone, isValidName } from '../core/utils.js';

const T = Config.TABLES;

export async function submitOrder({ name, phone, region, notes, locationUrl }) {
  const lastTime = customerState.get('lastOrderTime') ?? 0;
  if (Date.now() - lastTime < Config.APP.ORDER_COOLDOWN_MS) {
    const remaining = Math.ceil((Config.APP.ORDER_COOLDOWN_MS - (Date.now() - lastTime)) / 1000);
    throw new Error(`انتظر ${remaining} ثانية قبل إرسال طلب جديد`);
  }
  if (!isValidName(name))        throw new Error('يرجى إدخال الاسم الكامل (حرفان على الأقل)');
  if (!isValidIraqiPhone(phone)) throw new Error('رقم الهاتف يجب أن يكون 11 رقماً ويبدأ بـ 07');
  if (!region?.trim())           throw new Error('يرجى إدخال المنطقة أو الحي');

  const files   = customerState.get('files') ?? [];
  const cart    = customerState.get('cart') ?? [];
  const sugCart = customerState.get('suggestedCart') ?? {};
  if (!files.length && !cart.length && !Object.keys(sugCart).length) throw new Error('يرجى إضافة ملف للطباعة أو منتج للسلة');

  const user    = customerState.get('user');
  const pricing = customerState.get('pricing') ?? Config.DEFAULT_PRICING;
  const coupon  = customerState.get('appliedCoupon');
  const totals  = calcOrderTotals({ files, cart, sugCart, pricing, coupon, user });

  const orderPayload = {
    user_id:       user.id,
    customer_name: sanitize(name, 60),
    phone:         phone.trim(),
    region:        sanitize(region, 80),
    notes:         sanitize(notes, 300),
    location_url:  locationUrl || null,
    color:         customerState.get('printColor'),
    sides:         customerState.get('printSide'),
    packaging:     customerState.get('packaging'),
    express:       customerState.get('express'),
    files_data:    files.map(f => ({ name: f.name, pages: f.pages, copies: f.copies, size: f.size, url: f.uploadedUrl ?? null })),
    cart_items:    _buildCartItems(cart, sugCart),
    subtotal:      totals.subtotal,
    delivery_fee:  totals.deliveryFee,
    discount:      totals.discount,
    total:         totals.total,
    coupon_code:   coupon?.code ?? null,
    status:        'received',
    order_type:    files.length && (cart.length || Object.keys(sugCart).length) ? 'combined' : files.length ? 'print' : 'market',
  };

  const { data, error } = await sb.from(T.ORDERS).insert(orderPayload).select('id').single();
  if (error) throw new Error('فشل إرسال الطلب: ' + error.message);

  customerState.set('lastOrderTime', Date.now());
  customerState.set('lastOrderId',   data.id);

  // Update Points if used
  if (totals.pointsUsed > 0) {
    const newPoints = Math.max(0, (user.loyalty_points ?? 0) - totals.pointsUsed);
    await sb.from(T.USERS).update({ loyalty_points: newPoints }).eq('id', user.id);
    // Update local state to reflect new points immediately
    customerState.set('user', { ...user, loyalty_points: newPoints });
  }

  if (coupon?.id) {
    await sb.from(T.COUPONS).update({ used_count: (coupon.used_count ?? 0) + 1 }).eq('id', coupon.id);
  }
  _notifyAdmin(data.id, orderPayload).catch(() => {});
  return data.id;
}

export async function fetchUserOrders(userId) {
  const { data, error } = await sb.from(T.ORDERS)
    .select('id,status,total,created_at,cancel_reason,rating,files_data,cart_items')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return data ?? [];
}

export async function fetchOrderById(orderId) {
  const { data, error } = await sb.from(T.ORDERS).select('*').eq('id', orderId).single();
  if (error) throw error;
  return data;
}

export async function submitRating(orderId, stars, comment = '') {
  const { error } = await sb.from(T.ORDERS).update({ rating: stars, rating_comment: sanitize(comment, 200) || null }).eq('id', orderId);
  if (error) throw error;
}

export async function validateCoupon(code) {
  if (!code?.trim()) return null;
  const { data, error } = await sb.from(T.COUPONS).select('*').eq('code', code.trim().toUpperCase()).eq('active', true).maybeSingle();
  if (error || !data)                                         throw new Error('كود الخصم غير صالح');
  if (data.max_uses > 0 && data.used_count >= data.max_uses) throw new Error('تم استنفاد هذا الكوبون');
  if (data.expires_at && new Date(data.expires_at) < new Date()) throw new Error('انتهت صلاحية هذا الكوبون');
  // تطبيق نطاق الكوبون (scope) — يُعاد data كما هو ويُحسب في calcOrderTotals
  return data;
}

export function calcOrderTotals({ files, cart, sugCart, pricing, coupon, user }) {
  const P = pricing ?? Config.DEFAULT_PRICING;

  // طباعة
  let printSubtotal = 0;
  for (const f of files) {
    const pages    = (f.pages ?? 1) * (f.copies ?? 1);
    const isColor  = customerState.get('printColor') === 'c';
    const isDouble = customerState.get('printSide') === '2';
    let pricePerPage;
    if (isColor) {
      pricePerPage = isDouble ? (P.c_double ?? 130) : (P.c_single ?? 150);
    } else {
      pricePerPage = isDouble ? P.bw_double : P.bw_single;
    }
    printSubtotal += Math.max(pages * pricePerPage, P.min_price);
  }
  const pkgKey = customerState.get('packaging') ?? 'none';
  printSubtotal += P.packaging?.[pkgKey] ?? 0;
  if (customerState.get('express')) printSubtotal += P.express_fee;

  // سلة
  let cartSubtotal = 0;
  for (const item of cart) cartSubtotal += (item.effective_price ?? item.price) * (item.qty ?? 1);
  for (const [id, qty] of Object.entries(sugCart ?? {})) {
    const prod = customerState.get('suggestedProducts')?.find(p => p.id === id);
    if (prod) cartSubtotal += prod.price * qty;
  }
  const subtotal = printSubtotal + cartSubtotal;

  // نقاط
  const usePoints    = document.getElementById('ptstog')?.checked;
  const pointsSaving = usePoints ? Math.min((user?.loyalty_points ?? 0) * 10, subtotal * 0.3) : 0;

  // كوبون مع دعم scope
  let couponDiscount = 0;
  if (coupon && subtotal >= (coupon.min_order_amount ?? 0)) {
    const scope = coupon.scope ?? 'all';
    let base = subtotal;
    if (scope === 'market' || scope === 'market_only') base = cartSubtotal;
    if (scope === 'print')                              base = printSubtotal;
    couponDiscount = coupon.discount_type === 'percent'
      ? base * (coupon.discount_value / 100)
      : coupon.discount_value;
    couponDiscount = Math.min(couponDiscount, base);
  }

  const discount    = Math.round(pointsSaving + couponDiscount);
  const afterDisc   = Math.max(0, subtotal - discount);
  const deliveryFee = afterDisc >= P.delivery_free_threshold ? 0 : P.delivery_fee;
  
  return { 
    subtotal, 
    discount, 
    deliveryFee, 
    total: afterDisc + deliveryFee,
    pointsUsed: usePoints ? Math.round(pointsSaving / 10) : 0
  };
}

function _buildCartItems(cart, sugCart) {
  const items = cart.map(i => ({ id: i.id, name: i.name, qty: i.qty, price: i.effective_price ?? i.price, unit: i.unit }));
  const suggested = customerState.get('suggestedProducts') ?? [];
  for (const [id, qty] of Object.entries(sugCart ?? {})) {
    const p = suggested.find(x => x.id === id);
    if (p) items.push({ id, name: p.name, qty, price: p.price, unit: p.unit ?? 'قطعة', is_suggested: true });
  }
  return items;
}

async function _notifyAdmin(orderId, payload) {
  const msg = `🆕 طلب جديد #${orderId}\n👤 ${payload.customer_name}\n📞 ${payload.phone}\n🏠 ${payload.region}\n💰 ${payload.total?.toLocaleString()} د.ع`;
  
  for (let i = 0; i < 3; i++) {
    try {
      const { error } = await sb.functions.invoke(Config.FUNCTIONS.SEND_TG, { body: { chat_id: Config.TELEGRAM.ADMIN_TG_ID, text: msg } });
      if (!error) return;
      if (i === 2) throw error;
    } catch (e) {
      if (i === 2) console.warn('[TG Admin Notify Failed]', e);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

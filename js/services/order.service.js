import { sb }            from '../core/supabase.js';
import { Config }        from '../core/config.js';
import { customerState } from '../core/state.js';
import { esc, sanitize, isValidIraqiPhone, isValidName, withTimeout } from '../core/utils.js';

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

  const insertPromise = sb.from(T.ORDERS).insert(orderPayload).select('id').single();
  const { data, error } = await withTimeout(
    insertPromise,
    15000,
    'فشل إرسال الطلب بسبب بطء الاتصال بالخادم. يرجى المحاولة مرة أخرى.'
  );
  if (error) throw new Error('فشل إرسال الطلب: ' + error.message);

  // Update user's phone if they are not a guest
  if (user && user.id && !String(user.id).startsWith('guest_') && user.phone !== phone.trim()) {
    await sb.from(T.USERS).update({ phone: phone.trim() }).eq('id', user.id);
    customerState.set('user', { ...user, phone: phone.trim() });
  }

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
  _notifyCustomer(data.id, orderPayload.user_id).catch(() => {});
  return data.id;
}

export async function fetchUserOrders(userId) {
  try {
    const { data, error } = await sb.from(T.ORDERS)
      .select('id,status,total,created_at,cancel_reason,files_data,cart_items,order_metadata')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error) {
      console.error('[Supabase Fetch Error]', error);
      if (error.code === '42501') {
        throw new Error('تعذر الوصول للبيانات (خطأ في سياسة الأمان RLS). يرجى التأكد من إعدادات الحماية في Supabase.');
      }
      throw new Error(`تعذر تحميل البيانات من قاعدة البيانات (كود: ${error.code})`);
    }
    const orders = data ?? [];
    return orders.map(o => ({
      ...o,
      rating: o.order_metadata?.rating ?? null,
      rating_comment: o.order_metadata?.rating_comment ?? null
    }));
  } catch (err) {
    console.error('[fetchUserOrders Exception]', err);
    throw err;
  }
}

export async function fetchOrderById(orderId) {
  const { data, error } = await sb.from(T.ORDERS).select('*').eq('id', orderId).single();
  if (error) throw error;
  return data;
}

export async function submitRating(orderId, stars, comment = '') {
  const { data: order } = await sb.from(T.ORDERS).select('order_metadata').eq('id', orderId).single();
  const meta = order?.order_metadata || {};
  meta.rating = stars;
  meta.rating_comment = sanitize(comment, 200) || null;
  const { error } = await sb.from(T.ORDERS).update({ order_metadata: meta }).eq('id', orderId);
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
  let documentPages = 0;
  let imageUnits = 0;
  let printSubtotal = 0;
  const isColor = customerState.get('printColor') === 'c';
  const isDouble = customerState.get('printSide') === '2';

  for (const f of files) {
    const ext = f.name.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      imageUnits += (f.copies ?? 1);
    } else {
      documentPages += (f.pages ?? 1) * (f.copies ?? 1);
    }
  }

  // Calculate units based on side mode
  // If single-sided: 1 page = 1 unit
  // If double-sided: 2 pages = 1 unit (round up for odd numbers)
  const documentUnits = isDouble ? Math.ceil(documentPages / 2) : documentPages;
  const printUnits = documentUnits + imageUnits;

  // Determine price per page based on tiers (Color or BW) and scale dynamically
  let tiers = isColor ? P.color_tiers : P.bw_tiers;
  
  if (tiers && tiers.length > 0) {
    // Process the tiers directly without legacy scaling
    tiers = tiers.map(t => {
      const single = t.single ?? t.price ?? 0;
      const double = t.double ?? t.price ?? 0;
      return { ...t, single, double, price: isDouble ? double : single };
    });

    // Find the tier that matches the total volume
    const matchingTier = tiers.find(t => printUnits >= t.min && (t.max ? printUnits <= t.max : true));
    
    if (matchingTier) {
      const rate = isDouble ? (matchingTier.double ?? matchingTier.price) : (matchingTier.single ?? matchingTier.price);
      printSubtotal = printUnits * rate;
      console.log(`[Pricing] Volume matched tier ${matchingTier.min}-${matchingTier.max || '+'}. Rate: ${rate}, Total: ${printSubtotal}`);
    } else {
      // Fallback to default or the highest tier if over limit
      const highestTier = [...tiers].sort((a,b) => b.min - a.min)[0];
      const rate = isDouble ? (highestTier.double ?? highestTier.price) : (highestTier.single ?? highestTier.price);
      printSubtotal = printUnits * rate;
    }
  } else {
    // Fallback to legacy pricing
    const pricePerPage = isColor 
      ? (isDouble ? (P.c_double ?? 130) : (P.c_single ?? 150))
      : (isDouble ? (P.bw_double ?? 75) : (P.bw_single ?? 90));
    
    printSubtotal = printUnits * pricePerPage;
  }
  
  // Apply min_price at total print level
  if (files.length > 0 && printSubtotal < P.min_price) {
    console.log(`[Pricing] Print subtotal ${printSubtotal} < min_price ${P.min_price}. Adjusting.`);
    printSubtotal = P.min_price;
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
    pointsUsed: usePoints ? Math.round(pointsSaving / 10) : 0,
    printSubtotal,
    cartSubtotal
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
  let fileList = payload.files_data.map(f => `📄 ${esc(f.name)} (${f.pages} ص × ${f.copies})`).join('\n');
  let cartList = payload.cart_items.map(i => `📦 ${esc(i.name)} × ${i.qty}`).join('\n');
  
  let msg = `🆕 <b>طلب جديد #${orderId}</b>\n\n`;
  msg += `👤 <b>العميل:</b> ${esc(payload.customer_name)}\n`;
  msg += `📞 <b>الهاتف:</b> ${esc(payload.phone)}\n`;
  msg += `🏠 <b>المنطقة:</b> ${esc(payload.region)}\n`;
  if (payload.location_url) msg += `📍 <a href="${payload.location_url}">موقع العميل</a>\n`;
  msg += `\n⚙️ <b>خيارات:</b> ${payload.color === 'c' ? '🌈 ملون' : '⚪ أبيض وأسود'} • ${payload.sides === '2' ? 'وجهين' : 'وجه واحد'} • ${payload.packaging}\n`;
  if (payload.express) msg += `⚡ <b>طلب عاجل</b>\n`;
  
  if (fileList) msg += `\n📂 <b>الملفات:</b>\n${fileList}\n`;
  if (cartList) msg += `\n🛒 <b>القرطاسية:</b>\n${cartList}\n`;
  if (payload.notes) msg += `\n📝 <b>ملاحظات:</b> ${esc(payload.notes)}\n`;
  
  msg += `\n💰 <b>الإجمالي:</b> ${payload.total?.toLocaleString()} د.ع`;

  const adminChatId = Number(Config.TELEGRAM.ADMIN_TG_ID);

  for (let i = 0; i < 3; i++) {
    try {
      const { error } = await sb.functions.invoke(Config.FUNCTIONS.SEND_TG, { 
        body: { chat_id: adminChatId, text: msg, parse_mode: 'HTML' } 
      });
      if (!error) return;
      if (i === 2) throw error;
    } catch (e) {
      if (i === 2) console.warn('[TG Admin Notify Failed]', e);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function _notifyCustomer(orderId, userId) {
  if (!userId) return;
  
  const msg = Config.customerMessage(orderId, 'received');
  if (!msg) return;
  
  let finalChatId = null;
  const originalId = String(userId).trim();

  // 1. If originalId is numeric, it's likely a direct Telegram ID
  if (!isNaN(Number(originalId)) && !originalId.includes('-')) {
    finalChatId = Number(originalId);
  } else {
    // 2. If it's a UUID or Guest ID, we MUST find the telegram_id in the users table
    try {
      const { data: userData } = await sb.from(Config.TABLES.USERS)
        .select('telegram_id')
        .eq('id', originalId)
        .maybeSingle();
      
      if (userData?.telegram_id && !isNaN(Number(userData.telegram_id))) {
        finalChatId = Number(userData.telegram_id);
      }
    } catch (err) {
      console.error('[NotifyCustomer] Error fetching telegram_id:', err);
    }
  }

  if (!finalChatId) {
    console.log('[NotifyCustomer] No valid numeric telegram_id found for user:', userId);
    return;
  }

  console.log(`[NotifyCustomer] Sending to #${orderId} via Telegram ID: ${finalChatId}`);

  // Retry logic for robustness
  for (let i = 0; i < 3; i++) {
    try {
      const { data, error } = await sb.functions.invoke(Config.FUNCTIONS.SEND_TG, { 
        body: { chat_id: finalChatId, text: msg, parse_mode: 'HTML' } 
      });

      if (error) {
        console.error(`[TG Customer Notify Failed - Attempt ${i+1}]`, error);
        if (i === 2) throw error;
      } else {
        console.log('[TG Customer Notify Success] Message sent to customer');
        return;
      }
    } catch (e) {
      if (i === 2) console.warn('[TG Customer Notify Final Failure]', e);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

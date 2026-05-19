import { sb }         from '../core/supabase.js';
import { Config }     from '../core/config.js';
import { adminState } from '../core/state.js';
import { canChangeStatus, canSeeStatus } from './auth.service.js';

const T = Config.TABLES;

export async function fetchAllOrders() {
  const { data, error } = await sb.from(T.ORDERS).select('*').order('created_at', { ascending: false }).limit(300);
  if (error) throw error;
  const orders = (data ?? []).filter(o => canSeeStatus(o.status));
  adminState.set('allOrders', orders);
  return orders;
}

export async function changeOrderStatus(orderId, fromStatus, toStatus, cancelReason = '') {
  if (!canChangeStatus(fromStatus, toStatus)) throw new Error('ليس لديك صلاحية تغيير الحالة');
  
  const order = adminState.get('allOrders')?.find(o => o.id === orderId);
  if (!order) throw new Error('الطلب غير موجود في القائمة');

  const updateData = { status: toStatus, updated_at: new Date().toISOString() };
  if (toStatus === 'cancelled' && cancelReason) updateData.cancel_reason = cancelReason;
  
  const history = order.status_history ?? [];
  history.push({ status: toStatus, at: new Date().toISOString() });
  updateData.status_history = history;

  const { error } = await sb.from(T.ORDERS).update(updateData).eq('id', orderId);
  if (error) {
    console.error('Failed to update order status:', error);
    throw new Error('فشل تحديث حالة الطلب. يرجى المحاولة مرة أخرى.');
  }

  // 🏆 Award Points on Delivery (only if not already delivered before)
  if (toStatus === 'delivered' && order.user_id) {
    const alreadyDelivered = (order.status_history ?? []).some(h => h.status === 'delivered' && h.at !== updateData.updated_at);
    if (!alreadyDelivered) {
      const awardedPoints = Math.floor((order.total || 0) / 1000);
      if (awardedPoints > 0) {
        // Fetch current points to increment
        const { data: userProfile } = await sb.from(T.USERS).select('loyalty_points').eq('id', order.user_id).single();
        const newPoints = (userProfile?.loyalty_points || 0) + awardedPoints;
        await sb.from(T.USERS).update({ loyalty_points: newPoints }).eq('id', order.user_id);
        console.log(`✅ Awarded ${awardedPoints} points to user ${order.user_id}`);
      }
    }
  }

  // 🔔 Notify customer via Telegram
  if (order.user_id) {
    const { esc } = await import('../core/utils.js');
    const msg = Config.customerMessage(orderId, toStatus, esc(cancelReason));
    if (msg) {
      try {
        const { data: userData } = await sb.from(T.USERS)
          .select('telegram_id')
          .eq('id', order.user_id)
          .maybeSingle();

        // Priority: telegram_id from users table
        let chatId = userData?.telegram_id;
        
        // Fallback: If user_id itself is a direct Telegram ID number
        if (!chatId && !isNaN(Number(order.user_id)) && !String(order.user_id).includes('-')) {
          chatId = order.user_id;
        }

        if (chatId && !isNaN(Number(chatId))) {
          _retryInvoke(Config.FUNCTIONS.SEND_TG, { 
            chat_id: Number(chatId), 
            text: msg, 
            parse_mode: 'HTML' 
          }).catch(err => console.warn('TG notify failed:', err));
        } else {
          console.warn('[Notify] No valid telegram_id for user:', order.user_id, '| userData:', userData);
        }
      } catch (err) {
        console.error('[Notify] Error fetching user telegram_id:', err);
      }
    }
  }

  // Update local state
  const orders = adminState.get('allOrders') ?? [];
  const idx    = orders.findIndex(o => o.id === orderId);
  if (idx !== -1) { 
    orders[idx] = { ...orders[idx], ...updateData }; 
    adminState.set('allOrders', [...orders]); 
  }
}

async function _retryInvoke(func, body, retries = 3) {
  console.log('[TG Debug] Attempting to send to chat_id:', body.chat_id);
  for (let i = 0; i < retries; i++) {
    try {
      const { error } = await sb.functions.invoke(func, { body });
      if (!error) return;
      if (i === retries - 1) throw error;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

export function getFilteredOrders() {
  const orders       = adminState.get('allOrders') ?? [];
  const statusFilter = adminState.get('statusFilter');
  const typeFilter   = adminState.get('typeFilter');
  const mktFilter    = adminState.get('mktStatusFilter');
  const searchQuery  = adminState.get('searchQuery')?.toLowerCase().trim();
  return orders.filter(o => {
    if (typeFilter === 'print'    && o.order_type !== 'print')    return false;
    if (typeFilter === 'market'   && o.order_type !== 'market')   return false;
    if (typeFilter === 'combined' && o.order_type !== 'combined') return false;
    if (o.order_type === 'market') { if (mktFilter !== 'all' && o.status !== mktFilter) return false; }
    else                           { if (statusFilter !== 'all' && o.status !== statusFilter) return false; }
    if (searchQuery) {
      const haystack = [o.id, o.customer_name, o.phone, o.region].join(' ').toLowerCase();
      if (!haystack.includes(searchQuery)) return false;
    }
    return true;
  });
}

export function subscribeToOrders(onNewOrder, onStatusChange) {
  const channel = sb.channel('admin-orders')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: T.ORDERS }, payload => {
      const order = payload.new;
      const orders = adminState.get('allOrders') ?? [];
      adminState.set('allOrders', [order, ...orders]);
      
      // Play notification sound if possible
      try {
        const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
        audio.volume = 0.5;
        audio.play().catch(() => {});
      } catch (e) {}

      onNewOrder?.(order);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: T.ORDERS }, payload => {
      const updated = payload.new;
      const orders  = adminState.get('allOrders') ?? [];
      const idx     = orders.findIndex(o => o.id === updated.id);
      if (idx !== -1) { 
        orders[idx] = updated; 
        adminState.set('allOrders', [...orders]); 
      }
      onStatusChange?.(updated);
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') console.log('✅ Realtime: Subscribed to orders');
    });

  adminState.set('realtimeChannel', channel);
  return channel;
}

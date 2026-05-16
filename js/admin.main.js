/**
 * admin.main.js — نقطة دخول admin.html
 * FIX: renderOrders no longer adds accumulating listeners
 */

import { Config } from './core/config.js';
import { adminState } from './core/state.js';
import { esc, debounce, formatPrice, formatDate } from './core/utils.js';
import { adminLogin, checkExistingSession, adminLogout, canChangeStatus, isManager, hasPermission } from './services/auth.service.js';
import { fetchAllOrders, changeOrderStatus, getFilteredOrders, subscribeToOrders } from './services/order-admin.service.js';
import { savePricing, loadPricing, fetchAllProducts, saveProduct, deleteProduct, adjustProductStock, fetchSupplies, saveSupply, adjustSupplyStock } from './services/market.service.js';
import { uploadFile } from './services/upload.service.js';
import { showToast } from './components/toast.js';
import { withLoading } from './components/loading-btn.js';
import { Modal } from './components/modal.js';
import { Sidebar } from './admin/sidebar.js';

let sidebar;

async function init() {
  const dark = localStorage.getItem(Config.APP.STORAGE_KEYS.DARK_MODE_ADMIN) === 'true';
  applyTheme(dark);
  Modal.init();
  bindLoginForm();
  const session = await checkExistingSession();
  if (session) enterDashboard();
}

function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const icon = document.getElementById('dm-icon-adm');
  const lbl = document.getElementById('dm-lbl-adm');
  if (icon) icon.textContent = dark ? '☀️' : '🌙';
  if (lbl) lbl.textContent = dark ? 'نهاري' : 'ليلي';
}

function bindLoginForm() {
  document.getElementById('login-btn').addEventListener('click', () =>
    withLoading('login-btn', handleLogin)
  );
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.getElementById('login-screen').style.display !== 'none') {
      handleLogin();
    }
  });
}

async function handleLogin() {
  const email = document.getElementById('adm-user').value;
  const pass = document.getElementById('adm-pass').value;
  const errEl = document.getElementById('loginerr');
  errEl.style.display = 'none';
  try {
    await adminLogin(email, pass);
    enterDashboard();
  } catch (e) {
    errEl.textContent = '❌ ' + e.message;
    errEl.style.display = 'block';
  }
}

function enterDashboard() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';

  const profile = adminState.get('currentProfile');
  document.getElementById('role-badge-top').textContent =
    `${profile?.emoji ?? '👤'} ${profile?.name ?? ''}`;

  sidebar = new Sidebar(navigateTo);
  sidebar.render();

  document.getElementById('dm-toggle-btn').addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    localStorage.setItem(Config.APP.STORAGE_KEYS.DARK_MODE_ADMIN, String(!dark));
    applyTheme(!dark);
  });

  document.getElementById('mobile-menu-btn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebar-overlay').classList.toggle('show');
  });
  document.getElementById('sidebar-overlay').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebar-overlay').classList.remove('show');
  });

  document.querySelectorAll('.acc-header[data-acc]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.acc;
      const body = document.getElementById('acc-' + id);
      if (!body) return;
      const isOpen = body.style.display !== 'none';
      body.style.display = isOpen ? 'none' : 'block';
      btn.classList.toggle('open', !isOpen);
    });
  });

  bindOrderFilters();
  bindSettings();

  // ── FIX: bind order list actions ONCE here, not inside renderOrders ──
  bindOrderActions();

  document.getElementById('det-close-btn').addEventListener('click', () => { document.getElementById('detov').classList.remove('open'); document.getElementById('detpan').classList.remove('open'); });
  document.getElementById('detov').addEventListener('click', () => { document.getElementById('detov').classList.remove('open'); document.getElementById('detpan').classList.remove('open'); });

  document.getElementById('cancel-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) Modal.close('cancel-modal');
  });
  document.getElementById('cancel-reasons-grid').addEventListener('click', e => {
    const btn = e.target.closest('.reason-btn');
    if (btn) {
      document.querySelectorAll('.reason-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      document.getElementById('custom-reason').value = btn.dataset.reason;
    }
  });
  document.getElementById('confirm-cancel-btn').addEventListener('click', () =>
    withLoading('confirm-cancel-btn', confirmCancel)
  );
  document.getElementById('close-cancel-modal').addEventListener('click', () => Modal.close('cancel-modal'));

  document.getElementById('tx-cancel-btn').addEventListener('click', () => Modal.close('supply-tx-modal'));
  document.getElementById('tx-confirm-btn').addEventListener('click', () => withLoading('tx-confirm-btn', confirmSupplyTx));

  // Product modal bindings
  document.getElementById('prod-cancel-btn').addEventListener('click', () => Modal.close('product-modal'));
  document.getElementById('prod-save-btn').addEventListener('click', () => withLoading('prod-save-btn', saveProductForm));
  document.getElementById('prod-delete-btn').addEventListener('click', deleteProductAction);
  document.getElementById('prod-image-url').addEventListener('input', e => {
    const preview = document.getElementById('prod-image-preview');
    const urls = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
    if (urls.length > 0) {
      preview.innerHTML = urls.map(u => `<img src="${esc(u)}" style="max-width:80px;max-height:80px;border-radius:var(--radius-sm);border:2px solid var(--border-soft);">`).join('');
      preview.style.display = 'flex';
    } else {
      preview.style.display = 'none';
      preview.innerHTML = '';
    }
  });
  document.getElementById('prod-image-file').addEventListener('change', async e => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    try {
      const user = adminState.get('currentUser');
      const uploadPromises = files.map(f => uploadFile(f, user?.id ?? 'admin'));
      const newUrls = await Promise.all(uploadPromises);
      const urlInput = document.getElementById('prod-image-url');
      const currentUrls = urlInput.value.split(',').map(s => s.trim()).filter(Boolean);
      const allUrls = [...currentUrls, ...newUrls].join(', ');
      urlInput.value = allUrls;
      urlInput.dispatchEvent(new Event('input'));
      showToast('✅ تم رفع الصور', 'success');
    } catch (err) { showToast('❌ فشل رفع الصور: ' + err.message, 'error'); }
  });

  // Product stock adjustment modal bindings
  document.getElementById('adj-prod-cancel').addEventListener('click', () => Modal.close('prod-stock-modal'));
  document.getElementById('adj-prod-confirm').addEventListener('click', () => withLoading('adj-prod-confirm', confirmProductStockAdj));
  document.getElementById('prod-stock-modal').addEventListener('click', e => {
    const btn = e.target.closest('.adj-type-btn');
    if (btn) {
      document.querySelectorAll('.adj-type-btn').forEach(b => { b.classList.remove('active'); b.style.opacity = '0.5'; });
      btn.classList.add('active'); btn.style.opacity = '1';
      adminState.set('_adjProdType', btn.dataset.adjType);
    }
  });

  navigateTo('orders');
  subscribeToOrders(
    order => {
      flashBanner(`🆕 طلب جديد #${order.id}`);
      playAlert('received');
      updatePendingCount();
    },
    () => { renderOrders(); updatePendingCount(); }
  );
}

// ═══════════════════════════════════════
//  FIX: Order list click delegation — called ONCE in enterDashboard
// ═══════════════════════════════════════
function bindOrderActions() {
  const list = document.getElementById('olist');
  list.addEventListener('click', e => {
    // أزرار الإجراءات
    const btn = e.target.closest('.order-action-btn[data-action]');
    if (btn) {
      e.stopPropagation();
      const { action, oid, from } = btn.dataset;
      if (action === 'cancel') openCancelModal(oid, from);
      else changeStatus(oid, from, action);
      return;
    }
    // فتح تفاصيل الطلب
    const card = e.target.closest('.order-card[data-oid]');
    if (card) openOrderDetail(card.dataset.oid);
  });
}

function navigateTo(page) {
  if (page === '__logout__') { handleLogout(); return; }

  document.querySelectorAll('.admin-page').forEach(p => p.classList.remove('active'));
  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');

  const titles = {
    orders: 'الطلبات',
    stats: 'الإحصائيات',
    dash: 'داشبورد الموظفين',
    market: 'قرطاسية الشاطر',
    supplies: 'المخزن',
    reports: 'التقارير',
    settings: 'الإعدادات',
  };
  document.getElementById('page-title').textContent = titles[page] ?? page;
  sidebar.setActive(page);

  if (page === 'orders') { fetchAllOrders().then(renderOrders); }
  if (page === 'stats') { loadStats(); }
  if (page === 'dash') { loadStaffDashboard(); }
  if (page === 'market') { loadMarketPage(); }
  if (page === 'supplies') { loadSuppliesPage(); }
  if (page === 'reports') { loadReportsPage(); }
  if (page === 'settings') { loadSettingsPage(); }
}

async function handleLogout() {
  await adminLogout();
  location.reload();
}

function bindOrderFilters() {
  const searchEl = document.getElementById('order-search');
  searchEl.addEventListener('input', debounce(() => {
    adminState.set('searchQuery', searchEl.value);
    renderOrders();
  }, 300));

  document.getElementById('type-filter-bar').addEventListener('click', e => {
    const btn = e.target.closest('.filter-tab[data-type]');
    if (!btn) return;
    document.querySelectorAll('#type-filter-bar .filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    adminState.set('typeFilter', btn.dataset.type);
    document.getElementById('filter-bar').style.display = btn.dataset.type !== 'market' ? '' : 'none';
    document.getElementById('mkt-filter-bar').style.display = btn.dataset.type === 'market' ? '' : 'none';
    renderOrders();
  });

  document.getElementById('filter-bar').addEventListener('click', e => {
    const btn = e.target.closest('.filter-tab[data-status]');
    if (!btn) return;
    document.querySelectorAll('#filter-bar .filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    adminState.set('statusFilter', btn.dataset.status);
    renderOrders();
  });

  document.getElementById('mkt-filter-bar').addEventListener('click', e => {
    const btn = e.target.closest('.filter-tab[data-mkt-status]');
    if (!btn) return;
    document.querySelectorAll('#mkt-filter-bar .filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    adminState.set('mktStatusFilter', btn.dataset.mktStatus);
    renderOrders();
  });
}

// ═══════════════════════════════════════
//  FIX: renderOrders — NO event listeners added here anymore
// ═══════════════════════════════════════
function renderOrders() {
  const orders = getFilteredOrders();
  const list = document.getElementById('olist');
  updatePendingCount();

  if (!orders.length) {
    list.innerHTML = '<div style="text-align:center;padding:50px;color:var(--text-muted);">لا توجد طلبات</div>';
    return;
  }

  const SM = Config.ORDER_STATUSES;
  list.innerHTML = orders.map(o => {
    const s = SM[o.status] ?? { label: o.status, css: 'sr', icon: '📦' };
    const isNew = (Date.now() - new Date(o.created_at)) < 60_000 * 10;
    const actions = buildActionBtns(o);
    return `
      <div class="order-card${isNew ? ' is-new' : ''}" data-oid="${esc(o.id)}">
        <div class="order-header">
          <div>
            ${isNew ? '<span class="new-badge">جديد</span>' : ''}
            <b style="color:var(--navy);">#${esc(o.id)}</b>
          </div>
          <span class="status-badge ${s.css}">${s.icon} ${s.label}</span>
        </div>
        <div class="order-info-grid">
          <span class="order-info-item">👤 ${esc(o.customer_name ?? '—')}</span>
          <span class="order-info-item">📞 ${esc(o.phone ?? '—')}</span>
          <span class="order-info-item">🏠 ${esc(o.region ?? '—')}</span>
          <span class="order-info-item">💰 ${formatPrice(o.total)}</span>
        </div>
        <div style="font-size:.78rem;color:var(--text-muted);">${formatDate(o.created_at)}</div>
        ${actions ? `<div class="order-actions">${actions}</div>` : ''}
      </div>`;
  }).join('');
  // ← NO addEventListener here. bindOrderActions() handles everything via delegation.
}

function buildActionBtns(o) {
  const transitions = {
    received: [['printing', '🖨️ بدء الطباعة', 'btn-print']],
    printing: [['delivering', '🛵 أرسل للتوصيل', 'btn-deliver']],
    delivering: [['delivered', '✅ تم التسليم', 'btn-done']],
  };
  const available = transitions[o.status] ?? [];
  const btns = available
    .filter(([to]) => canChangeStatus(o.status, to))
    .map(([to, label, cls]) => `<button class="order-action-btn ${cls}" data-action="${to}" data-oid="${esc(o.id)}" data-from="${o.status}">${label}</button>`)
    .join('');
  const canCancel = canChangeStatus(o.status, 'cancelled') && !['delivered', 'cancelled'].includes(o.status);
  return btns + (canCancel ? `<button class="order-action-btn btn-cancel" data-action="cancel" data-oid="${esc(o.id)}" data-from="${o.status}">❌ إلغاء</button>` : '');
}

async function changeStatus(orderId, from, to) {
  try {
    await changeOrderStatus(orderId, from, to);
    renderOrders();
    playAlert(to);
    showToast(`✅ تم تغيير الحالة إلى ${Config.ORDER_STATUSES[to]?.label ?? to}`, 'success');
  } catch (e) { showToast('❌ ' + e.message, 'error'); }
}

function openOrderDetail(orderId) {
  const orders = adminState.get('allOrders') ?? [];
  const o = orders.find(x => x.id === orderId);
  if (!o) return;
  adminState.set('openOrderId', orderId);
  adminState.set('openOrderTgId', o.user_id);

  const SM = Config.ORDER_STATUSES;
  const s = SM[o.status] ?? { label: o.status, css: 'sr', icon: '📦' };

  document.getElementById('dettitle').textContent = `تفاصيل الطلب #${orderId}`;
  document.getElementById('detbody').innerHTML = `
    <div style="text-align:center;margin-bottom:16px;">
      <span class="status-badge ${s.css}" style="font-size:1rem;padding:8px 20px;">${s.icon} ${s.label}</span>
    </div>
    ${[
      ['👤 الاسم', o.customer_name],
      ['📞 الهاتف', `<a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>`],
      ['🏠 المنطقة', o.region],
      ['💰 المبلغ', formatPrice(o.total)],
      ['📅 التاريخ', formatDate(o.created_at)],
      o.coupon_code ? ['🎟️ الكوبون', o.coupon_code] : null,
      o.notes ? ['📝 ملاحظات', o.notes] : null,
      o.location_url ? ['📍 الموقع', `<a href="${esc(o.location_url)}" target="_blank" style="color:var(--teal);">فتح الخريطة 🗺️</a>`] : null,
      o.color ? ['🖨️ نوع الطباعة', o.color === 'c' ? '🌈 ملون' : '⚪ أبيض وأسود'] : null,
      o.sides ? ['📖 الوجهين', o.sides === '2' ? 'وجهين' : 'وجه واحد'] : null,
      o.packaging ? ['📦 التغليف', o.packaging === 'cardboard' ? 'مقوى' : o.packaging === 'spiral' ? 'سبايرول' : 'كبس'] : null,
      o.express ? ['⚡ عاجل', 'نعم'] : null,
    ].filter(Boolean).map(([l, v]) => `
      <div class="detail-row"><span style="color:var(--text-muted);">${l}</span><b>${esc(v) === v ? esc(v) : v}</b></div>
    `).join('')}

    ${o.files_data && o.files_data.length > 0 ? `
      <div style="margin-top:16px;border-top:1px dashed var(--border);padding-top:10px;">
        <b style="color:var(--navy);font-size:.9rem;">📁 الملفات المرفقة (${o.files_data.length}):</b>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">
          ${o.files_data.map(f => `
            <div style="background:var(--input-bg);padding:10px;border-radius:var(--radius-sm);display:flex;justify-content:space-between;align-items:center;">
              <div>
                <div style="font-weight:700;font-size:.85rem;color:var(--navy);">${esc(f.name)}</div>
                <div style="font-size:.75rem;color:var(--text-muted);">${f.pages} صفحة × ${f.copies} نسخ | ${Math.ceil(f.size / 1024)} KB</div>
              </div>
              ${f.url ? `<a href="${esc(f.url)}" target="_blank" style="background:var(--navy);color:#fff;padding:6px 10px;border-radius:var(--radius-sm);font-size:.75rem;text-decoration:none;font-weight:700;">تحميل 📥</a>` : '<span style="color:var(--red);font-size:.75rem;">لم يتم الرفع</span>'}
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    ${o.cart_items && o.cart_items.length > 0 ? `
      <div style="margin-top:16px;border-top:1px dashed var(--border);padding-top:10px;">
        <b style="color:var(--navy);font-size:.9rem;">🛒 القرطاسية (${o.cart_items.length}):</b>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px;">
          ${o.cart_items.map(i => `
            <div style="background:var(--input-bg);padding:8px 10px;border-radius:var(--radius-sm);display:flex;justify-content:space-between;font-size:.85rem;">
              <span>${esc(i.name)} × ${i.qty}</span>
              <b style="color:var(--teal);">${formatPrice(i.price * i.qty)}</b>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    ${o.cancel_reason ? `<div style="margin-top:12px;padding:12px;background:#fef2f2;border-radius:var(--radius-sm);color:var(--red);">❌ سبب الإلغاء: ${esc(o.cancel_reason)}</div>` : ''}
    <div style="margin-top:16px;">
      <a href="https://t.me/${esc(o.phone)}" target="_blank" style="display:flex;align-items:center;gap:8px;background:#dbeafe;color:#1e40af;padding:10px 14px;border-radius:var(--radius-sm);font-weight:800;text-decoration:none;">
        📱 تواصل عبر تيليجرام
      </a>
    </div>`;

  document.getElementById('detov').classList.add('open');
  document.getElementById('detpan').classList.add('open');
}

function openCancelModal(orderId, from) {
  adminState.set('openOrderId', orderId);
  adminState.set('_cancelFrom', from);
  document.getElementById('custom-reason').value = '';
  document.querySelectorAll('.reason-btn').forEach(b => b.classList.remove('selected'));
  Modal.open('cancel-modal');
}

async function confirmCancel() {
  const orderId = adminState.get('openOrderId');
  const from = adminState.get('_cancelFrom');
  const reason = document.getElementById('custom-reason').value.trim();
  if (!reason) { showToast('❌ يرجى اختيار سبب الإلغاء', 'error'); return; }
  try {
    await changeOrderStatus(orderId, from, 'cancelled', reason);
    Modal.close('cancel-modal');
    renderOrders();
    showToast('✅ تم إلغاء الطلب', 'success');
  } catch (e) { showToast('❌ ' + e.message, 'error'); }
}

function loadStats() {
  const orders = adminState.get('allOrders') ?? [];
  const today = new Date().toDateString();
  const tod = orders.filter(o => new Date(o.created_at).toDateString() === today);

  document.getElementById('s-today').textContent = tod.length;
  document.getElementById('s-pending').textContent = orders.filter(o => ['received', 'printing', 'delivering'].includes(o.status)).length;
  document.getElementById('s-revenue').textContent = formatPrice(tod.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (o.total ?? 0), 0));
  document.getElementById('s-total').textContent = orders.length;
  document.getElementById('s-market').textContent = orders.filter(o => o.order_type === 'market').length;
  document.getElementById('s-combined').textContent = orders.filter(o => o.order_type === 'combined').length;
  document.getElementById('s-delivered').textContent = orders.filter(o => o.status === 'delivered').length;
  document.getElementById('s-cancelled').textContent = orders.filter(o => o.status === 'cancelled').length;
}

async function loadStaffDashboard() {
  if (!isManager()) return;
  const page = document.getElementById('page-dash');
  if (!page) return;

  page.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">⏳ جاري تحميل بيانات الموظفين...</div>';

  try {
    const { sb } = await import('./core/supabase.js');
    const { data: profiles } = await sb
      .from('profiles')
      .select('name, emoji, role, permissions')
      .neq('role', 'admin');

    const list = profiles ?? [];
    page.innerHTML = `
      <h2 style="color:var(--navy);margin:0 0 20px;">🏆 لوحة متابعة الموظفين</h2>
      ${list.length
        ? list.map(p => `
          <div class="staff-card">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <b style="color:var(--navy);">${esc(p.emoji ?? '👤')} ${esc(p.name)}</b>
              <span class="role-badge rb-oper">${esc(p.role)}</span>
            </div>
            <div style="font-size:.78rem;color:var(--text-muted);margin-top:6px;">
              ${(p.permissions ?? []).join(' | ') || 'لا صلاحيات'}
            </div>
          </div>`).join('')
        : '<p style="color:var(--text-muted);text-align:center;padding:20px;">لا يوجد موظفون بعد</p>'
      }`;
  } catch (e) {
    page.innerHTML = `<div style="text-align:center;padding:40px;color:var(--red);">❌ تعذّر التحميل: ${esc(e.message)}</div>`;
  }
}

function bindSettings() {
  document.getElementById('save-pricing-btn').addEventListener('click', () =>
    withLoading('save-pricing-btn', savePricingForm)
  );
  document.getElementById('create-staff-btn').addEventListener('click', () =>
    withLoading('create-staff-btn', createStaffAccount)
  );
  document.getElementById('create-coupon-btn').addEventListener('click', () =>
    withLoading('create-coupon-btn', createCoupon)
  );
  // Reports export bindings
  document.getElementById('export-orders-excel')?.addEventListener('click', exportOrdersExcel);
  document.getElementById('export-market-csv')?.addEventListener('click', exportMarketCSV);
  document.getElementById('export-supplies-csv')?.addEventListener('click', exportSuppliesCSV);
}

async function loadSettingsPage() {
  const pricing = await loadPricing();
  if (pricing) {
    const P = pricing;
    document.getElementById('pr-min-pages').value = P.min_pages;
    document.getElementById('pr-min-price').value = P.min_price;
    document.getElementById('pr-c1').value = P.c_single ?? 150;
    document.getElementById('pr-c2').value = P.c_double ?? 130;
    document.getElementById('pr-bw1').value = P.bw_single;
    document.getElementById('pr-bw2').value = P.bw_double;
    document.getElementById('pr-del').value = P.delivery_fee;
    document.getElementById('pr-del-free').value = P.delivery_free_threshold;
    document.getElementById('pr-express').value = P.express_fee;
    document.getElementById('pr-pkg-none').value = P.packaging?.none ?? 0;
    document.getElementById('pr-pkg-cardboard').value = P.packaging?.cardboard ?? 500;
    document.getElementById('pr-pkg-spiral').value = P.packaging?.spiral ?? 1500;
  }
  // Load staff list
  loadStaffList();
  // Load coupon list
  loadCouponList();
}

async function savePricingForm() {
  const pricing = {
    min_pages: Number(document.getElementById('pr-min-pages').value),
    min_price: Number(document.getElementById('pr-min-price').value),
    c_single: Number(document.getElementById('pr-c1').value),
    c_double: Number(document.getElementById('pr-c2').value),
    bw_single: Number(document.getElementById('pr-bw1').value),
    bw_double: Number(document.getElementById('pr-bw2').value),
    delivery_fee: Number(document.getElementById('pr-del').value),
    delivery_free_threshold: Number(document.getElementById('pr-del-free').value),
    express_fee: Number(document.getElementById('pr-express').value),
    packaging: {
      none: Number(document.getElementById('pr-pkg-none').value),
      cardboard: Number(document.getElementById('pr-pkg-cardboard').value),
      spiral: Number(document.getElementById('pr-pkg-spiral').value),
    },
  };
  await savePricing(pricing);
  showToast('✅ تم حفظ التسعير', 'success');
}

async function createStaffAccount() {
  const { sb } = await import('./core/supabase.js');
  const name = document.getElementById('new-staff-name').value.trim();
  const email = document.getElementById('new-staff-user').value.trim();
  const pass = document.getElementById('new-staff-pass').value;
  const emoji = document.getElementById('new-staff-emoji').value || '👤';

  if (!name || !email || pass.length < 6) {
    showToast('❌ يرجى إدخال الاسم والبريد وكلمة المرور (6+ أحرف)', 'error');
    return;
  }

  const perms = ['perm-rp', 'perm-pd', 'perm-dd', 'perm-canc', 'perm-market', 'perm-supplies']
    .map(id => document.getElementById(id))
    .filter(el => el?.checked)
    .map(el => el.value);

  if (!perms.length) { showToast('❌ اختر صلاحية واحدة على الأقل', 'error'); return; }

  try {
    const { data, error } = await sb.functions.invoke(Config.FUNCTIONS.CREATE_STAFF, {
      body: { email, password: pass, name, emoji, permissions: perms }
    });
    if (error) throw error;
    showToast('✅ تم إنشاء الحساب بنجاح', 'success');
    // Clear form and reload list
    document.getElementById('new-staff-name').value = '';
    document.getElementById('new-staff-user').value = '';
    document.getElementById('new-staff-pass').value = '';
    document.getElementById('new-staff-emoji').value = '';
    ['perm-rp', 'perm-pd', 'perm-dd', 'perm-canc', 'perm-market', 'perm-supplies'].forEach(id => {
      const el = document.getElementById(id); if (el) el.checked = false;
    });
    loadStaffList();
  } catch (e) { showToast('❌ ' + e.message, 'error'); }
}

async function createCoupon() {
  const { sb } = await import('./core/supabase.js');
  const code = document.getElementById('cpn-code').value.trim().toUpperCase();
  const type = document.getElementById('cpn-type').value;
  const value = Number(document.getElementById('cpn-value').value);
  const maxUse = Number(document.getElementById('cpn-max').value) || 0;
  const minOrd = Number(document.getElementById('cpn-min-order').value) || 0;
  const expiry = document.getElementById('cpn-expires').value || null;

  if (!code || !value) { showToast('❌ يرجى إدخال الكود والقيمة', 'error'); return; }

  const { error } = await sb.from(Config.TABLES.COUPONS).insert({
    code, discount_type: type, discount_value: value,
    max_uses: maxUse, min_order_amount: minOrd,
    expires_at: expiry, active: true, used_count: 0,
  });

  if (error) { showToast('❌ ' + error.message, 'error'); return; }
  showToast('✅ تم إنشاء الكوبون', 'success');
  // Clear form and reload list
  document.getElementById('cpn-code').value = '';
  document.getElementById('cpn-value').value = '';
  document.getElementById('cpn-max').value = '';
  document.getElementById('cpn-min-order').value = '';
  document.getElementById('cpn-expires').value = '';
  loadCouponList();
}

async function loadMarketPage() {
  if (!isManager() && !hasPermission('manage_market')) return;
  const products = await fetchAllProducts();
  adminState.set('_marketProducts', products);
  const page = document.getElementById('page-market');
  page.innerHTML = `
    <h2 style="color:var(--navy);margin:0 0 20px;">📦 قرطاسية الشاطر</h2>
    <button id="add-product-btn" class="btn-primary" style="background:var(--navy);color:#fff;margin-bottom:16px;max-width:200px;">➕ منتج جديد</button>
    <div id="products-list-admin"></div>`;

  renderProductsList(products);

  const lowProds = products.filter(p => p.stock <= (p.min_stock ?? 0));
  if (lowProds.length) {
    const alertDiv = document.createElement('div');
    alertDiv.className = 'alert-low';
    alertDiv.style.marginBottom = '16px';
    alertDiv.innerHTML = `
      <p class="alert-low-title">⚠️ ${lowProds.length} منتجات مخزونها منخفض</p>
      ${lowProds.map(p => `<span style="font-size:.82rem;margin-left:8px;">• ${esc(p.name)} (${p.stock})</span>`).join('')}`;
    page.querySelector('#products-list-admin').before(alertDiv);
  }

  document.getElementById('add-product-btn').addEventListener('click', () => showProductForm());
  document.getElementById('products-list-admin')?.addEventListener('click', e => {
    const editBtn = e.target.closest('[data-edit-prod]');
    const adjBtn = e.target.closest('[data-adj-prod]');
    const products = adminState.get('_marketProducts') ?? [];
    if (editBtn) showProductForm(products.find(p => p.id === editBtn.dataset.editProd));
    if (adjBtn) adjProductStock(adjBtn.dataset.adjProd, products);
  });
}

function renderProductsList(products) {
  const list = document.getElementById('products-list-admin');
  if (!list) return;
  list.innerHTML = products.map(p => {
    const hasDiscount = p.discount && p.discount > 0;
    const effectivePrice = hasDiscount ? Math.max(0, p.price - p.discount) : p.price;
    return `
    <div class="product-admin-card">
      <div style="display:flex;gap:12px;align-items:center;">
        <div style="width:60px;height:60px;border-radius:var(--radius-sm);background:var(--input-bg);display:flex;align-items:center;justify-content:center;font-size:2rem;overflow:hidden;flex-shrink:0;">
          ${p.image_url ? `<img class="product-thumb" src="${esc(p.image_url.split(',')[0].trim())}" alt="${esc(p.name)}">` : '📦'}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <b style="color:var(--navy);">${esc(p.name)}</b>
            ${p.is_suggested ? '<span style="font-size:.65rem;background:var(--teal);color:#fff;padding:2px 6px;border-radius:var(--radius-full);font-weight:800;">🌟 مقترح</span>' : ''}
            ${!p.active ? '<span style="font-size:.65rem;background:var(--red);color:#fff;padding:2px 6px;border-radius:var(--radius-full);font-weight:800;">معطّل</span>' : ''}
          </div>
          <div style="font-size:.78rem;color:var(--text-muted);margin-top:2px;">
            ${hasDiscount
        ? `<span style="text-decoration:line-through;opacity:.6;">${formatPrice(p.price)}</span> <b style="color:var(--green);">${formatPrice(effectivePrice)}</b>`
        : formatPrice(p.price)
      } / ${esc(p.unit ?? 'قطعة')}
          </div>
          <div class="stock-bar-wrap"><div class="stock-bar" style="width:${Math.min((p.stock / (p.min_stock * 3 || 30)) * 100, 100)}%;background:${p.stock <= (p.min_stock ?? 0) ? 'var(--red)' : 'var(--green)'}"></div></div>
          <div style="font-size:.72rem;">${p.stock <= (p.min_stock ?? 0) ? `<span class="stock-low">⚠️ ${p.stock} متبقي</span>` : `<span class="stock-ok">✅ ${p.stock} ${esc(p.unit ?? '')}</span>`}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <button class="order-action-btn btn-print"   data-edit-prod="${esc(p.id)}">✏️ تعديل</button>
          <button class="order-action-btn btn-deliver" data-adj-prod="${esc(p.id)}">📦 مخزون</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function showProductForm(product = null) {
  const isEdit = !!product;
  document.getElementById('prod-modal-title').textContent = isEdit ? '✏️ تعديل المنتج' : '➕ إضافة منتج جديد';
  document.getElementById('prod-edit-id').value = product?.id ?? '';
  document.getElementById('prod-name').value = product?.name ?? '';
  document.getElementById('prod-category').value = product?.category ?? 'other';
  document.getElementById('prod-price').value = product?.price ?? '';
  document.getElementById('prod-discount').value = product?.discount ?? '';
  document.getElementById('prod-unit').value = product?.unit ?? 'قطعة';
  document.getElementById('prod-stock').value = product?.stock ?? '';
  document.getElementById('prod-min-stock').value = product?.min_stock ?? '';
  document.getElementById('prod-description').value = product?.description ?? '';
  document.getElementById('prod-image-url').value = product?.image_url ?? '';
  document.getElementById('prod-is-suggested').checked = product?.is_suggested ?? false;
  document.getElementById('prod-active').checked = product?.active ?? true;
  document.getElementById('prod-image-file').value = '';

  const preview = document.getElementById('prod-image-preview');
  const urls = (product?.image_url || '').split(',').map(s => s.trim()).filter(Boolean);
  if (urls.length > 0) {
    preview.innerHTML = urls.map(u => `<img src="${esc(u)}" style="max-width:80px;max-height:80px;border-radius:var(--radius-sm);border:2px solid var(--border-soft);">`).join('');
    preview.style.display = 'flex';
  } else {
    preview.style.display = 'none';
    preview.innerHTML = '';
  }

  document.getElementById('prod-delete-btn').style.display = isEdit ? '' : 'none';
  Modal.open('product-modal');
}

async function saveProductForm() {
  const name = document.getElementById('prod-name').value.trim();
  const price = Number(document.getElementById('prod-price').value);
  if (!name) { showToast('❌ يرجى إدخال اسم المنتج', 'error'); return; }
  if (!price) { showToast('❌ يرجى إدخال السعر', 'error'); return; }

  const id = document.getElementById('prod-edit-id').value || null;
  const product = {
    id,
    name,
    price,
    discount: Number(document.getElementById('prod-discount').value) || 0,
    stock: Number(document.getElementById('prod-stock').value) || 0,
    unit: document.getElementById('prod-unit').value.trim() || 'قطعة',
    category: document.getElementById('prod-category').value,
    description: document.getElementById('prod-description').value.trim(),
    image_url: document.getElementById('prod-image-url').value.trim() || null,
    min_stock: Number(document.getElementById('prod-min-stock').value) || 0,
    is_suggested: document.getElementById('prod-is-suggested').checked,
    active: document.getElementById('prod-active').checked,
  };

  try {
    await saveProduct(product);
    Modal.close('product-modal');
    showToast(id ? '✅ تم تحديث المنتج' : '✅ تم إضافة المنتج', 'success');
    loadMarketPage();
  } catch (e) { showToast('❌ ' + e.message, 'error'); }
}

async function deleteProductAction() {
  const id = document.getElementById('prod-edit-id').value;
  if (!id) return;
  if (!confirm('هل أنت متأكد من حذف هذا المنتج؟')) return;
  try {
    await deleteProduct(id);
    Modal.close('product-modal');
    showToast('✅ تم حذف المنتج', 'success');
    loadMarketPage();
  } catch (e) { showToast('❌ ' + e.message, 'error'); }
}

function adjProductStock(id, products) {
  const product = products.find(p => p.id === id);
  if (!product) return;
  adminState.set('_adjProdId', id);
  adminState.set('_adjProdType', 'add');
  document.getElementById('adj-prod-name').textContent = product.name;
  document.getElementById('adj-prod-current').textContent = `${product.stock} ${product.unit ?? ''}`;
  document.getElementById('adj-prod-qty').value = '';
  document.querySelectorAll('.adj-type-btn').forEach((b, i) => {
    b.classList.toggle('active', i === 0);
    b.style.opacity = i === 0 ? '1' : '0.5';
  });
  Modal.open('prod-stock-modal');
}

async function confirmProductStockAdj() {
  const id = adminState.get('_adjProdId');
  const type = adminState.get('_adjProdType') ?? 'add';
  const qty = Number(document.getElementById('adj-prod-qty').value);
  if (!qty || qty <= 0) { showToast('❌ أدخل كمية صحيحة', 'error'); return; }
  try {
    await adjustProductStock(id, type, qty);
    Modal.close('prod-stock-modal');
    showToast('✅ تم تحديث مخزون المنتج', 'success');
    loadMarketPage();
  } catch (e) { showToast('❌ ' + e.message, 'error'); }
}

async function loadSuppliesPage() {
  if (!isManager() && !hasPermission('manage_supplies')) return;
  const supplies = await fetchSupplies();
  const low = supplies.filter(s => s.stock <= (s.min_stock ?? 0));
  const page = document.getElementById('page-supplies');
  page.innerHTML = `
    <h2 style="color:var(--navy);margin:0 0 20px;">🗄️ مخزن المواد</h2>
    ${low.length ? `<div class="alert-low"><p class="alert-low-title">⚠️ ${low.length} مواد تحت الحد الأدنى</p>${low.map(s => `<span style="font-size:.82rem;margin-left:8px;">• ${esc(s.name)} (${s.stock})</span>`).join('')}</div>` : ''}
    <div class="stats-grid" style="margin-bottom:18px;">
      <div class="stat-card"><div class="stat-num" style="color:var(--navy);">${supplies.length}</div><div class="stat-lbl">إجمالي المواد</div></div>
      <div class="stat-card"><div class="stat-num" style="color:var(--orange);">${low.length}</div><div class="stat-lbl">منخفضة المخزون</div></div>
    </div>
    <div id="supplies-list-admin">${supplies.map(s => `
      <div class="product-admin-card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <b style="color:var(--navy);">${esc(s.name)}</b>
            <div style="font-size:.78rem;color:var(--text-muted);">${s.stock} ${esc(s.unit ?? '')} | حد التنبيه: ${s.min_stock ?? 0}</div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="order-action-btn btn-deliver" data-add-sup="${esc(s.id)}" data-sup-name="${esc(s.name)}">➕ إضافة</button>
            <button class="order-action-btn btn-cancel"  data-sub-sup="${esc(s.id)}" data-sup-name="${esc(s.name)}">➖ خصم</button>
          </div>
        </div>
      </div>`).join('')}</div>`;

  adminState.set('_suppliesData', supplies);

  const listEl = document.getElementById('supplies-list-admin');
  if (listEl) {
    listEl.addEventListener('click', e => {
      const addBtn = e.target.closest('[data-add-sup]');
      const subBtn = e.target.closest('[data-sub-sup]');
      if (addBtn) openSupplyTx(addBtn.dataset.addSup, addBtn.dataset.supName, 'add');
      if (subBtn) openSupplyTx(subBtn.dataset.subSup, subBtn.dataset.supName, 'sub');
    });
  }
}

function openSupplyTx(id, name, type) {
  adminState.set('_txSupplyId', id);
  adminState.set('_txSupplyType', type);
  document.getElementById('tx-type-label').textContent = type === 'add' ? '➕ إضافة مخزون' : '➖ خصم من المخزون';
  document.getElementById('tx-supply-name').textContent = name;
  document.getElementById('tx-qty').value = '';
  document.getElementById('tx-notes').value = '';
  Modal.open('supply-tx-modal');
}

async function confirmSupplyTx() {
  const id = adminState.get('_txSupplyId');
  const type = adminState.get('_txSupplyType');
  const qty = Number(document.getElementById('tx-qty').value);
  const note = document.getElementById('tx-notes').value;
  if (!qty || qty <= 0) { showToast('❌ أدخل كمية صحيحة', 'error'); return; }
  try {
    await adjustSupplyStock(id, type, qty, note);
    Modal.close('supply-tx-modal');
    showToast('✅ تم تحديث المخزون', 'success');
    loadSuppliesPage();
  } catch (e) { showToast('❌ ' + e.message, 'error'); }
}

function loadReportsPage() {
  const csvBtn = document.getElementById('export-orders-csv');
  if (csvBtn) csvBtn.onclick = exportOrdersCSV;

  // Load preview tables
  loadOrdersReportPreview();
  loadMarketReportPreview();
  loadSuppliesReportPreview();
}

function loadOrdersReportPreview() {
  const orders = adminState.get('allOrders') ?? [];
  const from = document.getElementById('rep-from').value;
  const to = document.getElementById('rep-to').value;
  const filtered = _filterOrdersByDate(orders, from, to);
  const preview = document.getElementById('orders-report-preview');
  if (!filtered.length) { preview.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">لا توجد طلبات في الفترة المحددة</p>'; return; }
  preview.innerHTML = `
    <table class="report-table">
      <thead><tr style="background:var(--navy);">
        <th>الرقم</th><th>الاسم</th><th>الهاتف</th><th>المنطقة</th><th>المبلغ</th><th>الحالة</th><th>التاريخ</th>
      </tr></thead>
      <tbody>
        ${filtered.slice(0, 50).map(o => {
    const s = Config.ORDER_STATUSES[o.status] ?? { label: o.status, icon: '📦' };
    return `<tr>
            <td><b>${esc(String(o.id).slice(0, 8))}</b></td>
            <td>${esc(o.customer_name ?? '—')}</td>
            <td>${esc(o.phone ?? '—')}</td>
            <td>${esc(o.region ?? '—')}</td>
            <td><b>${formatPrice(o.total)}</b></td>
            <td>${s.icon} ${s.label}</td>
            <td style="font-size:.78rem;">${new Date(o.created_at).toLocaleString('ar-IQ')}</td>
          </tr>`;
  }).join('')}
      </tbody>
    </table>
    <p style="font-size:.78rem;color:var(--text-muted);margin-top:8px;">عرض ${Math.min(filtered.length, 50)} من ${filtered.length} طلب</p>`;

  // bind date change
  document.getElementById('rep-from').onchange = loadOrdersReportPreview;
  document.getElementById('rep-to').onchange = loadOrdersReportPreview;
}

async function loadMarketReportPreview() {
  try {
    const products = await fetchAllProducts();
    const preview = document.getElementById('market-report-preview');
    if (!products.length) { preview.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">لا توجد منتجات</p>'; return; }
    preview.innerHTML = `
      <table class="report-table">
        <thead><tr style="background:var(--teal);">
          <th>المنتج</th><th>السعر</th><th>الخصم</th><th>المخزون</th><th>حد التنبيه</th><th>الحالة</th>
        </tr></thead>
        <tbody>
          ${products.map(p => `<tr>
            <td><b>${esc(p.name)}</b></td>
            <td>${formatPrice(p.price)}</td>
            <td>${p.discount ? formatPrice(p.discount) : '—'}</td>
            <td>${p.stock} ${esc(p.unit ?? '')}</td>
            <td>${p.min_stock ?? 0}</td>
            <td>${p.active ? '✅ فعّال' : '❌ معطّل'}${p.is_suggested ? ' 🌟' : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (e) { document.getElementById('market-report-preview').innerHTML = `<p style="color:var(--red);">❌ ${esc(e.message)}</p>`; }
}

async function loadSuppliesReportPreview() {
  try {
    const supplies = await fetchSupplies();
    const preview = document.getElementById('supplies-report-preview');
    if (!supplies.length) { preview.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">لا توجد مواد</p>'; return; }
    preview.innerHTML = `
      <table class="report-table">
        <thead><tr style="background:var(--navy);">
          <th>المادة</th><th>المخزون</th><th>الوحدة</th><th>حد التنبيه</th><th>الكلفة/وحدة</th>
        </tr></thead>
        <tbody>
          ${supplies.map(s => `<tr>
            <td><b>${esc(s.name)}</b></td>
            <td style="color:${s.stock <= (s.min_stock ?? 0) ? 'var(--red)' : 'var(--green)'};font-weight:800;">${s.stock}</td>
            <td>${esc(s.unit ?? '')}</td>
            <td>${s.min_stock ?? 0}</td>
            <td>${s.cost_per_unit ? formatPrice(s.cost_per_unit) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (e) { document.getElementById('supplies-report-preview').innerHTML = `<p style="color:var(--red);">❌ ${esc(e.message)}</p>`; }
}

function _filterOrdersByDate(orders, from, to) {
  return orders.filter(o => {
    const d = new Date(o.created_at);
    if (from && d < new Date(from)) return false;
    if (to && d > new Date(to + 'T23:59:59')) return false;
    return true;
  });
}

function _downloadCSV(filename, rows) {
  const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function exportOrdersCSV() {
  const orders = adminState.get('allOrders') ?? [];
  const from = document.getElementById('rep-from').value;
  const to = document.getElementById('rep-to').value;
  const filtered = _filterOrdersByDate(orders, from, to);
  const rows = [
    ['رقم الطلب', 'الاسم', 'الهاتف', 'المنطقة', 'المبلغ', 'الحالة', 'التاريخ'],
    ...filtered.map(o => [o.id, o.customer_name, o.phone, o.region, o.total, Config.ORDER_STATUSES[o.status]?.label ?? o.status, new Date(o.created_at).toLocaleString('ar-IQ')])
  ];
  _downloadCSV(`orders_${Date.now()}.csv`, rows);
  showToast('✅ تم تصدير التقرير', 'success');
}

function exportOrdersExcel() {
  // For Excel we generate a TSV with xls extension (basic compatibility)
  const orders = adminState.get('allOrders') ?? [];
  const from = document.getElementById('rep-from').value;
  const to = document.getElementById('rep-to').value;
  const filtered = _filterOrdersByDate(orders, from, to);
  const rows = [
    ['رقم الطلب', 'الاسم', 'الهاتف', 'المنطقة', 'المبلغ', 'الحالة', 'التاريخ'],
    ...filtered.map(o => [o.id, o.customer_name, o.phone, o.region, o.total, Config.ORDER_STATUSES[o.status]?.label ?? o.status, new Date(o.created_at).toLocaleString('ar-IQ')])
  ];
  const tsv = rows.map(r => r.map(c => String(c ?? '').replace(/\t/g, ' ')).join('\t')).join('\n');
  const blob = new Blob(['\uFEFF' + tsv], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `orders_${Date.now()}.xls` });
  a.click();
  URL.revokeObjectURL(url);
  showToast('✅ تم تصدير ملف Excel', 'success');
}

async function exportMarketCSV() {
  try {
    const products = await fetchAllProducts();
    const rows = [
      ['المنتج', 'السعر', 'الخصم', 'المخزون', 'الوحدة', 'حد التنبيه', 'التصنيف', 'الحالة', 'مقترح'],
      ...products.map(p => [p.name, p.price, p.discount ?? 0, p.stock, p.unit, p.min_stock ?? 0, p.category, p.active ? 'فعّال' : 'معطّل', p.is_suggested ? 'نعم' : 'لا'])
    ];
    _downloadCSV(`market_products_${Date.now()}.csv`, rows);
    showToast('✅ تم تصدير تقرير القرطاسية', 'success');
  } catch (e) { showToast('❌ ' + e.message, 'error'); }
}

async function exportSuppliesCSV() {
  try {
    const supplies = await fetchSupplies();
    const rows = [
      ['المادة', 'المخزون', 'الوحدة', 'حد التنبيه', 'الكلفة/وحدة', 'التصنيف'],
      ...supplies.map(s => [s.name, s.stock, s.unit, s.min_stock ?? 0, s.cost_per_unit ?? 0, s.category])
    ];
    _downloadCSV(`supplies_${Date.now()}.csv`, rows);
    showToast('✅ تم تصدير تقرير المخزن', 'success');
  } catch (e) { showToast('❌ ' + e.message, 'error'); }
}

async function loadStaffList() {
  const listEl = document.getElementById('staff-list');
  if (!listEl) return;
  try {
    const { sb } = await import('./core/supabase.js');
    const { data } = await sb.from('profiles').select('id, name, emoji, role, permissions').order('name');
    const profiles = data ?? [];
    if (!profiles.length) { listEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:10px;">لا يوجد موظفون</p>'; return; }
    listEl.innerHTML = profiles.map(p => `
      <div class="staff-card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <b style="color:var(--navy);">${esc(p.emoji ?? '👤')} ${esc(p.name)}</b>
          <div>
            ${p.role !== 'admin' ? `
            <button data-edit-staff="${esc(p.id)}" style="background:var(--teal);color:white;border:none;border-radius:4px;padding:4px 8px;font-size:0.75rem;cursor:pointer;">✏️ صلاحيات</button>
            <button data-del-staff="${esc(p.id)}" style="background:var(--red);color:white;border:none;border-radius:4px;padding:4px 8px;font-size:0.75rem;cursor:pointer;">🗑️ حذف</button>
            ` : ''}
            <span class="role-badge rb-oper">${esc(Config.STAFF_ROLES[p.role]?.label ?? p.role)}</span>
          </div>
        </div>
        <div style="font-size:.78rem;color:var(--text-muted);margin-top:6px;">
          ${(p.permissions ?? []).join(' | ') || 'لا صلاحيات خاصة'}
        </div>
      </div>`).join('');

    // Bind edit and delete events
    listEl.querySelectorAll('[data-del-staff]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('هل أنت متأكد من حذف هذا الموظف؟')) return;
        try {
          const { error } = await sb.from('profiles').delete().eq('id', btn.dataset.delStaff);
          if (error) throw error;
          showToast('✅ تم حذف الموظف', 'success');
          loadStaffList();
        } catch (e) { showToast('❌ ' + e.message, 'error'); }
      });
    });

    listEl.querySelectorAll('[data-edit-staff]').forEach(btn => {
      btn.addEventListener('click', () => {
        const profile = profiles.find(pr => pr.id === btn.dataset.editStaff);
        if (!profile) return;
        const newPermsStr = prompt('أدخل الصلاحيات الجديدة مفصولة بفاصلة (مثال: received→printing, manage_market\\nالصلاحيات المتاحة: received→printing, printing→delivering, delivering→delivered, any→cancelled, manage_market, manage_supplies)', (profile.permissions ?? []).join(', '));
        if (newPermsStr === null) return;
        const newPerms = newPermsStr.split(',').map(s=>s.trim()).filter(Boolean);
        sb.from('profiles').update({ permissions: newPerms }).eq('id', profile.id).then(({error}) => {
          if (error) showToast('❌ ' + error.message, 'error');
          else { showToast('✅ تم تحديث الصلاحيات', 'success'); loadStaffList(); }
        });
      });
    });
  } catch (e) { listEl.innerHTML = `<p style="color:var(--red);">❌ ${esc(e.message)}</p>`; }
}

async function loadCouponList() {
  const listEl = document.getElementById('coupon-list-s');
  if (!listEl) return;
  try {
    const { sb } = await import('./core/supabase.js');
    const { data } = await sb.from(Config.TABLES.COUPONS).select('*').order('created_at', { ascending: false });
    const coupons = data ?? [];
    if (!coupons.length) { listEl.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:10px;">لا توجد كوبونات</p>'; return; }
    listEl.innerHTML = `<h4 style="margin:0 0 12px;color:var(--navy);">📋 الكوبونات الحالية</h4>` + coupons.map(c => {
      const disc = c.discount_type === 'percent' ? c.discount_value + '%' : formatPrice(c.discount_value);
      const expired = c.expires_at && new Date(c.expires_at) < new Date();
      return `
      <div style="background:var(--input-bg);border-radius:var(--radius-sm);padding:12px;margin-bottom:8px;border:1px solid var(--border-soft);${!c.active || expired ? 'opacity:.6;' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <b style="color:var(--navy);font-size:.95rem;letter-spacing:1px;">${esc(c.code)}</b>
          <span style="font-size:.72rem;padding:2px 8px;border-radius:var(--radius-full);font-weight:800;background:${c.active && !expired ? '#dcfce7' : '#fef2f2'};color:${c.active && !expired ? '#166534' : '#991b1b'};">${c.active && !expired ? '✅ فعّال' : '❌ منتهي'}</span>
        </div>
        <div style="font-size:.78rem;color:var(--text-muted);margin-top:4px;display:flex;gap:12px;flex-wrap:wrap;">
          <span>💰 خصم ${disc}</span>
          <span>📊 استخدم ${c.used_count ?? 0}${c.max_uses ? '/' + c.max_uses : ''} مرة</span>
          ${c.min_order_amount ? `<span>🔒 حد أدنى ${formatPrice(c.min_order_amount)}</span>` : ''}
          ${c.expires_at ? `<span>📅 ينتهي ${new Date(c.expires_at).toLocaleDateString('ar-IQ')}</span>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch (e) { listEl.innerHTML = `<p style="color:var(--red);">❌ ${esc(e.message)}</p>`; }
}

function updatePendingCount() {
  const count = (adminState.get('allOrders') ?? []).filter(o => ['received', 'printing'].includes(o.status)).length;
  document.getElementById('pcnt').textContent = count;
  sidebar?.updateBadge(count);
}

let _bannerTimer;
function flashBanner(msg) {
  const b = document.getElementById('new-order-banner');
  const t = document.getElementById('new-order-banner-text');
  if (!b) return;
  if (t) t.textContent = msg;
  b.classList.add('show');
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  clearTimeout(_bannerTimer);
  _bannerTimer = setTimeout(() => b.classList.remove('show'), Config.APP.BANNER_DURATION_MS);
}

let _ac = null;
function playAlert(status) {
  if (!_ac) {
    try { _ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  }
  try {
    if (_ac.state === 'suspended') _ac.resume();
    const t = _ac.currentTime;
    const note = (f, st, dur, vol = 0.35) => {
      const o = _ac.createOscillator(), g = _ac.createGain();
      o.connect(g); g.connect(_ac.destination);
      o.frequency.value = f;
      g.gain.setValueAtTime(vol, st);
      g.gain.exponentialRampToValueAtTime(0.001, st + dur);
      o.start(st); o.stop(st + dur);
    };
    if (status === 'received') { note(880, t, .18); note(880, t + .28, .18); note(880, t + .56, .22); }
    if (status === 'delivered') { note(523, t, .14); note(659, t + .18, .14); note(784, t + .36, .14); note(1047, t + .54, .26); }
    if (status === 'cancelled') { note(440, t, .45); note(220, t + .52, .55); }
  } catch { }
}

window.addEventListener('online', () => { const b = document.getElementById('conn-badge'); b.className = 'online'; b.textContent = '✅ الاتصال يعمل'; setTimeout(() => b.className = '', 3000); });
window.addEventListener('offline', () => { const b = document.getElementById('conn-badge'); b.className = 'offline'; b.textContent = '❌ لا يوجد اتصال'; });

init().catch(console.error);

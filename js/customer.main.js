/**
 * customer.main.js — نقطة دخول index.html
 * FIX: { once: true } removed; order click listener moved to init (called once)
 */

import { sb } from './core/supabase.js';
import { Config } from './core/config.js';
import { customerState } from './core/state.js';
import { esc, debounce, isValidIraqiPhone, isValidName, formatPrice, renderSkeletonOrders, renderSkeletonProducts, renderEmptyState, friendlyError } from './core/utils.js';
import { authenticateTelegramUser } from './services/auth.service.js';
import { submitOrder, fetchUserOrders, validateCoupon, calcOrderTotals } from './services/order.service.js';
import { uploadFile } from './services/upload.service.js';
import { fetchActiveProducts, loadPricing } from './services/market.service.js';
import { Stepper } from './customer/stepper.js';
import { showToast } from './components/toast.js';
import { withLoading } from './components/loading-btn.js';
import { Modal } from './components/modal.js';
import { QtyControl } from './components/qty-control.js';

// Summary bar removed as per user request
function updateSummaryBar() {
  return;
}

async function countPptxSlides(file) {
  try {
    if (!window.JSZip) {
      console.warn('JSZip not found, defaulting to 1 slide');
      return 1;
    }
    const zip = await JSZip.loadAsync(file);
    
    // Attempt to read from metadata for most accurate count
    const appXml = await zip.file("docProps/app.xml")?.async("string");
    if (appXml) {
      const match = appXml.match(/<Slides>(\d+)<\/Slides>/);
      if (match && match[1]) {
        const count = parseInt(match[1]);
        console.log(`[PPTX] Metadata detected ${count} slides for ${file.name}`);
        return count;
      }
    }

    // Fallback: slides are in ppt/slides/ and match slideN.xml
    const files = Object.keys(zip.files);
    const actualSlides = files.filter(name => 
      name.toLowerCase().startsWith('ppt/slides/slide') && 
      name.toLowerCase().endsWith('.xml') &&
      !name.includes('_rels')
    );
    
    console.log(`[PPTX] Fallback detected ${actualSlides.length} slides in ${file.name}`);
    return actualSlides.length || 1;
  } catch (e) {
    console.error('Error counting PPTX slides:', e);
    return 1;
  }
}

async function countDocxPages(file) {
  try {
    if (!window.JSZip) return 1;
    const zip = await JSZip.loadAsync(file);
    const appXml = await zip.file("docProps/app.xml")?.async("string");
    if (appXml) {
      const match = appXml.match(/<Pages>(\d+)<\/Pages>/);
      if (match && match[1]) {
        const count = parseInt(match[1]);
        console.log(`[DOCX] Metadata detected ${count} pages for ${file.name}`);
        return count;
      }
    }

    // Fallback to mammoth estimation
    if (!window.mammoth) return 1;
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    const text = result.value || '';
    const est = Math.ceil(text.length / 1200);
    console.log(`[DOCX] Fallback estimated ${est} pages for ${file.name}`);
    return est || 1;
  } catch (e) {
    console.error('Error counting DOCX pages:', e);
    return 1;
  }
}

async function countPdfPages(file) {
  try {
    if (!window.pdfjsLib) {
      console.warn('pdfjsLib not found, defaulting to 1 page');
      return 1;
    }
    const arrayBuffer = await file.arrayBuffer();
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    console.log(`[PDF] Found ${pdf.numPages} pages in ${file.name}`);
    return pdf.numPages;
  } catch (e) {
    console.error('Error counting PDF pages:', e);
    return 1;
  }
}

async function processFilePages(f) {
  const ext = f.name.split('.').pop().toLowerCase();
  console.log(`[Process] Counting pages for ${f.name} (ext: ${ext})`);
  if (ext === 'pdf')  return await countPdfPages(f);
  if (['pptx', 'ppt'].includes(ext)) return await countPptxSlides(f);
  if (['docx', 'doc'].includes(ext)) return await countDocxPages(f);
  return 1; 
}

function _getFilePreviewHTML(f) {
  const ext = f.name.split('.').pop().toLowerCase();
  const badge = `<span class="file-preview-badge file-badge-${ext}">${ext.toUpperCase()}</span>`;

  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext) && f.file) {
    const url = URL.createObjectURL(f.file);
    return `<img src="${url}" style="width:100%;height:100%;object-fit:cover;" onload="URL.revokeObjectURL(this.src)">${badge}`;
  }

  if (ext === 'pdf' && f.file && window.pdfjsLib) {
    const url = URL.createObjectURL(f.file);
    const previewId = 'pdf-prev-' + f.id;
    setTimeout(async () => {
      try {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
        const pdf = await pdfjsLib.getDocument(url).promise;
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 0.3 });
        const canvas = document.getElementById(previewId);
        if (!canvas) { URL.revokeObjectURL(url); return; }
        canvas.width = vp.width;
        canvas.height = vp.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        URL.revokeObjectURL(url);
      } catch { URL.revokeObjectURL(url); }
    }, 50);
    return `<canvas id="${previewId}" style="width:100%;height:100%;object-fit:cover;"></canvas>${badge}`;
  }

  const icons = { doc: '📝', docx: '📝', xls: '📊', xlsx: '📊', ppt: '📰', pptx: '📰' };
  return `<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:2rem;background:var(--input-bg);">${icons[ext] ?? '📄'}${badge}</div>`;
}


async function init() {
  const tg = window.Telegram?.WebApp;
  tg?.ready();
  tg?.expand();
  const tgU = tg?.initDataUnsafe?.user;

  if (!tg?.initData) {
    console.warn('[Telegram] App opened outside of Telegram WebApp context.');
    setTimeout(() => {
      showToast('⚠️ يرجى فتح التطبيق من داخل البوت مباشرة (الزر الأزرق) لضمان حفظ نقاطك وطلباتك.', 'error', 10000);
    }, 1000);
  }

  // تطبيق الوضع الليلي تلقائياً إذا كان Telegram في الوضع الليلي
  let dark = localStorage.getItem(Config.APP.STORAGE_KEYS.DARK_MODE_CUSTOMER) === 'true';
  if (tg?.colorScheme === 'dark' && !localStorage.getItem(Config.APP.STORAGE_KEYS.DARK_MODE_CUSTOMER)) {
    dark = true;
    localStorage.setItem(Config.APP.STORAGE_KEYS.DARK_MODE_CUSTOMER, 'true');
  }
  applyTheme(dark);

  const authOk = await authenticateTelegramUser()
  if (!authOk && tg?.initData) {
    showToast('⚠️ تعذّر التحقق من هويتك. بعض الميزات قد لا تعمل.', 'error', 8000)
  }

  // Telegram Back Button
  if (tg) {
    tg.BackButton.onClick(() => {
      const pdpPage = document.getElementById('product-detail-page');
      const pdpOpen = pdpPage && pdpPage.style.display === 'block';
      const currentTab = document.querySelector('.tab.active')?.id?.replace('tab-', '');
      const successOpen = document.getElementById('success-overlay')?.classList.contains('open');
      const detOpen = document.getElementById('det-ov')?.classList.contains('open');
      const cartOpen = document.getElementById('cart-drawer')?.classList.contains('open');

      if (pdpOpen) {
        closeProductDetailPage();
      } else if (successOpen) {
        document.getElementById('success-overlay').classList.remove('open');
      } else if (detOpen) {
        document.getElementById('det-ov').classList.remove('open');
      } else if (cartOpen) {
        document.getElementById('cart-drawer').classList.remove('open');
      } else if (stepper?.current > 1) {
        stepper.prev();
      } else if (currentTab && currentTab !== 'order') {
        goTab('order');
      } else {
        tg.BackButton.hide();
      }
    });

    tg.MainButton.onClick(() => {
      const currentTab = document.querySelector('.tab.active')?.id?.replace('tab-', '');
      if (currentTab === 'order' && stepper?.current === 4) {
        withLoading('sendbtn', sendOrder);
      }
    });

    customerState.subscribe('currentStep', step => {
      step > 1 ? tg.BackButton.show() : tg.BackButton.hide();
    });
  }

  bindNav();
  bindStepper();
  bindUpload();
  bindPrintOptions();
  bindOrderForm();
  bindPhoneFields();
  bindCart();
  bindMarket();
  bindOrders();
  bindPoints();
  bindResearch();
  bindModals();
  bindSuccessOverlay();
  bindHomeTrackingCard();
  Modal.init();

  // Stable ID for tracking: use Telegram ID if available, otherwise persist a guest ID
  let userId;
  if (tgU?.id) {
    userId = String(tgU.id);
    localStorage.removeItem('shater_guest_id'); // Clear old guest ID since we have real ID
  } else {
    userId = localStorage.getItem('shater_guest_id');
    if (!userId) {
      userId = 'guest_' + Date.now() + Math.random().toString(36).substring(2, 6);
      localStorage.setItem('shater_guest_id', userId);
    }
  }

  // Initial local state setup
  customerState.merge('user', { 
    id: userId, 
    name: tgU?.first_name ?? 'ضيف', 
    username: tgU?.username ?? '' 
  });

  try {
    const { data } = await sb.from(Config.TABLES.USERS).select('*').eq('id', userId).maybeSingle();
    if (data) {
      // User exists — update if Telegram data changed
      const needsUpdate = tgU && (
        data.telegram_id !== String(tgU.id) ||
        data.first_name !== tgU.first_name
      );
      
      if (needsUpdate) {
        const updates = { 
          telegram_id: String(tgU.id), 
          first_name: tgU.first_name, 
          username: tgU.username 
        };
        await sb.from(Config.TABLES.USERS).update(updates).eq('id', userId);
        Object.assign(data, updates);
      }
      
      customerState.set('user', { 
        ...data, 
        name: data.first_name, 
        // Ensure telegram_id is properly set in the state
        telegram_id: tgU ? String(tgU.id) : data.telegram_id 
      });
    } else {
      const newUser = {
        id: userId, 
        telegram_id: tgU ? String(tgU.id) : null,
        first_name: tgU?.first_name ?? 'ضيف', 
        username: tgU?.username ?? '',
        loyalty_points: 0, 
        total_orders: 0, 
        total_spent: 0, 
        first_order_done: false
      };
      await sb.from(Config.TABLES.USERS).insert(newUser);
      customerState.set('user', { ...newUser, name: newUser.first_name });
    }

    // Auto-fill forms with name and phone
    const activeUser = customerState.get('user');
    if (activeUser) {
      const fullName = (tgU?.first_name || activeUser.first_name || '') + (tgU?.last_name ? ' ' + tgU.last_name : '');
      const phone = activeUser.phone || '';

      ['uName', 'cart-name', 'res-name'].forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.value) el.value = fullName.trim();
      });
      ['uPhone', 'res-phone', 'cart-phone'].forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.value) el.value = phone;
      });
    }
  } catch (e) { console.warn('[Auth]', e.message); }

  const pricing = await loadPricing();
  if (pricing) customerState.set('pricing', pricing);
  applyPricingToUI(pricing ?? Config.DEFAULT_PRICING);

  customerState.subscribe('user', refreshPtsUI);
  refreshPtsUI();
  startRealtime(userId);

  customerState.subscribe('files', updatePrintBadge);
  updatePrintBadge(customerState.get('files') ?? []);

  // Bind Launchpad transitions and buttons
  bindLaunchpad();

  // Load suggested products for step 3
  loadSuggestedProducts();
  loadOrders();
}

window.loadMktProducts = loadMktProducts;

function applyPricingToUI(pricing) {
  const P = pricing ?? Config.DEFAULT_PRICING;
  const cardboardPrice = P.packaging?.cardboard ?? 500;
  const spiralPrice = P.packaging?.spiral ?? 1500;
  const expressFee = P.express_fee ?? 1500;

  const cardPriceEl = document.getElementById('pkg-cardboard-price');
  if (cardPriceEl) cardPriceEl.textContent = cardboardPrice === 0 ? 'مجاني' : `${formatPrice(cardboardPrice)}`;

  const spiralPriceEl = document.getElementById('pkg-spiral-price');
  if (spiralPriceEl) spiralPriceEl.textContent = spiralPrice === 0 ? 'مجاني' : `${formatPrice(spiralPrice)}`;

  const expressFeeEl = document.getElementById('express-fee-label');
  if (expressFeeEl) expressFeeEl.textContent = `أولوية في الطباعة (+${formatPrice(expressFee)})`;
}

function updateTrackingNodes(containerId, lineProgressId, status) {
  const nodes = document.querySelectorAll(`#${containerId} .track-node`);
  const lineProgress = document.getElementById(lineProgressId);
  if (!nodes.length || !lineProgress) return;

  nodes.forEach(n => {
    n.classList.remove('active');
    const circle = n.querySelector('div');
    if (circle) {
      circle.removeAttribute('style');
    }
    const label = n.querySelector('div:nth-child(2)');
    if (label) {
      label.removeAttribute('style');
    }
  });

  let activeIndex = 0;
  if (status === 'received' || status === 'pending') {
    activeIndex = 0;
  } else if (status === 'printing') {
    activeIndex = 1;
  } else if (status === 'delivering' || status === 'ready' || status === 'delivered') {
    activeIndex = 2;
  }

  for (let i = 0; i <= activeIndex; i++) {
    const n = nodes[i];
    if (!n) continue;
    n.classList.add('active');
  }

  const pct = activeIndex * 50;
  lineProgress.style.width = `${pct}%`;
}


function updateSuccessTracking(status) {
  updateTrackingNodes('success-tracking-steps', 'track-line-progress', status);
}

function populateSuccessDetails() {
  const itemsList = document.getElementById('success-items-list');
  const detailsBox = document.getElementById('success-order-details');
  if (!itemsList || !detailsBox) return;

  itemsList.innerHTML = '';
  
  const files = customerState.get('files') ?? [];
  const cart = customerState.get('cart') ?? [];
  const sugCart = customerState.get('suggestedCart') ?? {};
  const suggestedProducts = customerState.get('suggestedProducts') ?? [];

  if (files.length === 0 && cart.length === 0 && Object.keys(sugCart).length === 0) {
    detailsBox.style.display = 'none';
    return;
  }
  detailsBox.style.display = 'block';

  // Files
  files.forEach(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    const isImg = ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
    const typeIcon = isImg ? '🖼️' : '📄';
    const isColor = customerState.get('printColor') === 'c';
    const isDouble = customerState.get('printSide') === '2';
    const colorMode = isColor ? 'ملون' : 'أسود وأبيض';
    const sideMode = isDouble ? 'على الوجهين' : 'وجه واحد';
    const itemEl = document.createElement('div');
    itemEl.style.padding = '6px 0';
    itemEl.style.borderBottom = '1px solid #f1f5f9';
    itemEl.style.fontSize = '0.8rem';
    itemEl.innerHTML = `
      <b style="color: var(--navy); display: block;">${typeIcon} ${esc(f.name)}</b>
      <span style="font-size: 0.72rem; color: var(--text-muted);">
        ${f.pages ?? 1} صفحة × ${f.copies ?? 1} نسخة • ${colorMode} • ${sideMode}
      </span>
    `;
    itemsList.appendChild(itemEl);
  });

  // Stationery
  cart.forEach(i => {
    const itemEl = document.createElement('div');
    itemEl.style.padding = '6px 0';
    itemEl.style.borderBottom = '1px solid #f1f5f9';
    itemEl.style.fontSize = '0.8rem';
    itemEl.innerHTML = `
      <b style="color: var(--navy); display: block;">📦 ${esc(i.name)}</b>
      <span style="font-size: 0.72rem; color: var(--text-muted);">
        الكمية: ${i.qty} • السعر: ${formatPrice(i.effective_price ?? i.price)}
      </span>
    `;
    itemsList.appendChild(itemEl);
  });

  // Suggested Items
  Object.entries(sugCart).forEach(([id, qty]) => {
    const p = suggestedProducts.find(x => x.id === id);
    if (p) {
      const itemEl = document.createElement('div');
      itemEl.style.padding = '6px 0';
      itemEl.style.borderBottom = '1px solid #f1f5f9';
      itemEl.style.fontSize = '0.8rem';
      itemEl.innerHTML = `
        <b style="color: var(--navy); display: block;">✨ ${esc(p.name)}</b>
        <span style="font-size: 0.72rem; color: var(--text-muted);">
          الكمية: ${qty} • السعر: ${formatPrice(p.price)}
        </span>
      `;
      itemsList.appendChild(itemEl);
    }
  });
}

function updateHomeOrderTrackingCard(order) {
  const card = document.getElementById('home-order-tracking-card');
  const activeBanner = document.getElementById('home-active-order-banner');
  const dashboard = document.getElementById('launchpad-dashboard');
  const printWizard = document.getElementById('print-wizard-container');

  if (!card) return;

  if (!order || customerState.get('hideHomeTracking') === true) {
    card.style.display = 'none';
    if (printWizard) printWizard.style.display = 'none';
    if (dashboard) dashboard.style.display = 'block';
    if (order && activeBanner) {
      activeBanner.style.display = 'block';
    } else if (activeBanner) {
      activeBanner.style.display = 'none';
    }
    return;
  }

  card.style.display = 'block';
  if (dashboard) dashboard.style.display = 'none';
  if (printWizard) printWizard.style.display = 'none';
  if (activeBanner) activeBanner.style.display = 'none';

  const orderIdShort = order.id.length > 8 ? order.id.slice(0, 8) : order.id;
  document.getElementById('home-track-order-id').textContent = '#' + orderIdShort;
  
  const statusMap = Config.ORDER_STATUSES;
  const s = statusMap[order.status] ?? { label: order.status, icon: '📦' };
  document.getElementById('home-track-order-status').textContent = `${s.label} ${s.icon}`;
  document.getElementById('home-track-order-addr').textContent = order.region || 'استلام من المركز';
  document.getElementById('home-track-order-total').textContent = formatPrice(order.total);

  const itemsList = document.getElementById('home-track-items-list');
  if (itemsList) {
    itemsList.innerHTML = '';
    const items = [];
    
    if (order.files_data && Array.isArray(order.files_data)) {
      order.files_data.forEach(f => {
        const ext = f.name.split('.').pop().toLowerCase();
        const isImg = ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
        const typeIcon = isImg ? '🖼️' : '📄';
        items.push(`${typeIcon} ${esc(f.name)} (${f.pages} ص × ${f.copies})`);
      });
    }
    if (order.cart_items && Array.isArray(order.cart_items)) {
      order.cart_items.forEach(item => {
        const prefix = item.is_suggested ? '✨' : '📦';
        items.push(`${prefix} ${esc(item.name)} × ${item.qty}`);
      });
    }

    if (items.length > 0) {
      itemsList.innerHTML = items.map(txt => `<div style="border-bottom: 1px solid #f1f5f9; padding: 4px 0; font-size: 0.8rem;">${txt}</div>`).join('');
    } else {
      itemsList.innerHTML = '<div style="color:var(--text-muted);font-size:0.78rem;">لا توجد تفاصيل للمواد</div>';
    }
  }

  updateTrackingNodes('home-tracking-steps', 'home-track-line-progress', order.status);
}

function bindHomeTrackingCard() {
  const refreshBtn = document.getElementById('home-track-refresh-status');
  refreshBtn?.addEventListener('click', async () => {
    const orderId = document.getElementById('home-track-order-id').textContent.replace('#', '');
    if (!orderId || orderId === '-----') return;

    refreshBtn.style.transform = 'rotate(360deg)';
    refreshBtn.style.transition = 'transform 0.5s ease';
    setTimeout(() => {
      refreshBtn.style.transform = 'none';
      refreshBtn.style.transition = 'none';
    }, 500);

    try {
      const allOrders = customerState.get('allUserOrders') ?? [];
      let matchedOrder = allOrders.find(o => o.id.startsWith(orderId) || o.id === orderId);
      if (!matchedOrder) {
        const { data, error } = await sb.from(Config.TABLES.ORDERS).select('*').ilike('id', `${orderId}%`).limit(1);
        if (!error && data && data.length) {
          matchedOrder = data[0];
        }
      }

      if (matchedOrder) {
        const { data, error } = await sb.from(Config.TABLES.ORDERS).select('*').eq('id', matchedOrder.id).single();
        if (!error && data) {
          updateHomeOrderTrackingCard(data);
          showToast('🔄 تم تحديث حالة الطلب', 'success');
          loadOrders();
        }
      }
    } catch (err) {
      console.error('[Home Refresh status failed]', err);
    }
  });

  const newOrderBtn = document.getElementById('home-track-new-order');
  newOrderBtn?.addEventListener('click', () => {
    customerState.set('hideHomeTracking', true);
    updateHomeOrderTrackingCard(null);
    const orders = customerState.get('allUserOrders') ?? [];
    const activeStatuses = ['received', 'printing', 'delivering', 'pending', 'ready'];
    const activeOrder = orders.find(o => activeStatuses.includes(o.status));
    const banner = document.getElementById('home-active-order-banner');
    if (banner && activeOrder) {
      banner.style.display = 'block';
    }
  });

  const hideBtn = document.getElementById('home-track-hide');
  hideBtn?.addEventListener('click', () => {
    customerState.set('hideHomeTracking', true);
    updateHomeOrderTrackingCard(null);
    const orders = customerState.get('allUserOrders') ?? [];
    const activeStatuses = ['received', 'printing', 'delivering', 'pending', 'ready'];
    const activeOrder = orders.find(o => activeStatuses.includes(o.status));
    const banner = document.getElementById('home-active-order-banner');
    if (banner && activeOrder) {
      banner.style.display = 'block';
    }
  });

  const banner = document.getElementById('home-active-order-banner');
  if (banner) {
    banner.addEventListener('click', () => {
      customerState.set('hideHomeTracking', false);
      banner.style.display = 'none';
      const orders = customerState.get('allUserOrders') ?? [];
      const activeStatuses = ['received', 'printing', 'delivering', 'pending', 'ready'];
      const activeOrder = orders.find(o => activeStatuses.includes(o.status));
      if (activeOrder) {
        updateHomeOrderTrackingCard(activeOrder);
      }
    });
  }
}

function bindSuccessOverlay() {
  document.getElementById('success-view-orders')?.addEventListener('click', () => {
    document.getElementById('success-overlay').classList.remove('open');
    goTab('orders');
  });

  document.getElementById('success-close')?.addEventListener('click', () => {
    document.getElementById('success-overlay').classList.remove('open');
    goTab('order');
  });

  document.getElementById('success-refresh-status')?.addEventListener('click', async () => {
    const btn = document.getElementById('success-refresh-status');
    const originalId = document.getElementById('success-order-id').textContent.replace('#', '');
    if (!originalId || originalId === '-----') return;

    btn.style.transform = 'rotate(360deg)';
    btn.style.transition = 'transform 0.5s ease';
    setTimeout(() => { btn.style.transform = 'none'; btn.style.transition = 'none'; }, 500);

    try {
      const allOrders = customerState.get('allUserOrders') ?? [];
      let matchedOrder = allOrders.find(o => o.id.startsWith(originalId) || o.id === originalId);
      if (!matchedOrder) {
        const { data, error } = await sb.from(Config.TABLES.ORDERS).select('*').ilike('id', `${originalId}%`).limit(1);
        if (!error && data && data.length) {
          matchedOrder = data[0];
        }
      }

      if (matchedOrder) {
        const { data, error } = await sb.from(Config.TABLES.ORDERS).select('status').eq('id', matchedOrder.id).single();
        if (!error && data) {
          const statusMap = Config.ORDER_STATUSES;
          const s = statusMap[data.status] ?? { label: data.status, icon: '📦' };
          document.getElementById('success-order-status').textContent = `${s.label} ${s.icon}`;
          updateSuccessTracking(data.status);
          showToast('🔄 تم تحديث حالة الطلب', 'success');
          loadOrders(); // background refresh
        }
      }
    } catch (err) {
      console.error('[Refresh status failed]', err);
    }
  });
}

function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.getElementById('dm-icon').textContent = dark ? '☀️' : '🌙';
  document.getElementById('dm-lbl').textContent = dark ? 'نهاري' : 'ليلي';
}

function bindNav() {
  document.getElementById('nav-dm').addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    localStorage.setItem(Config.APP.STORAGE_KEYS.DARK_MODE_CUSTOMER, String(!dark));
    applyTheme(!dark);
  });

  document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => goTab(btn.dataset.tab));
  });
}

function goTab(t) {
  const currentTab = document.querySelector('.tab.active');

  // If returning to Home (order), reset to Launchpad dashboard
  if (t === 'order') {
    const dashboard = document.getElementById('launchpad-dashboard');
    const printWizard = document.getElementById('print-wizard-container');
    if (dashboard) dashboard.style.display = 'block';
    if (printWizard) printWizard.style.display = 'none';
  } else {
    // Hide Telegram MainButton when navigating away from the order tab
    window.Telegram?.WebApp?.MainButton?.hide();
  }

  // انتقال الخروج
  if (currentTab && currentTab.id !== 'tab-' + t) {
    currentTab.classList.add('tab-exit');
    setTimeout(() => {
      currentTab.classList.remove('active', 'tab-exit');
      currentTab.style.display = 'none';
    }, 180);
  }

  // انتقال الدخول
  const targetTab = document.getElementById('tab-' + t);
  if (targetTab) {
    targetTab.style.display = 'block';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => targetTab.classList.add('active'));
    });
  }

  document.querySelectorAll('.nav-btn').forEach(x => x.classList.remove('active'));
  document.getElementById('nav-' + t)?.classList.add('active');

  if (t === 'orders') loadOrders();
  if (t === 'points') loadPtsTab();
  if (t === 'market') { const p = customerState.get('mktProducts'); if (!p?.length) loadMktProducts(); }

  window.scrollTo({ top: 0, behavior: 'smooth' });
  window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
}


let stepper;
function bindStepper() {
  stepper = new Stepper(4, step => {
    updateSummaryBar();
    if (step === 3) updateStep3Summary();
    if (step === 4) updateInvoice();

    // Telegram Main Button في الخطوة الأخيرة
    const tg = window.Telegram?.WebApp;
    if (tg) {
      if (step === 4) {
        tg.MainButton.setText('🚀 تأكيد وإرسال الطلب');
        tg.MainButton.show();
      } else {
        tg.MainButton.hide();
      }
    }
  });

  stepper.setValidator(1, () => {
    const files = customerState.get('files') ?? [];
    const cart = customerState.get('cart') ?? [];
    if (!files.length && !cart.length) return 'يرجى إضافة ملف للطباعة أو منتج للسلة';
    return true;
  });

  document.getElementById('step1-next').addEventListener('click', () => {
    const r = stepper.next();
    if (r !== true) showToast(r, 'error');
  });
  [2, 3].forEach(s => {
    document.getElementById(`step${s}-next`).addEventListener('click', () => stepper.next());
    document.getElementById(`step${s}-prev`).addEventListener('click', () => stepper.prev());
  });
  document.getElementById('step4-prev').addEventListener('click', () => stepper.prev());

  document.querySelectorAll('.step-item').forEach(item => {
    item.addEventListener('click', () => {
      const s = Number(item.dataset.step);
      if (s < stepper.current) stepper.goTo(s);
    });
  });
}

function bindUpload() {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('fileinp');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') input.click(); });

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.borderColor = 'var(--navy)'; });
  zone.addEventListener('dragleave', () => { zone.style.borderColor = ''; });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.style.borderColor = '';
    handleFiles(Array.from(e.dataTransfer.files));
  });

  input.addEventListener('change', () => {
    handleFiles(Array.from(input.files));
    input.value = '';
  });

  document.getElementById('flist').addEventListener('click', e => {
    const delBtn = e.target.closest('[data-del-file]');
    if (delBtn) removeFile(delBtn.dataset.delFile);
  });
  QtyControl.delegate(document.getElementById('flist'), (id, delta) => {
    adjustFileCopies(id, delta);
  });
}

async function handleFiles(newFiles) {
  const allowed = newFiles.filter(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    return ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'jpg', 'jpeg', 'png', 'webp'].includes(ext);
  });
  if (!allowed.length) { showToast('❌ نوع الملف غير مدعوم', 'error'); window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error'); return; }

  // مؤشر معالجة فوري في منطقة الرفع
  const zone = document.getElementById('upload-zone');
  const originalHTML = zone.innerHTML;
  zone.innerHTML = `
    <span class="upload-zone-icon" style="animation:spin .7s linear infinite;display:inline-block;">⚙️</span>
    <span style="font-size:1rem;font-weight:700;color:var(--navy);">جاري قراءة الملفات...</span>
    <p style="font-size:.82rem;margin:6px 0 0;color:var(--teal);">0 / ${allowed.length} ملف</p>`;
  zone.style.pointerEvents = 'none';

  for (let idx = 0; idx < allowed.length; idx++) {
    const f = allowed[idx];
    zone.querySelector('p').textContent = `${idx + 1} / ${allowed.length} ملف`;
    const id = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const pages = await processFilePages(f);
    const currentFiles = [...(customerState.get('files') ?? [])];
    currentFiles.push({ id, name: f.name, size: f.size, pages: pages, copies: 1, file: f });
    customerState.set('files', currentFiles);
  }

  zone.innerHTML = originalHTML;
  zone.style.pointerEvents = '';
  renderFileList();
  if (allowed.length > 1) showToast(`✅ تمت إضافة ${allowed.length} ملفات`, 'success');
  window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium');
}


function removeFile(id) {
  const card = document.getElementById('fc-' + id);
  if (card) {
    card.classList.add('removing');
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('soft');
    setTimeout(() => {
      const files = (customerState.get('files') ?? []).filter(f => f.id !== id);
      customerState.set('files', files);
      renderFileList();
    }, 280);
  } else {
    const files = (customerState.get('files') ?? []).filter(f => f.id !== id);
    customerState.set('files', files);
    renderFileList();
  }
}

function adjustFileCopies(id, delta) {
  const files = (customerState.get('files') ?? []).map(f => f.id === id ? { ...f, copies: Math.max(1, (f.copies ?? 1) + delta) } : f);
  customerState.set('files', files);
  renderFileList();
}

function renderFileList() {
  const files = customerState.get('files') ?? [];
  const flist = document.getElementById('flist');
  const isColor = customerState.get('printColor') === 'c';

  flist.innerHTML = files.map(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    const unitName = (['pptx', 'ppt'].includes(ext)) ? 'شريحة' : 'صفحة';
    return `
    <div class="file-card" id="fc-${esc(f.id)}">
      <div class="file-preview${isColor ? '' : ' bw'}" id="prev-${esc(f.id)}">
        ${_getFilePreviewHTML(f)}
      </div>
      <div class="file-info">
        <span class="file-name">${esc(f.name)}</span>
        <span class="file-meta">${f.pages > 0 ? f.pages + ' ' + unitName + ' • ' : ''}${(f.size / 1024).toFixed(0)} KB</span>
        <div style="display:flex;align-items:center;gap:6px;margin-top:auto;">
          ${QtyControl.html({ id: f.id, value: f.copies ?? 1, min: 1, max: 99 })}
          <button class="file-del-btn" data-del-file="${esc(f.id)}">🗑️ حذف</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // Restore Counters Summary Box
  const sumBox = document.getElementById('upload-summary-box');
  if (files.length && sumBox) {
    let docFilesCount = 0;
    let imgs = 0;
    let pages = 0;
    files.forEach(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
        imgs += (f.copies ?? 1);
      } else {
        docFilesCount++;
        pages += (f.pages ?? 1) * (f.copies ?? 1);
      }
    });
    document.getElementById('s1-tot-files').textContent = docFilesCount;
    document.getElementById('s1-tot-imgs').textContent = imgs;
    document.getElementById('s1-tot-pages').textContent = pages;
    sumBox.style.display = 'block';
  } else if (sumBox) {
    sumBox.style.display = 'none';
  }

  document.getElementById('step1-next').textContent =
    files.length ? `التالي: خيارات الطباعة (${files.length} ملف) ←` : 'التالي: خيارات الطباعة ←';

  renderPrintSummary();
}

function bindPrintOptions() {
  document.querySelectorAll('.option-btn[data-color]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.option-btn[data-color]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      customerState.set('printColor', btn.dataset.color);
      renderFileList();
      renderPrintSummary();
    });
  });

  document.querySelectorAll('.option-btn[data-side]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.option-btn[data-side]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      customerState.set('printSide', btn.dataset.side);
      renderPrintSummary();
    });
  });

  document.querySelectorAll('.pkg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pkg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      customerState.set('packaging', btn.dataset.pkg);
      renderPrintSummary();
    });
  });
  document.querySelector('.pkg-btn[data-pkg="none"]')?.classList.add('active');

  document.getElementById('expressTog').addEventListener('change', e => {
    customerState.set('express', e.target.checked);
    const label = document.getElementById('express-label');
    const card = document.getElementById('express-card');
    if (e.target.checked) {
      label.textContent = '⚡ طلب عاجل — مفعّل ✅';
      label.style.color = 'var(--green)';
      card.style.borderColor = 'var(--green)';
    } else {
      label.textContent = '⚡ طلب عاجل (Express)';
      label.style.color = 'var(--express)';
      card.style.borderColor = 'var(--express)';
    }
    renderPrintSummary();
  });
}

function renderPrintSummary() {
  const files = customerState.get('files') ?? [];
  const pkgKey = customerState.get('packaging') ?? 'none';
  const express = customerState.get('express');
  const P = customerState.get('pricing') ?? Config.DEFAULT_PRICING;

  const sumBox = document.getElementById('step2-summary-box');
  if (!sumBox) return;

  if (!files.length) {
    sumBox.style.display = 'none';
    return;
  }
  sumBox.style.display = 'block';

  let totalPages = 0;
  let totalImgs = 0;
  files.forEach(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      totalImgs += (f.copies ?? 1);
    } else {
      totalPages += (f.pages ?? 1) * (f.copies ?? 1);
    }
  });

  const packagingName = {
    none: 'كبس فقط (مجاني)',
    cardboard: 'ورق مقوى ونايلون (+500 د.ع)',
    spiral: 'سبايرول (+1,500 د.ع)'
  }[pkgKey] ?? pkgKey;

  const expressText = express ? 'نعم (+1,500 د.ع)' : 'لا';

  const totals = calcOrderTotals({
    files,
    cart: customerState.get('cart') ?? [],
    sugCart: customerState.get('suggestedCart') ?? {},
    pricing: P,
    coupon: customerState.get('appliedCoupon'),
    user: customerState.get('user'),
  });

  const packagingPrice = P.packaging?.[pkgKey] ?? 0;
  const expressPrice = express ? P.express_fee : 0;
  const basePrintPrice = totals.printSubtotal - packagingPrice - expressPrice;

  document.getElementById('s2-sum-pages').textContent = totalPages + ' صفحة';
  document.getElementById('s2-sum-imgs').textContent = totalImgs + ' صورة';
  document.getElementById('s2-sum-print-only').textContent = formatPrice(basePrintPrice);
  document.getElementById('s2-sum-pkg-price').textContent = formatPrice(packagingPrice);
  document.getElementById('s2-sum-express-price').textContent = formatPrice(expressPrice);
  document.getElementById('s2-sum-total').textContent = formatPrice(totals.printSubtotal);
  updateStep3Summary();
}

function updateStep3Summary() {
  const box = document.getElementById('step3-summary-box');
  if (!box) return;

  const files = customerState.get('files') ?? [];
  const cart = customerState.get('cart') ?? [];
  const sugCart = customerState.get('suggestedCart') ?? {};

  if (files.length === 0 && cart.length === 0 && Object.keys(sugCart).length === 0) {
    box.style.display = 'none';
    return;
  }

  box.style.display = 'block';

  const pricing = customerState.get('pricing') ?? Config.DEFAULT_PRICING;
  const totals = calcOrderTotals({
    files,
    cart,
    sugCart,
    pricing,
    coupon: customerState.get('appliedCoupon'),
    user: customerState.get('user')
  });

  const printSubtotal = totals.printSubtotal;
  const cartSubtotal = totals.cartSubtotal;

  document.getElementById('s3-sum-print').textContent = formatPrice(printSubtotal);
  document.getElementById('s3-sum-market').textContent = formatPrice(cartSubtotal);

  // تحديث رسوم التوصيل
  const deliveryVal = document.getElementById('s3-sum-delivery');
  if (deliveryVal) {
    deliveryVal.innerHTML = totals.deliveryFee === 0 
      ? '<span style="color:var(--green)">🎁 مجاني</span>' 
      : formatPrice(totals.deliveryFee);
  }

  const ptsRow = document.getElementById('s3-pts-row');
  const ptsVal = document.getElementById('s3-sum-pts');
  const usePoints = document.getElementById('ptstog')?.checked;
  const user = customerState.get('user');
  const subtotal = printSubtotal + cartSubtotal;
  const pointsSaving = usePoints ? Math.min((user?.loyalty_points ?? 0) * 10, subtotal * 0.3) : 0;

  if (pointsSaving > 0) {
    if (ptsRow) ptsRow.style.display = 'flex';
    if (ptsVal) ptsVal.textContent = '- ' + formatPrice(Math.round(pointsSaving));
  } else {
    if (ptsRow) ptsRow.style.display = 'none';
  }

  // تحديث خصم الكوبون
  const couponRow = document.getElementById('s3-coupon-row');
  const couponVal = document.getElementById('s3-sum-coupon');
  const couponDiscount = Math.max(0, totals.discount - pointsSaving);

  if (couponDiscount > 0) {
    if (couponRow) couponRow.style.display = 'flex';
    if (couponVal) couponVal.textContent = '- ' + formatPrice(Math.round(couponDiscount));
  } else {
    if (couponRow) couponRow.style.display = 'none';
  }

  document.getElementById('s3-sum-total').textContent = formatPrice(totals.total);
}

function bindOrderForm() {
  document.getElementById('locbtn').addEventListener('click', () => {
    if (!navigator.geolocation) { showToast('الموقع الجغرافي غير مدعوم', 'error'); return; }
    const btn = document.getElementById('locbtn');
    btn.textContent = '⏳ جاري التحديد...';
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      pos => {
        const url = `https://maps.google.com/maps?q=${pos.coords.latitude},${pos.coords.longitude}`;
        customerState.set('locationUrl', url);
        btn.textContent = '✅ تم تحديد موقعك';
        btn.style.background = 'var(--green)';
        btn.disabled = false;
      },
      () => {
        btn.textContent = '📍 تحديد موقعي على الخريطة';
        btn.disabled = false;
        showToast('تعذّر تحديد الموقع', 'error');
      }
    );
  });

  document.getElementById('coupon-apply-btn').addEventListener('click', applyCoupon);
  document.getElementById('couponInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') applyCoupon();
  });
  document.getElementById('couponInput').addEventListener('input', e => {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(pos, pos);
  });

  const regionInput = document.getElementById('uRegion');
  regionInput.addEventListener('focus', showAddrSuggestions);
  regionInput.addEventListener('input', showAddrSuggestions);
  document.addEventListener('click', e => {
    if (!e.target.closest('.addr-wrap')) document.getElementById('addr-sug').style.display = 'none';
  });

  document.getElementById('sendbtn').addEventListener('click', () => {
    withLoading('sendbtn', sendOrder);
  });

  document.getElementById('ptstog').addEventListener('change', () => {
    updateInvoice();
    updateStep3Summary();
  });
}

function bindPhoneFields() {
  const phoneFields = ['uPhone', 'res-phone', 'cart-phone'];
  phoneFields.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', e => {
      const cleaned = e.target.value.replace(/\D/g, '').slice(0, 11);
      e.target.value = cleaned;
      if (cleaned.length === 0) {
        el.style.borderColor = '';
      } else if (/^07[0-9]{9}$/.test(cleaned)) {
        el.style.borderColor = 'var(--green)';
      } else if (cleaned.length >= 3 && !cleaned.startsWith('07')) {
        el.style.borderColor = 'var(--red)';
      } else {
        el.style.borderColor = 'var(--orange)';
      }
    });
    el.addEventListener('blur', e => {
      if (e.target.value && !/^07[0-9]{9}$/.test(e.target.value)) {
        showToast('❌ رقم الهاتف يجب أن يبدأ بـ 07 ويكون 11 رقماً', 'error');
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
      }
    });
  });
}

async function applyCoupon() {
  const code = document.getElementById('couponInput').value.trim();
  const msgEl = document.getElementById('coupon-msg');
  if (!code) { msgEl.style.display = 'none'; customerState.set('appliedCoupon', null); updateInvoice(); return; }
  try {
    const coupon = await validateCoupon(code);
    customerState.set('appliedCoupon', coupon);
    const disc = coupon.discount_type === 'percent' ? coupon.discount_value + '%' : formatPrice(coupon.discount_value);
    showCouponMsg('success', `✅ تم تطبيق الكوبون — خصم ${disc}`);
  } catch (e) {
    customerState.set('appliedCoupon', null);
    showCouponMsg('error', '❌ ' + e.message);
  }
  updateInvoice();
}

function showCouponMsg(type, text) {
  const el = document.getElementById('coupon-msg');
  const map = {
    success: { background: '#f0fdf4', color: '#166534', border: '1px solid #86efac' },
    error: { background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' },
  };
  Object.assign(el.style, { display: 'block', ...map[type] });
  el.textContent = text;
}

function showAddrSuggestions() {
  const val = document.getElementById('uRegion').value.toLowerCase().trim();
  const saved = JSON.parse(localStorage.getItem(Config.APP.STORAGE_KEYS.SAVED_ADDRESSES) || '[]');
  const items = saved.filter(a => !val || a.toLowerCase().includes(val));
  const box = document.getElementById('addr-sug');
  if (!items.length) { box.style.display = 'none'; return; }
  box.innerHTML = items.map(a => `<div class="addr-suggestion-item">📍 ${esc(a)}</div>`).join('');
  box.style.display = 'block';
  box.querySelectorAll('.addr-suggestion-item').forEach((item, i) => {
    item.addEventListener('click', () => {
      document.getElementById('uRegion').value = items[i];
      box.style.display = 'none';
    });
  });
}

function updateInvoice() {
  const pricing = customerState.get('pricing') ?? Config.DEFAULT_PRICING;
  const totals = calcOrderTotals({
    files: customerState.get('files') ?? [],
    cart: customerState.get('cart') ?? [],
    sugCart: customerState.get('suggestedCart') ?? {},
    pricing, coupon: customerState.get('appliedCoupon'),
    user: customerState.get('user'),
  });

  const files = customerState.get('files') ?? [];
  const cart = customerState.get('cart') ?? [];
  const sugCart = customerState.get('suggestedCart') ?? {};
  const suggestedProducts = customerState.get('suggestedProducts') ?? [];

  const cartTotal = cart.reduce((s, i) => s + (i.effective_price ?? i.price) * (i.qty ?? 1), 0);
  let sugCartTotal = 0;
  
  const rows = [];
  if (files.length > 0) {
    rows.push(['<b style="color:var(--navy);">الملفات المرفوعة:</b>', '']);
    files.forEach(f => {
      rows.push([`<span style="margin-right:10px;font-size:0.85rem">📄 ${esc(f.name)} (${f.pages ?? 1} ص × ${f.copies ?? 1} نسخ)</span>`, '']);
    });

    const P = pricing ?? Config.DEFAULT_PRICING;
    const pkgKey = customerState.get('packaging') ?? 'none';
    const packagingPrice = P.packaging?.[pkgKey] ?? 0;
    const expressPrice = customerState.get('express') ? (P.express_fee ?? 0) : 0;
    
    const printCost = totals.printSubtotal; 
    const basePrintPrice = printCost - packagingPrice - expressPrice;
    
    rows.push([`<span style="margin-right:10px;font-size:0.85rem;color:var(--teal)">💵 سعر الطباعة فقط</span>`, `<b>${formatPrice(basePrintPrice)}</b>`]);
    
    if (packagingPrice > 0) {
      const packagingName = {
        none: 'كبس فقط',
        cardboard: 'ورق مقوى ونايلون شفاف',
        spiral: 'تجليد حلزوني (سبايرول)'
      }[pkgKey] ?? pkgKey;
      rows.push([`<span style="margin-right:10px;font-size:0.85rem;color:var(--teal)">📦 إضافة التغليف (${packagingName})</span>`, `<b>+ ${formatPrice(packagingPrice)}</b>`]);
    }
    
    if (expressPrice > 0) {
      rows.push([`<span style="margin-right:10px;font-size:0.85rem;color:var(--teal)">⚡ إضافة طلب عاجل</span>`, `<b>+ ${formatPrice(expressPrice)}</b>`]);
    }
    
    rows.push([`<span style="margin-right:10px;font-size:0.85rem;color:var(--navy);font-weight:800">💰 السعر الكلي للطباعة</span>`, `<b style="color:var(--teal);font-weight:900">${formatPrice(printCost)}</b>`]);
  }

  const cartItems = cart.map(i => ({...i, isSug: false}));
  Object.entries(sugCart).forEach(([id, qty]) => {
     const p = suggestedProducts.find(x => x.id === id);
     if (p) cartItems.push({name: p.name, qty, price: p.price, isSug: true});
  });

  if (cartItems.length > 0) {
    rows.push(['<b style="color:var(--navy);margin-top:8px;display:block;">منتجات القرطاسية:</b>', '']);
    let allCartPrice = 0;
    cartItems.forEach(i => {
      const price = i.effective_price ?? i.price;
      const t = price * i.qty;
      allCartPrice += t;
      rows.push([`<span style="margin-right:10px;font-size:0.85rem">📦 ${esc(i.name)} × ${i.qty}</span>`, formatPrice(t)]);
    });
    rows.push(['<span style="margin-right:10px;font-size:0.85rem;color:var(--teal)">إجمالي تكلفة القرطاسية</span>', `<b style="color:var(--teal)">${formatPrice(allCartPrice)}</b>`]);
  }

  rows.push(['<b style="color:var(--navy);margin-top:8px;display:block;">التوصيل والخصم:</b>', '']);
  rows.push(['<span style="font-size:0.85rem;margin-right:10px;">🚚 رسوم التوصيل</span>', totals.deliveryFee === 0 ? '<b style="color:var(--green)">🎁 مجاني</b>' : formatPrice(totals.deliveryFee)]);
  if (totals.discount > 0) rows.push(['<span style="font-size:0.85rem;margin-right:10px;">💎 قيمة الخصم</span>', '<b style="color:var(--red)">- ' + formatPrice(totals.discount) + '</b>']);

  document.getElementById('invdet').innerHTML = rows
    .map(([l, v]) => `<div style="display:flex;justify-content:space-between;margin-bottom:10px;font-size:.95rem;opacity:.9;"><span>${l}</span><b>${v}</b></div>`)
    .join('');
  document.getElementById('totlbl').textContent = `المجموع النهائي: ${formatPrice(totals.total)}`;
}



async function uploadWithRetry(file, userId, onProgress, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await uploadFile(file.file, userId, onProgress)
    } catch (err) {
      if (attempt === maxRetries) throw err
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
      showToast(`⚠️ إعادة رفع ${file.name} (${attempt + 1}/${maxRetries})...`, 'info')
    }
  }
}

async function sendOrder() {
  const errEl = document.getElementById('errbox');
  errEl.style.display = 'none';

  try {
    const files = customerState.get('files') ?? [];
    const userId = customerState.get('user')?.id ?? 'guest';
    const pcon = document.getElementById('pcon');
    const pbar = document.getElementById('pbar');
    const stxt = document.getElementById('statustxt');

    if (files.length) {
      pcon.style.display = 'block';
      stxt.style.display = 'block';
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f.uploadedUrl) continue;
        stxt.textContent = `جاري رفع ${f.name} (${i + 1}/${files.length})...`;
        pbar.style.width = `${((i) / files.length) * 100}%`;
        try {
          const url = await uploadWithRetry(f, userId, pct => {
            pbar.style.width = `${((i + pct / 100) / files.length) * 100}%`;
          });
          f.uploadedUrl = url;
        } catch (uploadErr) {
          throw new Error(`فشل رفع الملف ${f.name}: ${uploadErr.message}`);
        }
      }
      pbar.style.width = '100%';
      stxt.textContent = '✅ تم رفع جميع الملفات';
      customerState.set('files', [...files]);
    }

    const pricing = customerState.get('pricing') ?? Config.DEFAULT_PRICING;
    const totals = calcOrderTotals({
      files: customerState.get('files') ?? [],
      cart: customerState.get('cart') ?? [],
      sugCart: customerState.get('suggestedCart') ?? {},
      pricing, coupon: customerState.get('appliedCoupon'),
      user: customerState.get('user'),
    });

    const orderId = await submitOrder({
      name: document.getElementById('uName').value,
      phone: document.getElementById('uPhone').value,
      region: document.getElementById('uRegion').value,
      notes: document.getElementById('uNotes').value,
      locationUrl: customerState.get('locationUrl'),
    });

    pcon.style.display = 'none';
    stxt.style.display = 'none';

    const region = document.getElementById('uRegion').value.trim();
    if (region) {
      const saved = JSON.parse(localStorage.getItem(Config.APP.STORAGE_KEYS.SAVED_ADDRESSES) || '[]');
      const updated = [region, ...saved.filter(a => a !== region)].slice(0, Config.APP.MAX_SAVED_ADDRESSES);
      localStorage.setItem(Config.APP.STORAGE_KEYS.SAVED_ADDRESSES, JSON.stringify(updated));
    }

    customerState.set('hideHomeTracking', false);
    populateSuccessDetails();
    customerState.set('files', []);
    customerState.set('cart', []);
    customerState.set('suggestedCart', {});
    customerState.set('appliedCoupon', null);
    customerState.set('locationUrl', '');
    customerState.set('express', false);
    customerState.set('packaging', 'none');
    renderFileList();
    updateCartBadge();
    updateSummaryBar();
    stepper.reset();

    // Show Success Overlay
    const orderIdShort = orderId.length > 8 ? orderId.slice(0, 8) : orderId;
    document.getElementById('success-order-id').textContent = '#' + orderIdShort;
    document.getElementById('success-order-total').textContent = formatPrice(totals.total);
    document.getElementById('success-order-addr').textContent = document.getElementById('uRegion').value || 'استلام من المركز';
    document.getElementById('success-order-status').textContent = 'مستلم 📥';
    updateSuccessTracking('received');
    document.getElementById('success-overlay').classList.add('open');
    window.Telegram?.WebApp?.MainButton?.hide();
    
    // Refresh orders in background
    loadOrders();
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
  } catch (e) {
    const pcon = document.getElementById('pcon');
    const stxt = document.getElementById('statustxt');
    pcon.style.display = 'none';
    stxt.style.display = 'none';
    errEl.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:10px;">
        <span style="font-size:1.3rem;flex-shrink:0;">❌</span>
        <div>
          <b style="display:block;margin-bottom:4px;">حدث خطأ</b>
          <span style="font-weight:500;">${friendlyError(e.message)}</span>
        </div>
      </div>`;
    errEl.style.display = 'block';
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error');
  }
}

function bindCart() {
  document.getElementById('cart-fab')?.addEventListener('click', openCartDrawer);
  document.getElementById('open-cart-btn')?.addEventListener('click', openCartDrawer);
  document.getElementById('mkt-bar-checkout-btn')?.addEventListener('click', openCartDrawer);
  document.getElementById('cart-close')?.addEventListener('click', () => document.getElementById('cart-drawer')?.classList.remove('open'));
  document.getElementById('add-more-market-btn')?.addEventListener('click', () => goTab('market'));
  document.getElementById('checkout-btn')?.addEventListener('click', () => withLoading('checkout-btn', checkoutMarket));

  QtyControl.delegate(document.getElementById('cart-items-list'), (id, delta) => {
    const cart = customerState.get('cart') ?? [];
    const item = cart.find(i => i.id === id);
    if (!item) return;
    item.qty = Math.max(0, (item.qty ?? 1) + delta);
    if (item.qty === 0) customerState.set('cart', cart.filter(i => i.id !== id));
    else customerState.set('cart', [...cart]);
    renderCart();
  });

  // Handle direct item deletion
  document.getElementById('cart-items-list')?.addEventListener('click', e => {
    const btn = e.target.closest('.delete-cart-item-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const cart = customerState.get('cart') ?? [];
    customerState.set('cart', cart.filter(i => i.id !== id));
    renderCart();
  });
}

function openCartDrawer() {
  const activeUser = customerState.get('user');
  if (activeUser) {
    const nameEl = document.getElementById('cart-name');
    const phoneEl = document.getElementById('cart-phone');
    if (nameEl && !nameEl.value) nameEl.value = (activeUser.name || activeUser.first_name || '').trim();
    if (phoneEl && !phoneEl.value && activeUser.phone) phoneEl.value = activeUser.phone;
  }
  document.getElementById('cart-drawer')?.classList.add('open');
}

function addToCart(product, selectedOptions = null) {
  let variants = product.variants ?? [];
  if (typeof variants === 'string') {
    try { variants = JSON.parse(variants); } catch (e) { variants = []; }
  }
  if (!Array.isArray(variants)) variants = [];
  const hasVariants = variants.length > 0;

  // If product has variants and no options selected yet, open picker
  if (hasVariants && !selectedOptions) {
    openVariantPicker({ ...product, variants });
    return;
  }

  const cart = customerState.get('cart') ?? [];
  // Create a unique key combining product id + selected options for variants
  const optionsKey = selectedOptions ? JSON.stringify(selectedOptions) : '';
  const existing = cart.find(i => i.id === product.id && (JSON.stringify(i.selected_options ?? '') === (optionsKey || JSON.stringify(''))));
  if (existing) {
    existing.qty = Math.min(existing.qty + 1, product.stock);
  } else {
    const effectivePrice = (product.discount && product.discount > 0)
      ? Math.max(0, product.price - product.discount)
      : (product.effective_price ?? product.price);
    cart.push({ ...product, qty: 1, effective_price: effectivePrice, selected_options: selectedOptions || null });
  }
  customerState.set('cart', [...cart]);
  renderCart();
  updateCartBadge();
  updateUnifiedCart();
  showToast('✅ أُضيف للسلة', 'success');
  window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
}

function openVariantPicker(product) {
  let variants = product.variants ?? [];
  if (typeof variants === 'string') {
    try { variants = JSON.parse(variants); } catch (e) { variants = []; }
  }
  if (!Array.isArray(variants)) variants = [];

  customerState.set('_vpProduct', { ...product, variants });
  document.getElementById('vp-product-name').textContent = product.name;
  document.getElementById('vp-error').style.display = 'none';
  const container = document.getElementById('vp-options-container');
  container.innerHTML = variants.map((vg, idx) => `
    <div class="vp-group" data-vg-idx="${idx}" style="margin-bottom:12px;">
      <label style="font-size:.85rem;font-weight:800;color:var(--navy);display:block;margin-bottom:6px;">
        ${esc(vg.name)} ${vg.required ? '<span style="color:var(--red);">*</span>' : '<span style="font-size:.72rem;color:var(--text-muted);font-weight:500;">(اختياري)</span>'}
      </label>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${(vg.options || []).map(opt => `
          <button type="button" class="vp-opt-btn" data-vg-name="${esc(vg.name)}" data-opt="${esc(opt)}"
            style="border:2px solid var(--border-soft);background:var(--card);color:var(--navy);padding:7px 14px;border-radius:var(--radius-full);font-weight:700;cursor:pointer;font-family:var(--font-main);font-size:.82rem;transition:all .2s;">
            ${esc(opt)}
          </button>
        `).join('')}
      </div>
    </div>
  `).join('');

  // Bind option button clicks
  container.querySelectorAll('.vp-opt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const groupName = btn.dataset.vgName;
      // Deselect others in same group
      container.querySelectorAll(`.vp-opt-btn[data-vg-name="${groupName}"]`).forEach(b => {
        b.style.background = 'var(--card)';
        b.style.borderColor = 'var(--border-soft)';
        b.style.color = 'var(--navy)';
        b.classList.remove('selected');
      });
      // Select this one
      btn.style.background = 'var(--teal)';
      btn.style.borderColor = 'var(--teal)';
      btn.style.color = '#fff';
      btn.classList.add('selected');
    });
  });

  Modal.open('variant-picker-modal');
}

function renderCart() {
  const cart = customerState.get('cart') ?? [];
  const pricing = customerState.get('pricing') ?? Config.DEFAULT_PRICING;
  const itemsEl = document.getElementById('cart-items-list');
  const checkEl = document.getElementById('cart-checkout-area');

  if (!cart.length) {
    itemsEl.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;"><div style="font-size:3rem;opacity:.3;">🛒</div><p>السلة فارغة</p></div>';
    checkEl.style.display = 'none';
    return;
  }

  itemsEl.innerHTML = cart.map(i => {
    const optionsHtml = i.selected_options
      ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;">${Object.entries(i.selected_options).map(([k, v]) => `<span style="font-size:.68rem;background:var(--input-bg);color:var(--navy);padding:2px 7px;border-radius:var(--radius-full);font-weight:700;">${esc(k)}: ${esc(v)}</span>`).join('')}</div>`
      : '';
    return `
    <div class="cart-item" style="gap: 12px;">
      <div style="flex: 1;">
        <b style="font-size:.9rem;color:var(--navy);">${esc(i.name)}</b>
        ${optionsHtml}
        <p style="margin:2px 0 0;font-size:.78rem;color:var(--text-muted);">${formatPrice(i.effective_price ?? i.price)} / ${esc(i.unit ?? 'قطعة')}</p>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        ${QtyControl.html({ id: i.id, value: i.qty, min: 0, max: i.stock })}
        <button class="delete-cart-item-btn" data-id="${i.id}" style="background:none; border:none; color:#ef4444; font-size:1.1rem; cursor:pointer; padding:4px; transition:color 0.2s;" title="حذف المنتج">🗑️</button>
      </div>
    </div>`;
  }).join('');

  checkEl.style.display = 'block';
  const sub = cart.reduce((s, i) => s + (i.effective_price ?? i.price) * i.qty, 0);
  const del = sub >= pricing.delivery_free_threshold ? 0 : pricing.delivery_fee;
  const roundedGrandTotal = Math.round((sub + del) / 250) * 250;
  document.getElementById('cart-items-total').textContent = formatPrice(sub);
  document.getElementById('cart-del-fee').textContent = del === 0 ? '🎁 مجاني' : formatPrice(del);
  document.getElementById('cart-grand-total').textContent = formatPrice(roundedGrandTotal);
  updateCartBadge();
}

function updateCartBadge() {
  const cart = customerState.get('cart') ?? [];
  const count = cart.reduce((s, i) => s + (i.qty ?? 1), 0);
  const sub = cart.reduce((s, i) => s + (i.effective_price ?? i.price) * (i.qty ?? 1), 0);

  const badges = ['cart-count', 'nav-cart-badge', 'mkt-badge'];
  badges.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = count || '';
    el.style.display = count > 0 ? '' : 'none';
  });
  const fab = document.getElementById('cart-fab');
  if (fab) fab.style.display = count > 0 ? 'flex' : 'none';

  // Update PDP cart badge
  const pdpBadge = document.getElementById('pdp-cart-badge');
  if (pdpBadge) {
    pdpBadge.textContent = count || '';
    pdpBadge.style.display = count > 0 ? 'flex' : 'none';
  }

  // Update floating market cart bar
  const mktBar = document.getElementById('mkt-floating-cart-bar');
  if (mktBar) {
    mktBar.style.display = count > 0 ? 'flex' : 'none';
    const mktCount = document.getElementById('mkt-bar-count');
    const mktTotal = document.getElementById('mkt-bar-total');
    if (mktCount) mktCount.textContent = count;
    if (mktTotal) mktTotal.textContent = formatPrice(sub);
  }
}

function updatePrintBadge(files) {
  const count = (files ?? []).length;
  const badge = document.getElementById('print-badge');
  if (badge) {
    badge.textContent = count || '';
    badge.style.display = count > 0 ? '' : 'none';
  }
  const banner = document.getElementById('pending-files-banner');
  const bannerText = document.getElementById('pending-files-banner-text');
  if (banner) {
    if (count > 0) {
      banner.style.display = 'flex';
      if (bannerText) {
        bannerText.textContent = `اضغط هنا لمتابعة إرسال ${count} ملف/صورة معلقة.`;
      }
    } else {
      banner.style.display = 'none';
    }
  }
}

function updateUnifiedCart() {
  const cart = customerState.get('cart') ?? [];
  const sugCart = customerState.get('suggestedCart') ?? {};
  const suggests = customerState.get('suggestedProducts') ?? [];

  const sec = document.getElementById('unified-cart-section');
  const list = document.getElementById('unified-cart-items');

  const allItems = cart.map(i => ({ ...i, isSug: false }));
  for (const [id, qty] of Object.entries(sugCart)) {
    const p = suggests.find(x => x.id === id);
    if (p) allItems.push({ ...p, qty, effective_price: p.price, isSug: true });
  }

  if (!allItems.length) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';

  list.innerHTML = allItems.map(i => `
    <div style="display:flex;justify-content:space-between;align-items:center;font-size:.85rem;padding:8px 0;border-bottom:1px solid var(--border-soft);">
      <div style="display:flex;align-items:center;gap:8px;">
        <button class="delete-addon-btn" data-id="${i.id}" data-sug="${!!i.isSug}" 
          style="border:none;background:#fef2f2;color:var(--red);width:26px;height:26px;border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:0.8rem;transition:all var(--transition-fast);" title="حذف">
          🗑️
        </button>
        <span style="font-weight:700;color:var(--navy);">${esc(i.name)} <span style="color:var(--text-muted);font-weight:500;">× ${i.qty}</span></span>
      </div>
      <b style="color:var(--teal);font-weight:800;">${formatPrice((i.effective_price ?? i.price) * i.qty)}</b>
    </div>`).join('');

  list.querySelectorAll('.delete-addon-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const isSug = btn.dataset.sug === 'true';
      if (isSug) {
        const sug = customerState.get('suggestedCart') ?? {};
        delete sug[id];
        customerState.set('suggestedCart', { ...sug });
      } else {
        const c = customerState.get('cart') ?? [];
        customerState.set('cart', c.filter(x => x.id !== id));
      }
      renderCart();
      updateCartBadge();
      updateUnifiedCart();
      updateInvoice();
      showToast('🗑️ تم إزالة الإضافة بنجاح', 'success');
    });
  });

  const total = allItems.reduce((s, i) => s + (i.effective_price ?? i.price) * i.qty, 0);
  document.getElementById('ucart-subtotal').textContent = formatPrice(total);
  updateStep3Summary();
}

async function checkoutMarket() {
  const errEl = document.getElementById('cart-err');
  errEl.style.display = 'none';
  const name = document.getElementById('cart-name').value;
  const phone = document.getElementById('cart-phone').value;
  const region = document.getElementById('cart-region').value;

  if (!isValidName(name)) { errEl.textContent = '❌ يرجى إدخال الاسم الكامل'; errEl.style.display = 'block'; return; }
  if (!isValidIraqiPhone(phone)) { errEl.textContent = '❌ رقم الهاتف غير صحيح'; errEl.style.display = 'block'; return; }
  if (!region?.trim()) { errEl.textContent = '❌ يرجى إدخال المنطقة'; errEl.style.display = 'block'; return; }

  const files = customerState.get('files') ?? [];
  if (files.length > 0) {
    errEl.textContent = '❌ لديك ملفات قيد الانتظار للطباعة. يرجى إتمام الطلب من صفحة التأكيد النهائية لضمان رفع الملفات بنجاح.';
    errEl.style.display = 'block';
    return;
  }

  try {
    const pricing = customerState.get('pricing') ?? Config.DEFAULT_PRICING;
    const totals = calcOrderTotals({
      files: [],
      cart: customerState.get('cart') ?? [],
      sugCart: {},
      pricing,
      coupon: customerState.get('appliedCoupon'),
      user: customerState.get('user')
    });

    const orderId = await submitOrder({ name, phone, region, notes: document.getElementById('cart-notes').value });
    document.getElementById('cart-drawer').classList.remove('open');

    customerState.set('hideHomeTracking', false);
    populateSuccessDetails();
    customerState.set('cart', []);
    renderCart();
    updateCartBadge();

    // Show Success Screen
    const orderIdShort = orderId.length > 8 ? orderId.slice(0, 8) : orderId;
    document.getElementById('success-order-id').textContent = '#' + orderIdShort;
    document.getElementById('success-order-total').textContent = formatPrice(totals.total);
    document.getElementById('success-order-addr').textContent = region || 'استلام من المركز';
    document.getElementById('success-order-status').textContent = 'مستلم 📥';
    updateSuccessTracking('received');
    document.getElementById('success-overlay').classList.add('open');
    window.Telegram?.WebApp?.MainButton?.hide();

    await loadOrders();
  } catch (e) {
    errEl.textContent = '❌ ' + e.message;
    errEl.style.display = 'block';
  }
}

async function bindMarket() {
  const searchEl = document.getElementById('mkt-search');
  searchEl.addEventListener('input', debounce(filterMktProducts, 300));

  document.getElementById('mkt-cat-bar').addEventListener('click', e => {
    const btn = e.target.closest('.filter-tab[data-cat]');
    if (!btn) return;
    document.querySelectorAll('#mkt-cat-bar .filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    customerState.set('marketFilter', btn.dataset.cat);
    filterMktProducts();
  });

  // Variant picker modal bindings
  document.getElementById('vp-cancel-btn')?.addEventListener('click', () => Modal.close('variant-picker-modal'));
  document.getElementById('vp-confirm-btn')?.addEventListener('click', () => {
    const product = customerState.get('_vpProduct');
    if (!product) return;
    const variants = product.variants ?? [];
    const selected = {};
    const errEl = document.getElementById('vp-error');
    errEl.style.display = 'none';

    for (const vg of variants) {
      const btn = document.querySelector(`.vp-opt-btn[data-vg-name="${vg.name}"].selected`);
      if (btn) {
        selected[vg.name] = btn.dataset.opt;
      } else if (vg.required) {
        errEl.textContent = `❌ يرجى اختيار ${vg.name}`;
        errEl.style.display = 'block';
        return;
      }
    }

    Modal.close('variant-picker-modal');
    addToCart(product, Object.keys(selected).length > 0 ? selected : null);
  });

  // PDP Header bindings
  document.getElementById('pdp-back')?.addEventListener('click', closeProductDetailPage);
  document.getElementById('pdp-cart-btn')?.addEventListener('click', () => {
    closeProductDetailPage();
    openCartDrawer();
  });
}

function showProductDetailPage(product) {
  if (!product) return;
  
  let variants = product.variants ?? [];
  if (typeof variants === 'string') {
    try { variants = JSON.parse(variants); } catch (e) { variants = []; }
  }
  if (!Array.isArray(variants)) variants = [];
  const normalizedProduct = { ...product, variants };
  customerState.set('_currentPdpProduct', normalizedProduct);
  
  const page = document.getElementById('product-detail-page');
  const titleEl = document.getElementById('pdp-title');
  const contentEl = document.getElementById('pdp-content');
  if (titleEl) titleEl.textContent = product.name;

  const images = (product.image_url || '').split(',').map(s => s.trim()).filter(Boolean);
  const hasMultipleImages = images.length > 1;
  const hasDiscount = product.discount && product.discount > 0;
  const effectivePrice = hasDiscount ? Math.max(0, product.price - product.discount) : (product.effective_price ?? product.price);
  const categoryLabels = {
    notebooks: '📓 دفاتر',
    books: '📚 كتب',
    stationery: '✏️ قرطاسية',
    other: '📦 أخرى'
  };
  const catLabel = categoryLabels[product.category] || '📦 منتج';

  // Check if item already in cart
  const cart = customerState.get('cart') ?? [];
  const inCartItem = cart.find(i => i.id === product.id);
  let initialQty = inCartItem ? inCartItem.qty : 1;

  contentEl.innerHTML = `
    <!-- معرض الصور -->
    <div class="pdp-gallery-wrap" style="position:relative;margin-bottom:16px;">
      <div id="pdp-main-img-box" style="width:100%;height:240px;border-radius:var(--radius-lg);background:#f8fafc;display:flex;align-items:center;justify-content:center;overflow:hidden;border:1.5px solid var(--border-soft);box-shadow:var(--shadow-sm);position:relative;">
        ${images.length > 0
          ? `<img id="pdp-active-img" src="${esc(images[0])}" alt="${esc(product.name)}" style="width:100%;height:100%;object-fit:contain;transition:opacity 0.25s ease;">`
          : `<span style="font-size:4.5rem;opacity:0.3;">📦</span>`
        }
        ${hasMultipleImages
          ? `<span id="pdp-img-counter" style="position:absolute;bottom:10px;left:10px;background:rgba(13,59,102,0.85);backdrop-filter:blur(4px);color:#fff;padding:3px 10px;border-radius:var(--radius-full);font-size:0.75rem;font-weight:700;">📷 1/${images.length}</span>`
          : ''
        }
      </div>
      ${hasMultipleImages ? `
        <div class="pdp-thumbnails" style="display:flex;gap:8px;margin-top:10px;overflow-x:auto;padding-bottom:4px;">
          ${images.map((img, idx) => `
            <div class="pdp-thumb ${idx === 0 ? 'active' : ''}" data-idx="${idx}" data-src="${esc(img)}"
              style="width:58px;height:58px;border-radius:var(--radius-sm);background:#fff;border:2px solid ${idx === 0 ? 'var(--teal)' : 'var(--border-soft)'};overflow:hidden;cursor:pointer;flex-shrink:0;transition:all 0.2s;">
              <img src="${esc(img)}" alt="صورة ${idx + 1}" style="width:100%;height:100%;object-fit:cover;">
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>

    <!-- معلومات المنتج والأسعار -->
    <div style="margin-bottom:16px;padding:18px;background:var(--card);border:1.5px solid var(--border-soft);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:10px;">
        <span style="font-size:0.75rem;background:rgba(20,184,166,0.12);color:var(--teal);padding:4px 10px;border-radius:var(--radius-full);font-weight:800;">
          ${catLabel}
        </span>
        ${product.is_suggested ? `<span style="font-size:0.72rem;background:var(--teal);color:#fff;padding:3px 8px;border-radius:var(--radius-full);font-weight:800;">🌟 مقترح</span>` : ''}
        ${product.stock <= (product.min_stock ?? 3)
          ? `<span style="font-size:0.72rem;background:#fef2f2;color:var(--red);padding:3px 8px;border-radius:var(--radius-full);font-weight:800;">⚠️ متبقي ${product.stock} فقط</span>`
          : `<span style="font-size:0.72rem;background:#f0fdf4;color:var(--green);padding:3px 8px;border-radius:var(--radius-full);font-weight:800;">✅ متوفر بالمخزن</span>`
        }
      </div>

      <h1 style="color:var(--navy);font-size:1.3rem;font-weight:900;margin:0 0 12px;line-height:1.4;">${esc(product.name)}</h1>

      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px;">
        <span style="font-size:1.55rem;font-weight:900;color:var(--orange);font-family:'Plus Jakarta Sans',sans-serif;">${formatPrice(effectivePrice)}</span>
        ${hasDiscount ? `<span style="text-decoration:line-through;color:var(--text-muted);font-size:0.95rem;opacity:0.6;">${formatPrice(product.price)}</span>` : ''}
        <span style="font-size:0.85rem;color:var(--text-muted);font-weight:600;">/ ${esc(product.unit ?? 'قطعة')}</span>
      </div>

      ${hasDiscount ? `<div style="display:inline-block;background:#fef3c7;color:#92400e;padding:4px 10px;border-radius:var(--radius-sm);font-size:0.78rem;font-weight:800;margin-top:4px;">🎉 وفرت ${formatPrice(product.discount)} على هذا المنتج</div>` : ''}
    </div>

    <!-- بطاقة وصف المنتج البارزة -->
    <div style="margin-bottom:16px;padding:18px;background:#f8fafc;border:1.5px solid #e2e8f0;border-right:5px solid var(--teal);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm);">
      <div style="font-weight:800;color:var(--navy);font-size:0.98rem;margin-bottom:10px;display:flex;align-items:center;gap:8px;">
        <span style="font-size:1.15rem;">📝</span>
        <span>وصف وتفاصيل المنتج:</span>
      </div>
      <div style="font-size:0.92rem;color:#334155;line-height:1.8;white-space:pre-wrap;font-weight:500;">
        ${product.description ? esc(product.description) : '<span style="color:var(--text-muted);font-size:0.85rem;">لا يوجد وصف إضافي متوفر لهذا المنتج.</span>'}
      </div>
    </div>

    <!-- بطاقة خيارات وتخصيصات المنتج -->
    ${(variants.length > 0) ? `
      <div style="margin-bottom:16px;padding:18px;background:#faf5ff;border:1.5px solid #e9d5ff;border-right:5px solid #8b5cf6;border-radius:var(--radius-lg);box-shadow:var(--shadow-sm);">
        <div style="font-weight:800;color:#5b21b6;font-size:0.98rem;margin-bottom:12px;display:flex;align-items:center;gap:8px;">
          <span style="font-size:1.15rem;">🎨</span>
          <span>اختر المواصفات والتفاصيل:</span>
        </div>
        <div id="pdp-variants-container">
          ${variants.map((vg, idx) => `
            <div class="pdp-vg-group" data-vg-name="${esc(vg.name)}" data-vg-required="${vg.required ? 'true' : 'false'}" style="margin-bottom:14px;">
              <label style="font-size:0.88rem;font-weight:800;color:var(--navy);display:block;margin-bottom:8px;">
                ${esc(vg.name)}: ${vg.required ? '<span style="color:var(--red);font-weight:900;">* (إلزامي)</span>' : '<span style="font-size:0.75rem;color:var(--text-muted);font-weight:500;">(اختياري)</span>'}
              </label>
              <div style="display:flex;flex-wrap:wrap;gap:8px;">
                ${(vg.options || []).map(opt => `
                  <button type="button" class="pdp-opt-btn" data-vg-name="${esc(vg.name)}" data-opt="${esc(opt)}"
                    style="border:2px solid #ddd6fe;background:#fff;color:var(--navy);padding:8px 16px;border-radius:var(--radius-full);font-weight:700;cursor:pointer;font-family:var(--font-main);font-size:0.85rem;transition:all 0.2s;">
                    ${esc(opt)}
                  </button>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
        <div id="pdp-var-error" style="display:none;color:var(--red);font-size:0.85rem;font-weight:800;margin-top:8px;"></div>
      </div>
    ` : ''}

    <!-- شريط الإضافة للسلة الثابت أسفل صفحة المنتج -->
    <div style="position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:600px;background:rgba(255,255,255,0.96);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-top:1.5px solid var(--border-soft);padding:14px 18px;box-shadow:0 -6px 25px rgba(0,0,0,0.12);z-index:350;display:flex;align-items:center;gap:12px;">
      <!-- عداد الكمية -->
      <div style="display:flex;align-items:center;background:var(--input-bg);border:1.5px solid var(--border-soft);border-radius:var(--radius-md);overflow:hidden;height:46px;">
        <button id="pdp-qty-minus" style="border:none;background:none;width:38px;height:100%;cursor:pointer;font-size:1.2rem;font-weight:900;color:var(--navy);display:flex;align-items:center;justify-content:center;">−</button>
        <span id="pdp-qty-val" style="min-width:34px;text-align:center;font-weight:900;font-size:1rem;color:var(--navy);">${initialQty}</span>
        <button id="pdp-qty-plus" style="border:none;background:none;width:38px;height:100%;cursor:pointer;font-size:1.2rem;font-weight:900;color:var(--navy);display:flex;align-items:center;justify-content:center;">+</button>
      </div>

      <!-- زر الإضافة -->
      <button id="pdp-add-btn" class="btn-primary" style="flex:1;height:46px;background:var(--grad-navy);color:#fff;border:none;border-radius:var(--radius-md);font-weight:800;font-size:0.95rem;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 14px rgba(13,59,102,0.25);">
        <span>🛒 أضف للسلة</span>
        <span style="opacity:0.8;font-size:0.85rem;">•</span>
        <span id="pdp-btn-total">${formatPrice(effectivePrice * initialQty)}</span>
      </button>
    </div>
  `;

  // Bind thumbnails click
  contentEl.querySelectorAll('.pdp-thumb').forEach(thumb => {
    thumb.addEventListener('click', () => {
      const src = thumb.dataset.src;
      const idx = Number(thumb.dataset.idx) + 1;
      const activeImg = document.getElementById('pdp-active-img');
      if (activeImg) {
        activeImg.style.opacity = '0';
        setTimeout(() => {
          activeImg.src = src;
          activeImg.style.opacity = '1';
        }, 150);
      }
      const counter = document.getElementById('pdp-img-counter');
      if (counter) counter.textContent = `📷 ${idx}/${images.length}`;

      contentEl.querySelectorAll('.pdp-thumb').forEach(t => {
        t.style.borderColor = 'var(--border-soft)';
        t.classList.remove('active');
      });
      thumb.style.borderColor = 'var(--teal)';
      thumb.classList.add('active');
    });
  });

  // Bind option buttons click
  contentEl.querySelectorAll('.pdp-opt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const groupName = btn.dataset.vgName;
      contentEl.querySelectorAll(`.pdp-opt-btn[data-vg-name="${groupName}"]`).forEach(b => {
        b.style.background = 'var(--input-bg)';
        b.style.borderColor = 'var(--border-soft)';
        b.style.color = 'var(--navy)';
        b.classList.remove('selected');
      });
      btn.style.background = 'var(--teal)';
      btn.style.borderColor = 'var(--teal)';
      btn.style.color = '#fff';
      btn.classList.add('selected');
      const errEl = document.getElementById('pdp-var-error');
      if (errEl) errEl.style.display = 'none';
    });
  });

  // Quantity controls
  let qty = initialQty;
  const qtyValEl = document.getElementById('pdp-qty-val');
  const btnTotalEl = document.getElementById('pdp-btn-total');
  const minusBtn = document.getElementById('pdp-qty-minus');
  const plusBtn = document.getElementById('pdp-qty-plus');

  minusBtn?.addEventListener('click', () => {
    if (qty > 1) {
      qty--;
      if (qtyValEl) qtyValEl.textContent = qty;
      if (btnTotalEl) btnTotalEl.textContent = formatPrice(effectivePrice * qty);
    }
  });

  plusBtn?.addEventListener('click', () => {
    if (qty < product.stock) {
      qty++;
      if (qtyValEl) qtyValEl.textContent = qty;
      if (btnTotalEl) btnTotalEl.textContent = formatPrice(effectivePrice * qty);
    } else {
      showToast(`⚠️ أقصى كمية متوفرة هي ${product.stock}`, 'warning');
    }
  });

  // Add to cart button
  document.getElementById('pdp-add-btn')?.addEventListener('click', () => {
    const variants = product.variants ?? [];
    const selected = {};
    const errEl = document.getElementById('pdp-var-error');
    if (errEl) errEl.style.display = 'none';

    for (const vg of variants) {
      const selectedBtn = contentEl.querySelector(`.pdp-opt-btn[data-vg-name="${vg.name}"].selected`);
      if (selectedBtn) {
        selected[vg.name] = selectedBtn.dataset.opt;
      } else if (vg.required) {
        if (errEl) {
          errEl.textContent = `❌ يرجى تحديد ${vg.name}`;
          errEl.style.display = 'block';
        }
        showToast(`❌ يرجى تحديد ${vg.name}`, 'error');
        return;
      }
    }

    const selectedOptions = Object.keys(selected).length > 0 ? selected : null;
    
    // Add multiple quantity
    const cart = customerState.get('cart') ?? [];
    const optionsKey = selectedOptions ? JSON.stringify(selectedOptions) : '';
    const existing = cart.find(i => i.id === product.id && (JSON.stringify(i.selected_options ?? '') === (optionsKey || JSON.stringify(''))));
    if (existing) {
      existing.qty = Math.min(existing.qty + qty, product.stock);
    } else {
      cart.push({ ...product, qty, effective_price: effectivePrice, selected_options: selectedOptions });
    }
    customerState.set('cart', [...cart]);
    renderCart();
    updateCartBadge();
    updateUnifiedCart();
    showToast(`✅ تمت إضافة ${qty} × ${product.name} إلى السلة`, 'success');
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium');

    // Update PDP button text to show added
    const addBtn = document.getElementById('pdp-add-btn');
    if (addBtn) {
      addBtn.innerHTML = `<span>✅ تم التحديث في السلة</span> • <span>${formatPrice(effectivePrice * qty)}</span>`;
      addBtn.style.background = 'var(--grad-success)';
      setTimeout(() => {
        if (document.getElementById('pdp-add-btn')) {
          document.getElementById('pdp-add-btn').innerHTML = `<span>🛒 أضف للسلة</span> • <span>${formatPrice(effectivePrice * qty)}</span>`;
          document.getElementById('pdp-add-btn').style.background = 'var(--grad-navy)';
        }
      }, 2000);
    }
  });

  // Open PDP
  page.style.display = 'block';
  window.Telegram?.WebApp?.BackButton?.show();
}

function closeProductDetailPage() {
  const page = document.getElementById('product-detail-page');
  if (page) page.style.display = 'none';
  const currentStep = customerState.get('currentStep') ?? 1;
  if (currentStep <= 1) {
    window.Telegram?.WebApp?.BackButton?.hide();
  }
}

async function loadMktProducts() {
  const grid = document.getElementById('mkt-products-grid');
  grid.style.display = 'grid';
  grid.innerHTML = renderSkeletonProducts(4);
  try {
    const products = await fetchActiveProducts();
    customerState.set('mktProducts', products);
    filterMktProducts();
  } catch (e) {
    grid.innerHTML = renderEmptyState({
      icon: '📡',
      title: 'تعذّر تحميل المنتجات',
      subtitle: friendlyError(e.message),
      btnText: '🔄 إعادة المحاولة',
      btnAction: 'this.closest(".empty-state").remove(); loadMktProducts()'
    });
  }
}

function filterMktProducts() {
  const products = customerState.get('mktProducts') ?? [];
  const cat = customerState.get('marketFilter') ?? 'all';
  const search = document.getElementById('mkt-search').value.toLowerCase().trim();
  const cart = customerState.get('cart') ?? [];

  const filtered = products.filter(p =>
    (cat === 'all' || p.category === cat) &&
    (!search || p.name.toLowerCase().includes(search))
  );

  const grid = document.getElementById('mkt-products-grid');
  if (!filtered.length) {
    grid.innerHTML = renderEmptyState({
      icon: '🛒',
      title: 'لا توجد منتجات',
      subtitle: 'جرب تغيير الفلتر أو البحث بكلمة أخرى',
      btnText: 'عرض الكل',
      btnAction: `document.querySelector('#mkt-cat-bar .filter-tab').click()`
    });
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const inCart = cart.find(i => i.id === p.id);
    const hasDiscount = p.discount && p.discount > 0;
    const displayPrice = hasDiscount ? Math.max(0, p.price - p.discount) : p.price;
    return `
      <div class="product-card" data-pid="${esc(p.id)}">
        <div class="product-img" style="display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:0;">
          ${p.image_url ? p.image_url.split(',').map(s=>s.trim()).filter(Boolean).map(u => 
            `<img src="${esc(u)}" alt="${esc(p.name)}" loading="lazy" style="flex:0 0 100%;width:100%;height:100%;object-fit:cover;scroll-snap-align:start;">`
          ).join('') : '📦'}
        </div>
        <b style="font-size:.92rem;display:block;margin-bottom:4px;color:var(--navy);">${esc(p.name)}</b>
        <span class="product-price">
          ${hasDiscount
        ? `<span style="text-decoration:line-through;opacity:.5;font-size:.78rem;">${formatPrice(p.price)}</span> <b style="color:var(--green);">${formatPrice(displayPrice)}</b>`
        : formatPrice(p.price)
      } / ${esc(p.unit ?? 'قطعة')}
        </span>
        <button class="btn-add-cart${inCart ? ' in-cart' : ''}" data-add-cart="${esc(p.id)}">
          ${inCart ? `✅ في السلة (${inCart.qty})` : '🛒 أضف للسلة'}
        </button>
        ${(p.variants?.length) ? '<div style="font-size:.68rem;text-align:center;color:#7c3aed;font-weight:700;margin-top:2px;">🎨 خيارات متوفرة</div>' : ''}
      </div>`;
  }).join('');

  grid.querySelectorAll('[data-add-cart]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const pid = btn.dataset.addCart;
      const product = products.find(p => p.id === pid);
      if (product) addToCart(product);
    });
  });

  // Click on product card opens PDP
  grid.querySelectorAll('.product-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('[data-add-cart]')) return;
      const pid = card.dataset.pid;
      const product = products.find(p => p.id === pid);
      if (product) showProductDetailPage(product);
    });
  });
}

async function loadOrders(isBackground = false) {
  const user = customerState.get('user');
  if (!user?.id) return;

  const box = document.getElementById('ordersbox');
  if (!isBackground) {
    box.innerHTML = renderSkeletonOrders(3);
  }

  try {
    const [orders, researchRequests] = await Promise.all([
      fetchUserOrders(user.id),
      sb.from(Config.TABLES.RESEARCH).select('*').eq('user_id', user.id).order('created_at', { ascending: false })
    ]);

    const unifiedOrders = [
      ...orders.map(o => ({ ...o, isResearch: false })),
      ...(researchRequests.data ?? []).map(r => ({ ...r, isResearch: true, total: 0 }))
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    customerState.set('allUserOrders', unifiedOrders);
    renderOrders();
  } catch (err) { 
    console.error('[loadOrders Error]', err);
    if (!isBackground) {
      box.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">📡</span>
          <h3 class="empty-state-title">تعذّر تحميل الطلبات</h3>
          <p class="empty-state-sub">${friendlyError(err.message)}</p>
          <button class="empty-state-btn" id="retry-orders-btn">🔄 إعادة المحاولة</button>
        </div>`;
      document.getElementById('retry-orders-btn')?.addEventListener('click', () => loadOrders(false));
    }
  }
}

// ═══════════════════════════════════════
//  FIX: renderOrders — NO addEventListener here
//  click is handled by delegation set up ONCE in bindPoints()
// ═══════════════════════════════════════
function renderOrders() {
  const orders = customerState.get('allUserOrders') ?? [];
  const filter = customerState.get('orderFilter') ?? 'all';
  const typeFilter = customerState.get('orderTypeFilter') ?? 'all';
  const active = ['received', 'printing', 'delivering', 'pending', 'ready', 'in_progress'];

  const filtered = orders.filter(o => {
    // 1. Status Filter
    if (filter === 'active') {
      if (!active.includes(o.status)) return false;
    } else if (filter === 'delivered') {
      if (o.status !== 'delivered' && o.status !== 'completed') return false;
    } else if (filter === 'cancelled') {
      if (o.status !== 'cancelled' && o.status !== 'rejected') return false;
    }

    // 2. Service Type Filter
    if (typeFilter !== 'all') {
      if (o.isResearch) {
        if (typeFilter !== 'research') return false;
      } else {
        const filesCount = o.files_data?.length ?? 0;
        const cartCount = o.cart_items?.length ?? 0;
        const type = filesCount && cartCount ? 'combined' : filesCount ? 'print' : 'market';
        
        if (typeFilter === 'print' && type !== 'print' && type !== 'combined') return false;
        if (typeFilter === 'market' && type !== 'market' && type !== 'combined') return false;
        if (typeFilter === 'research') return false;
      }
    }
    return true;
  });

  const box = document.getElementById('ordersbox');

  // Update Home Active Order Tracking Card / Banner (only for regular print/market orders)
  const activeStatuses = ['received', 'printing', 'delivering', 'pending', 'ready'];
  const activeOrder = orders.find(o => !o.isResearch && activeStatuses.includes(o.status));
  const homeBanner = document.getElementById('home-active-order-banner');
  
  if (activeOrder) {
    if (customerState.get('hideHomeTracking') === true) {
      if (homeBanner) {
        homeBanner.style.display = 'block';
        homeBanner.onclick = () => {
          customerState.set('hideHomeTracking', false);
          renderOrders();
        };
      }
      updateHomeOrderTrackingCard(null);
    } else {
      if (homeBanner) homeBanner.style.display = 'none';
      updateHomeOrderTrackingCard(activeOrder);
    }
  } else {
    if (homeBanner) homeBanner.style.display = 'none';
    updateHomeOrderTrackingCard(null);
  }

  if (!filtered.length) {
    box.innerHTML = renderEmptyState({
      icon: '📦',
      title: 'لا توجد طلبات بعد',
      subtitle: 'ابدأ طلبك الأول الآن وسنوصله إليك بأسرع وقت!',
      btnText: '➕ إنشاء طلب جديد',
      btnAction: `document.getElementById('nav-order')?.click()`
    });
    return;
  }

  const statusMap = Config.ORDER_STATUSES;
  const researchStatusMap = {
    pending: { label: 'معلق', css: 'sr', icon: '🕐' },
    in_progress: { label: 'قيد العمل', css: 'sp', icon: '⚙️' },
    completed: { label: 'مكتمل', css: 'sv', icon: '✅' },
    rejected: { label: 'مرفوض', css: 'sr', icon: '❌' }
  };

  box.innerHTML = filtered.map((o, idx) => {
    if (o.isResearch) {
      const s = researchStatusMap[o.status] ?? { label: o.status, css: 'sr', icon: '📝' };
      const accentColor = o.status === 'completed' ? 'var(--green)' : o.status === 'in_progress' ? 'var(--teal)' : o.status === 'rejected' ? 'var(--red)' : 'var(--orange)';
      return `
        <div class="ocard" data-oid="${esc(o.id)}" data-is-research="true" style="animation-delay:${idx * 45}ms; border-right: 4px solid ${accentColor};">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div>
              <b style="color:var(--navy);font-size:.9rem;">#${esc(o.id.slice(0, 8))}</b>
              <span style="font-size:.72rem;color:var(--text-muted);margin-right:6px;">📝 طلب بحث</span>
            </div>
            <span class="sbadge ${esc(s.css)}">${s.icon} ${s.label}</span>
          </div>
          <div style="font-weight:700; color:var(--navy); font-size:0.95rem; margin-bottom:6px;">${esc(o.type)} - ${esc(o.subject || o.title)}</div>
          <div style="font-size:.85rem;color:var(--text-muted);">
            📅 ${new Date(o.created_at).toLocaleDateString('ar-IQ')}
          </div>
        </div>`;
    } else {
      const s = statusMap[o.status] ?? { label: o.status, css: 'sr', icon: '📦' };
      const filesCount = o.files_data?.length ?? 0;
      const cartCount = o.cart_items?.length ?? 0;
      const typeLabel = filesCount && cartCount ? '🔀 مشترك' : filesCount ? '🖨️ استنساخ' : '📦 قرطاسية';
      return `
        <div class="ocard" data-oid="${esc(o.id)}" data-is-research="false" style="animation-delay:${idx * 45}ms;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div>
              <b style="color:var(--navy);font-size:.9rem;">#${esc(o.id.slice(0, 8))}</b>
              <span style="font-size:.72rem;color:var(--text-muted);margin-right:6px;">${typeLabel}</span>
            </div>
            <span class="sbadge ${esc(s.css)}">${s.icon} ${s.label}</span>
          </div>
          <div style="font-size:.85rem;color:var(--text-muted);">
            💰 ${formatPrice(o.total)} • ${new Date(o.created_at).toLocaleDateString('ar-IQ')}
          </div>
        </div>`;
    }
  }).join('');
}

function bindOrders() {
  document.getElementById('ordersbox').addEventListener('click', e => {
    const card = e.target.closest('.ocard[data-oid]');
    if (card) {
      const isResearch = card.dataset.isResearch === 'true';
      if (isResearch) {
        showResearchDetail(card.dataset.oid);
      } else {
        showOrderDetail(card.dataset.oid);
      }
    }
  });

  document.getElementById('orders-fbar').addEventListener('click', e => {
    const btn = e.target.closest('.filter-tab[data-filter]');
    if (!btn) return;
    document.querySelectorAll('#orders-fbar .filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    customerState.set('orderFilter', btn.dataset.filter);
    renderOrders();
  });

  document.getElementById('orders-type-fbar')?.addEventListener('click', e => {
    const btn = e.target.closest('.filter-tab[data-type]');
    if (!btn) return;
    document.querySelectorAll('#orders-type-fbar .filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    customerState.set('orderTypeFilter', btn.dataset.type);
    renderOrders();
  });
}

function bindPoints() {
  document.querySelectorAll('.rbtn[data-pts]').forEach(btn => {
    btn.addEventListener('click', () => redeemPts(Number(btn.dataset.pts), Number(btn.dataset.val)));
  });
}

function refreshPtsUI() {
  const user = customerState.get('user');
  const pts = user?.loyalty_points ?? 0;

  // Update dashboard welcome name and points balance card
  const dashName = document.getElementById('dash-user-name');
  if (dashName && user?.name) dashName.textContent = user.name;
  const dashPts = document.getElementById('dash-user-pts');
  if (dashPts) dashPts.textContent = pts.toLocaleString();

  const el = document.getElementById('ptsnum');
  if (el) el.textContent = pts.toLocaleString();
  const ptscard = document.getElementById('ptscard');
  if (ptscard) ptscard.style.display = pts > 0 ? 'block' : 'none';
  if (document.getElementById('ptslbl'))
    document.getElementById('ptslbl').textContent = `رصيدك: ${pts} نقطة`;
}

async function loadPtsTab() {
  const user = customerState.get('user');
  refreshPtsUI();
  const pts = user?.loyalty_points ?? 0;
  const tier = pts >= 1000 ? { cls: 'tgold', lbl: '🥇 ذهبي' } : pts >= 200 ? { cls: 'tsilv', lbl: '🥈 فضي' } : { cls: 'tbron', lbl: '🥉 برونز' };
  const tierEl = document.getElementById('tierdisp');
  if (tierEl) tierEl.innerHTML = `<div class="tierbadge ${tier.cls}">${tier.lbl}</div>`;
  const bar = document.getElementById('ptsbar');
  if (bar) bar.style.width = Math.min((pts / 1000) * 100, 100) + '%';

  ['rb100', 'rb300', 'rb700'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = pts < Number(btn.dataset.pts);
  });

  try {
    const userId = customerState.get('user')?.id;
    if (!userId) return;
    const { data } = await sb.from(Config.TABLES.ORDERS)
      .select('id, total, created_at')
      .eq('user_id', userId)
      .eq('status', 'delivered')
      .order('created_at', { ascending: false })
      .limit(10);
    const hist = document.getElementById('ptshist');
    if (data?.length) {
      hist.innerHTML = data.map(o => `
        <div class="pts-history-row">
          <div class="pts-history-left">
            <span class="pts-history-id">#${esc(o.id.slice(0, 8))}</span>
            <span class="pts-history-date">${new Date(o.created_at).toLocaleDateString('ar-IQ')}</span>
          </div>
          <div class="pts-history-right">
            <span class="pts-history-badge">+${Math.floor((o.total ?? 0) / 1000)} نقطة</span>
          </div>
        </div>`).join('');
    }
  } catch { }
}

async function redeemPts(pts, discount) {
  const user = customerState.get('user');
  if ((user?.loyalty_points ?? 0) < pts) { showToast('نقاطك غير كافية', 'error'); return; }
  try {
    const { error } = await sb.rpc('sp_redeem_points', {
      p_user_id: user.id,
      p_points: pts,
      p_discount: discount
    });
    if (error) throw error;
    customerState.merge('user', { loyalty_points: (user.loyalty_points ?? 0) - pts });
    refreshPtsUI();
    const banner = document.getElementById('redeembanner');
    if (banner) { banner.textContent = `✅ تم استبدال ${pts} نقطة بخصم ${formatPrice(discount)}`; banner.style.display = 'block'; }
    showToast('✅ تم الاستبدال بنجاح', 'success');
  } catch { showToast('❌ فشل الاستبدال', 'error'); }
}

function showOrderDetail(orderId) {
  customerState.set('activeDetailOrderId', orderId);
  const orders = customerState.get('allUserOrders') ?? [];
  const o = orders.find(x => x.id === orderId);
  if (!o) return;
  const s = Config.ORDER_STATUSES[o.status] ?? { label: o.status, css: 'sr', icon: '📦' };

  const filesHTML = (o.files_data ?? []).map(f =>
    `<div style="font-size:.82rem;color:var(--text-muted);padding:3px 0;">📄 ${esc(f.name)} × ${f.copies ?? 1} (${f.pages ?? 1} صفحة)</div>`
  ).join('');

  const cartHTML = (o.cart_items ?? []).map(i => {
    const optsHtml = i.selected_options && Object.keys(i.selected_options).length > 0
      ? ` <span style="font-size:.7rem;color:#7c3aed;">(${Object.entries(i.selected_options).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('، ')})</span>`
      : '';
    return `<div style="font-size:.82rem;color:var(--text-muted);padding:3px 0;">📦 ${esc(i.name)} × ${i.qty}${optsHtml}</div>`;
  }).join('');

  const isCancelled = o.status === 'cancelled';
  const stepperHTML = isCancelled ? '' : `
    <div id="det-tracking-steps" style="margin-top: 15px; margin-bottom: 25px; display: flex; justify-content: space-between; position: relative; padding: 0 10px;">
      <div style="position: absolute; top: 15px; left: 10%; right: 10%; height: 2px; background: var(--border-soft); z-index: 0;"></div>
      <div id="det-line-progress" style="position: absolute; top: 15px; left: 10%; width: 0%; height: 2px; background: var(--teal); z-index: 1; transition: width 0.5s ease;"></div>
      
      <div class="track-node active">
        <div>1</div>
        <div>تم الاستلام</div>
      </div>
      <div class="track-node">
        <div>2</div>
        <div>الطباعة</div>
      </div>
      <div class="track-node">
        <div>3</div>
        <div>التوصيل</div>
      </div>
    </div>
  `;


  document.getElementById('det-title').textContent = `طلب #${o.id.slice(0, 8)}`;
  document.getElementById('det-body').innerHTML = `
    <div style="text-align:center;margin-bottom:16px;">
      <span class="sbadge ${s.css}" style="font-size:1rem;padding:8px 20px;">${s.icon} ${s.label}</span>
    </div>
    ${stepperHTML}
    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
      <span>المبلغ الكلي</span><b>${formatPrice(o.total)}</b>
    </div>
    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
      <span>تاريخ الطلب</span><b>${new Date(o.created_at).toLocaleString('ar-IQ')}</b>
    </div>
    ${filesHTML ? `<div style="padding:10px 0;border-bottom:1px solid var(--border);"><b style="font-size:.85rem;color:var(--navy);">الملفات:</b>${filesHTML}</div>` : ''}
    ${cartHTML ? `<div style="padding:10px 0;border-bottom:1px solid var(--border);"><b style="font-size:.85rem;color:var(--navy);">القرطاسية:</b>${cartHTML}</div>` : ''}
    ${o.cancel_reason ? `<div style="padding:10px;margin-top:10px;background:#fef2f2;border-radius:var(--radius-sm);color:var(--red);font-size:.88rem;">❌ سبب الإلغاء: ${esc(o.cancel_reason)}</div>` : ''}
  `;

  if (!isCancelled) {
    updateTrackingNodes('det-tracking-steps', 'det-line-progress', o.status);
  }

  document.getElementById('det-ov').classList.add('open');
}

function bindModals() {
  const detClose = document.getElementById('det-close');
  if (detClose) {
    detClose.addEventListener('click', () => document.getElementById('det-ov')?.classList.remove('open'));
  }
  
  const detOv = document.getElementById('det-ov');
  if (detOv) {
    detOv.addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });
  }

  const successViewOrders = document.getElementById('success-view-orders');
  if (successViewOrders) {
    successViewOrders.addEventListener('click', () => {
      document.getElementById('success-overlay')?.classList.remove('open');
      goTab('orders');
    });
  }
  
  const successClose = document.getElementById('success-close');
  if (successClose) {
    successClose.addEventListener('click', () => {
      document.getElementById('success-overlay')?.classList.remove('open');
    });
  }

  const rateStars = document.getElementById('rate-stars');
  if (rateStars) {
    rateStars.addEventListener('click', e => {
      const star = e.target.closest('.rate-star');
      if (!star) return;
      const v = Number(star.dataset.v);
      customerState.set('rateStars', v);
      document.querySelectorAll('.rate-star').forEach(s => s.classList.toggle('active', Number(s.dataset.v) <= v));
      const submitBtn = document.getElementById('rate-submit-btn');
      if (submitBtn) submitBtn.disabled = false;
    });
  }
  
  const rateSubmitBtn = document.getElementById('rate-submit-btn');
  if (rateSubmitBtn) {
    rateSubmitBtn.addEventListener('click', () => withLoading('rate-submit-btn', submitRating));
  }
  
  const rateCancelBtn = document.getElementById('rate-cancel-btn');
  if (rateCancelBtn) {
    rateCancelBtn.addEventListener('click', () => document.getElementById('rate-modal')?.classList.remove('open'));
  }
}

// ═══════════════════════════════════════
//  Research/Report request submission
// ═══════════════════════════════════════
function bindResearch() {
  document.getElementById('res-btn').addEventListener('click', () => withLoading('res-btn', submitResearch));
}

async function submitResearch() {
  const errEl = document.getElementById('research-err');
  errEl.style.display = 'none';

  const name = document.getElementById('res-name').value.trim();
  const phone = document.getElementById('res-phone').value.trim();
  const subject = document.getElementById('res-subject').value.trim();
  const type = document.getElementById('res-type').value;
  const pages = document.getElementById('res-pages').value;
  const deadline = document.getElementById('res-deadline').value;
  const details = document.getElementById('res-details').value.trim();

  if (!name || name.length < 2) { errEl.textContent = '❌ يرجى إدخال الاسم الكامل'; errEl.style.display = 'block'; return; }
  if (!/^07[0-9]{9}$/.test(phone)) { errEl.textContent = '❌ رقم الهاتف غير صحيح'; errEl.style.display = 'block'; return; }
  if (!subject) { errEl.textContent = '❌ يرجى إدخال موضوع البحث'; errEl.style.display = 'block'; return; }
  if (!type) { errEl.textContent = '❌ يرجى اختيار نوع الطلب'; errEl.style.display = 'block'; return; }

  try {
    const userId = customerState.get('user')?.id ?? null;
    const { error } = await sb.from(Config.TABLES.RESEARCH).insert({
      user_id: userId,
      name,
      phone,
      title: subject,
      subject,
      type,
      pages: Number(pages) || null,
      deadline: deadline || null,
      details,
      status: 'pending',
    });
    if (error) throw error;

    // show success
    document.getElementById('res-confirm-box').style.display = 'block';
    document.getElementById('res-name').value = '';
    document.getElementById('res-phone').value = '';
    document.getElementById('res-subject').value = '';
    document.getElementById('res-type').value = '';
    document.getElementById('res-pages').value = '';
    document.getElementById('res-deadline').value = '';
    document.getElementById('res-details').value = '';

    showToast('✅ تم إرسال طلب البحث بنجاح!', 'success', 5000);
    loadOrders();

    // Notify admin via TG
    try {
      const msg = `📝 طلب بحث جديد\n👤 ${name}\n📞 ${phone}\n📚 ${type}: ${subject}\n📄 ${pages || '—'} صفحة\n📅 الموعد: ${deadline || '—'}`;
      await sb.functions.invoke(Config.FUNCTIONS.SEND_TG, {
        body: { chat_id: Config.TELEGRAM.ADMIN_TG_ID, text: msg }
      });
    } catch { }
  } catch (e) {
    errEl.textContent = '❌ فشل إرسال الطلب: ' + e.message;
    errEl.style.display = 'block';
  }
}



// ═══════════════════════════════════════
//  Suggested products for step 3
// ═══════════════════════════════════════
async function loadSuggestedProducts() {
  try {
    const list = document.getElementById('suggested-products-list');
    if (list) list.innerHTML = renderSkeletonProducts(2);

    const { fetchActiveProducts } = await import('./services/market.service.js');
    const products = await fetchActiveProducts();
    const suggested = products.filter(p => p.is_suggested);
    if (!suggested.length) { if (list) list.innerHTML = ''; return; }

    customerState.set('suggestedProducts', suggested);
    const section = document.getElementById('suggested-products-section');
    section.style.display = 'block';
    list.innerHTML = suggested.map(p => {
      const hasDiscount = p.discount && p.discount > 0;
      const displayPrice = hasDiscount ? Math.max(0, p.price - p.discount) : p.price;
      return `
      <div style="display:flex;align-items:center;gap:10px;background:var(--card);border-radius:var(--radius-sm);padding:10px;border:1px solid var(--border-soft);" data-sug-id="${esc(p.id)}">
        <div style="width:44px;height:44px;border-radius:var(--radius-sm);background:var(--input-bg);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;font-size:1.4rem;">
          ${p.image_url ? `<img src="${esc(p.image_url.split(',')[0].trim())}" style="width:100%;height:100%;object-fit:cover;">` : '📦'}
        </div>
        <div style="flex:1;min-width:0;">
          <b style="font-size:.85rem;color:var(--navy);">${esc(p.name)}</b>
          <div style="font-size:.75rem;color:var(--text-muted);">
            ${hasDiscount
          ? `<span style="text-decoration:line-through;opacity:.6;">${formatPrice(p.price)}</span> <b style="color:var(--green);">${formatPrice(displayPrice)}</b>`
          : formatPrice(p.price)
        }
          </div>
        </div>
        <button class="sug-add-btn" data-sug-add="${esc(p.id)}" style="border:none;background:var(--teal);color:#fff;padding:8px 14px;border-radius:var(--radius-sm);font-weight:800;cursor:pointer;font-family:var(--font-main);font-size:.8rem;white-space:nowrap;">➕ أضف</button>
      </div>`;
    }).join('');

    list.addEventListener('click', e => {
      const btn = e.target.closest('[data-sug-add]');
      if (btn) {
        const prodId = btn.dataset.sugAdd;
        const product = suggested.find(p => p.id === prodId);
        if (!product) return;

        const sugCart = { ...(customerState.get('suggestedCart') ?? {}) };
        sugCart[prodId] = (sugCart[prodId] ?? 0) + 1;
        customerState.set('suggestedCart', sugCart);
        btn.textContent = `✅ (${sugCart[prodId]})`;
        btn.style.background = 'var(--green)';
        showToast(`✅ تمت الإضافة: ${product.name}`, 'success');
        updateUnifiedCart();
        return;
      }

      const card = e.target.closest('[data-sug-id]');
      if (card) {
        const prodId = card.dataset.sugId;
        const product = suggested.find(p => p.id === prodId);
        if (product) showProductDetailPage(product);
      }
    });
  } catch (e) { console.warn('[suggested]', e.message); }
}

async function submitRating() {
  const oid = customerState.get('rateOrderId');
  const stars = customerState.get('rateStars');
  if (!oid || !stars) return;
  const { submitRating: doRating } = await import('./services/order.service.js');
  const commentVal = document.getElementById('rate-comment')?.value ?? '';
  await doRating(oid, stars, commentVal);
  document.getElementById('rate-modal')?.classList.remove('open');
  showToast('🌟 شكراً على تقييمك!', 'success');
}

function startRealtime(userId) {
  try {
    // 1. Listen to orders updates
    sb.channel('orders-user-' + userId)
      .on('postgres_changes', { 
        event: 'UPDATE', 
        schema: 'public', 
        table: Config.TABLES.ORDERS,
        filter: `user_id=eq.${userId}`
      },
        p => {
          if (p.new?.user_id !== userId) return;
          handleRealtimeUpdate(p.new, false);
        })
      .subscribe();

    // 2. Listen to research requests updates
    sb.channel('research-user-' + userId)
      .on('postgres_changes', { 
        event: 'UPDATE', 
        schema: 'public', 
        table: Config.TABLES.RESEARCH,
        filter: `user_id=eq.${userId}`
      },
        p => {
          if (p.new?.user_id !== userId) return;
          handleRealtimeUpdate(p.new, true);
        })
      .subscribe();
  } catch (e) { console.warn('[Realtime error]', e); }
}

function handleRealtimeUpdate(item, isResearch = false) {
  if (!item?.status) return;
  const st = item.status;
  
  const statusMap = isResearch ? {
    pending: { label: 'معلق', css: 'sr', icon: '🕐' },
    in_progress: { label: 'قيد العمل', css: 'sp', icon: '⚙️' },
    completed: { label: 'مكتمل', css: 'sv', icon: '✅' },
    rejected: { label: 'مرفوض', css: 'sr', icon: '❌' }
  } : Config.ORDER_STATUSES;
  
  const s = statusMap[st] ?? { label: st, icon: '🔔' };
  showToast(`🔔 ${isResearch ? 'بحث: ' : ''}${s.icon} ${s.label}`, st === 'cancelled' || st === 'rejected' ? 'error' : 'info');

  // Update Success Overlay tracking if open
  if (!isResearch && document.getElementById('success-overlay')?.classList.contains('open')) {
    document.getElementById('success-order-status').textContent = `${s.label} ${s.icon}`;
    updateSuccessTracking(st);
  }

  loadOrders(true).then(() => {
    const detOv = document.getElementById('det-ov');
    if (detOv && detOv.classList.contains('open') && customerState.get('activeDetailOrderId') === item.id) {
      if (isResearch) {
        showResearchDetail(item.id);
      } else {
        showOrderDetail(item.id);
      }
    }
  });

  if (!isResearch && st === 'delivered') {
    customerState.set('rateOrderId', item.id);
    customerState.set('rateStars', 0);
    setTimeout(() => document.getElementById('rate-modal')?.classList.add('open'), 1500);
  }
}

window.addEventListener('online', async () => {
  const b = document.getElementById('conn-badge')
  if (b) {
    b.className = 'online'
    b.innerHTML = '✅ عاد الاتصال'
    b.style.display = 'block'
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success')
    setTimeout(() => { b.style.display = 'none' }, 3000)
  }
  try {
    const { data: { session } } = await sb.auth.getSession()
    if (!session) await authenticateTelegramUser()
  } catch {}
  const tab = document.querySelector('.tab.active')?.id?.replace('tab-', '')
  if (tab === 'orders') loadOrders()
  if (tab === 'market') loadMktProducts()
})

window.addEventListener('offline', () => {
  const b = document.getElementById('conn-badge')
  if (b) {
    b.className = 'offline'
    b.innerHTML = '📡 لا يوجد اتصال'
    b.style.display = 'block'
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('warning')
  }
})

function bindLaunchpad() {
  // 1. Printing Portal
  document.getElementById('portal-print-btn')?.addEventListener('click', () => {
    document.getElementById('launchpad-dashboard').style.display = 'none';
    document.getElementById('print-wizard-container').style.display = 'block';
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
  });

  // 2. Research Portal
  document.getElementById('portal-research-btn')?.addEventListener('click', () => {
    goTab('research');
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
  });

  // 3. Market Portal
  document.getElementById('portal-market-btn')?.addEventListener('click', () => {
    goTab('market');
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
  });

  // 4. Points holographic card click
  document.getElementById('dash-points-trigger')?.addEventListener('click', () => {
    goTab('points');
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
  });

  // 5. Exit print wizard button
  document.getElementById('btn-exit-print-wizard')?.addEventListener('click', () => {
    document.getElementById('print-wizard-container').style.display = 'none';
    document.getElementById('launchpad-dashboard').style.display = 'block';
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
  });

  // 6. Back buttons to launchpad across tabs
  document.querySelectorAll('.btn-back-to-launchpad').forEach(btn => {
    btn.addEventListener('click', () => {
      goTab('order');
    });
  });

  // 7. Click pending files banner to open print wizard
  document.getElementById('pending-files-banner')?.addEventListener('click', () => {
    document.getElementById('launchpad-dashboard').style.display = 'none';
    document.getElementById('print-wizard-container').style.display = 'block';
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
  });
}

function showResearchDetail(orderId) {
  customerState.set('activeDetailOrderId', orderId);
  const orders = customerState.get('allUserOrders') ?? [];
  const r = orders.find(x => x.id === orderId);
  if (!r) return;

  const statusMap = {
    pending: { label: 'معلق', css: 'sr', icon: '🕐' },
    in_progress: { label: 'قيد العمل', css: 'sp', icon: '⚙️' },
    completed: { label: 'مكتمل', css: 'sv', icon: '✅' },
    rejected: { label: 'مرفوض', css: 'sr', icon: '❌' }
  };
  const s = statusMap[r.status] ?? { label: r.status, css: 'sr', icon: '📝' };

  const isCancelled = r.status === 'cancelled' || r.status === 'rejected';
  
  let stepperHTML = '';
  if (!isCancelled) {
    const nodes = [
      { step: 'pending', num: 1, label: 'معلق' },
      { step: 'in_progress', num: 2, label: 'قيد العمل' },
      { step: 'completed', num: 3, label: 'مكتمل' }
    ];
    const currentIdx = nodes.findIndex(n => n.step === r.status);
    
    stepperHTML = `
      <div id="det-tracking-steps" style="margin-top: 15px; margin-bottom: 25px; display: flex; justify-content: space-between; position: relative; padding: 0 10px;">
        <div style="position: absolute; top: 15px; left: 10%; right: 10%; height: 2px; background: var(--border-soft); z-index: 0;"></div>
        <div id="det-line-progress" style="position: absolute; top: 15px; left: 10%; width: ${currentIdx * 40}%; height: 2px; background: var(--teal); z-index: 1; transition: width 0.5s ease;"></div>
        
        ${nodes.map(n => {
          const isActive = nodes.findIndex(x => x.step === r.status) >= nodes.findIndex(x => x.step === n.step);
          return `
            <div class="track-node ${isActive ? 'active' : ''}">
              <div>${n.num}</div>
              <div>${n.label}</div>
            </div>`;
        }).join('')}
      </div>`;
  }

  const deadline = r.deadline ? new Date(r.deadline).toLocaleDateString('ar-IQ') : 'غير محدد';

  document.getElementById('det-title').textContent = `طلب بحث #${r.id.slice(0, 8)}`;
  document.getElementById('det-body').innerHTML = `
    <div style="text-align:center;margin-bottom:16px;">
      <span class="sbadge ${s.css}" style="font-size:1rem;padding:8px 20px;">${s.icon} ${s.label}</span>
    </div>
    ${stepperHTML}
    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
      <span>نوع الطلب</span><b>${esc(r.type)}</b>
    </div>
    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
      <span>الموضوع / العنوان</span><b>${esc(r.subject || r.title)}</b>
    </div>
    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
      <span>تاريخ التقديم</span><b>${new Date(r.created_at).toLocaleString('ar-IQ')}</b>
    </div>
    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
      <span>موعد التسليم المطلوب</span><b>${esc(deadline)}</b>
    </div>
    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
      <span>عدد الصفحات التقريبي</span><b>${r.pages ?? 'غير محدد'}</b>
    </div>
    ${r.details ? `<div style="padding:12px 0; line-height: 1.5; border-bottom:1px solid var(--border);"><b style="font-size:.85rem;color:var(--navy);display:block;margin-bottom:4px;">تفاصيل البحث:</b><p style="margin:0;font-size:0.85rem;color:var(--text-muted);">${esc(r.details)}</p></div>` : ''}
    ${r.cancel_reason ? `<div style="padding:10px;margin-top:10px;background:#fef2f2;border-radius:var(--radius-sm);color:var(--red);font-size:.88rem;">❌ سبب الإلغاء/الرفض: ${esc(r.cancel_reason)}</div>` : ''}
  `;

  document.getElementById('det-ov').classList.add('open');
}

init().catch(console.error);

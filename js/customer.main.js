/**
 * customer.main.js — نقطة دخول index.html
 * FIX: { once: true } removed; order click listener moved to init (called once)
 */

import { sb } from './core/supabase.js';
import { Config } from './core/config.js';
import { customerState } from './core/state.js';
import { esc, debounce, isValidIraqiPhone, isValidName, formatPrice } from './core/utils.js';
import { authenticateTelegramUser } from './services/auth.service.js';
import { submitOrder, fetchUserOrders, validateCoupon, calcOrderTotals } from './services/order.service.js';
import { uploadFile } from './services/upload.service.js';
import { fetchActiveProducts, loadPricing } from './services/market.service.js';
import { Stepper } from './customer/stepper.js';
import { showToast } from './components/toast.js';
import { withLoading } from './components/loading-btn.js';
import { Modal } from './components/modal.js';
import { QtyControl } from './components/qty-control.js';

const tg = window.Telegram?.WebApp;
const tgU = tg?.initDataUnsafe?.user;
tg?.ready();
tg?.expand();

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
  const badge = `<span class="file-preview-badge">${ext.toUpperCase()}</span>`;

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
  const dark = localStorage.getItem(Config.APP.STORAGE_KEYS.DARK_MODE_CUSTOMER) === 'true';
  applyTheme(dark);

  bindNav();
  bindStepper();
  bindUpload();
  bindPrintOptions();
  bindOrderForm();
  bindCart();
  bindMarket();
  bindOrders();
  bindPoints();
  bindResearch();
  bindModals();
  bindSuccessOverlay();
  bindHomeTrackingCard();
  Modal.init();

  await authenticateTelegramUser();

  // Stable ID for tracking: use Telegram ID if available, otherwise persist a guest ID
  let userId = tgU?.id ? String(tgU.id) : localStorage.getItem('shater_guest_id');
  if (!userId) {
    userId = 'guest_' + Date.now() + Math.random().toString(36).substring(2, 6);
    localStorage.setItem('shater_guest_id', userId);
  }

  customerState.merge('user', { id: userId, name: tgU?.first_name ?? '', username: tgU?.username ?? '' });

  try {
    const { data } = await sb.from(Config.TABLES.USERS).select('*').eq('id', userId).maybeSingle();
    if (data) {
      // Update info if changed
      if (tgU && (data.telegram_id !== String(tgU.id) || data.first_name !== tgU.first_name)) {
        await sb.from(Config.TABLES.USERS).update({ 
          telegram_id: String(tgU.id), 
          first_name: tgU.first_name, 
          username: tgU.username 
        }).eq('id', userId);
      }
      customerState.set('user', { ...data, name: data.first_name, telegram_id: data.telegram_id || (tgU ? String(tgU.id) : null) });
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
  } catch (e) { console.warn('[Auth]', e.message); }

  const pricing = await loadPricing();
  if (pricing) customerState.set('pricing', pricing);
  applyPricingToUI(pricing ?? Config.DEFAULT_PRICING);

  customerState.subscribe('user', refreshPtsUI);
  refreshPtsUI();
  startRealtime(userId);

  // Load suggested products for step 3
  loadSuggestedProducts();
}

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
      circle.style.background = '#e2e8f0';
      circle.style.color = '#64748b';
      circle.style.boxShadow = 'none';
    }
    const label = n.querySelector('div:nth-child(2)');
    if (label) {
      label.style.color = '#94a3b8';
      label.style.fontWeight = '700';
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
    const circle = n.querySelector('div');
    if (circle) {
      circle.style.background = 'var(--teal)';
      circle.style.color = '#fff';
      circle.style.boxShadow = '0 0 0 4px var(--bg)';
    }
    const label = n.querySelector('div:nth-child(2)');
    if (label) {
      label.style.color = 'var(--teal)';
      label.style.fontWeight = '800';
    }
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
  const stepper = document.querySelector('.stepper-wrap');
  const activeBanner = document.getElementById('home-active-order-banner');

  if (!card || !stepper) return;

  if (!order || customerState.get('hideHomeTracking') === true) {
    card.style.display = 'none';
    stepper.style.display = 'block';
    if (order && activeBanner) {
      activeBanner.style.display = 'block';
    } else if (activeBanner) {
      activeBanner.style.display = 'none';
    }
    return;
  }

  card.style.display = 'block';
  stepper.style.display = 'none';
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
    goTab('home');
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
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(x => x.classList.remove('active'));
  document.getElementById('tab-' + t)?.classList.add('active');
  document.getElementById('nav-' + t)?.classList.add('active');
  if (t === 'orders') loadOrders();
  if (t === 'points') loadPtsTab();
  if (t === 'market') { const p = customerState.get('mktProducts'); if (!p?.length) loadMktProducts(); }
}


let stepper;
function bindStepper() {
  stepper = new Stepper(4, step => {
    updateSummaryBar();
    if (step === 3) updateStep3Summary();
    if (step === 4) updateInvoice();
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
  if (!allowed.length) { showToast('❌ نوع الملف غير مدعوم', 'error'); return; }

  const files = [...(customerState.get('files') ?? [])];
  
  // Show a loading toast if many files
  if (allowed.length > 2) showToast('⏳ جاري معالجة الملفات وحساب الصفحات...', 'info');

  for (const f of allowed) {
    const id = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const pages = await processFilePages(f);
    files.push({ id, name: f.name, size: f.size, pages: pages, copies: 1, file: f });
  }
  
  customerState.set('files', files);
  renderFileList();
}


function removeFile(id) {
  const files = (customerState.get('files') ?? []).filter(f => f.id !== id);
  customerState.set('files', files);
  renderFileList();
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
    let imgs = 0, pages = 0;
    files.forEach(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) { imgs++; pages += (f.copies ?? 1); }
      else { pages += (f.pages ?? 1) * (f.copies ?? 1); }
    });
    document.getElementById('s1-tot-files').textContent = files.length;
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
          const url = await uploadFile(f.file, userId, pct => {
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
    
    // Refresh orders in background
    loadOrders();
  } catch (e) {
    const pcon = document.getElementById('pcon');
    const stxt = document.getElementById('statustxt');
    pcon.style.display = 'none';
    stxt.style.display = 'none';
    errEl.textContent = '❌ ' + e.message;
    errEl.style.display = 'block';
  }
}

function bindCart() {
  document.getElementById('cart-fab')?.addEventListener('click', () => document.getElementById('cart-drawer').classList.add('open'));
  document.getElementById('open-cart-btn')?.addEventListener('click', () => document.getElementById('cart-drawer').classList.add('open'));
  document.getElementById('cart-close').addEventListener('click', () => document.getElementById('cart-drawer').classList.remove('open'));
  document.getElementById('add-more-market-btn').addEventListener('click', () => goTab('market'));
  document.getElementById('checkout-btn').addEventListener('click', () => withLoading('checkout-btn', checkoutMarket));

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

function addToCart(product) {
  const cart = customerState.get('cart') ?? [];
  const existing = cart.find(i => i.id === product.id);
  if (existing) {
    existing.qty = Math.min(existing.qty + 1, product.stock);
  } else {
    const effectivePrice = (product.discount && product.discount > 0)
      ? Math.max(0, product.price - product.discount)
      : (product.effective_price ?? product.price);
    cart.push({ ...product, qty: 1, effective_price: effectivePrice });
  }
  customerState.set('cart', [...cart]);
  renderCart();
  updateCartBadge();
  updateUnifiedCart();
  showToast('✅ أُضيف للسلة', 'success');
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

  itemsEl.innerHTML = cart.map(i => `
    <div class="cart-item" style="gap: 12px;">
      <div style="flex: 1;">
        <b style="font-size:.9rem;color:var(--navy);">${esc(i.name)}</b>
        <p style="margin:2px 0 0;font-size:.78rem;color:var(--text-muted);">${formatPrice(i.effective_price ?? i.price)} / ${esc(i.unit ?? 'قطعة')}</p>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        ${QtyControl.html({ id: i.id, value: i.qty, min: 0, max: i.stock })}
        <button class="delete-cart-item-btn" data-id="${i.id}" style="background:none; border:none; color:#ef4444; font-size:1.1rem; cursor:pointer; padding:4px; transition:color 0.2s;" title="حذف المنتج">🗑️</button>
      </div>
    </div>`).join('');

  checkEl.style.display = 'block';
  const sub = cart.reduce((s, i) => s + (i.effective_price ?? i.price) * i.qty, 0);
  const del = sub >= pricing.delivery_free_threshold ? 0 : pricing.delivery_fee;
  document.getElementById('cart-items-total').textContent = formatPrice(sub);
  document.getElementById('cart-del-fee').textContent = del === 0 ? '🎁 مجاني' : formatPrice(del);
  document.getElementById('cart-grand-total').textContent = formatPrice(sub + del);
  updateCartBadge();
}

function updateCartBadge() {
  const count = (customerState.get('cart') ?? []).reduce((s, i) => s + (i.qty ?? 1), 0);
  const badges = ['cart-count', 'nav-cart-badge', 'mkt-badge'];
  badges.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = count || '';
    el.style.display = count > 0 ? '' : 'none';
  });
  const fab = document.getElementById('cart-fab');
  if (fab) fab.style.display = count > 0 ? 'flex' : 'none';
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
    const orderId = await submitOrder({ name, phone, region, notes: document.getElementById('cart-notes').value });
    document.getElementById('cart-drawer').classList.remove('open');
    
    const cart = customerState.get('cart') ?? [];
    const sub = cart.reduce((s, i) => s + (i.effective_price ?? i.price) * i.qty, 0);
    const pricing = customerState.get('pricing') ?? Config.DEFAULT_PRICING;
    const del = sub >= pricing.delivery_free_threshold ? 0 : pricing.delivery_fee;

    customerState.set('hideHomeTracking', false);
    populateSuccessDetails();
    customerState.set('cart', []);
    renderCart();
    updateCartBadge();

    // Show Success Screen
    const orderIdShort = orderId.length > 8 ? orderId.slice(0, 8) : orderId;
    document.getElementById('success-order-id').textContent = '#' + orderIdShort;
    document.getElementById('success-order-total').textContent = formatPrice(sub + del);
    document.getElementById('success-order-addr').textContent = region || 'استلام من المركز';
    document.getElementById('success-order-status').textContent = 'مستلم 📥';
    updateSuccessTracking('received');
    document.getElementById('success-overlay').classList.add('open');

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
}

async function loadMktProducts() {
  try {
    const products = await fetchActiveProducts();
    customerState.set('mktProducts', products);
    filterMktProducts();
  } catch (e) {
    document.getElementById('mkt-products-grid').innerHTML = `<div style="grid-column:span 2;text-align:center;padding:40px;color:var(--red);">❌ ${esc(e.message)}</div>`;
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
    grid.innerHTML = '<div style="grid-column:span 2;text-align:center;padding:40px;color:#94a3b8;"><p>لا توجد منتجات</p></div>';
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
}

async function loadOrders() {
  const user = customerState.get('user');
  if (!user?.id) return;

  const box = document.getElementById('ordersbox');
  box.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;">⏳</div>';

  try {
    const orders = await fetchUserOrders(user.id);
    customerState.set('allUserOrders', orders);
    renderOrders();
  } catch (err) { 
    console.error('[loadOrders Error]', err);
    box.innerHTML = `<div style="text-align:center;padding:40px;color:var(--red);">
      <p>❌ تعذّر تحميل الطلبات</p>
      <p style="font-size:0.75rem;opacity:0.7;margin-top:8px;">${esc(err.message)}</p>
      <button onclick="location.reload()" style="margin-top:12px;background:var(--navy);color:#fff;border:none;padding:8px 16px;border-radius:8px;">إعادة المحاولة</button>
    </div>`; 
  }
}

// ═══════════════════════════════════════
//  FIX: renderOrders — NO addEventListener here
//  click is handled by delegation set up ONCE in bindPoints()
// ═══════════════════════════════════════
function renderOrders() {
  const orders = customerState.get('allUserOrders') ?? [];
  const filter = customerState.get('orderFilter') ?? 'all';
  const active = ['received', 'printing', 'delivering'];

  const filtered = orders.filter(o => {
    if (filter === 'active') return active.includes(o.status);
    if (filter === 'delivered') return o.status === 'delivered';
    if (filter === 'cancelled') return o.status === 'cancelled';
    return true;
  });

  const box = document.getElementById('ordersbox');

  // Update Home Active Order Tracking Card / Banner
  const activeStatuses = ['received', 'printing', 'delivering', 'pending', 'ready'];
  const activeOrder = orders.find(o => activeStatuses.includes(o.status));
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
    box.innerHTML = '<div style="text-align:center;padding:60px;color:#94a3b8;"><div style="font-size:4rem;opacity:.4;">📦</div><p>لا توجد طلبات</p></div>';
    return;
  }

  const statusMap = Config.ORDER_STATUSES;
  box.innerHTML = filtered.map(o => {
    const s = statusMap[o.status] ?? { label: o.status, css: 'sr', icon: '📦' };
    const filesCount = o.files_data?.length ?? 0;
    const cartCount = o.cart_items?.length ?? 0;
    const typeLabel = filesCount && cartCount ? '🔀 مشترك' : filesCount ? '🖨️ استنساخ' : '📦 قرطاسية';
    return `
      <div class="ocard" data-oid="${esc(o.id)}">
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
  }).join('');
  // ← NO addEventListener. Delegation is in bindPoints().
}

function bindOrders() {
  document.getElementById('ordersbox').addEventListener('click', e => {
    const card = e.target.closest('.ocard[data-oid]');
    if (card) showOrderDetail(card.dataset.oid);
  });

  document.getElementById('orders-fbar').addEventListener('click', e => {
    const btn = e.target.closest('.filter-tab[data-filter]');
    if (!btn) return;
    document.querySelectorAll('#orders-fbar .filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    customerState.set('orderFilter', btn.dataset.filter);
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
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:.85rem;">
          <span style="color:var(--text-muted);">#${esc(o.id.slice(0, 8))} — ${new Date(o.created_at).toLocaleDateString('ar-IQ')}</span>
          <b style="color:var(--teal);">+${Math.floor((o.total ?? 0) / 1000)} نقطة</b>
        </div>`).join('');
    }
  } catch { }
}

async function redeemPts(pts, discount) {
  const user = customerState.get('user');
  if ((user?.loyalty_points ?? 0) < pts) { showToast('نقاطك غير كافية', 'error'); return; }
  try {
    await sb.from(Config.TABLES.USERS)
      .update({ loyalty_points: (user.loyalty_points ?? 0) - pts })
      .eq('id', user.id);
    customerState.merge('user', { loyalty_points: (user.loyalty_points ?? 0) - pts });
    refreshPtsUI();
    const banner = document.getElementById('redeembanner');
    if (banner) { banner.textContent = `✅ تم استبدال ${pts} نقطة بخصم ${formatPrice(discount)}`; banner.style.display = 'block'; }
    showToast('✅ تم الاستبدال بنجاح', 'success');
  } catch { showToast('❌ فشل الاستبدال', 'error'); }
}

function showOrderDetail(orderId) {
  const orders = customerState.get('allUserOrders') ?? [];
  const o = orders.find(x => x.id === orderId);
  if (!o) return;
  const s = Config.ORDER_STATUSES[o.status] ?? { label: o.status, css: 'sr', icon: '📦' };

  const filesHTML = (o.files_data ?? []).map(f =>
    `<div style="font-size:.82rem;color:var(--text-muted);padding:3px 0;">📄 ${esc(f.name)} × ${f.copies ?? 1} (${f.pages ?? 1} صفحة)</div>`
  ).join('');

  const cartHTML = (o.cart_items ?? []).map(i =>
    `<div style="font-size:.82rem;color:var(--text-muted);padding:3px 0;">📦 ${esc(i.name)} × ${i.qty}</div>`
  ).join('');

  const isCancelled = o.status === 'cancelled';
  const stepperHTML = isCancelled ? '' : `
    <div id="det-tracking-steps" style="margin-top: 15px; margin-bottom: 25px; display: flex; justify-content: space-between; position: relative; padding: 0 10px;">
      <div style="position: absolute; top: 15px; left: 10%; right: 10%; height: 2px; background: #e2e8f0; z-index: 0;"></div>
      <div id="det-line-progress" style="position: absolute; top: 15px; left: 10%; width: 0%; height: 2px; background: var(--teal); z-index: 1; transition: width 0.5s ease;"></div>
      
      <div class="track-node active" style="z-index: 2; text-align: center; width: 20%;">
        <div style="width: 32px; height: 32px; background: var(--teal); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 8px; color: #fff; font-size: 0.8rem; box-shadow: 0 0 0 4px var(--bg);">1</div>
        <div style="font-size: 0.65rem; font-weight: 800; color: var(--teal);">تم الاستلام</div>
      </div>
      <div class="track-node" style="z-index: 2; text-align: center; width: 20%;">
        <div style="width: 32px; height: 32px; background: #e2e8f0; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 8px; color: #64748b; font-size: 0.8rem;">2</div>
        <div style="font-size: 0.65rem; font-weight: 700; color: #94a3b8;">الطباعة</div>
      </div>
      <div class="track-node" style="z-index: 2; text-align: center; width: 20%;">
        <div style="width: 32px; height: 32px; background: #e2e8f0; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 8px; color: #64748b; font-size: 0.8rem;">3</div>
        <div style="font-size: 0.65rem; font-weight: 700; color: #94a3b8;">التوصيل</div>
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
    const { fetchActiveProducts } = await import('./services/market.service.js');
    const products = await fetchActiveProducts();
    const suggested = products.filter(p => p.is_suggested);
    if (!suggested.length) return;

    customerState.set('suggestedProducts', suggested);
    const section = document.getElementById('suggested-products-section');
    section.style.display = 'block';

    const list = document.getElementById('suggested-products-list');
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
      if (!btn) return;
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
    sb.channel('orders-user-' + userId)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: Config.TABLES.ORDERS, filter: `user_id=eq.${userId}` },
        p => {
          if (!p.new?.status) return;
          const st = p.new.status;
          const statusMap = Config.ORDER_STATUSES;
          const s = statusMap[st] ?? { label: st, icon: '🔔' };
          
          showToast(`🔔 ${s.icon} ${s.label}`, st === 'cancelled' ? 'error' : 'info');
          
          // Update Success Overlay tracking if open
          if (document.getElementById('success-overlay').classList.contains('open')) {
            document.getElementById('success-order-status').textContent = `${s.label} ${s.icon}`;
            updateSuccessTracking(st);
          }

          loadOrders();
          if (st === 'delivered') {
            customerState.set('rateOrderId', p.new.id);
            customerState.set('rateStars', 0);
            setTimeout(() => document.getElementById('rate-modal')?.classList.add('open'), 1500);
          }
        })
      .subscribe();
  } catch { }
}

window.addEventListener('online', () => { const b = document.getElementById('conn-badge'); b.className = 'online'; b.textContent = '✅ اتصال يعمل'; setTimeout(() => b.className = '', 3000); });
window.addEventListener('offline', () => { const b = document.getElementById('conn-badge'); b.className = 'offline'; b.textContent = '❌ لا يوجد اتصال'; });

init().catch(console.error);

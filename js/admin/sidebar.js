import { adminState }  from '../core/state.js';
import { hasPermission, isManager } from '../services/auth.service.js';

const PAGES = [
  { id: 'orders',   icon: '📋', label: 'الطلبات',        always: true  },
  { id: 'research', icon: '📝', label: 'طلبات البحوث',   always: true  },
  { id: 'market',   icon: '📦', label: 'قرطاسية الشاطر', perm: 'manage_market' },
  { id: 'supplies', icon: '🗄️', label: 'المخزن',          perm: 'manage_supplies' },
  { id: 'settings', icon: '⚙️', label: 'الإعدادات',       manager: true },
];

export class Sidebar {
  #onNavigate; #collapsed = false;
  constructor(onNavigate) {
    this.#onNavigate = onNavigate;
    this.#collapsed  = localStorage.getItem('adm-sidebar-collapsed') === 'true';
  }
  render() {
    const sidebar = document.getElementById('sidebar'); if (!sidebar) return;
    const pages = this.#getVisiblePages();
    const role  = adminState.get('currentProfile');
    sidebar.innerHTML = `
      <div class="sidebar-header">
        <div class="sidebar-logo">
          <span class="sidebar-logo-icon">🖨️</span>
          <span class="sidebar-logo-text">لوحة الشاطر</span>
        </div>
        <button class="sidebar-collapse-btn" id="sidebar-toggle" title="طي القائمة">⇒</button>
      </div>
      <nav class="sidebar-nav" id="sidebar-nav">
        ${pages.map(p => this.#pageItem(p)).join('')}
        <div class="sidebar-divider"></div>
        <div style="padding:10px 16px;">
          <div style="color:rgba(255,255,255,.5);font-size:.72rem;font-weight:700;margin-bottom:6px;white-space:nowrap;overflow:hidden;">
            ${role?.emoji??'👤'} <span class="sidebar-item-text">${role?.name??''}</span>
          </div>
        </div>
      </nav>
      <div class="sidebar-footer">
        <button class="sidebar-item w-full" id="sidebar-logout" style="color:#f87171;">
          <span class="sidebar-item-icon">🚪</span>
          <span class="sidebar-item-text">تسجيل الخروج</span>
        </button>
      </div>`;
    if (this.#collapsed) sidebar.classList.add('collapsed');
    this.#bindEvents();
    this.setActive(adminState.get('activePage') ?? 'orders');
  }
  setActive(pageId) { document.querySelectorAll('.sidebar-item[data-page]').forEach(btn => btn.classList.toggle('active', btn.dataset.page === pageId)); }
  toggle() { this.#collapsed = !this.#collapsed; document.getElementById('sidebar')?.classList.toggle('collapsed', this.#collapsed); localStorage.setItem('adm-sidebar-collapsed', String(this.#collapsed)); }
  updateBadge(count) { 
    const badge = document.querySelector('.sidebar-item[data-page="orders"] .sidebar-badge'); 
    if (!badge) return; 
    badge.textContent = count > 0 ? count : ''; 
    badge.style.display = count > 0 ? '' : 'none'; 
    badge.classList.toggle('pulse', count > 0);
  }
  #getVisiblePages() { return PAGES.filter(p => { if (p.always) return true; if (p.manager) return isManager(); if (p.perm) return isManager()||hasPermission(p.perm); return false; }); }
  #pageItem(page) {
    const badge = page.id === 'orders' ? '<span class="sidebar-badge" style="display:none;">0</span>' : '';
    return `<button class="sidebar-item" data-page="${page.id}"><span class="sidebar-item-icon">${page.icon}</span><span class="sidebar-item-text">${page.label}</span>${badge}</button>`;
  }
  #bindEvents() {
    document.getElementById('sidebar-nav')?.addEventListener('click', e => {
      const btn = e.target.closest('.sidebar-item[data-page]'); if (!btn) return;
      const page = btn.dataset.page;
      adminState.set('activePage', page); this.setActive(page); this.#onNavigate?.(page); this.#closeMobile();
    });
    document.getElementById('sidebar-toggle')?.addEventListener('click', () => this.toggle());
    document.getElementById('sidebar-logout')?.addEventListener('click', () => this.#onNavigate?.('__logout__'));
  }
  #closeMobile() { document.getElementById('sidebar')?.classList.remove('mobile-open'); document.getElementById('sidebar-overlay')?.classList.remove('show'); }
}

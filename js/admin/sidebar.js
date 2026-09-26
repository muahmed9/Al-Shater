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
        <button class="sidebar-collapse-btn" id="sidebar-toggle" title="طي / إغلاق القائمة">⇒</button>
      </div>
      <nav class="sidebar-nav" id="sidebar-nav">
        ${pages.map(p => this.#pageItem(p)).join('')}
        <div class="sidebar-divider"></div>
        <div style="padding:10px 16px;">
          <div style="color:rgba(255,255,255,.6);font-size:.75rem;font-weight:700;margin-bottom:6px;white-space:nowrap;overflow:hidden;">
            ${role?.emoji ?? '👤'} <span class="sidebar-item-text">${role?.name ?? ''}</span>
          </div>
        </div>
      </nav>
      <div class="sidebar-footer">
        <button class="sidebar-item w-full" id="sidebar-logout" style="color:#f87171;">
          <span class="sidebar-item-icon">🚪</span>
          <span class="sidebar-item-text">تسجيل الخروج</span>
        </button>
      </div>`;

    // Only apply collapsed mode on desktop screens
    if (this.#collapsed && window.innerWidth > 768) {
      sidebar.classList.add('collapsed');
    }

    this.#renderBottomNav(pages);
    this.#bindEvents();
    this.setActive(adminState.get('activePage') ?? 'orders');
  }

  #renderBottomNav(pages) {
    const bNav = document.getElementById('admin-bottom-nav');
    if (!bNav) return;

    // Pick top primary pages for the bottom dock
    const primary = pages.slice(0, 3);
    bNav.innerHTML = `
      ${primary.map(p => `
        <button class="bottom-nav-item" data-page="${p.id}" id="bnav-${p.id}">
          <span class="bottom-nav-icon">${p.icon}</span>
          <span class="bottom-nav-label">${p.label.replace('طلبات ', '').replace('قرطاسية الشاطر', 'القرطاسية')}</span>
          ${p.id === 'orders' ? '<span class="bottom-nav-badge" id="bottom-orders-badge" style="display:none;">0</span>' : ''}
        </button>
      `).join('')}
      <button class="bottom-nav-item" id="bottom-nav-menu" title="القائمة الكاملة">
        <span class="bottom-nav-icon">☰</span>
        <span class="bottom-nav-label">القائمة</span>
      </button>
    `;
  }

  setActive(pageId) {
    document.querySelectorAll('.sidebar-item[data-page]').forEach(btn => 
      btn.classList.toggle('active', btn.dataset.page === pageId)
    );
    document.querySelectorAll('.bottom-nav-item[data-page]').forEach(btn => 
      btn.classList.toggle('active', btn.dataset.page === pageId)
    );
  }

  toggle() {
    if (window.innerWidth <= 768) {
      this.#closeMobile();
      return;
    }
    this.#collapsed = !this.#collapsed;
    document.getElementById('sidebar')?.classList.toggle('collapsed', this.#collapsed);
    localStorage.setItem('adm-sidebar-collapsed', String(this.#collapsed));
  }

  updateBadge(count) { 
    const badge = document.querySelector('.sidebar-item[data-page="orders"] .sidebar-badge'); 
    if (badge) { 
      badge.textContent = count > 0 ? count : ''; 
      badge.style.display = count > 0 ? '' : 'none'; 
      badge.classList.toggle('pulse', count > 0);
    }
    const bBadge = document.getElementById('bottom-orders-badge');
    if (bBadge) {
      bBadge.textContent = count > 0 ? count : '';
      bBadge.style.display = count > 0 ? '' : 'none';
    }
  }

  #getVisiblePages() {
    return PAGES.filter(p => {
      if (p.always) return true;
      if (p.manager) return isManager();
      if (p.perm) return isManager() || hasPermission(p.perm);
      return false;
    });
  }

  #pageItem(page) {
    const badge = page.id === 'orders' ? '<span class="sidebar-badge" style="display:none;">0</span>' : '';
    return `<button class="sidebar-item" data-page="${page.id}"><span class="sidebar-item-icon">${page.icon}</span><span class="sidebar-item-text">${page.label}</span>${badge}</button>`;
  }

  #bindEvents() {
    document.getElementById('sidebar-nav')?.addEventListener('click', e => {
      const btn = e.target.closest('.sidebar-item[data-page]');
      if (!btn) return;
      const page = btn.dataset.page;
      adminState.set('activePage', page);
      this.setActive(page);
      this.#onNavigate?.(page);
      this.#closeMobile();
    });

    document.getElementById('sidebar-toggle')?.addEventListener('click', () => this.toggle());
    
    document.getElementById('sidebar-logout')?.addEventListener('click', () => {
      this.#closeMobile();
      this.#onNavigate?.('__logout__');
    });

    // Bottom navigation clicks on mobile
    document.getElementById('admin-bottom-nav')?.addEventListener('click', e => {
      const btn = e.target.closest('.bottom-nav-item');
      if (!btn) return;
      if (btn.id === 'bottom-nav-menu') {
        const sb = document.getElementById('sidebar');
        const ov = document.getElementById('sidebar-overlay');
        const isOpen = sb?.classList.contains('mobile-open');
        sb?.classList.toggle('mobile-open', !isOpen);
        ov?.classList.toggle('show', !isOpen);
        return;
      }
      const page = btn.dataset.page;
      if (page) {
        adminState.set('activePage', page);
        this.setActive(page);
        this.#onNavigate?.(page);
        this.#closeMobile();
      }
    });
  }

  #closeMobile() {
    document.getElementById('sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebar-overlay')?.classList.remove('show');
  }
}

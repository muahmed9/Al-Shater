class AppState {
  #data = {};
  #listeners = {};
  constructor(init = {}) { this.#data = { ...init }; }
  get(key) { return this.#data[key]; }
  set(key, value) { const prev = this.#data[key]; this.#data[key] = value; if (prev !== value) this.#notify(key, value, prev); }
  merge(key, part) { const prev = this.#data[key] ?? {}; this.set(key, { ...prev, ...part }); }
  subscribe(key, fn) { if (!this.#listeners[key]) this.#listeners[key] = new Set(); this.#listeners[key].add(fn); return () => this.#listeners[key].delete(fn); }
  #notify(key, nv, ov) { this.#listeners[key]?.forEach(fn => { try { fn(nv, ov); } catch (e) { console.error('[state]', e); } }); }
}

export const customerState = new AppState({
  files: [], printColor: 'c', printSide: '1', packaging: 'none', express: false,
  user: { id: null, name: '', username: '', loyalty_points: 0, total_orders: 0, total_spent: 0, first_order_done: false },
  locationUrl: '', cart: [], suggestedCart: {}, appliedCoupon: null,
  lastOrderId: null, lastOrderTime: 0, pricing: null,
  orderFilter: 'all', marketFilter: 'all', currentStep: 1,
});

export const adminState = new AppState({
  currentUser: null, currentProfile: null, currentRole: '', customPermissions: [],
  allOrders: [], allMarketOrders: [],
  statusFilter: 'all', typeFilter: 'all', mktStatusFilter: 'all', searchQuery: '',
  openOrderId: null, openOrderTgId: null, activePage: 'orders', realtimeChannel: null,
});

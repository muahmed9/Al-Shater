export const Config = Object.freeze({
  SUPABASE: {
    URL: 'https://zrumnqtgdscrwgcguseq.supabase.co',
    ANON_KEY: 'sb_publishable_xEqE6S21QUMCkDxSMvTskg_9g3pi-vZ',
  },
  TELEGRAM: {
    ADMIN_TG_ID: '7618746133',
  },
  TABLES: {
    ORDERS: 'orders',
    USERS: 'users',
    SETTINGS: 'settings',
    PROFILES: 'profiles',
    MARKET_PRODUCTS: 'market_products',
    MARKET_ORDERS: 'market_orders',
    SUPPLIES: 'supplies',
    SUPPLY_LOG: 'supply_log',
    COUPONS: 'coupons',
    RESEARCH: 'research_requests',
  },
  FUNCTIONS: {
    SEND_TG: 'send-tg',
    TG_AUTH: 'telegram-auth',
    CREATE_STAFF: 'create-staff',
  },
  DEFAULT_PRICING: {
    min_pages: 5,
    min_price: 1000,
    c_single: 150,
    c_double: 130,
    bw_single: 90,
    bw_double: 75,
    // Tiered color pricing (e.g. 1-20 pages: 150, 21-50: 125, etc.)
    color_tiers: [
      { min: 1, max: 10, single: 150, double: 130 },
      { min: 11, max: 30, single: 125, double: 110 },
      { min: 31, max: 70, single: 100, double: 90 },
      { min: 71, max: 150, single: 85, double: 75 },
      { min: 151, max: 99999, single: 65, double: 55 }
    ],
    // Tiered Black & White pricing
    bw_tiers: [
      { min: 1, max: 20, single: 90, double: 75 },
      { min: 21, max: 50, single: 75, double: 60 },
      { min: 51, max: 100, single: 60, double: 50 },
      { min: 101, max: 99999, single: 50, double: 40 }
    ],
    delivery_fee: 1000,
    delivery_free_threshold: 10000,
    express_fee: 1500,
    packaging: { none: 0, cardboard: 500, spiral: 1500 },
  },
  ORDER_STATUSES: {
    received: { label: 'مستلم', css: 'sr', icon: '📥' },
    printing: { label: 'قيد الطباعة', css: 'sp', icon: '🖨️' },
    delivering: { label: 'في الطريق', css: 'sd', icon: '🛵' },
    delivered: { label: 'تم التسليم', css: 'sv', icon: '✅' },
    cancelled: { label: 'ملغى', css: 'sc', icon: '❌' },
    pending: { label: 'معلق', css: 'sp', icon: '🕐' },
    ready: { label: 'جاهز', css: 'sd', icon: '✅' },
  },
  STAFF_ROLES: {
    admin: {
      label: 'مدير عام', emoji: '🏢', isManager: true,
      can: ['received→printing', 'printing→delivering', 'delivering→delivered', 'any→cancelled'],
      sees: null,
    },
    operator: {
      label: 'موظف استنساخ', emoji: '🖨️', isManager: false,
      can: ['received→printing', 'printing→delivering', 'received→cancelled', 'printing→cancelled'],
      sees: ['received', 'printing', 'delivering', 'cancelled'],
    },
    driver: {
      label: 'مندوب توصيل', emoji: '🛵', isManager: false,
      can: ['delivering→delivered'],
      sees: ['printing', 'delivering', 'delivered', 'cancelled'],
    },
    preparer: {
      label: 'مجهّز طلبات', emoji: '🎁', isManager: false,
      can: [], sees: ['received', 'printing'], extra: ['confirm_ready'],
    },
    storekeeper: {
      label: 'أمين مخزن', emoji: '🏪', isManager: false,
      can: [], sees: null, extra: ['manage_supplies'],
    },
  },
  customerMessage(orderId, status, cancelReason = '') {
    const shortId = orderId ? String(orderId).slice(0, 8) : '';
    const msgs = {
      received: `✨ <b>تم استلام طلبك بنجاح</b> ✨\n\n📦 رقم الطلب: #${shortId}\n\nشكراً لاختيارك "الشاطر". فريقنا سيبدأ بتجهيز طلبك قريباً جداً. 🚀`,
      printing: `✨ <b>تحديث طلبك من الشاطر</b> ✨\n\n🖨️ طلبك #${shortId} قيد الطباعة الآن!\n\nنحن نهتم بأدق التفاصيل لضمان أفضل جودة لك. سنُخطرك فور إرساله مع المندوب. 💫`,
      delivering: `✨ <b>تحديث طلبك من الشاطر</b> ✨\n\n🛵 طلبك #${shortId} في الطريق إليك!\n\nالمندوب متجه نحوك الآن، يرجى البقاء على مقربة من هاتفك. 🏃‍♂️💨`,
      delivered: `✨ <b>تحديث طلبك من الشاطر</b> ✨\n\n✅ تم تسليم طلبك #${shortId} بنجاح!\n\nشكراً لثقتك بنا. نتمنى أن تنال خدمتنا رضاك. 🌟\n💎 تمت إضافة نقاط الولاء لرصيدك!`,
      cancelled: `⚠️ <b>تحديث طلبك من الشاطر</b> ⚠️\n\n❌ نعتذر منك، تم إلغاء طلبك #${shortId}.\n\n📋 السبب: ${cancelReason}\n\n📞 للاستفسار أو إعادة الطلب:\n📱 07752564099\n💬 <a href="https://wa.me/9647752564099">مراسلتنا على واتساب</a>`,
    };
    return msgs[status] || '';
  },
  APP: {
    ORDER_COOLDOWN_MS: 60_000,
    SEARCH_DEBOUNCE_MS: 300,
    TOAST_DURATION_MS: 3500,
    BANNER_DURATION_MS: 4500,
    MAX_SAVED_ADDRESSES: 6,
    STORAGE_KEYS: {
      DARK_MODE_CUSTOMER: 'sh-dark',
      DARK_MODE_ADMIN: 'adm-dark',
      ONBOARDING_DONE: 'sh-ob',
      RATED_ORDERS: 'sh-rated',
      SAVED_ADDRESSES: 'sh-addrs',
    },
  },
});

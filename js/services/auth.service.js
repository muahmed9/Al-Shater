import { sb }         from '../core/supabase.js';
import { Config }     from '../core/config.js';
import { adminState } from '../core/state.js';

const { STAFF_ROLES, FUNCTIONS } = Config;

export async function adminLogin(email, password) {
  if (!email?.trim() || !password) throw new Error('يرجى إدخال البريد الإلكتروني وكلمة المرور');
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (error) throw new Error(_translateAuthError(error.message));
  const profile = await _fetchProfile(data.user.id);
  if (!profile) { await sb.auth.signOut(); throw new Error('لا يوجد صلاحيات مرتبطة بهذا الحساب. تواصل مع المدير.'); }
  _applyProfileToState(data.user, profile);
  return { user: data.user, profile };
}

export async function checkExistingSession() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const profile = await _fetchProfile(session.user.id);
    if (!profile) return null;
    _applyProfileToState(session.user, profile);
    return { user: session.user, profile };
  } catch(e) { console.warn('[auth]', e.message); return null; }
}

export async function adminLogout() {
  const channel = adminState.get('realtimeChannel');
  if (channel) { try { sb.removeChannel(channel); } catch {} }
  await sb.auth.signOut();
  adminState.set('currentUser', null); adminState.set('currentProfile', null);
  adminState.set('currentRole', '');   adminState.set('customPermissions', []);
  adminState.set('realtimeChannel', null);
}

export async function authenticateTelegramUser() {
  const tg = window.Telegram?.WebApp;
  const initData = tg?.initData;
  if (!initData) { console.info('[auth] وضع ضيف'); return false; }
  try {
    const { data: authData, error: authErr } = await sb.functions.invoke(FUNCTIONS.TG_AUTH, { body: { initData } });
    if (authErr || !authData?.session) { console.warn('[auth] فشل:', authErr?.message); return false; }
    await sb.auth.setSession(authData.session);
    return true;
  } catch(e) { console.error('[auth]', e.message); return false; }
}

export function canChangeStatus(fromStatus, toStatus) {
  const role  = adminState.get('currentRole');
  const perms = adminState.get('customPermissions') || [];
  const allowed = role === 'custom' ? perms : (STAFF_ROLES[role]?.can ?? []);
  if (allowed.includes(`${fromStatus}→${toStatus}`)) return true;
  if (toStatus === 'cancelled' && allowed.includes('any→cancelled')) return true;
  return false;
}

export function hasPermission(permission) {
  const role  = adminState.get('currentRole');
  const perms = adminState.get('customPermissions') || [];
  if (role === 'admin') return true;
  if (STAFF_ROLES[role]?.extra?.includes(permission)) return true;
  if (role === 'custom' && perms.includes(permission)) return true;
  return false;
}

export function isManager() {
  const role = adminState.get('currentRole');
  return STAFF_ROLES[role]?.isManager === true || role === 'admin';
}

export function canSeeStatus(orderStatus) {
  const role = adminState.get('currentRole');
  const sees = STAFF_ROLES[role]?.sees;
  if (sees === null) return true;
  if (role === 'custom') return true;
  return sees?.includes(orderStatus) ?? false;
}

async function _fetchProfile(userId) {
  try {
    const { data, error } = await sb.from(Config.TABLES.PROFILES).select('role,name,emoji,permissions').eq('id', userId).single();
    if (error || !data) return null;
    return data;
  } catch { return null; }
}

function _applyProfileToState(user, profile) {
  adminState.set('currentUser',    user);
  adminState.set('currentProfile', profile);
  adminState.set('currentRole',    profile.role);
  adminState.set('customPermissions', profile.role === 'custom' ? (profile.permissions ?? []) : []);
}

function _translateAuthError(msg) {
  const map = {
    'Invalid login credentials': 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
    'Email not confirmed':        'يرجى تأكيد البريد الإلكتروني أولاً',
    'Too many requests':          'محاولات كثيرة — انتظر قليلاً ثم حاول مجدداً',
    'User not found':             'لا يوجد حساب بهذا البريد الإلكتروني',
    'Invalid email':              'صيغة البريد الإلكتروني غير صحيحة',
  };
  return map[msg] ?? msg;
}

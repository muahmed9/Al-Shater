import { Config } from './config.js';

export function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}
export function sanitize(str, maxLen = 500) {
  if (!str) return '';
  return String(str).replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
}
export function formatPrice(amount) {
  if (amount == null || isNaN(amount)) return '0 د.ع';
  return Number(amount).toLocaleString('ar-IQ') + ' د.ع';
}
export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr), now = new Date(), diff = now - d;
  const pad = n => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff < 86_400_000 && d.getDate() === now.getDate()) return `اليوم ${time}`;
  if (diff < 172_800_000) return `أمس ${time}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
export function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'الآن';
  if (mins < 60) return `منذ ${mins} دقيقة`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `منذ ${hrs} ساعة`;
  return `منذ ${Math.floor(hrs / 24)} يوم`;
}
export function el(id) { const e = document.getElementById(id); if (!e) throw new Error(`#${id} غير موجود`); return e; }
export function qs(sel, root = document) { const e = root.querySelector(sel); if (!e) throw new Error(`"${sel}" لم يُطابق`); return e; }
export function qsa(sel, root = document) { return root.querySelectorAll(sel); }
export function show(t, d = 'block') { const e = typeof t === 'string' ? document.getElementById(t) : t; if (e) e.style.display = d; }
export function hide(t) { const e = typeof t === 'string' ? document.getElementById(t) : t; if (e) e.style.display = 'none'; }
export function debounce(fn, delay = Config.APP.SEARCH_DEBOUNCE_MS) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}
export function throttle(fn, limit) {
  let last = 0;
  return (...args) => { const now = Date.now(); if (now - last >= limit) { last = now; fn(...args); } };
}
export function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB']; let i = 0, size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
export function getExt(filename) { return (filename.split('.').pop() || '').toLowerCase(); }
export function isAllowedFile(file) {
  return ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'jpg', 'jpeg', 'png', 'webp'].includes(getExt(file.name));
}
export function uid() { return Math.random().toString(36).slice(2, 8); }
export async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta); return ok;
  }
}
export function isValidIraqiPhone(phone) { return /^07[0-9]{9}$/.test(phone?.trim() ?? ''); }
export function isValidName(name) { return (name?.trim().length ?? 0) >= 2 && (name?.trim().length ?? 0) <= 60; }

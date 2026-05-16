import { Config } from '../core/config.js';
let _toastTimer = null;
export function showToast(message, type = 'info', duration = Config.APP.TOAST_DURATION_MS) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  const colors = { info: 'var(--navy)', success: 'var(--green)', error: 'var(--red)', warning: 'var(--orange)' };
  el.style.background = colors[type] ?? colors.info;
  el.textContent = message;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

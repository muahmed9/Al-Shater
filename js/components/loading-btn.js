export async function withLoading(buttonOrId, asyncFn, loadingText) {
  const btn = typeof buttonOrId === 'string' ? document.getElementById(buttonOrId) : buttonOrId;
  if (!btn) return asyncFn();
  const originalText = btn.innerHTML;
  const originalDisabled = btn.disabled;
  const text = loadingText ?? btn.dataset.loadingText ?? 'جاري الإرسال ⏳...';
  btn.disabled = true;
  btn.innerHTML = text;
  btn.classList.add('loading');
  try { return await asyncFn(); }
  finally { btn.disabled = originalDisabled; btn.innerHTML = originalText; btn.classList.remove('loading'); }
}

export function initLoadingButtons() {
  document.querySelectorAll('[data-async-action]').forEach(btn => {
    const actionName = btn.dataset.asyncAction;
    btn.addEventListener('click', async e => {
      e.preventDefault();
      const fn = window.__actions?.[actionName];
      if (typeof fn !== 'function') { console.warn(`[loading-btn] "${actionName}" غير موجودة`); return; }
      await withLoading(btn, fn);
    });
  });
}

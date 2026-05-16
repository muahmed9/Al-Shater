export class Modal {
  static open(id) { const el = document.getElementById(id); if (!el) return; el.classList.add('open'); document.body.style.overflow = 'hidden'; }
  static close(id) { const el = document.getElementById(id); if (!el) return; el.classList.remove('open'); if (!document.querySelector('.modal-overlay.open')) document.body.style.overflow = ''; }
  static closeAll() { document.querySelectorAll('.modal-overlay.open').forEach(el => el.classList.remove('open')); document.body.style.overflow = ''; }
  static init() {
    document.addEventListener('click', e => {
      if (e.target.closest('.modal-close')) { const o = e.target.closest('.modal-overlay'); if (o) Modal.close(o.id); }
    });
    document.addEventListener('click', e => { if (e.target.classList.contains('modal-overlay')) Modal.close(e.target.id); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') Modal.closeAll(); });
  }
}

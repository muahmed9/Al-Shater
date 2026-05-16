export class QtyControl {
  #id; #value; #min; #max; #onChange; #element = null;
  constructor({ id, value = 1, min = 0, max = 999, onChange = () => { } }) {
    this.#id = id; this.#value = Math.min(Math.max(value, min), max); this.#min = min; this.#max = max; this.#onChange = onChange;
  }
  render() {
    const wrap = document.createElement('div');
    wrap.className = 'qty-ctrl'; wrap.dataset.id = this.#id;
    wrap.innerHTML = this.#buildHTML();
    wrap.querySelector('.qty-dec').addEventListener('click', e => { e.stopPropagation(); this.#adjust(-1); });
    wrap.querySelector('.qty-inc').addEventListener('click', e => { e.stopPropagation(); this.#adjust(+1); });
    this.#element = wrap; this.#syncUI(); return wrap;
  }
  setValue(v) { this.#value = Math.min(Math.max(v, this.#min), this.#max); this.#syncUI(); }
  getValue() { return this.#value; }

  static html({ id, value = 1, min = 0, max = 999 }) {
    const decDisabled = value <= min ? 'disabled' : '';
    const incDisabled = value >= max ? 'disabled' : '';
    return `<div class="qty-ctrl" data-id="${id}" data-min="${min}" data-max="${max}"><button class="qty-btn qty-dec" ${decDisabled} aria-label="تقليل">−</button><span class="qty-val">${value}</span><button class="qty-btn qty-inc" ${incDisabled} aria-label="زيادة">+</button></div>`;
  }

  static delegate(container, onAdjust) {
    container.addEventListener('click', e => {
      const btn = e.target.closest('.qty-btn');
      if (!btn) return;
      e.stopPropagation();
      const wrap = btn.closest('.qty-ctrl'); if (!wrap) return;
      const id = wrap.dataset.id, min = Number(wrap.dataset.min ?? 0), max = Number(wrap.dataset.max ?? 999);
      const valEl = wrap.querySelector('.qty-val'); if (!valEl) return;
      let cur = parseInt(valEl.textContent, 10) || 0;
      const delta = btn.classList.contains('qty-dec') ? -1 : +1;
      const next = Math.min(Math.max(cur + delta, min), max);
      valEl.textContent = next;
      wrap.querySelector('.qty-dec').disabled = next <= min;
      wrap.querySelector('.qty-inc').disabled = next >= max;
      onAdjust(id, delta, next);
    });
  }

  #adjust(delta) {
    const next = Math.min(Math.max(this.#value + delta, this.#min), this.#max);
    if (next === this.#value) return;
    this.#value = next; this.#syncUI(); this.#onChange(this.#value, this.#id);
  }
  #buildHTML() { return `<button class="qty-btn qty-dec" aria-label="تقليل">−</button><span class="qty-val">${this.#value}</span><button class="qty-btn qty-inc" aria-label="زيادة">+</button>`; }
  #syncUI() {
    if (!this.#element) return;
    const v = this.#element.querySelector('.qty-val');
    const d = this.#element.querySelector('.qty-dec');
    const i = this.#element.querySelector('.qty-inc');
    if (v) v.textContent = this.#value;
    if (d) d.disabled = this.#value <= this.#min;
    if (i) i.disabled = this.#value >= this.#max;
  }
}

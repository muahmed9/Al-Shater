import { customerState } from '../core/state.js';

export class Stepper {
  #totalSteps; #currentStep = 1; #validators = {}; #onStepChange = null;
  constructor(totalSteps = 4, onStepChange = null) {
    this.#totalSteps = totalSteps;
    this.#onStepChange = onStepChange;
    customerState.set('currentStep', 1);
  }
  setValidator(step, fn) { this.#validators[step] = fn; }
  next() {
    const result = this.#validate(this.#currentStep);
    if (result !== true) return result;
    if (this.#currentStep < this.#totalSteps) this.#goTo(this.#currentStep + 1);
    return true;
  }
  prev() { if (this.#currentStep > 1) this.#goTo(this.#currentStep - 1); }
  goTo(step) { if (step >= 1 && step < this.#currentStep) this.#goTo(step); }
  get current() { return this.#currentStep; }
  reset() { this.#currentStep = 1; customerState.set('currentStep', 1); this.render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  renderHeader() {
    document.querySelectorAll('.step-item').forEach((item, i) => {
      const step = i + 1;
      item.classList.remove('done', 'active', 'locked');
      if (step < this.#currentStep) item.classList.add('done');
      else if (step === this.#currentStep) item.classList.add('active');
      else item.classList.add('locked');
    });
  }
  renderPanels() { document.querySelectorAll('.step-panel').forEach((p, i) => p.classList.toggle('active', i + 1 === this.#currentStep)); }
  renderNav() {
    const prevBtn = document.getElementById('stepper-prev');
    const nextBtn = document.getElementById('stepper-next');
    const submitBtn = document.getElementById('stepper-submit');
    if (prevBtn) prevBtn.style.display = this.#currentStep > 1 ? '' : 'none';
    if (nextBtn) nextBtn.style.display = this.#currentStep < this.#totalSteps ? '' : 'none';
    if (submitBtn) submitBtn.style.display = this.#currentStep === this.#totalSteps ? '' : 'none';
  }
  render() { this.renderHeader(); this.renderPanels(); this.renderNav(); }
  #goTo(step) {
    this.#currentStep = step;
    customerState.set('currentStep', step);
    this.render();
    this.#onStepChange?.(step);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  #validate(step) { const fn = this.#validators[step]; if (!fn) return true; return fn() ?? true; }
}

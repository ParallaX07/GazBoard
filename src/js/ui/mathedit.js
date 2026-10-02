// The maths editor: the LaTeX, a live preview of it, and a palette of the
// symbols and shapes people reach for, for anyone who does not know the
// commands by heart.
//
// It opens under the maths box being edited (or in the middle of the board
// for a new one), and the box is only changed when you finish: Done, Enter,
// or a click anywhere else. Escape walks away and leaves the box as it was.
// A new box that is left empty is simply never made.

import { h } from './popover.js';
import { t } from '../i18n.js';
import { toHtml, loadKatex } from '../core/maths.js';

/*
 * The palette. Each entry is [what the button shows, the LaTeX it puts in].
 * In the LaTeX, @ is where the cursor lands afterwards - inside the first
 * empty box - and if some text was selected, that text goes there instead,
 * so selecting "x+1" and pressing the root button gives \sqrt{x+1}.
 */
export const MATH_PALETTE = [
  { name: 'Structures', items: [
    ['a⁄b', '\\frac{@}{}'], ['√', '\\sqrt{@}'], ['ⁿ√', '\\sqrt[n]{@}'], ['x²', '^{@}', 'x^{2}'], ['xᵢ', '_{@}', 'x_{i}'],
    ['∑', '\\sum_{i=1}^{n} @', '\\sum'], ['∏', '\\prod_{i=1}^{n} @', '\\prod'], ['∫', '\\int_{a}^{b} @\\,dx', '\\int'], ['lim', '\\lim_{x \\to \\infty} @', '\\lim'],
    ['log', '\\log_{2} @', '\\log_2'], ['( )', '\\left( @ \\right)'], ['⌊ ⌋', '\\lfloor @ \\rfloor'], ['⌈ ⌉', '\\lceil @ \\rceil'],
    ['[ ]', '\\begin{bmatrix} @ & \\\\ & \\end{bmatrix}', ''], ['{ cases', 'f(x) = \\begin{cases} @ & \\text{if } \\\\ & \\text{otherwise} \\end{cases}', ''],
    ['x̄', '\\bar{@}'], ['x⃗', '\\vec{@}'], ['abc', '\\text{@}']
  ] },
  { name: 'Greek', items: [
    ['α', '\\alpha'], ['β', '\\beta'], ['γ', '\\gamma'], ['δ', '\\delta'], ['ε', '\\epsilon'], ['θ', '\\theta'], ['λ', '\\lambda'],
    ['μ', '\\mu'], ['π', '\\pi'], ['ρ', '\\rho'], ['σ', '\\sigma'], ['τ', '\\tau'], ['φ', '\\phi'], ['ω', '\\omega'],
    ['Γ', '\\Gamma'], ['Δ', '\\Delta'], ['Θ', '\\Theta'], ['Λ', '\\Lambda'], ['Π', '\\Pi'], ['Σ', '\\Sigma'], ['Φ', '\\Phi'], ['Ω', '\\Omega']
  ] },
  { name: 'Symbols', items: [
    ['±', '\\pm'], ['×', '\\times'], ['÷', '\\div'], ['·', '\\cdot'], ['≤', '\\le'], ['≥', '\\ge'], ['≠', '\\ne'], ['≈', '\\approx'],
    ['≡', '\\equiv'], ['∞', '\\infty'], ['→', '\\to'], ['⇒', '\\Rightarrow'], ['⇔', '\\Leftrightarrow'], ['∈', '\\in'], ['∉', '\\notin'],
    ['⊂', '\\subset'], ['⊆', '\\subseteq'], ['∪', '\\cup'], ['∩', '\\cap'], ['∅', '\\emptyset'], ['∀', '\\forall'], ['∃', '\\exists'],
    ['¬', '\\neg'], ['∧', '\\land'], ['∨', '\\lor'], ['∂', '\\partial'], ['∇', '\\nabla'], ['°', '^{\\circ}'], ['…', '\\ldots'],
    ['O(n)', 'O(@)'], ['Θ(n)', '\\Theta(@)'], ['ℝ', '\\mathbb{R}'], ['ℕ', '\\mathbb{N}'], ['ℤ', '\\mathbb{Z}']
  ] }
];

const GROUP_LABEL = { Structures: () => t('Structures'), Greek: () => t('Greek'), Symbols: () => t('Symbols') };

/** Put `tex` into a textarea at its selection, the way a palette button does. */
export function insertTemplate(area, tex) {
  const s = area.selectionStart ?? area.value.length, e = area.selectionEnd ?? s;
  const picked = area.value.slice(s, e);
  const at = tex.indexOf('@');
  let piece = tex.replace('@', picked);
  // a bare command needs a space after it before the next letter, or \pix is one (unknown) command
  if (at < 0 && /\\[a-zA-Z]+$/.test(piece) && /^[a-zA-Z]/.test(area.value.slice(e))) piece += ' ';
  area.value = area.value.slice(0, s) + piece + area.value.slice(e);
  const caret = at < 0 ? s + piece.length : s + at + picked.length;
  area.setSelectionRange(picked && at >= 0 ? s + at : caret, caret);
  area.dispatchEvent(new Event('input'));
}

export class MathEditor {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.target = null;           // { id } for a box being edited, or { at } for a new one
    this._outside = (e) => {
      if (!this.el || this.el.contains(e.target)) return;
      this.finish();
    };
  }

  get active() { return !!this.el; }
  get value() { return this.area ? this.area.value : ''; }
  set value(v) { if (this.area) { this.area.value = v; this.area.dispatchEvent(new Event('input')); } }

  /**
   * Open the editor.
   * @param {{id?: string, at?: {x:number,y:number}}} target  a box to edit, or a board point for a new one
   */
  open(target) {
    this.close();
    const app = this.app;
    const obj = target.id ? app.store.get(target.id) : null;
    this.target = target;
    this.original = obj ? String(obj.tex || '') : '';

    const area = h('textarea', { class: 'mx-src', rows: '2', dir: 'ltr', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off',
      'aria-label': t('LaTeX'), placeholder: t('Type LaTeX, e.g. \\frac{a}{b} or x^2 + y^2 = r^2') });
    area.value = this.original;
    const preview = h('div', { class: 'mx-preview', dir: 'ltr', 'aria-live': 'polite' });
    const error = h('div', { class: 'mx-error' });
    let seq = 0;
    const show = async () => {
      const mine = ++seq;
      const tex = area.value;
      if (!tex.trim()) { preview.innerHTML = ''; preview.appendChild(h('span', { class: 'mx-empty' }, t('The preview appears here'))); error.textContent = ''; return; }
      try {
        const r = await toHtml(tex);
        if (mine !== seq) return;
        preview.innerHTML = r.html;
        error.textContent = r.error ? t('Not quite LaTeX yet: {why}', { why: r.error.replace(/^(ParseError:\s*)?KaTeX parse error:\s*/, '') }) : '';
      } catch {
        if (mine === seq) error.textContent = t('Maths could not be loaded');
      }
    };
    let timer = null;
    area.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(show, 90); });
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancel(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.finish(); }
    });

    const tabs = h('div', { class: 'mx-tabs', role: 'tablist' });
    const grid = h('div', { class: 'mx-palette' });
    const showGroup = (g) => {
      for (const b of tabs.children) b.classList.toggle('on', b.dataset.group === g.name);
      grid.innerHTML = '';
      for (const [label, tex, shownTex] of g.items) {
        const b = h('button', { type: 'button', class: 'mx-key', title: tex.replace('@', '…'), 'data-tex': tex }, label);
        // The button shows the real thing, typeset, once KaTeX is here; the plain label stands in until then.
        if (window.katex && g.name === 'Structures' && shownTex !== '') {
          try {
            const shown = shownTex ?? tex.replace('@', 'x').replace(/\{\}/g, '{y}').replace('\\text{x}', '\\text{abc}');
            b.innerHTML = window.katex.renderToString(shown, { throwOnError: true, displayMode: false });
            b.classList.add('typeset');
          } catch { /* keep the plain label */ }
        }
        // keep the textarea's selection: a palette press must not take the focus away first
        b.addEventListener('pointerdown', (e) => e.preventDefault());
        b.addEventListener('click', () => { area.focus(); insertTemplate(area, tex); });
        grid.appendChild(b);
      }
    };
    for (const g of MATH_PALETTE) {
      const b = h('button', { type: 'button', class: 'mx-tab', role: 'tab', 'data-group': g.name }, GROUP_LABEL[g.name]());
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => showGroup(g));
      tabs.appendChild(b);
    }

    const done = h('button', { type: 'button', class: 'btn primary', 'data-math-done': '1' }, t('Done'));
    done.addEventListener('click', () => this.finish());
    const cancel = h('button', { type: 'button', class: 'btn' }, t('Cancel'));
    cancel.addEventListener('click', () => this.cancel());

    this.el = h('div', { class: 'math-editor', id: 'mathEditor', role: 'dialog', 'aria-label': t('Maths') },
      h('div', { class: 'mx-head' }, h('b', {}, t('Maths')), h('small', {}, t('Enter to finish · Shift+Enter for a new line · Esc to cancel'))),
      area, preview, error, tabs, grid,
      h('div', { class: 'mx-actions' }, h('small', { class: 'mx-tip' }, t('Tip: in any text, $x^2$ puts maths in a sentence.')), cancel, done));
    this.area = area;
    document.getElementById('stage').appendChild(this.el);
    showGroup(MATH_PALETTE[0]);
    this.place();
    loadKatex().then(() => { show(); showGroup(MATH_PALETTE.find((g) => tabs.querySelector('.on')?.dataset.group === g.name) || MATH_PALETTE[0]); }).catch(() => { error.textContent = t('Maths could not be loaded'); });
    show();
    setTimeout(() => { area.focus(); area.setSelectionRange(area.value.length, area.value.length); }, 0);
    // a click anywhere else on the page finishes, the way leaving a text box does
    setTimeout(() => document.addEventListener('pointerdown', this._outside, true), 0);
    app.syncUI?.();
  }

  /** Under the box being edited, or in the middle of the board for a new one; always on screen. */
  place() {
    if (!this.el) return;
    const app = this.app, stage = document.getElementById('stage').getBoundingClientRect();
    const el = this.el;
    const narrow = stage.width < 560;
    el.classList.toggle('docked', narrow);
    if (narrow) { el.style.left = ''; el.style.top = ''; return; }
    const o = this.target.id ? app.store.get(this.target.id) : null;
    const w = el.offsetWidth, hh = el.offsetHeight;
    let x, y;
    if (o) {
      const a = app.surface.cam.toScreen(o.x, o.y), b = app.surface.cam.toScreen(o.x + o.w, o.y + o.h);
      x = (a.x + b.x) / 2 - w / 2;
      y = Math.max(a.y, b.y) + 14;
      if (y + hh > stage.height - 8) y = Math.min(a.y, b.y) - hh - 14;
    } else {
      x = stage.width / 2 - w / 2;
      y = stage.height / 2 - hh / 2;
    }
    el.style.left = Math.round(Math.max(8, Math.min(stage.width - w - 8, x))) + 'px';
    el.style.top = Math.round(Math.max(8, Math.min(stage.height - hh - 8, y))) + 'px';
  }

  /** Keep what was typed. */
  finish() {
    if (!this.el) return;
    const target = this.target, tex = this.area.value;
    this.close();
    return this.app.commitMath(target, tex, this.original);
  }

  /** Leave the box as it was. */
  cancel() { this.close(); }

  close() {
    document.removeEventListener('pointerdown', this._outside, true);
    if (this.el) { this.el.remove(); this.el = null; this.area = null; this.app.syncUI?.(); }
  }
}

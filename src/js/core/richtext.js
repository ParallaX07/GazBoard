// Rich text: words that remember their own style.
//
// Every piece of text on the board - a text box, a note, a shape's label, a
// table cell - has always been one plain string, drawn in one style. That
// string stays exactly where it was (`o.text`, `o.cells[key]`), and it stays
// the whole truth about WHAT the words are. What is new is an optional list of
// RUNS alongside it, which says how each stretch of those words looks:
//
//     text: "Newton's second law"
//     runs: [{ t: "Newton's " }, { t: "second law", b: 1, c: "#e81123" }]
//
// A run's flags are b (bold), i (italic), u (underline) and c (a colour). A
// flag that is missing means "as the box is": a box that is bold all over
// keeps its bold words bold. A flag set to 0 means "not, even though the box
// is" - so one word in a bold box can be plain.
//
// The runs are only believed when their letters add up to exactly the text.
// That single rule is what keeps every older path safe: a board from before
// this, a copy of GazBoard that has never heard of runs editing the text over
// sync, an importer that writes `text` and nothing else - in each case the
// runs no longer match, and the words are simply drawn plain, the way they
// always were. Nothing can ever show words that are not in the text.
//
// A text with no styled run at all stores no runs, so boards that never use
// any of this are byte-for-byte what they were.

import { mathEntry, mathSpans, inlineFit } from './maths.js';

const KEYS = ['b', 'i', 'u', 'c'];

/** Two runs look the same. */
export function sameStyle(a, b) {
  for (const k of KEYS) if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  return true;
}

/** Does this run carry any style of its own? */
export function isStyled(r) {
  for (const k of KEYS) if (r[k] !== undefined && r[k] !== null) return true;
  return false;
}

/** Only the style of a run, without its letters. */
export function styleOf(r) {
  const st = {};
  for (const k of KEYS) if (r[k] !== undefined && r[k] !== null) st[k] = r[k];
  return st;
}

/** The letters of a list of runs. */
export function runsText(runs) {
  let s = '';
  for (const r of runs || []) s += r.t || '';
  return s;
}

/**
 * The tidy form of a list of runs: neighbours that look alike merged, empty
 * ones dropped. Null when nothing in it is styled, because plain text needs
 * no runs at all.
 */
export function normalizeRuns(runs) {
  if (!Array.isArray(runs)) return null;
  const out = [];
  for (const r of runs) {
    if (!r || typeof r.t !== 'string' || !r.t) continue;
    const run = { t: r.t, ...styleOf(r) };
    const last = out[out.length - 1];
    if (last && sameStyle(last, run)) last.t += run.t;
    else out.push(run);
  }
  return out.some(isStyled) ? out : null;
}

/** The runs, if they still describe exactly this text; otherwise none. */
export function validRuns(runs, text) {
  if (!Array.isArray(runs) || !runs.length) return null;
  return runsText(runs) === String(text ?? '') ? runs : null;
}

/** The runs of an object, or of one table cell in it, when they can be trusted. */
export function objectRuns(o, cell = null) {
  if (!o) return null;
  if (cell) return validRuns(o.cellRuns?.[cell], o.cells?.[cell]);
  return validRuns(o.runs, o.text);
}

/** How a stretch actually looks, once the box's own style has had its say. */
export function effective(st, base) {
  return {
    bold: st.b === undefined || st.b === null ? !!base.bold : !!st.b,
    italic: st.i === undefined || st.i === null ? !!base.italic : !!st.i,
    underline: st.u === undefined || st.u === null ? !!base.underline : !!st.u,
    color: st.c || base.color
  };
}

export function fontFor(eff, base, size = base.size) {
  return `${eff.italic ? 'italic ' : ''}${eff.bold ? '600' : (base.weight || '400')} ${size}px ${base.family}`;
}

/*
 * Cut the runs into paragraphs, and each paragraph into the units a line can
 * break between: a WORD (every letter up to the next space, even when the
 * word changes style halfway, so "re**write**" never splits at the bold) or
 * a stretch of spaces.
 */
function paragraphs(runs) {
  const paras = [[]];
  for (const r of runs) {
    const st = styleOf(r);
    const pieces = String(r.t).split('\n');
    pieces.forEach((piece, i) => {
      if (i) paras.push([]);
      if (piece) paras[paras.length - 1].push({ t: piece, st });
    });
  }
  return paras.map((pieces) => {
    const units = [];
    for (const p of mathTokens(pieces)) {
      if (p.math != null) {
        // A formula is one unbreakable piece of whatever word it sits in.
        const last = units[units.length - 1];
        if (last && !last.space) last.parts.push(p);
        else units.push({ space: false, parts: [p] });
        continue;
      }
      for (const tok of p.t.split(/(\s+)/)) {
        if (!tok) continue;
        const space = /^\s+$/.test(tok);
        const last = units[units.length - 1];
        if (last && last.space === space) last.parts.push({ t: tok, st: p.st });
        else units.push({ space, parts: [{ t: tok, st: p.st }] });
      }
    }
    return units;
  });
}

/*
 * Cut a paragraph's pieces at its $...$ stretches. Each stretch becomes one
 * piece carrying its LaTeX (and the style of its first letter); the words
 * around it stay as they were. A stretch may cross a change of style - the
 * maths just takes the style it started in.
 */
function mathTokens(pieces) {
  const text = pieces.map((p) => p.t).join('');
  const spans = mathSpans(text);
  if (!spans.length) return pieces;
  const out = [];
  let off = 0, si = 0;
  for (const p of pieces) {
    const L = p.t.length;
    let a = 0;
    while (a < L) {
      const g = off + a;
      while (si < spans.length && spans[si].end <= g) si++;
      const sp = spans[si];
      if (sp && sp.start <= g) {
        if (g === sp.start) out.push({ t: text.slice(sp.start, sp.end), st: p.st, math: sp.tex });
        a = Math.min(L, sp.end - off);
      } else {
        const stop = sp ? Math.min(L, sp.start - off) : L;
        out.push({ t: p.t.slice(a, stop), st: p.st });
        a = stop;
      }
    }
    off += L;
  }
  return out;
}

/** The colour inline maths is measured in. Its width does not depend on colour. */
const MEASURE_INK = '#201f1e';

/**
 * How wide a formula in a line is: its picture's width once it is ready, the
 * raw $...$ until then (and a repaint, through `onload`, when it arrives).
 */
function mathWidth(ctx, p, base, size, widthOfText) {
  const e = mathEntry(p.math, MEASURE_INK, base.onload, false);
  if (e.status === 'ready' && e.img) return inlineFit(e, size, size * (base.lineHeight || 1.28)).w;
  return widthOfText(p.t, p.st);
}

/** How far below a 'top' baseline the letters sit on their line, for this font. */
const baselines = new Map();
function baselineBelowTop(ctx) {
  const key = ctx.font;
  if (!baselines.has(key)) {
    const was = ctx.textBaseline;
    ctx.textBaseline = 'top';
    const m = ctx.measureText('H');
    ctx.textBaseline = was;
    baselines.set(key, m.actualBoundingBoxDescent || parseFloat(key.match(/(\d+(?:\.\d+)?)px/)?.[1] || 16) * 0.8);
    if (baselines.size > 200) baselines.delete(baselines.keys().next().value);
  }
  return baselines.get(key);
}

/**
 * Lay the runs out in lines no wider than maxW.
 *
 * The same rules the plain text has always followed: break between words,
 * drop the spaces a line would otherwise start with, and chop a word that is
 * wider than the whole box at the last letter that fits.
 *
 * @returns {Array<{segs: Array<{t:string, st:object, w:number}>, w:number}>}
 */
export function layoutRich(ctx, runs, maxW, base, size = base.size) {
  const widthOfText = (t, st) => { ctx.font = fontFor(effective(st, base), base, size); return ctx.measureText(t).width; };
  const widthOf = (t, st, math) => (math != null ? mathWidth(ctx, { t, st, math }, base, size, widthOfText) : widthOfText(t, st));
  const lines = [];
  for (const units of paragraphs(runs)) {
    let line = [], lineW = 0, ink = false;
    const finish = () => {
      while (line.length && /^\s+$/.test(line[line.length - 1].t)) lineW -= line.pop().w;
      const last = line[line.length - 1];
      if (last && last.math == null && /\s$/.test(last.t)) {
        const trimmed = last.t.replace(/\s+$/, '');
        lineW -= last.w - widthOf(trimmed, last.st);
        last.t = trimmed; last.w = widthOf(trimmed, last.st);
      }
      lines.push({ segs: mergeSegs(line), w: Math.max(0, lineW) });
      line = []; lineW = 0; ink = false;
    };
    for (const u of units) {
      const parts = u.parts.map((p) => ({ ...p, w: widthOf(p.t, p.st, p.math) }));
      const uw = parts.reduce((s, p) => s + p.w, 0);
      if (u.space) {
        if (!line.length) continue;                   // no line starts with a space
        line.push(...parts); lineW += uw; continue;
      }
      if (ink && lineW + uw > maxW) finish();
      if (uw > maxW) {
        // Wider than the box on its own: letter by letter, wherever it has to.
        for (const p of parts) {
          if (p.math != null) {                          // a formula is never cut
            if (ink && lineW + p.w > maxW) finish();
            line.push(p); lineW += p.w; ink = true;
            continue;
          }
          for (const ch of Array.from(p.t)) {
            const cw = widthOf(ch, p.st);
            if (ink && lineW + cw > maxW) finish();
            line.push({ t: ch, st: p.st, w: cw }); lineW += cw; ink = true;
          }
        }
        continue;
      }
      line.push(...parts); lineW += uw; ink = true;
    }
    finish();
  }
  // Widths re-measured over whole merged segments, which is what is drawn.
  for (const l of lines) {
    let w = 0;
    for (const s of l.segs) { s.w = widthOf(s.t, s.st, s.math); w += s.w; }
    l.w = w;
  }
  return lines;
}

function mergeSegs(segs) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.math == null && s.math == null && sameStyle(last.st, s.st)) { last.t += s.t; last.w += s.w; }
    else out.push(s.math != null ? { t: s.t, st: s.st, w: s.w, math: s.math } : { t: s.t, st: s.st, w: s.w });
  }
  return out;
}

/** The biggest size, between min and max, at which the runs fit the box. */
export function fitRichSize(ctx, runs, maxW, maxH, base, max = 96, min = 8) {
  let lo = min, hi = max, best = min;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const lines = layoutRich(ctx, runs, maxW, base, mid);
    const h = lines.length * mid * 1.25;
    let widest = 0;
    for (const l of lines) widest = Math.max(widest, l.w);
    if (h <= maxH && widest <= maxW) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/*
 * A line whose first real letter is Arabic (or Hebrew) reads from the right.
 * Its stretches are laid down right to left, so the first thing written sits
 * at the right-hand end the way it does in the plain text.
 */
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿঀ-৿一-鿿]/;
function rtlLine(line) {
  for (const s of line.segs) {
    if (s.math != null) continue;
    for (const ch of s.t) {
      if (RTL.test(ch)) return true;
      if (LTR.test(ch)) return false;
    }
  }
  return false;
}

/**
 * Draw laid-out lines into a box, aligned and placed the same way the plain
 * text is. `paint` turns a stored colour into the one to show (the theme's say
 * over default ink); `lineHeight` matches the plain path.
 */
export function drawRichLines(ctx, lines, x, y, w, h, base, opt = {}) {
  const size = base.size;
  const lh = size * (opt.lineHeight || 1.28);
  const total = lines.length * lh;
  let ty = y;
  if (opt.valign === 'middle') ty = y + (h - total) / 2;
  else if (opt.valign === 'bottom') ty = y + h - total;
  const align = opt.align || 'left';
  const paint = opt.paint || ((c) => c);
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  for (const line of lines) {
    if (ty > y + h + lh) break;
    let lx = align === 'center' ? x + (w - line.w) / 2 : align === 'right' ? x + w - line.w : x;
    const segs = rtlLine(line) ? line.segs.slice().reverse() : line.segs;
    for (const s of segs) {
      const eff = effective(s.st, base);
      ctx.font = fontFor(eff, base, size);
      ctx.fillStyle = paint(eff.color);
      if (s.math != null) {
        const e = mathEntry(s.math, paint(eff.color), opt.onload || base.onload, false);
        if (e.status === 'ready' && e.img) {
          const f = inlineFit(e, size, lh);
          const by = ty + baselineBelowTop(ctx);
          ctx.drawImage(e.img, lx - f.pad, by - e.base * f.k, e.w * f.k, e.h * f.k);
          lx += s.w;
          continue;
        }
      }
      ctx.fillText(s.t, lx, ty);
      if (eff.underline && s.t.trim()) ctx.fillRect(lx, ty + size * 1.05, s.w, Math.max(1, size / 16));
      lx += s.w;
    }
    ty += lh;
  }
  ctx.restore();
}

/*
 * Toggling a style over part of the text, as the format bar and the shortcuts
 * do. Works on character offsets into the plain text, so it needs nothing
 * from the page and the tests can drive it directly.
 */

/** Split runs so that offsets a and b fall on run boundaries. */
function splitAt(runs, offsets) {
  const out = [];
  let pos = 0;
  for (const r of runs) {
    let t = r.t, start = pos;
    const cuts = offsets.filter((o) => o > start && o < start + t.length).sort((p, q) => p - q);
    let prev = 0;
    for (const c of cuts) { out.push({ ...r, t: t.slice(prev, c - start) }); prev = c - start; }
    out.push({ ...r, t: t.slice(prev) });
    pos += t.length;
  }
  return out.filter((r) => r.t);
}

/**
 * Set (or clear, with value null) one style key over [a, b).
 * @returns the new, normalised runs (null when nothing is styled any more)
 */
export function applyStyle(runs, text, a, b, key, value) {
  const base = validRuns(runs, text) || [{ t: String(text ?? '') }];
  const parts = splitAt(base, [a, b]);
  let pos = 0;
  for (const r of parts) {
    const s = pos, e = pos + r.t.length;
    if (s >= a && e <= b && e > s) {
      if (value === null || value === undefined) delete r[key]; else r[key] = value;
    }
    pos = e;
  }
  return normalizeRuns(parts);
}

/** Is every letter in [a, b) showing this style (given the box's own)? */
export function hasStyle(runs, text, a, b, key, base = {}) {
  const list = validRuns(runs, text) || [{ t: String(text ?? '') }];
  const baseOn = { b: !!base.bold, i: !!base.italic, u: !!base.underline }[key];
  let pos = 0, any = false;
  for (const r of list) {
    const s = pos, e = pos + r.t.length;
    pos = e;
    if (e <= a || s >= b) continue;
    any = true;
    const v = r[key];
    const on = v === undefined || v === null ? baseOn : !!v;
    if (!on) return false;
  }
  return any;
}

/* ------------------------------------------------------------------ *
 *  Leaving the board, and arriving on it
 * ------------------------------------------------------------------ */

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Runs as HTML that Word, Google Docs or an email will keep the look of.
 * `base` is the box's own style; a colour of null means "leave it to the
 * other app", which is what the board's automatic ink should become there.
 */
export function runsToHtml(runs, text, base = {}) {
  const list = validRuns(runs, text) || [{ t: String(text ?? '') }];
  let out = '';
  for (const r of list) {
    const eff = effective(r, base);
    const css = [];
    if (eff.bold) css.push('font-weight:bold');
    if (eff.italic) css.push('font-style:italic');
    if (eff.underline) css.push('text-decoration:underline');
    if (eff.color) css.push('color:' + eff.color);
    const body = escHtml(r.t).replace(/\n/g, '<br>');
    out += css.length ? `<span style="${css.join(';')}">${body}</span>` : body;
  }
  return out;
}

/** The board's own ink: black on a light board, light on a dark one. */
export const AUTO_INK = '#201f1e';

/*
 * What a colour from somebody else's page becomes on the board.
 *
 * Black (or near-black grey, or Word's "automatic") becomes the board's own
 * ink - it stays black here, where it was black there, and still turns light
 * on a dark board instead of vanishing. It used to be dropped altogether,
 * which left those words in whatever colour GazBoard's text happened to be
 * set to last: black words from Word arrived red. White or near-white grey -
 * copied from a dark web page - is dropped, or it would vanish on a white
 * board. Every real colour is kept exactly, however dark: a navy heading is
 * navy, not black.
 */
function keepColour(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseInt(v, 16));
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
  const grey = hi - lo < 30;
  if (grey && hi < 80) return AUTO_INK;
  if (grey && lo > 225) return null;
  return hex.toLowerCase();
}

let colourCtx = null;
function toHexColour(v) {
  if (!v || /inherit|initial|currentcolor/i.test(v)) return null;
  if (/windowtext|^\s*auto\s*$/i.test(v)) return '#000000';       // Word's "automatic" is black
  try {
    colourCtx = colourCtx || document.createElement('canvas').getContext('2d');
    colourCtx.fillStyle = '#000001';
    colourCtx.fillStyle = v;
    const got = colourCtx.fillStyle;
    if (got === '#000001') return null;          // not a colour it understood
    return /^#[0-9a-f]{6}$/i.test(got) ? got : null;
  } catch { return null; }
}

const BLOCKS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER']);
const SKIP = new Set(['STYLE', 'SCRIPT', 'HEAD', 'TITLE', 'META', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'IMG', 'SVG', 'svg', 'OBJECT', 'IFRAME']);

/**
 * Somebody else's HTML (Word, a web page, another GazBoard box) as runs.
 *
 * Only what the board can draw is kept: bold, italic, underline and a colour.
 * Fonts, sizes, backgrounds, links and pictures are dropped. Paragraphs and
 * line breaks become new lines; everything else about the layout goes.
 * Returns { text, runs } - runs is null when nothing was styled.
 */
export function htmlToRuns(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const rules = [];
  for (const st of doc.querySelectorAll('style')) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(st.textContent || '');
      for (const r of sheet.cssRules) if (r.selectorText && r.style) rules.push(r);
    } catch { /* a style sheet it cannot read is simply not used */ }
  }
  const out = [];
  const endsWithBreak = () => { const s = out.length ? out[out.length - 1].t : '\n'; return /\n$/.test(s) || !out.length; };
  const lastChar = () => (out.length ? out[out.length - 1].t.slice(-1) : '\n');
  const walk = (node, st, pre) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        let t = ch.data;
        if (!pre) {
          // Ordinary white space collapses the way a page shows it; a
          // non-breaking space is somebody's deliberate space and stays.
          t = t.replace(/[ \t\r\n\f]+/g, ' ');
          if (/\s/.test(lastChar()) || endsWithBreak()) t = t.replace(/^ +/, '');
          t = t.replace(/\u00a0/g, ' ');
        }
        if (t) out.push({ t, ...st });
        continue;
      }
      if (ch.nodeType !== 1) continue;             // comments: Word leaves plenty
      const tag = ch.tagName.toUpperCase();
      if (SKIP.has(ch.tagName) || SKIP.has(tag)) continue;
      if (tag === 'BR') { out.push({ t: '\n', ...st }); continue; }
      const next = { ...st };
      if (tag === 'B' || tag === 'STRONG') next.b = 1;
      if (tag === 'I' || tag === 'EM') next.i = 1;
      if (tag === 'U' || tag === 'INS') next.u = 1;
      if (tag === 'FONT' && ch.getAttribute('color')) {
        const c = keepColour(toHexColour(ch.getAttribute('color')));
        if (c) next.c = c; else delete next.c;
      }
      /*
       * The look can come from the page's own style sheet rather than the
       * element: Word on a phone, and some web editors, write
       * <span class="c3"> and put "c3 { font-weight: bold }" in a <style>
       * block. Those rules are applied first, then the element's own style,
       * so the nearer one wins the way it does on the page.
       */
      const looks = [];
      for (const rule of rules) { try { if (ch.matches(rule.selectorText)) looks.push(rule.style); } catch { /* a selector the browser cannot test */ } }
      if (ch.style) looks.push(ch.style);
      for (const s of looks) {
        const w = s.fontWeight;
        if (w) { if (w === 'bold' || w === 'bolder' || parseInt(w, 10) >= 600) next.b = 1; else if (w === 'normal' || parseInt(w, 10) < 600) delete next.b; }
        if (s.fontStyle) { if (/italic|oblique/.test(s.fontStyle)) next.i = 1; else if (s.fontStyle === 'normal') delete next.i; }
        const deco = s.textDecorationLine || s.textDecoration;
        if (deco) { if (/underline/.test(deco)) next.u = 1; else if (/none/.test(deco)) delete next.u; }
        if (s.color) { const c = keepColour(toHexColour(s.color)); if (c) next.c = c; else delete next.c; }
      }
      const block = BLOCKS.has(tag);
      if (block && !endsWithBreak()) out.push({ t: '\n' });
      if (tag === 'TD' || tag === 'TH') { if (out.length && !/[\s]$/.test(lastChar())) out.push({ t: ' ' }); }
      walk(ch, next, pre || tag === 'PRE');
      if (block && !endsWithBreak()) out.push({ t: '\n' });
    }
  };
  walk(doc.body || doc.documentElement, {}, false);
  // No trailing new lines or spaces: a pasted paragraph ends where its words do.
  while (out.length && /^[\s]*$/.test(out[out.length - 1].t)) out.pop();
  if (out.length) out[out.length - 1].t = out[out.length - 1].t.replace(/\s+$/, '');
  const runs = normalizeRuns(out);
  const text = runsText(out);
  return { text, runs: runs && runsText(runs) === text ? runs : null };
}

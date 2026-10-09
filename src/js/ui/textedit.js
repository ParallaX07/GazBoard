// In-place text editing: a positioned editable box layered over the canvas.
//
// It was a <textarea>, which can only hold plain text. It is now an editable
// <div>, so a word can be bold or red while the rest is not (see richtext.js).
// The div still answers to .value, .selectionStart, .selectionEnd and
// setSelectionRange() exactly as the textarea did, in plain-text character
// offsets, so everything that used to talk to the textarea still can.

import { boundsOf } from '../core/store.js';
import { fitFontSize, readableText, wrapText, clamp } from '../core/util.js';
import { faceOf, noteTypeRange, inkPaint } from '../core/render.js';
import { objectRuns, normalizeRuns, layoutRich, fitRichSize, htmlToRuns, needsRich } from '../core/richtext.js';
import { refSpans, refToken, refLabel, refMissing } from '../core/boardrefs.js';
import { openBoardPicker } from './boardpicker.js';
import { updateSelectionBar } from './contextmenu.js';
import { t } from '../i18n.js';

/* ---------- the editable box <-> plain offsets and runs ---------- */

const BLOCK = new Set(['DIV', 'P', 'LI']);

/*
 * The box's contents as a flat list: each text node, each line break, and the
 * line break implied by a new block (the browser sometimes makes one). A line
 * break that is the very last thing in the box is the browser's placeholder
 * for an empty last line, not a character, so it is left out.
 */
function flatten(root, keepTail = false) {
  const items = [];
  let pos = 0;
  const walk = (node) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        if (ch.data) { items.push({ kind: 'text', node: ch, from: pos, to: pos + ch.data.length }); pos += ch.data.length; }
      } else if (ch.nodeType === 1) {
        // a link to a board is one piece, whatever its label says: its text is the link itself
        const ref = ch.getAttribute && ch.getAttribute('data-ref');
        if (ref) { items.push({ kind: 'ref', node: ch, token: ref, from: pos, to: pos + ref.length }); pos += ref.length; }
        else if (ch.tagName === 'BR') { items.push({ kind: 'br', node: ch, from: pos, to: pos + 1 }); pos += 1; }
        else {
          if (BLOCK.has(ch.tagName) && pos > 0 && items.length && items[items.length - 1].kind !== 'br') {
            items.push({ kind: 'block', node: ch, from: pos, to: pos + 1 }); pos += 1;
          }
          walk(ch);
        }
      }
    }
  };
  walk(root);
  const last = items[items.length - 1];
  if (!keepTail && last && last.kind === 'br') items.pop();
  return items;
}

function plainOf(root) {
  let s = '';
  for (const it of flatten(root)) s += it.kind === 'text' ? it.node.data : it.kind === 'ref' ? it.token : '\n';
  return s;
}

/** Plain-text offset of a DOM point inside the box. */
function offsetOf(root, container, offset) {
  const total = plainOf(root).length;
  if (!root.contains(container)) return total;
  const r = document.createRange();
  r.setStart(root, 0);
  try { r.setEnd(container, offset); } catch { return total; }
  const holder = document.createElement('div');
  holder.appendChild(r.cloneContents());
  let n = 0;
  for (const it of flatten(holder, true)) n = it.to;
  return Math.min(n, total);
}

/** The DOM point for a plain-text offset. */
function pointAt(root, n) {
  const items = flatten(root);
  for (const it of items) {
    if (it.kind === 'text' && n >= it.from && n <= it.to) return [it.node, n - it.from];
    if (it.kind !== 'text' && n === it.from) {
      const parent = it.node.parentNode;
      return [parent, Array.prototype.indexOf.call(parent.childNodes, it.node)];
    }
  }
  // The end: before the placeholder break if there is one, so the caret sits
  // on the empty last line rather than past it.
  const tail = root.lastChild;
  if (tail && tail.nodeType === 1 && tail.tagName === 'BR' && !items.some((it) => it.node === tail)) {
    return [root, root.childNodes.length - 1];
  }
  return [root, root.childNodes.length];
}

const hex2 = (v) => Number(v).toString(16).padStart(2, '0');
function toHex(rgb) {
  const m = String(rgb).match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? '#' + hex2(m[1]) + hex2(m[2]) + hex2(m[3]) : null;
}

function looksOf(el, root) {
  const cs = getComputedStyle(el);
  const w = parseInt(cs.fontWeight, 10) || (cs.fontWeight === 'bold' ? 700 : 400);
  let under = false;
  for (let n = el; n; n = n.parentElement) {
    if (n.tagName === 'U' || getComputedStyle(n).textDecorationLine.includes('underline')) { under = true; break; }
    if (n === root) break;
  }
  return { bold: w >= 600, italic: /italic|oblique/.test(cs.fontStyle), under, color: toHex(cs.color) };
}

/**
 * What is in the box, as runs: every stretch whose look differs from the box
 * itself carries that difference. Reading the COMPUTED style means it does not
 * matter how the browser chose to mark the words up - <b>, a styled span, a
 * <font> tag - only how they actually look.
 */
function runsOf(root, paint = (c) => c) {
  const base = looksOf(root, root);
  // The board's own ink is shown through the theme; read it back as itself.
  const shown = String(paint('#201f1e'));
  const autoShown = (/^#[0-9a-f]{6}$/i.test(shown) ? shown.toLowerCase() : toHex(shown)) || '#201f1e';
  const runs = [];
  for (const it of flatten(root)) {
    if (it.kind !== 'text' && it.kind !== 'ref') { runs.push({ t: '\n' }); continue; }
    // a link takes the look of the words it sits in; its own blue is only how it is shown
    const l = looksOf(it.kind === 'ref' ? (it.node.parentElement || root) : it.node.parentElement, root);
    const r = { t: it.kind === 'ref' ? it.token : it.node.data };
    if (l.bold !== base.bold) r.b = l.bold ? 1 : 0;
    if (l.italic !== base.italic) r.i = l.italic ? 1 : 0;
    if (l.under !== base.under) r.u = l.under ? 1 : 0;
    if (l.color && l.color !== base.color) r.c = l.color === autoShown ? '#201f1e' : l.color;
    runs.push(r);
  }
  return normalizeRuns(runs);
}

/** Fill the box with runs (or plain text), the way it will be drawn. */
function fill(root, runs, text, paint = (c) => c) {
  root.textContent = '';
  const list = runs || [{ t: String(text ?? '') }];
  for (const r of list) {
    let into = root;
    if (r.b !== undefined || r.i !== undefined || r.u !== undefined || r.c) {
      into = document.createElement('span');
      if (r.b !== undefined) into.style.fontWeight = r.b ? '600' : '400';
      if (r.i !== undefined) into.style.fontStyle = r.i ? 'italic' : 'normal';
      if (r.u !== undefined) into.style.textDecorationLine = r.u ? 'underline' : 'none';
      if (r.c) into.style.color = paint(r.c);
      root.appendChild(into);
    }
    String(r.t).split('\n').forEach((piece, i) => {
      if (i) into.appendChild(document.createElement('br'));
      if (piece) appendWithLinks(into, piece);
    });
  }
  // An empty last line needs something for the caret to stand on.
  if (/\n$/.test(runsTextOf(list))) root.appendChild(document.createElement('br'));
}
const runsTextOf = (list) => list.map((r) => r.t).join('');

/** A link to a board as it sits among the words being typed: its name, as one piece. */
export function linkChip(ref) {
  const el = document.createElement('span');
  el.className = 'rt-ref' + (refMissing(ref) ? ' missing' : '');
  el.contentEditable = 'false';
  el.setAttribute('data-ref', refToken(ref));
  el.textContent = refLabel(ref);
  return el;
}

/** Words into the box, with each link in them made into one piece. */
function appendWithLinks(into, text) {
  let at = 0;
  for (const sp of refSpans(text)) {
    if (sp.start > at) into.appendChild(document.createTextNode(text.slice(at, sp.start)));
    into.appendChild(linkChip(sp));
    at = sp.end;
  }
  if (at < text.length) into.appendChild(document.createTextNode(text.slice(at)));
}

/** Make an editable div answer the questions a textarea used to. */
function textareaFace(el) {
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: () => plainOf(el),
    set: (v) => { fill(el, null, v); el.dispatchEvent(new Event('input')); }
  });
  const sel = () => {
    const s = document.getSelection();
    if (!s || !s.rangeCount || !el.contains(s.getRangeAt(0).startContainer)) return null;
    return s.getRangeAt(0);
  };
  Object.defineProperty(el, 'selectionStart', {
    configurable: true,
    get: () => { const r = sel(); return r ? offsetOf(el, r.startContainer, r.startOffset) : plainOf(el).length; }
  });
  Object.defineProperty(el, 'selectionEnd', {
    configurable: true,
    get: () => { const r = sel(); return r ? offsetOf(el, r.endContainer, r.endOffset) : plainOf(el).length; }
  });
  el.setSelectionRange = (a, b = a) => {
    const len = plainOf(el).length;
    const r = document.createRange();
    const [sn, so] = pointAt(el, clamp(a, 0, len));
    const [en, eo] = pointAt(el, clamp(b, 0, len));
    r.setStart(sn, so); r.setEnd(en, eo);
    const s = document.getSelection();
    s.removeAllRanges(); s.addRange(r);
  };
  el.select = () => el.setSelectionRange(0, plainOf(el).length);
}

export class TextEditor {
  constructor(app) {
    this.app = app;
    this.layer = document.getElementById('editLayer');
    this.el = null;
    this.target = null;
    this.cell = null;
    this.measure = document.createElement('canvas').getContext('2d');
  }

  get active() { return !!this.el; }

  begin(obj, cell = null) {
    this.commit();
    const app = this.app;
    this.target = obj;
    this.cell = cell;
    // A note grows to fit what is typed into it. The height it had when
    // editing started is kept so the growth can be rewound and re-applied as
    // part of the same undo entry as the text itself.
    this.startH = obj.h;
    this.startW = obj.w;
    // How wide an automatic text box may grow before its words wrap. Fixed for
    // the whole edit, so deleting text cannot lower it and make retyping wrap
    // early. Boxes made before this was stored get one from their font size.
    this.wrapW = obj.type === 'text'
      ? (obj.wrapW || Math.max(obj.w || 0, (obj.fontSize || 24) * 11.25)) : null;

    const ta = document.createElement('div');
    ta.className = 'rt';
    ta.contentEditable = 'true';
    ta.setAttribute('role', 'textbox');
    ta.setAttribute('aria-multiline', 'true');
    ta.spellcheck = true;
    /*
     * Grammarly and its kind put a floating button inside any box you type
     * into - over the very words being written, on a board where the box is
     * sized to the words. These attributes are how such tools are told a field
     * is not theirs to decorate; the spell check underline still works.
     */
    ta.setAttribute('data-gramm', 'false');
    ta.setAttribute('data-gramm_editor', 'false');
    ta.setAttribute('data-enable-grammarly', 'false');
    textareaFace(ta);
    this.paint = !cell && (obj.type === 'text' || obj.type === 'shape') ? (c) => inkPaint(c) : (c) => c;
    fill(ta, objectRuns(obj, cell), cell ? (obj.cells?.[cell] || '') : (obj.text || ''), this.paint);
    this.el = ta;
    this.layer.appendChild(ta);
    // On touch/mobile viewports, keep active edit target in comfortable visible area above software keyboard
    const p = app.surface.cam.toScreen(obj.x + (obj.w || 200) / 2, obj.y + (obj.h || 100) / 2);
    const vh = window.visualViewport ? window.visualViewport.height : (window.innerHeight || 768);
    // A pen-and-touch Windows laptop reports touch points and fires ontouchstart
    // exactly as a phone does, so testing for touch AT ALL made the board scroll
    // out from under anyone editing a note low in the window on a touchscreen PC.
    // What this actually wants to know is whether the pointer is a fingertip, and
    // that is what (pointer: coarse) reports: a phone or tablet matches, a laptop
    // with a mouse or a pen does not, touchscreen or otherwise.
    const touchFirst = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (p.y > vh * 0.65 && touchFirst) {
      app.surface.cam.panBy(0, -(p.y - vh * 0.38));
      app.surface.clampCamera();
      app.surface.invalidate();
    }

    // The canvas must stop drawing this object's text while the textarea is
    // showing it, or the two sit a pixel apart and smear into each other.
    app.surface.editing = { id: obj.id, cell };
    // On a phone the keyboard takes most of the screen and the toolbar ends up
    // sitting on the very box being typed into. The pens are no use mid-word,
    // so they stand down until the words are finished - see app.css.
    document.body.classList.add('typing');

    this.place();

    ta.addEventListener('input', () => { this.place(); app.surface.invalidate(); this.watchMention(); });
    /*
     * Words come in with the look the board can draw, and nothing else.
     *
     * Pasting into an editable box would otherwise bring the source's whole
     * page along - its fonts, sizes, backgrounds, links - none of which the
     * board can draw. What survives from Word or a web page is bold, italic,
     * underline and colour (see htmlToRuns). Ctrl+Shift+V pastes the words
     * alone, in whatever style is being typed.
     */
    const insertPlain = (text) => {
      const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
      lines.forEach((line, i) => {
        if (i) document.execCommand('insertLineBreak');
        if (line) document.execCommand('insertText', false, line);
      });
    };
    const insertRich = (runs) => {
      const s = document.getSelection();
      if (!s || !s.rangeCount || !ta.contains(s.getRangeAt(0).startContainer)) return false;
      const range = s.getRangeAt(0);
      range.deleteContents();
      const holder = document.createElement('div');
      fill(holder, runs, null, this.paint);
      const nodes = [...holder.childNodes];
      if (!nodes.length) return true;
      const frag = document.createDocumentFragment();
      for (const n of nodes) frag.appendChild(n);
      range.insertNode(frag);
      const after = document.createRange();
      after.setStartAfter(nodes[nodes.length - 1]);
      after.collapse(true);
      s.removeAllRanges(); s.addRange(after);
      ta.dispatchEvent(new Event('input'));
      return true;
    };
    this._insertRich = insertRich;
    this._insertPlain = insertPlain;
    ta.addEventListener('paste', (e) => {
      e.preventDefault();
      const plain = e.clipboardData?.getData('text/plain') || '';
      const html = this._plainPaste ? '' : (e.clipboardData?.getData('text/html') || '');
      this._plainPaste = false;
      if (html) {
        const got = htmlToRuns(html);
        if (got.runs && insertRich(got.runs)) return;
        if (!plain && got.text) { insertPlain(got.text); return; }
      }
      insertPlain(plain);
    });
    ta.addEventListener('drop', (e) => {
      e.preventDefault();
      insertPlain(e.dataTransfer?.getData('text/plain'));
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      // the list of boards after "@" has first say over the keys it moves through
      if (this.mention?.open && !e.isComposing && this.mention.key(e)) { e.preventDefault(); return; }
      // Ctrl+Shift+V: the words only, whatever they looked like where they came from.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'V' || e.key === 'v')) this._plainPaste = true;
      if (e.key === 'Escape') { e.preventDefault(); this.cancel(); app.surface.canvas.focus(); }
      else if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey) && !e.isComposing) {
        // A new line, never a new block - the board has no paragraphs to give it.
        e.preventDefault();
        document.execCommand('insertLineBreak');
      }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.commit(); }
      else if (e.key === 'Tab' && cell) { e.preventDefault(); this.commit(); }
    });
    ta.addEventListener('blur', () => { if (!this._picking) this.commit(); });
    // The format bar shows what the caret is sitting in.
    this._onSel = () => { if (this.el && document.activeElement === this.el) updateSelectionBar(app, true); };
    document.addEventListener('selectionchange', this._onSel);
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    /*
     * Caret at the end, not everything selected.
     *
     * Opening an existing box with all of its text highlighted means the next
     * key you press deletes the lot. That is a fine way to REPLACE something
     * and a terrible default for coming back to fix a word, which is what
     * re-opening a text box is nearly always for. Every text box on a page
     * behaves the other way: you get a caret, and the text stays put. Ctrl+A
     * is still there for anyone who did want all of it.
     */
    setTimeout(() => {
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    }, 0);
    app.surface.invalidate();
  }

  place() {
    if (!this.el || !this.target) return;
    const app = this.app, cam = app.surface.cam, o = this.target;
    let box;
    if (this.cell) {
      const [r, c] = this.cell.split(',').map(Number);
      const cw = o.w / o.cols, ch = o.h / o.rows;
      box = { x: o.x + c * cw, y: o.y + r * ch, w: cw, h: ch };
    } else box = boundsOf(o);

    if (o.type === 'note' && !this.cell) {
      /*
       * Grows AND shrinks. It used to only grow, so a note that had swollen to
       * hold a paragraph stayed that size no matter how much of it you deleted
       * - you could empty the thing completely and still be looking at a note
       * four lines tall.
       *
       * The floor is the height the note had when this edit began, never
       * smaller: a note somebody sized by hand keeps the size they gave it.
       * And the measuring is done against that same fixed height rather than
       * the live one, because the automatic font size is chosen to fit the
       * height - measure against a height that is itself changing and the two
       * chase each other.
       */
      const base = this.startH != null ? this.startH : o.h;
      const want = Math.max(base, this.noteHeight(o, this.el.value, base, this.runs()));
      if (want !== o.h) { o.h = want; box = boundsOf(o); app.surface.touch?.(); }
    }

    /*
     * A text box is exactly as tall as its words, as you type them.
     *
     * It used to keep the height it was created with, so the moment the text
     * ran past one line the box scrolled inside itself and the first line went
     * out of sight. Then I made it grow but not shrink, on the theory that
     * resizing on every backspace would make the frame flinch. That was wrong
     * twice over: deleting a paragraph left a tall empty box, and the box then
     * snapped smaller anyway the instant you clicked away, because that is what
     * commit() has always done. A jump at the end is worse than movement while
     * typing, and this way there is no jump at all - what you are looking at
     * while you type is already the finished size.
     *
     * Nothing here can oscillate: the width is fixed while editing, so the
     * number of lines depends on the words alone and never on the height.
     */
    if (o.type === 'text' && !this.cell && o.autoSize !== false) {
      /*
       * And exactly as WIDE as its words, too: it grows to the right as you
       * type and comes back in as you delete, up to its wrapping width, where
       * the words start a new line instead. It used to open at that full width
       * and stay there until you clicked away, so a two-letter word sat in a
       * frame with a long empty stretch after it, and a box you came back to
       * later could not grow at all - it wrapped at whatever width it had been
       * shrunk to. A box sized by hand (autoSize false) keeps its width.
       */
      const want = this.fitBox(o, this.el.value, this.wrapW, this.runs());
      if (want.h !== o.h || want.w !== o.w) { o.h = want.h; o.w = want.w; box = boundsOf(o); app.surface.touch?.(); }
    } else if (o.type === 'text' && !this.cell) {
      // Sized by hand: the width is theirs, but the height still follows the
      // words, or the lines typed past the bottom are hidden.
      const want = this.fitBox(o, this.el.value, o.w, this.runs()).h;
      if (want !== o.h) { o.h = want; box = boundsOf(o); app.surface.touch?.(); }
    }

    const pad = o.type === 'note' ? Math.max(10, o.w * 0.08) : o.type === 'shape' ? 10 : 0;
    const wx = box.x + pad, wy = box.y + pad, ww = box.w - pad * 2, wh = box.h - pad * 2;
    const p = cam.toScreen(wx, wy);

    let size = o.fontSize || 0;
    // Measure in the face the text is actually set in. Comic Sans runs much wider
    // than Segoe UI, so autofitting against the sans face overflows the note.
    const face = faceOf(o.font);
    if (!size) {
      this.measure.font = `16px ${face}`;
      // A note's type range comes from its own width, so it is the same on
      // screen whatever zoom the note was made at - see noteTypeRange().
      const range = o.type === 'note' ? noteTypeRange(o) : { max: 72, min: 10 };
      const runs = this.runs();
      size = runs
        ? fitRichSize(this.measure, runs, ww, wh, this.richBase(o, face), range.max, range.min)
        : fitFontSize(this.measure, this.el.value || ' ', ww, wh, face, '400', range.max, range.min);
    }
    const s = this.el.style;
    s.left = p.x + 'px';
    s.top = p.y + 'px';
    s.width = Math.max(24, ww * cam.z) + 'px';
    s.height = Math.max(20, wh * cam.z) + 'px';
    s.fontSize = size * cam.z + 'px';
    s.lineHeight = 1.28;
    s.fontFamily = face;      // what you type in is what gets committed
    s.fontWeight = o.bold ? '600' : '400';
    s.fontStyle = o.italic ? 'italic' : 'normal';
    s.textDecorationLine = o.underline && !this.cell ? 'underline' : 'none';
    s.textAlign = this.cell ? 'center' : (o.align || (o.type === 'text' ? 'left' : 'center'));
    /*
     * A note carries its own colour, so its text is read off that and is right
     * in either theme. Everything else is ink on the board, which means on a
     * dark board it has to follow the same rule the canvas does - otherwise you
     * type in black onto black and watch nothing appear, then see the words the
     * moment you click away and the canvas takes over.
     */
    const ink = o.type === 'note' ? (o.textColor || readableText(o.color || '#ffd94a'))
      : inkPaint(o.color || o.textColor);
    s.color = ink;
    s.caretColor = ink;                 // a black caret is invisible on a dark note
    /*
     * Show what will actually be there.
     *
     * Everything except a note used to be typed into an opaque white panel,
     * which hid the shape it was inside, the ink behind it, and the fact that a
     * text box has no fill of its own. You typed onto white and got something
     * else the moment you clicked away. A note keeps its own colour because a
     * note really is a coloured square; everything else shows whatever the
     * object will actually be drawn with, which is usually nothing.
     */
    s.background = o.type === 'note' ? o.color
      : (!this.cell && o.background && o.background !== 'none' ? o.background : 'transparent');
    // The frame has to be visible against whatever it is sitting on, and on a
    // dark note that is not near-black.
    s.outlineColor = o.type === 'note' ? ink : 'rgba(0,0,0,.45)';
    s.transform = o.rotation ? `rotate(${o.rotation}rad)` : '';
    s.transformOrigin = '0 0';
    s.padding = '0';
    if (o.type === 'note' || o.type === 'shape' || this.cell) {
      const lines = this.el.value.split('\n').length;
      const contentH = lines * size * 1.28 * cam.z;
      s.paddingTop = Math.max(0, (wh * cam.z - contentH) / 2) + 'px';
    } else s.paddingTop = '0';
    // Keep the format bar above the box as it grows.
    if (document.activeElement === this.el) updateSelectionBar(app, true);
  }

  /** What is in the box right now, as runs - or null when it is all plain. */
  runs() {
    if (!this.el || !this.el.isConnected) return null;
    return runsOf(this.el, this.paint);
  }

  /** The box's own style, as the rich layout wants it. */
  richBase(o, face = faceOf(o.font), size = o.fontSize || 24) {
    return { family: face, weight: '400', bold: !!o.bold && !this.cell, italic: !!o.italic && !this.cell, underline: !!o.underline && !this.cell, color: '#000', size };
  }

  commit() {
    if (!this.el || !this.target) return;
    this.endMention();
    const value = this.el.value;
    // Read while the box is still on the page: the styles are read off it.
    const runs = this.runs();
    const o = this.target;
    const el = this.el;
    this.stopWatching();
    this.el = null;
    const target = this.target;
    const cell = this.cell;
    this.target = null; this.cell = null;
    this.app.surface.editing = null;      // the canvas owns the text again
    document.body.classList.remove('typing');
    el.remove();

    const store = this.app.store;
    const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
    if (cell) {
      const cells = { ...(target.cells || {}) };
      const oldRuns = objectRuns(target, cell);
      if ((cells[cell] || '') !== value || !same(oldRuns, runs)) {
        if (value) cells[cell] = value; else delete cells[cell];
        const patch = { cells };
        if (runs || target.cellRuns) {
          const cellRuns = { ...(target.cellRuns || {}) };
          if (runs && value) cellRuns[cell] = runs; else delete cellRuns[cell];
          patch.cellRuns = Object.keys(cellRuns).length ? cellRuns : undefined;
        }
        store.update(target.id, patch, 'edit table');
      }
    } else if ((target.text || '') !== value || !same(objectRuns(target), runs)) {
      const patch = { text: value };
      if (runs || target.runs !== undefined) patch.runs = runs || undefined;
      if (target.type === 'text' && target.autoSize !== false) {
        // Rewind the growth that happened while typing, so the undo entry
        // records the height the box had BEFORE this edit rather than the one
        // it drifted to during it. fitBox reads the width and the font, never
        // the height, so the answer is the same either way.
        if (this.startH != null) target.h = this.startH;
        if (this.startW != null) target.w = this.startW;
        Object.assign(patch, this.fitBox(target, value, this.wrapW, runs));
        patch.wrapW = this.wrapW;
      } else if (target.type === 'text') {
        if (this.startH != null) target.h = this.startH;
        const h = this.fitBox(target, value, target.w, runs).h;
        if (h !== target.h) patch.h = h;
      }
      if (target.type === 'note') {
        // Rewind the live resizing so update() records the height the note had
        // before this edit, then ask for the height the finished text needs -
        // never below where it started.
        if (this.startH != null) target.h = this.startH;
        const base = target.h;
        const want = Math.max(base, this.noteHeight(target, value, base, runs));
        if (want !== target.h) patch.h = want;
      }
      store.update(target.id, patch, 'edit text');
      // an empty brand-new text box is not worth keeping
      if (!value && target.type === 'text') store.remove([target.id], 'remove empty text');
    } else if (!value && target.type === 'text' && !target.text) {
      store.remove([target.id], 'remove empty text');
    } else if (this.startH != null && (target.type === 'note' || target.type === 'text')) {
      target.h = this.startH;      // nothing changed, so neither should the box
      if (target.type === 'text' && this.startW != null) target.w = this.startW;
    }
    this.startH = null; this.startW = null; this.wrapW = null;

    this.app.afterTextEdit();
    this.app.surface.invalidate();
    this.app.syncUI();
  }

  /**
   * Shrink a text box to the text in it.
   *
   * A new box starts wide enough to type into; leaving it that size afterwards
   * gives a short label a selection frame several times its own width.
   */
  fitBox(o, value, wrapW = this.wrapW, runs = null) {
    if (!runs && needsRich(value)) runs = [{ t: value }];
    const size = o.fontSize || 24;
    const family = faceOf(o.font);
    this.measure.font = `${o.bold ? '600 ' : ''}${size}px ${family}`;
    const pad = size * 0.35;
    const limit = Math.max(40, wrapW || o.w);
    let lines, widest = 0;
    if (runs) {
      const laid = layoutRich(this.measure, runs, limit, this.richBase(o, family, size));
      lines = laid;
      for (const l of laid) widest = Math.max(widest, l.w);
    } else {
      lines = wrapText(this.measure, value, limit);
      for (const line of lines) widest = Math.max(widest, this.measure.measureText(line).width);
    }
    return {
      w: clamp(widest + pad, size * 1.2, limit),   // never wider than its wrapping width: long text wraps
      h: Math.max(size * 1.3, lines.length * size * 1.28 + pad * 0.4)
    };
  }

  /**
   * How tall a note has to be for its text to fit inside it.
   *
   * Notes shrink their text first - that is what they have always done - and
   * only grow when even the smallest size will not fit. The result is never
   * smaller than the note already is, so a note the user sized by hand keeps
   * the size they gave it.
   */
  noteHeight(o, value, baseH = o.h, runs = null) {
    if (!runs && needsRich(value)) runs = [{ t: value }];
    const pad = Math.max(10, o.w * 0.08);
    const innerW = Math.max(8, o.w - pad * 2);
    const face = faceOf(o.font);
    const weight = o.bold ? '600' : '400';
    let size = o.fontSize;
    if (!size) {
      // Against baseH, not the live height. The automatic size is picked to fit
      // the box, and the box is about to be sized to fit the text: measuring
      // against a height that is itself moving sets the two chasing each other.
      this.measure.font = `${weight} 16px ${face}`;
      const range = noteTypeRange(o);
      size = runs
        ? fitRichSize(this.measure, runs, innerW, Math.max(8, baseH - pad * 2), this.richBase(o, face), range.max, range.min)
        : fitFontSize(this.measure, value || ' ', innerW, Math.max(8, baseH - pad * 2), face, weight, range.max, range.min);
    }
    this.measure.font = `${weight} ${size}px ${face}`;
    const lines = runs ? layoutRich(this.measure, runs, innerW, this.richBase(o, face, size)) : wrapText(this.measure, value || ' ', innerW);
    // What the text NEEDS. Whether the note is allowed to become that small is
    // the caller's business, and the answer is never below the size it started.
    return Math.ceil(lines.length * size * 1.28 + pad * 2);
  }

  cancel() {
    if (!this.el) return;
    this.endMention();
    const target = this.target;
    const el = this.el;
    /*
     * Clear the fields BEFORE detaching the textarea.
     *
     * Removing a focused element fires `blur`, and the blur handler is
     * commit(). With this.el still set, that commit ran for real - so
     * cancelling an edit quietly SAVED it instead of throwing it away, the
     * note-height rewind below never happened, and commit's own el.remove()
     * then threw on a node that was already gone. Nulling first makes the
     * blur-driven commit hit its own guard and return, which is what it
     * should always have done.
     */
    this.stopWatching();
    this.el = null; this.target = null; this.cell = null;
    this.app.surface.editing = null;      // the canvas owns the text again
    document.body.classList.remove('typing');
    el.remove();
    // A cancelled edit gives back whatever height it grew to while typing -
    // for a text box exactly as for a note.
    if (target && (target.type === 'note' || target.type === 'text') && this.startH != null) {
      target.h = this.startH;
      if (target.type === 'text' && this.startW != null) target.w = this.startW;
    }
    this.startH = null; this.startW = null; this.wrapW = null;
    if (target && target.type === 'text' && !target.text) this.app.store.remove([target.id], 'remove empty text');
    this.app.afterTextEdit();
    this.app.surface.invalidate();
    this.app.syncUI();
  }

  reposition() { if (this.el) this.place(); }

  /*
   * "@" followed by a few words, right before the caret, is a search for a
   * board. It has to start a word - "me@home.com" is an address, not a link -
   * and it gives up at a new line, at a second "@", or after forty letters.
   */
  mentionQuery() {
    if (!this.el) return null;
    const s = document.getSelection();
    if (!s || !s.rangeCount || !s.isCollapsed) return null;
    const caret = this.el.selectionStart;
    const before = this.el.value.slice(0, caret);
    const m = /(^|[\s(\[{"'“‘])@([^@\n]{0,40})$/.exec(before);
    // "@[" is a link already made, not a search
    if (!m || /\s\s$/.test(m[2]) || /^[\s[]/.test(m[2])) return null;
    return { at: caret - m[2].length - 1, caret, query: m[2] };
  }

  watchMention() {
    const q = this.mentionQuery();
    if (!q) { this.endMention(); return; }
    this._mentionAt = q;
    if (this.mention?.open) { this.mention.setQuery(q.query); return; }
    const r = document.getSelection().getRangeAt(0).cloneRange();
    let box = r.getBoundingClientRect();
    if (!box || (!box.width && !box.height && !box.left)) box = this.el.getBoundingClientRect();
    this.app.refreshBoardDirectory?.();
    this.mention = openBoardPicker(this.app, {
      at: { x: box.left - 8, y: box.bottom + 6 },
      query: q.query,
      onPick: (ref) => this.pickMention(ref),
      onClose: () => { this.mention = null; }
    });
  }

  endMention() {
    const m = this.mention;
    this.mention = null;
    if (m?.open) m.close();
  }

  /** Swap the "@words" just typed for a link to the board chosen (made first, when asked for). */
  async pickMention(choice) {
    const at = this._mentionAt;
    this.mention = null;
    if (!this.el || !at) return;
    let ref = choice;
    if (choice.create) {
      this._picking = true;
      try { ref = await this.app.createLinkedBoard(choice.create); } finally { this._picking = false; }
      if (!ref || !this.el) return;
    }
    this.el.focus();
    this.el.setSelectionRange(at.at, at.caret);
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    // the link, then a space, with the caret after the space ready for the next word
    const chip = linkChip(ref), space = document.createTextNode(' ');
    range.insertNode(space);
    range.insertNode(chip);
    const after = document.createRange();
    after.setStart(space, 1); after.collapse(true);
    sel.removeAllRanges(); sel.addRange(after);
    this.el.dispatchEvent(new Event('input'));
  }

  stopWatching() {
    if (this._onSel) document.removeEventListener('selectionchange', this._onSel);
    this._onSel = null;
  }

  /**
   * Bold, italic or underline for the highlighted words - or, with nothing
   * highlighted, for whatever is typed next. The same thing Ctrl+B, Ctrl+I and
   * Ctrl+U do on their own.
   */
  format(kind) {
    if (!this.el) return;
    if (document.activeElement !== this.el) this.el.focus();
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(kind);
    this.place();
    this.app.surface.invalidate();
  }

  /** Colour the highlighted words (or what is typed next). Null goes back to the box's own colour. */
  colour(hex) {
    if (!this.el) return;
    if (document.activeElement !== this.el) this.el.focus();
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, hex || getComputedStyle(this.el).color);
    this.place();
    this.app.surface.invalidate();
  }

  /**
   * Paste from the machine's clipboard through the app rather than through
   * the keyboard. On a phone this matters: pasting from the keyboard's own
   * clipboard strip types the words in as if they were typed, and the bold
   * and colours copied in Word never arrive. Asking the clipboard directly
   * gets the formatted copy too.
   */
  async pasteFromClipboard() {
    if (!this.el || !window.board?.clipboardRead) return false;
    let got = null;
    try { got = await window.board.clipboardRead(); } catch { got = null; }
    if (!this.el) return false;
    if (document.activeElement !== this.el) this.el.focus();
    const html = got && got.html ? String(got.html) : '';
    const text = got && got.text ? String(got.text) : '';
    if (html) {
      const r = htmlToRuns(html);
      if (r.runs && this._insertRich?.(r.runs)) return true;
      if (!text && r.text) { this._insertPlain?.(r.text); return true; }
    }
    if (text) { this._insertPlain?.(text); return true; }
    this.app.toast(t('There is nothing to paste'));
    return false;
  }

  /** Is the caret (or the highlighted words) bold / italic / underlined? */
  state(kind) {
    try { return document.queryCommandState(kind); } catch { return false; }
  }
}

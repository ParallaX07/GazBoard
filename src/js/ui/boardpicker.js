// The list that comes up after "@": every other board, narrowing as you type.
//
// It is used two ways. Typing "@" inside words opens it at the caret, and the
// words being typed after the "@" are the search - the box keeps the focus and
// passes the arrow keys, Enter and Escape on to the list. Typing "@" on the
// board itself (or choosing Insert > Link to a board) opens it with a search
// box of its own, and the pick becomes a card where the pointer was.
//
// A board with more than one page can be opened up (the arrow on its row, or
// the right arrow key) to link to one page of it. When nothing is called what
// was typed, the last row offers to make a board with that name.

import { openPopover, closePopover, h } from './popover.js';
import { allBoards, currentBoardId, onDirectoryChange } from '../core/boardrefs.js';
import { folderOf, folderPath } from '../core/folders.js';
import { t } from '../i18n.js';

const words = (s) => String(s || '').toLowerCase().split(/[\s\-_.,/]+/).filter(Boolean);

/**
 * How well a board's name answers a search. 0 is no match; higher is better.
 * Every word typed has to be found, the way the emoji search works: the whole
 * name beats its start, which beats the start of a word, which beats a match
 * somewhere in the middle.
 */
export function scoreBoard(name, query) {
  const n = String(name || '').toLowerCase().trim();
  const q = String(query || '').toLowerCase().trim();
  if (!q) return 1;
  if (n === q) return 1000;
  let score = n.startsWith(q) ? 500 : 0;
  const nw = words(n);
  for (const w of words(q)) {
    if (nw.some((x) => x === w)) score += 60;
    else if (nw.some((x) => x.startsWith(w))) score += 40;
    else if (n.includes(w)) score += 10;
    else return 0;
  }
  return score;
}

/** The boards that answer a search, best first; with no search, the most recently changed first. */
export function matchBoards(query, list = allBoards(), limit = 8, except = currentBoardId()) {
  return list
    .filter((b) => b.id !== except)
    .map((b) => ({ b, s: scoreBoard(b.name, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.b.modified || 0) - (a.b.modified || 0))
    .slice(0, limit)
    .map((x) => x.b);
}

/* How many pages each board has. Only known by opening it, so it is asked for
   once per version of the board and remembered. */
const pageCache = new Map();
/** Where page counts come from: the board store. Kept on an object so the tests can slow it down. */
export const pageCounter = { load: (id) => window.board?.boards?.load?.(id) };
/** Forget every count, so the next look reads the boards again. */
export function forgetPageCounts() { pageCache.clear(); }
/** The pages of a board, once known; null while they are still being counted. */
function pagesOf(b) {
  const hit = pageCache.get(b.id);
  if (hit && hit.modified === b.modified) return hit.pages;
  countPages(b);
  return null;
}
/** Count a board's pages (once per version of it). Resolves to the list of pages. */
function countPages(b) {
  const hit = pageCache.get(b.id);
  if (hit && hit.modified === b.modified) return hit.done;
  const entry = { modified: b.modified, pages: null };
  entry.done = Promise.resolve()
    .then(() => pageCounter.load(b.id))
    .then((data) => Array.isArray(data?.pages) ? data.pages.map((p) => ({ date: p && p.date })) : [])
    .catch(() => [])
    .then((pages) => { entry.pages = pages; return pages; });
  pageCache.set(b.id, entry);
  return entry.done;
}

/**
 * Open the list.
 * @param {object} app
 * @param {{at:{x:number,y:number}, query?:string, search?:boolean, onPick:Function, onClose?:Function}} opts
 *   `at` is a point on the window; `search` gives the list its own search box.
 *   onPick gets { id, name, page } - or { create: name } for "make a board".
 * @returns the list's handle: setQuery(q), key(event) -> handled?, close()
 */
export function openBoardPicker(app, opts) {
  let query = opts.query || '';
  let open = null;              // the board whose pages are showing
  let hot = 0;
  let rows = [];                // what Enter would pick, row by row
  let closed = false;
  let lastMove = null;
  let waitingRight = null;      // → was pressed on a board whose pages were still being counted
  const afterCount = (b) => {
    if (waitingRight !== b.id) return;
    waitingRight = null;
    const pages = pagesOf(b);
    if (rows[hot]?.board?.id === b.id && pages && pages.length > 1) pick({ kind: 'pages', board: b });
  };

  const listEl = h('div', { class: 'bp-list', role: 'listbox' });
  const input = opts.search ? h('input', {
    class: 'emoji-search bp-search', type: 'search', placeholder: t('Find a board…'),
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false'
  }) : null;
  if (input) input.value = query;
  const body = h('div', { class: 'bp-pop' }, input, listEl);

  const pick = (row) => {
    if (!row) return;
    if (row.kind === 'pages') { open = row.board; hot = 0; render(); return; }
    if (row.kind === 'back') { open = null; hot = 0; render(); return; }
    finish();
    opts.onPick(row.kind === 'create' ? { create: row.name } : { id: row.board.id, name: row.board.name, page: row.page || 0 });
  };

  const rowEl = (row, i) => {
    const el = h('div', { class: 'bp-row' + (i === hot ? ' hot' : '') + (row.kind === 'create' ? ' bp-create' : ''), role: 'option' });
    // keep the caret in the words being typed: a press here must not take the focus away
    el.addEventListener('pointerdown', (e) => e.preventDefault());
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', () => pick(row));
    // Only a pointer that MOVES chooses a row. A list that opens under a mouse
    // resting on the board must not have Enter pick whatever row landed there.
    el.addEventListener('pointermove', (e) => {
      if (lastMove && lastMove.x === e.clientX && lastMove.y === e.clientY) return;
      const first = !lastMove;
      lastMove = { x: e.clientX, y: e.clientY };
      if (first) return;
      if (hot !== i) { hot = i; paintHot(); }
    });
    if (row.kind === 'board') {
      const thumb = h('div', { class: 'bp-thumb' });
      if (row.board.thumb) thumb.appendChild(h('img', { src: row.board.thumb, alt: '' }));
      const path = folderPath(app.settings, folderOf(app.settings, row.board.id)).map((f) => f.name).join(' › ');
      el.append(thumb, h('div', { class: 'bp-text' }, h('div', { class: 'bp-name' }, row.board.name || t('Untitled board')), path ? h('div', { class: 'bp-path' }, path) : null));
      const pages = pagesOf(row.board);
      if (!pages) {
        // still counting its pages: a small turning circle where the arrow will go
        el.appendChild(h('span', { class: 'bp-spin', role: 'status', title: t('Counting pages…'), 'aria-label': t('Counting pages…') }));
        countPages(row.board).then(() => { if (!closed && !open) { render(); afterCount(row.board); } });
      } else if (pages.length > 1) {
        const more = h('button', { class: 'bp-more', title: t('Link to one page'), 'aria-label': t('Link to one page') }, '›');
        more.addEventListener('pointerdown', (e) => e.preventDefault());
        more.addEventListener('mousedown', (e) => e.preventDefault());
        more.addEventListener('click', (e) => { e.stopPropagation(); pick({ kind: 'pages', board: row.board }); });
        el.appendChild(more);
      }
    } else if (row.kind === 'back') {
      el.append(h('div', { class: 'bp-back' }, '‹ ' + (row.board.name || t('Untitled board'))));
    } else if (row.kind === 'page') {
      el.append(h('div', { class: 'bp-text' }, h('div', { class: 'bp-name' }, row.page ? t('Page {n}', { n: row.page }) : t('The whole board')),
        row.date ? h('div', { class: 'bp-path' }, row.date) : null));
    } else if (row.kind === 'create') {
      el.append(h('div', { class: 'bp-plus' }, '+'), h('div', { class: 'bp-text' }, h('div', { class: 'bp-name' }, t('Create “{name}”', { name: row.name }))));
    }
    return el;
  };

  const render = () => {
    if (closed) return;
    rows = [];
    if (open) {
      rows.push({ kind: 'back', board: open });
      rows.push({ kind: 'page', board: open, page: 0 });
      const pages = pageCache.get(open.id)?.pages || [];
      pages.forEach((p, i) => rows.push({ kind: 'page', board: open, page: i + 1, date: p.date ? new Date(p.date).toLocaleDateString() : '' }));
      if (hot === 0) hot = 1;
    } else {
      for (const b of matchBoards(query)) rows.push({ kind: 'board', board: b });
      const q = query.trim();
      if (q && !allBoards().some((b) => String(b.name || '').trim().toLowerCase() === q.toLowerCase())) rows.push({ kind: 'create', name: q });
    }
    hot = Math.max(0, Math.min(hot, rows.length - 1));
    listEl.replaceChildren();
    if (!rows.length) listEl.appendChild(h('div', { class: 'emoji-empty' }, t('No other boards yet')));
    rows.forEach((r, i) => listEl.appendChild(rowEl(r, i)));
  };
  const paintHot = () => {
    [...listEl.children].forEach((el, i) => el.classList.toggle('hot', i === hot));
    listEl.children[hot]?.scrollIntoView?.({ block: 'nearest' });
  };

  /** A key pressed while the list is up. True when the list used it. */
  const key = (e) => {
    if (closed) return false;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      if (rows.length) { hot = (hot + (k === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; paintHot(); }
      return true;
    }
    if (k === 'Enter' || k === 'Tab') { if (!rows.length) return false; pick(rows[hot]); return true; }
    if (k === 'ArrowRight' && !open && rows[hot]?.kind === 'board') {
      const b = rows[hot].board;
      const pages = pagesOf(b);
      if (pages && pages.length > 1) { pick({ kind: 'pages', board: b }); return true; }
      // still counting: remember the key, and open the pages the moment they are known
      if (!pages) { waitingRight = b.id; return true; }
      return false;
    }
    if (k === 'ArrowLeft' && open) { pick({ kind: 'back' }); return true; }
    if (k === 'Escape') { finish(); opts.onClose?.('escape'); return true; }
    return false;
  };

  // the list is opened at once and filled in again when a fresh read of the boards arrives
  const stopWatching = onDirectoryChange(() => render());
  let finishing = false;
  const finish = () => {
    if (closed) return;
    finishing = true;
    closed = true;
    stopWatching();
    closePopover();
    finishing = false;
  };

  const el = openPopover(opts.at, body, {
    key: 'boardpicker', placement: 'point', className: 'bp-popover',
    onClose: () => { const was = closed; closed = true; stopWatching(); if (!was && !finishing) opts.onClose?.('away'); }
  });
  if (!el) { closed = true; stopWatching(); return { setQuery() {}, key: () => false, close() {}, get open() { return false; } }; }

  if (input) {
    input.addEventListener('input', () => { query = input.value; open = null; hot = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (key(e)) { e.preventDefault(); e.stopPropagation(); }
      else e.stopPropagation();
    });
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.focus(), 0);
  }
  render();

  return {
    setQuery(q) { if (closed) return; if (q !== query) { query = q; open = null; hot = 0; render(); } },
    key,
    close() { finish(); },
    get open() { return !closed; },
    get rows() { return rows.map((r) => ({ kind: r.kind, id: r.board?.id, name: r.board?.name ?? r.name, page: r.page })); },
    get hot() { return hot; },
    get spinning() { return [...listEl.querySelectorAll('.bp-row')].map((r) => (r.querySelector('.bp-spin') ? 'spin' : r.querySelector('.bp-more') ? 'more' : '-')); }
  };
}

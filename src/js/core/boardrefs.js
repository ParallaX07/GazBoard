// Links from one board to another.
//
// A link lives in two places. Inside words - a text box, a note, a shape's
// label, a table cell - it is a short piece of text:
//
//     @[Week 5](b:b3k9x2)        the board whose id is b3k9x2
//     @[Notes](b:b77aa1#3)       page 3 of that board
//
// so it is saved, undone, synced and copied along with the words around it,
// exactly as $...$ maths is. On the board itself it is a card (type
// 'boardlink') that carries the same three things: { id, name, page }.
//
// The id is what a link follows. The name is only what it was called when the
// link was made: the label always shows the board's name NOW, so renaming a
// board never breaks or dates a link to it. The name earns its keep when the
// id is not on this computer - a board sent over the network, or opened from
// a file, can arrive with a different id - and then a board with exactly that
// name is the one meant. When neither is found, the link says so, greyed out,
// and still reads as the name of what is missing.

export const REF_RE = /@\[([^\]\n]{1,200})\]\(b:([A-Za-z0-9_-]{1,128})(?:#(\d{1,4}))?\)/g;

const clean = (s) => String(s ?? '').replace(/[\]\n\r]/g, ' ').trim().slice(0, 200) || '?';

/** The text form of a link, for putting into words. */
export function refToken(ref) {
  const page = ref.page > 0 ? '#' + Math.floor(ref.page) : '';
  return `@[${clean(ref.name)}](b:${ref.id}${page})`;
}

/** Every link in a stretch of text: [{start, end, id, name, page}]. Pages count from 1. */
export function refSpans(text) {
  const out = [];
  const s = String(text ?? '');
  if (!s.includes('](b:')) return out;
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(s))) {
    out.push({ start: m.index, end: m.index + m[0].length, name: m[1], id: m[2], page: m[3] ? Number(m[3]) : 0 });
  }
  return out;
}

export const hasRefs = (text) => typeof text === 'string' && text.includes('](b:') && refSpans(text).length > 0;

/** The words with every link written the way a person would: "@Week 5". For copying out to other apps. */
export function refsAsWords(text) {
  if (!hasRefs(text)) return String(text ?? '');
  return String(text).replace(REF_RE, (_, name, id, page) => '@' + (directoryName(id) || name) + (page ? ' › ' + page : ''));
}

/* ------------------------------------------------------------------ *
 *  What boards there are
 * ------------------------------------------------------------------ */

const byId = new Map();          // id -> { id, name, thumb, modified }
let known = false;               // has the list been read at all yet?
let current = { id: null, name: '' };
const listeners = new Set();

/** The board list, as the board store gives it. */
export function setBoardDirectory(list) {
  byId.clear();
  for (const b of list || []) if (b && b.id) byId.set(b.id, { id: b.id, name: b.name || '', thumb: b.thumb || null, modified: b.modified || 0, origin: b.origin || null });
  known = true;
  for (const fn of listeners) { try { fn(); } catch { /* a listener's problem is its own */ } }
}

/** The board that is open, whose name is the one being typed in the title box - not the one last saved. */
export function setCurrentBoard(id, name) {
  current = { id, name: name || '' };
}

export const currentBoardId = () => current.id;
export const directoryKnown = () => known;
export function onDirectoryChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Every board on this computer, the open one included. */
export function allBoards() {
  const list = [...byId.values()];
  if (current.id && !byId.has(current.id)) list.push({ id: current.id, name: current.name, thumb: null, modified: Date.now() });
  return list.map((b) => (b.id === current.id ? { ...b, name: current.name || b.name } : b));
}

function directoryName(id) {
  if (id && id === current.id) return current.name;
  return byId.get(id)?.name || null;
}

/**
 * The board a link means here: by its id, or - when that id is not on this
 * computer - by its name, if exactly one board has that name.
 * @returns {{id, name, thumb}|null}
 */
export function lookupBoard(ref) {
  if (!ref) return null;
  if (ref.id && ref.id === current.id) return { id: current.id, name: current.name, thumb: byId.get(current.id)?.thumb || null };
  const e = ref.id && byId.get(ref.id);
  if (e) return e;
  // A board that came over the network remembers the id it had on the computer
  // it came from (origin "sync:<device>/<id>"), so links made over there find it here.
  if (ref.id) {
    const tail = '/' + ref.id;
    const came = [...byId.values()].filter((b) => typeof b.origin === 'string' && b.origin.startsWith('sync:') && b.origin.endsWith(tail));
    if (came.length === 1) return came[0];
  }
  const name = String(ref.name || '').trim().toLowerCase();
  if (!name) return null;
  const same = allBoards().filter((b) => String(b.name || '').trim().toLowerCase() === name);
  return same.length === 1 ? same[0] : null;
}

/** Is this link to a board that is not here? Only said once the list has been read. */
export const refMissing = (ref) => known && !lookupBoard(ref);

/** What a link reads as: the board's name now, and the page if it points at one. */
export function refLabel(ref) {
  const b = lookupBoard(ref);
  const name = (b && b.name) || ref.name || '?';
  return ref.page > 0 ? `${name} › ${ref.page}` : name;
}

/** The links in a list of objects (an array, or a board's id -> object map), each board once, in the order met. */
export function linkedRefs(objects) {
  const seen = new Map();
  const add = (ref) => { if (ref && ref.id && !seen.has(ref.id)) seen.set(ref.id, { id: ref.id, name: ref.name || '' }); };
  const words = (s) => { for (const r of refSpans(s)) add(r); };
  const list = Array.isArray(objects) ? objects : Object.values(objects || {});
  for (const o of list) {
    if (!o) continue;
    if (o.type === 'boardlink') add(o.board);
    if (typeof o.text === 'string') words(o.text);
    if (o.cells) for (const v of Object.values(o.cells)) words(v);
  }
  return [...seen.values()];
}

/**
 * The same objects with their links pointed at new board ids: `map` is old id
 * -> new id. Used when boards arrive together and some of them have to be given
 * new ids here - their links to each other must follow. A styled run that a
 * link happens to straddle cannot be rewritten safely, so those words lose
 * their styling rather than show anything but their own text.
 */
export function remapBoardIds(objects, map) {
  if (!map || !map.size) return objects;
  const swap = (s) => (typeof s === 'string' && s.includes('](b:')
    ? s.replace(REF_RE, (whole, name, id, page) => (map.has(id) ? `@[${name}](b:${map.get(id)}${page ? '#' + page : ''})` : whole))
    : s);
  const runsFor = (runs, text) => {
    if (!Array.isArray(runs)) return runs;
    const next = runs.map((r) => ({ ...r, t: swap(r.t) }));
    return next.map((r) => r.t).join('') === text ? next : undefined;
  };
  const one = (o) => {
    if (!o || typeof o !== 'object') return o;
    const n = { ...o };
    if (n.type === 'boardlink' && n.board && map.has(n.board.id)) n.board = { ...n.board, id: map.get(n.board.id) };
    if (typeof n.text === 'string') {
      n.text = swap(n.text);
      if (n.runs) { const r = runsFor(n.runs, n.text); if (r) n.runs = r; else delete n.runs; }
    }
    if (n.cells) {
      n.cells = Object.fromEntries(Object.entries(n.cells).map(([k, v]) => [k, swap(v)]));
      if (n.cellRuns) {
        n.cellRuns = Object.fromEntries(Object.entries(n.cellRuns)
          .map(([k, r]) => [k, runsFor(r, n.cells[k])]).filter(([, r]) => r));
      }
    }
    return n;
  };
  return Array.isArray(objects) ? objects.map(one) : Object.fromEntries(Object.entries(objects || {}).map(([k, o]) => [k, one(o)]));
}

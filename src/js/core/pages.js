// The page strip.
//
// A board is either infinite (no pages) or a stack of sheets laid out top to
// bottom in ONE flat world coordinate space, with a gutter between them. That
// choice is the whole reason multi-page was cheap to add: hit testing,
// selection, transforms, culling, the op log and undo all keep working on
// plain world coordinates and never learn that pages exist.
//
// Page 0 is centred on the origin, so a board saved when only a single page
// was possible occupies exactly the same rectangle it always did and nothing
// on it moves.

export const PAGE_GAP = 56;        // world units of desk between sheets

/**
 * World rectangles for every sheet, top to bottom.
 * @param {Array<{w:number,h:number}>} pages
 * @returns {Array<{x:number,y:number,w:number,h:number}>}
 */
export function pageRects(pages) {
  if (!pages || !pages.length) return [];
  const out = [];
  let top = -pages[0].h / 2;
  for (const p of pages) {
    out.push({ x: -p.w / 2, y: top, w: p.w, h: p.h });
    top += p.h + PAGE_GAP;
  }
  return out;
}

/** The rectangle of one sheet, or null. */
export function pageRectAt(pages, i) {
  const r = pageRects(pages);
  return (i >= 0 && i < r.length) ? r[i] : null;
}

/** Everything the sheets cover, gutters included. Null when infinite. */
export function stripBounds(pages) {
  const r = pageRects(pages);
  if (!r.length) return null;
  const last = r[r.length - 1];
  let x = r[0].x, right = r[0].x + r[0].w;
  for (const p of r) { x = Math.min(x, p.x); right = Math.max(right, p.x + p.w); }
  return { x, y: r[0].y, w: right - x, h: last.y + last.h - r[0].y };
}

export const inRect = (r, x, y) => !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/* The `…In` variants take rectangles the caller already computed. The render
 * loop asks which sheet an object is on once per object per frame, and on a
 * pad of thirty imported pages rebuilding the whole strip for each of those
 * questions is thirty times the work for the same answer. */

/** Index of the sheet under a world point, given precomputed rects. */
export function pageIndexAtIn(rects, x, y) {
  for (let i = 0; i < rects.length; i++) if (inRect(rects[i], x, y)) return i;
  return -1;
}

/** Index of the sheet a box belongs to, given precomputed rects. */
export function pageIndexForBoxIn(rects, b) {
  return b ? pageIndexAtIn(rects, b.x + b.w / 2, b.y + b.h / 2) : -1;
}

/** Index of the sheet under a world point, or -1 for the gutter. */
export function pageIndexAt(pages, x, y) {
  const r = pageRects(pages);
  for (let i = 0; i < r.length; i++) if (inRect(r[i], x, y)) return i;
  return -1;
}

/** Index of the sheet a box belongs to, decided by its centre. -1 for none. */
export function pageIndexForBox(pages, b) {
  if (!b) return -1;
  return pageIndexAt(pages, b.x + b.w / 2, b.y + b.h / 2);
}

/** The sheet nearest a world point - used to rescue something in the gutter. */
export function nearestPageIndex(pages, x, y) {
  const r = pageRects(pages);
  if (!r.length) return -1;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < r.length; i++) {
    const cx = Math.max(r[i].x, Math.min(x, r[i].x + r[i].w));
    const cy = Math.max(r[i].y, Math.min(y, r[i].y + r[i].h));
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * How far a box has to move to sit inside a sheet.
 *
 * A box larger than the sheet is centred on it rather than jammed against a
 * corner - being unable to place an oversized image at all is worse than
 * having it overhang symmetrically, and the renderer clips it either way.
 *
 * @returns {{dx:number,dy:number}}
 */
export function offsetIntoRect(b, r) {
  if (!b || !r) return { dx: 0, dy: 0 };
  let dx = 0, dy = 0;
  if (b.w >= r.w) dx = (r.x + r.w / 2) - (b.x + b.w / 2);
  else if (b.x < r.x) dx = r.x - b.x;
  else if (b.x + b.w > r.x + r.w) dx = (r.x + r.w) - (b.x + b.w);
  if (b.h >= r.h) dy = (r.y + r.h / 2) - (b.y + b.h / 2);
  else if (b.y < r.y) dy = r.y - b.y;
  else if (b.y + b.h > r.y + r.h) dy = (r.y + r.h) - (b.y + b.h);
  return { dx, dy };
}

/** Clamp a world point into a rectangle. */
export function clampPoint(r, x, y) {
  return r ? { x: Math.max(r.x, Math.min(x, r.x + r.w)), y: Math.max(r.y, Math.min(y, r.y + r.h)) } : { x, y };
}

/** World rect -> screen rect under a camera. */
export function toScreen(r, cam) {
  return r ? { x: r.x * cam.z + cam.x, y: r.y * cam.z + cam.y, w: r.w * cam.z, h: r.h * cam.z } : null;
}

/**
 * Normalise whatever a saved file carries into a pages array.
 * Boards written before multi-page carry a single `page:{w,h}`.
 */
export function pagesFrom(data) {
  if (Array.isArray(data?.pages)) return data.pages.filter((p) => p && p.w > 0 && p.h > 0).map(cleanPage);
  if (data?.page && data.page.w > 0 && data.page.h > 0) return [cleanPage(data.page)];
  return [];
}

/* ---------- the date a sheet was started ----------
 *
 * Every sheet remembers the day it was added, the way you write the date at
 * the top of a notebook page: once, and it stays. It is kept as a plain
 * YYYY-MM-DD so it means the same day in every language and on every machine,
 * and only turned into "৬ অক্টোবর" or "6 October" at the moment it is drawn.
 * Sheets from boards made before this simply have none, and opening such a
 * board never invents one - that would be editing someone's file behind
 * their back.
 */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Where "today" comes from. The suite swaps `now` to pretend it is another day. */
export const pageClock = { now: () => new Date() };

/** Today (or `d`) as YYYY-MM-DD, in local time - the day on the person's own calendar. */
export function todayStamp(d = pageClock.now()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** A sheet reduced to what is kept on disk: its size, and its date when it has one. */
export function cleanPage(p) {
  const out = { w: p.w, h: p.h };
  if (typeof p.date === 'string' && DATE_RE.test(p.date)) out.date = p.date;
  return out;
}

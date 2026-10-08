// Geometry mutations shared by the move / resize / rotate gestures.

import { boundsOf } from './store.js';
import { bboxOfPoints, rotatePoint } from './util.js';

/*
 * An arrow is moved, scaled and turned through its two ends. An end that
 * holds on to something is worked out from that thing whenever the arrow is
 * drawn, so moving it here only matters if it is free - which is exactly
 * right: drag an arrow on its own and its loose ends go with it while its
 * attached ends stay put; move it together with what it connects and it
 * follows them.
 */
function eachEnd(o, fn) { for (const k of ['a', 'b']) if (o[k]) fn(o[k]); }

export function translateObject(o, dx, dy) {
  if (o.type === 'connector') {
    eachEnd(o, (e) => { e.x += dx; e.y += dy; });
    o.x += dx; o.y += dy;
    return;
  }
  if (o.type === 'stroke') {
    for (const p of o.points) { p.x += dx; p.y += dy; }
    o.bbox = bboxOfPoints(o.points);
  } else { o.x += dx; o.y += dy; }
}

export function scaleObject(o, sx, sy, ox, oy) {
  if (o.type === 'connector') {
    eachEnd(o, (e) => { e.x = ox + (e.x - ox) * sx; e.y = oy + (e.y - oy) * sy; });
    return;
  }
  if (o.type === 'stroke') {
    for (const p of o.points) { p.x = ox + (p.x - ox) * sx; p.y = oy + (p.y - oy) * sy; }
    o.bbox = bboxOfPoints(o.points);
    o.width = Math.max(0.5, (o.width || 4) * Math.sqrt(Math.abs(sx * sy)));
  } else {
    o.x = ox + (o.x - ox) * sx;
    o.y = oy + (o.y - oy) * sy;
    o.w *= sx;
    o.h *= sy;
    if (o.w < 0) { o.x += o.w; o.w = -o.w; }
    if (o.h < 0) { o.y += o.h; o.h = -o.h; }
    if (o.fontSize) o.fontSize = Math.max(6, o.fontSize * Math.sqrt(Math.abs(sx * sy)));
    if (o.type === 'text') o.autoSize = false;   // a hand-set size is kept
    if (o.lineWidth) o.lineWidth = Math.max(0.5, o.lineWidth * Math.sqrt(Math.abs(sx * sy)));
  }
}

export function rotateObjectAround(o, angle, cx, cy) {
  if (o.type === 'connector') {
    // an arrow turns by moving its ends; it never carries a rotation of its own
    eachEnd(o, (e) => { const p = rotatePoint(e.x, e.y, cx, cy, angle); e.x = p.x; e.y = p.y; });
    return;
  }
  const b = boundsOf(o);
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const nc = rotatePoint(c.x, c.y, cx, cy, angle);
  translateObject(o, nc.x - c.x, nc.y - c.y);
  o.rotation = (o.rotation || 0) + angle;
}

export function normalizeRect(a, b, square = false) {
  let x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  if (square) {
    const s = Math.max(w, h);
    if (b.x < a.x) x = a.x - s;
    if (b.y < a.y) y = a.y - s;
    w = h = s;
  }
  return { x, y, w, h };
}

export const CURSORS = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', rot: 'grab'
};

export function anchorFor(handle, box) {
  const { x, y, w, h } = box;
  switch (handle) {
    case 'nw': return { x: x + w, y: y + h };
    case 'n': return { x: x + w / 2, y: y + h };
    case 'ne': return { x, y: y + h };
    case 'e': return { x, y: y + h / 2 };
    case 'se': return { x, y };
    case 's': return { x: x + w / 2, y };
    case 'sw': return { x: x + w, y };
    case 'w': return { x: x + w, y: y + h / 2 };
  }
  return { x, y };
}

// Animated slides, imported the way they look after the last click.
//
// Every converter - LibreOffice, Microsoft Office's own Save as PDF, the
// built-in reader - ignores a slide's animations and draws it as it is
// before the first click, everything at once: a box that fades out is still
// there, covering what replaced it; an arrow that grows is at its small
// starting size; a shape that travels along a path sits where it started.
//
// So the slide is rewritten, before any converter sees it, to how it stands
// once every click has been made:
//   - something that leaves (an exit effect) is gone - unless a later click
//     brings it back;
//   - something that travels (a motion path) is where the path ends;
//   - something that grows or shrinks is at its final size, and something
//     that spins at its final angle;
//   - something that comes in (an entrance effect) is simply there.
// Then the slide's animations are taken out, so the work is never done twice.
//
// Only the slide's main click sequence counts. A trigger sequence (things
// that happen when a particular shape is clicked) is optional, so it is left
// as the slide shows before anyone clicks.

const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';

const nsAll = (el, name) => (el ? Array.from(el.getElementsByTagNameNS('*', name)) : []);
const nsFirst = (el, name) => (el ? el.getElementsByTagNameNS('*', name)[0] || null : null);
const kids = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const SHAPES = ['sp', 'pic', 'grpSp', 'graphicFrame', 'cxnSp'];

function resolve(dir, target) {
  if (!target) return null;
  if (target.startsWith('/')) return target.slice(1);
  const parts = dir.split('/');
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** The last point of a motion path, as a fraction of the slide ("M 0 0 L 0.25 0.1 E" ends at 0.25, 0.1). */
export function pathEnd(path) {
  const nums = String(path || '').replace(/[A-Za-z]/g, ' ').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (nums.length < 2 || nums.some((n) => !Number.isFinite(n))) return null;
  return { dx: nums[nums.length - 2], dy: nums[nums.length - 1] };
}

/**
 * Read the main click sequence of a slide: what each shape ends up as.
 * @returns {Map<string,{visible?:boolean, dx:number, dy:number, sx:number, sy:number, rot:number}>}
 */
export function finalStates(slideDoc) {
  const out = new Map();
  const timing = nsFirst(slideDoc, 'timing');
  if (!timing) return out;
  const main = nsAll(timing, 'cTn').find((c) => c.getAttribute('nodeType') === 'mainSeq');
  if (!main) return out;
  const state = (id) => {
    if (!out.has(id)) out.set(id, { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 });
    return out.get(id);
  };
  // effects in the order they play, which is the order they are written in
  for (const eff of nsAll(main, 'cTn').filter((c) => c.hasAttribute('presetClass'))) {
    const cls = eff.getAttribute('presetClass');
    const tgt = nsFirst(eff, 'spTgt');
    if (!tgt) continue;
    // one paragraph of a text box coming and going is not the whole box
    if (nsFirst(tgt, 'txEl') || nsFirst(tgt, 'bg') || nsFirst(tgt, 'subSp') || nsFirst(tgt, 'oleChartEl')) continue;
    const id = tgt.getAttribute('spid');
    if (!id) continue;
    const s = state(id);
    if (cls === 'entr') s.visible = true;
    else if (cls === 'exit') s.visible = false;
    for (const m of nsAll(eff, 'animMotion')) {
      const end = pathEnd(m.getAttribute('path'));
      if (end) { s.dx += end.dx; s.dy += end.dy; }
    }
    for (const sc of nsAll(eff, 'animScale')) {
      const by = kids(sc, 'by')[0], to = kids(sc, 'to')[0];
      if (by) { s.sx *= (Number(by.getAttribute('x')) || 100000) / 100000; s.sy *= (Number(by.getAttribute('y')) || 100000) / 100000; }
      else if (to) { s.sx = (Number(to.getAttribute('x')) || 100000) / 100000; s.sy = (Number(to.getAttribute('y')) || 100000) / 100000; }
    }
    for (const r of nsAll(eff, 'animRot')) {
      const by = Number(r.getAttribute('by'));
      if (Number.isFinite(by)) s.rot += by / 60000;
    }
  }
  return out;
}

/** The shape on the slide with this id, wherever it sits. */
function shapeById(doc, id) {
  for (const c of nsAll(doc, 'cNvPr')) {
    if (c.getAttribute('id') !== id) continue;
    let el = c.parentNode;
    while (el && !SHAPES.includes(el.localName)) el = el.parentNode;
    if (el) return el;
  }
  return null;
}

/** A shape's own frame, if it has one written on the slide. */
function frameOf(shape) {
  if (shape.localName === 'graphicFrame') return kids(shape, 'xfrm')[0] || null;
  const pr = kids(shape, shape.localName === 'grpSp' ? 'grpSpPr' : 'spPr')[0];
  return pr ? kids(pr, 'xfrm')[0] || null : null;
}

/**
 * A placeholder (a title, a content box) usually takes its place from the
 * layout or the master rather than writing it on the slide. To move or size
 * one, that place is copied onto the slide first.
 */
async function inheritedFrame(zip, slidePath, slideRels, shape) {
  const ph = nsFirst(shape, 'ph');
  if (!ph) return null;
  const type = ph.getAttribute('type') || 'body', idx = ph.getAttribute('idx');
  const find = (doc) => {
    for (const sp of nsAll(doc, 'sp')) {
      const p = nsFirst(sp, 'ph');
      if (!p) continue;
      const sameIdx = idx != null && p.getAttribute('idx') === idx;
      const sameType = (p.getAttribute('type') || 'body') === type;
      if (sameIdx || (idx == null && sameType)) {
        const xf = frameOf(sp);
        if (xf) return xf;
      }
    }
    // a title is a title, whatever its number
    if (/title/i.test(type)) for (const sp of nsAll(doc, 'sp')) {
      const p = nsFirst(sp, 'ph');
      if (p && /title/i.test(p.getAttribute('type') || '')) { const xf = frameOf(sp); if (xf) return xf; }
    }
    return null;
  };
  let dir = slidePath.replace(/\/[^/]+$/, ''), rels = slideRels, path = slidePath;
  for (let hop = 0; hop < 2; hop++) {
    const rel = Object.values(rels).find((r) => /slideLayout|slideMaster/.test(r.type));
    if (!rel) return null;
    path = resolve(dir, rel.target);
    const f = zip.file(path);
    if (!f) return null;
    const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
    const xf = find(doc);
    if (xf) return xf;
    dir = path.replace(/\/[^/]+$/, '');
    rels = await relsOf(zip, path);
  }
  return null;
}

async function relsOf(zip, path) {
  const f = zip.file(path.replace(/([^/]+)$/, '_rels/$1.rels'));
  const map = {};
  if (!f) return map;
  const x = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
  for (const r of nsAll(x, 'Relationship')) map[r.getAttribute('Id')] = { target: r.getAttribute('Target'), type: r.getAttribute('Type') || '' };
  return map;
}

function frameOnSlide(doc, shape, copyFrom) {
  let xf = frameOf(shape);
  if (xf || !copyFrom) return xf;
  if (shape.localName === 'graphicFrame') return null;
  const prName = shape.localName === 'grpSp' ? 'grpSpPr' : 'spPr';
  let pr = kids(shape, prName)[0];
  if (!pr) { pr = doc.createElementNS(P_NS, 'p:' + prName); shape.appendChild(pr); }
  xf = doc.importNode(copyFrom, true);
  pr.insertBefore(xf, pr.firstChild);
  return xf;
}

/**
 * Put every animated slide of an opened deck into its after-the-last-click
 * look. Changes the zip in place.
 * @returns {Promise<{slides:number, hidden:number, moved:number, sized:number, turned:number, skipped:string[]}>}
 */
export async function finalLook(zip) {
  const report = { slides: 0, hidden: 0, moved: 0, sized: 0, turned: 0, skipped: [] };
  const presFile = zip.file('ppt/presentation.xml');
  if (!presFile) return report;
  const pres = new DOMParser().parseFromString(await presFile.async('string'), 'application/xml');
  const sz = nsFirst(pres, 'sldSz');
  const W = Number(sz?.getAttribute('cx')) || 12192000, H = Number(sz?.getAttribute('cy')) || 6858000;

  const slides = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  for (const path of slides) {
    const xml = await zip.file(path).async('string');
    if (!/<p:timing[\s>]/.test(xml)) continue;
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const states = finalStates(doc);
    let rels = null;
    let changed = false;

    for (const [id, s] of states) {
      const shape = shapeById(doc, id);
      if (!shape) continue;
      if (s.visible === false) {
        shape.parentNode.removeChild(shape);
        report.hidden++; changed = true;
        continue;
      }
      const moves = Math.abs(s.dx) > 1e-6 || Math.abs(s.dy) > 1e-6;
      const sizes = Math.abs(s.sx - 1) > 1e-6 || Math.abs(s.sy - 1) > 1e-6;
      const turns = Math.abs(s.rot) > 1e-6;
      if (!moves && !sizes && !turns) continue;
      let xf = frameOf(shape);
      if (!xf) {
        rels = rels || await relsOf(zip, path);
        xf = frameOnSlide(doc, shape, await inheritedFrame(zip, path, rels, shape));
      }
      const off = xf && kids(xf, 'off')[0], ext = xf && kids(xf, 'ext')[0];
      if (!off || !ext) { report.skipped.push(`${path}: shape ${id} has no place of its own to move`); continue; }
      let x = Number(off.getAttribute('x')) || 0, y = Number(off.getAttribute('y')) || 0;
      let w = Number(ext.getAttribute('cx')) || 0, h = Number(ext.getAttribute('cy')) || 0;
      if (sizes) {
        // grows about its middle, the way the effect does
        const cx = x + w / 2, cy = y + h / 2;
        w = Math.max(1, w * s.sx); h = Math.max(1, h * s.sy);
        x = cx - w / 2; y = cy - h / 2;
        ext.setAttribute('cx', String(Math.round(w))); ext.setAttribute('cy', String(Math.round(h)));
        report.sized++;
      }
      if (moves) { x += s.dx * W; y += s.dy * H; report.moved++; }
      off.setAttribute('x', String(Math.round(x))); off.setAttribute('y', String(Math.round(y)));
      if (turns) {
        const rot = ((Number(xf.getAttribute('rot')) || 0) + Math.round(s.rot * 60000)) % 21600000;
        xf.setAttribute('rot', String((rot + 21600000) % 21600000));
        report.turned++;
      }
      changed = true;
    }

    // its animations are spent: nothing reads them again, and nothing does this twice
    const timing = nsFirst(doc, 'timing');
    if (timing) timing.parentNode.removeChild(timing);
    zip.file(path, new XMLSerializer().serializeToString(doc));
    if (changed) report.slides++;
  }
  return report;
}


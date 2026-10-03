// Videos and moving pictures on slides, turned into a still worth looking at.
//
// A slide only ever becomes a picture on the board, so a video on it becomes
// its "poster" - the still PowerPoint keeps for it - and an animated GIF
// becomes its first frame. Both are very often blank: a clip that fades in
// from black has a black poster, and an animation that builds itself up
// starts from an empty frame. In a classroom that is a black box, or nothing
// at all, where the interesting part of the slide should be.
//
// So before a deck is converted (by any converter - LibreOffice, Microsoft
// Office or the built-in one), each such still is checked, and a blank one is
// swapped for a frame that has something in it:
//   - a video gets a frame from its own clip, with a small play sign so the
//     class can see it is a clip; if the clip cannot be played here, a plain
//     card saying it is a video stands in, never a black box;
//   - a GIF gets its last frame (the finished picture), or failing that the
//     busiest frame in it.
// A still that already shows something is left exactly as it is.

import { t } from '../i18n.js';
import { finalLook } from './slideanim.js';

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

const nsAll = (el, name) => (el ? Array.from(el.getElementsByTagNameNS('*', name)) : []);
const nsFirst = (el, name) => (el ? el.getElementsByTagNameNS('*', name)[0] || null : null);
const relOf = (el) => (el ? el.getAttributeNS(R_NS, 'embed') || el.getAttributeNS(R_NS, 'link') || el.getAttribute('r:embed') || el.getAttribute('r:link') : null);

const VIDEO_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/webm' };

/** With a deadline, so a clip this machine cannot play never holds the import up. */
function within(ms, p) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
}

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

/**
 * How much is going on in a picture: the spread of its brightness, sampled
 * small. A blank frame - all black, all white, one flat colour - scores near 0.
 */
export function busyness(source, w, h) {
  const S = 48;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';                   // a transparent GIF frame reads as the slide behind it
  g.fillRect(0, 0, S, S);
  g.drawImage(source, 0, 0, w || source.width, h || source.height, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S).data;
  let sum = 0, sq = 0;
  const n = S * S;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    sum += y; sq += y * y;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

const BLANK = 6;                          // brightness spread below this is "nothing to see"

async function bitmapOf(bytes, mime) {
  return createImageBitmap(new Blob([bytes], { type: mime || 'image/png' }));
}

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

/** The small round play sign in the corner, so a still from a clip reads as a clip. */
function playBadge(g, w, h) {
  const r = Math.max(10, Math.min(w, h) * 0.09);
  const cx = r * 1.4, cy = h - r * 1.4;
  g.save();
  g.fillStyle = 'rgba(0,0,0,.55)';
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(cx - r * 0.35, cy - r * 0.5); g.lineTo(cx + r * 0.55, cy); g.lineTo(cx - r * 0.35, cy + r * 0.5);
  g.closePath(); g.fill();
  g.restore();
}

/** What stands in for a clip that cannot be played here: a light card, never a black box. */
function videoCard(w, h, label) {
  const c = canvasOf(w, h), g = c.getContext('2d');
  g.fillStyle = '#eef1f5'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#c3cad4'; g.lineWidth = Math.max(2, c.width / 160); g.strokeRect(1, 1, c.width - 2, c.height - 2);
  const r = Math.min(c.width, c.height) * 0.16;
  const cx = c.width / 2, cy = c.height / 2 - r * 0.35;
  g.fillStyle = '#5b6573';
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(cx - r * 0.35, cy - r * 0.5); g.lineTo(cx + r * 0.55, cy); g.lineTo(cx - r * 0.35, cy + r * 0.5); g.closePath(); g.fill();
  g.fillStyle = '#3b4350';
  g.font = `600 ${Math.max(12, Math.round(c.height * 0.075))}px "Segoe UI", system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'top';
  let text = label || t('Video');
  while (text.length > 4 && g.measureText(text).width > c.width * 0.9) text = text.slice(0, -2);
  if (text !== (label || t('Video'))) text += '…';
  g.fillText(text, cx, cy + r * 1.3);
  return c;
}

/** A frame from the clip itself that has something in it, or null. */
async function frameFromClip(bytes, ext) {
  const mime = VIDEO_MIME[ext];
  if (!mime) return null;
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.playsInline = true;
  try {
    await within(5000, new Promise((res, rej) => {
      v.onloadeddata = res; v.onerror = () => rej(new Error('cannot play'));
      v.src = url;
    }));
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, 1280 / vw);
    const c = canvasOf(vw * scale, vh * scale), g = c.getContext('2d');
    const times = d ? [Math.min(1, d * 0.1), d * 0.25, d * 0.5, d * 0.75, Math.max(0, d - 0.05)] : [0];
    for (const tm of times) {
      try {
        await within(3000, new Promise((res, rej) => { v.onseeked = res; v.onerror = () => rej(new Error('seek')); v.currentTime = tm; }));
      } catch { continue; }
      g.drawImage(v, 0, 0, c.width, c.height);
      if (busyness(c) >= BLANK) return c;      // the first frame worth showing
    }
    return null;                               // all of it blank: the card says more than a black frame
  } catch {
    return null;
  } finally {
    v.removeAttribute('src'); try { v.load(); } catch { /* gone */ }
    URL.revokeObjectURL(url);
  }
}

/** The finished picture of an animated GIF whose first frame is empty. */
async function frameFromGif(bytes) {
  if (typeof window.ImageDecoder !== 'function') return null;
  let dec = null;
  try {
    dec = new window.ImageDecoder({ data: bytes, type: 'image/gif' });
    await within(4000, dec.tracks.ready);
    const count = dec.tracks.selectedTrack?.frameCount || 1;
    if (count < 2) return null;
    const take = async (i) => {
      const { image } = await within(3000, dec.decode({ frameIndex: i }));
      const c = canvasOf(image.displayWidth, image.displayHeight);
      c.getContext('2d').drawImage(image, 0, 0);
      image.close();
      return c;
    };
    const last = await take(count - 1);
    if (busyness(last) >= BLANK) return last;
    // the last frame is empty too (it fades out): the busiest one, looked at sparingly
    let best = null, bestScore = -1;
    const step = Math.max(1, Math.floor(count / 24));
    for (let i = 0; i < count; i += step) {
      const c = await take(i);
      const s = busyness(c);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return bestScore >= BLANK ? best : null;
  } catch {
    return null;
  } finally {
    try { dec?.close(); } catch { /* closed */ }
  }
}

const toPng = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => res(new Uint8Array(a)), rej) : rej(new Error('no picture'))), 'image/png'));

/**
 * Look over every slide in an opened deck and replace each blank video poster
 * or blank animated GIF with a still worth seeing. Changes the zip in place.
 *
 * @param {JSZip} zip
 * @returns {Promise<{changed:number, videos:number, gifs:number, notes:string[]}>}
 */
export async function fixSlideMedia(zip) {
  const report = { changed: 0, videos: 0, gifs: 0, notes: [] };
  const slides = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  let serial = 0;
  let needPng = false;

  for (const path of slides) {
    const relsPath = path.replace(/([^/]+)$/, '_rels/$1.rels');
    const relsFile = zip.file(relsPath);
    if (!relsFile) continue;
    const slideXml = await zip.file(path).async('string');
    // cheap test first: most slides have neither a clip nor a GIF
    const relsXml = await relsFile.async('string');
    if (!/video|media|\.gif"/i.test(relsXml)) continue;

    const rels = new DOMParser().parseFromString(relsXml, 'application/xml');
    const relMap = {};
    for (const r of nsAll(rels, 'Relationship')) relMap[r.getAttribute('Id')] = r;
    const doc = new DOMParser().parseFromString(slideXml, 'application/xml');
    const dir = path.replace(/\/[^/]+$/, '');
    let touched = false;

    for (const pic of nsAll(doc, 'pic')) {
      const blip = nsFirst(pic, 'blip');
      const posterId = relOf(blip);
      const posterRel = posterId && relMap[posterId];
      const posterPath = posterRel && posterRel.getAttribute('TargetMode') !== 'External' ? resolve(dir, posterRel.getAttribute('Target')) : null;
      const nvPr = nsFirst(pic, 'nvPr');
      const clipRef = nsFirst(nvPr, 'videoFile') || nsFirst(nvPr, 'media');
      const isGif = !!posterPath && /\.gif$/i.test(posterPath);
      if (!clipRef && !isGif) continue;

      const posterFile = posterPath && zip.file(posterPath);
      const posterBytes = posterFile ? await posterFile.async('uint8array') : null;
      const ext = (posterPath || '').split('.').pop().toLowerCase();
      let posterBmp = null;
      try { posterBmp = posterBytes ? await bitmapOf(posterBytes, ext === 'gif' ? 'image/gif' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png') : null; } catch { posterBmp = null; }
      const blank = !posterBmp || busyness(posterBmp) < BLANK;
      if (!blank) continue;

      let still = null;
      if (clipRef) {
        report.videos++;
        // the clip: an embedded one is a part of the package; a linked one sits next to the deck and is not ours to read
        let clipPath = null;
        for (const el of [nsFirst(nvPr, 'media'), nsFirst(nvPr, 'videoFile')]) {
          const id = relOf(el);
          const r = id && relMap[id];
          if (r && r.getAttribute('TargetMode') !== 'External') { clipPath = resolve(dir, r.getAttribute('Target')); break; }
        }
        const clipFile = clipPath && zip.file(clipPath);
        const clipExt = (clipPath || '').split('.').pop().toLowerCase();
        const frame = clipFile ? await frameFromClip(await clipFile.async('uint8array'), clipExt) : null;
        const w = frame?.width || posterBmp?.width || 640, hh = frame?.height || posterBmp?.height || 360;
        if (frame) {
          still = frame;
          playBadge(still.getContext('2d'), still.width, still.height);
          report.notes.push(`${path}: a frame from ${clipPath}`);
        } else {
          const name = nsFirst(pic, 'cNvPr')?.getAttribute('name') || (clipPath || '').split('/').pop() || t('Video');
          still = videoCard(Math.max(320, w), Math.max(180, hh), name);
          report.notes.push(`${path}: a video card for ${clipPath || 'a linked clip'}`);
        }
      } else {
        report.gifs++;
        still = await frameFromGif(posterBytes);
        if (!still) { report.notes.push(`${path}: ${posterPath} is blank all the way through`); continue; }
        report.notes.push(`${path}: the finished frame of ${posterPath}`);
      }

      // a new picture of our own, so a poster shared with another slide is left alone there
      const png = await toPng(still);
      let name;
      do { name = `ppt/media/gazboard-still-${++serial}.png`; } while (zip.file(name));
      zip.file(name, png);
      let id;
      do { id = `rIdGz${serial}${Math.random().toString(36).slice(2, 6)}`; } while (relMap[id]);
      const rel = rels.createElementNS(PKG_NS, 'Relationship');
      rel.setAttribute('Id', id);
      rel.setAttribute('Type', IMAGE_REL);
      rel.setAttribute('Target', '../media/' + name.split('/').pop());
      rels.documentElement.appendChild(rel);
      relMap[id] = rel;
      blip.setAttributeNS(R_NS, 'r:embed', id);
      touched = true;
      needPng = true;
      report.changed++;
    }

    if (touched) {
      zip.file(path, new XMLSerializer().serializeToString(doc));
      zip.file(relsPath, new XMLSerializer().serializeToString(rels));
    }
  }

  if (needPng) {
    const ctFile = zip.file('[Content_Types].xml');
    if (ctFile) {
      const ct = await ctFile.async('string');
      if (!/Extension="png"/i.test(ct)) {
        zip.file('[Content_Types].xml', ct.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'));
      }
    }
  }
  return report;
}

/** The zip reader, fetched the first time a deck needs it (the board page does not load it up front). */
function zipReader() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('../../vendor/jszip.min.js', import.meta.url).href;
    s.onload = () => (window.JSZip ? res(window.JSZip) : rej(new Error('no zip reader')));
    s.onerror = () => rej(new Error('no zip reader'));
    document.head.appendChild(s);
  });
}

/**
 * Get a deck ready for any converter: blank video stills and empty GIF frames
 * swapped for pictures worth seeing, and - unless asked not to - every
 * animated slide put into its after-the-last-click look. Returns the fixed
 * deck as bytes, or null when nothing on it needed changing (so the original
 * file is used untouched).
 */
export async function fixDeckBytes(bytes, { finalLook: last = true } = {}) {
  const JSZip = await zipReader().catch(() => null);
  const none = (why) => ({ bytes: null, report: { changed: 0, videos: 0, gifs: 0, notes: [why] }, animations: null });
  if (!JSZip) return none('no zip reader');
  const zip = await JSZip.loadAsync(bytes);
  if (!zip.file('ppt/presentation.xml')) return none('not a deck');
  const report = await fixSlideMedia(zip);
  let animations = null;
  if (last) {
    try { animations = await finalLook(zip); } catch (e) { animations = { slides: 0, error: e?.message || String(e) }; }
  }
  if (!report.changed && !(animations && animations.slides)) return { bytes: null, report, animations };
  return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), report, animations };
}

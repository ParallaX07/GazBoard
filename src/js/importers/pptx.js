// Minimal OOXML PowerPoint reader.
//
// Used only when LibreOffice is not installed: it walks the slide XML and
// rebuilds each slide as absolutely-positioned HTML, which the main process
// then prints to PDF and the board rasterises. Fidelity is "readable", not
// pixel-perfect - shapes, text, pictures, tables and basic formatting.

import { t } from '../i18n.js';
import { fixSlideMedia } from './slidemedia.js';
import { finalLook } from './slideanim.js';

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relId = (el) => (el ? el.getAttributeNS(R_NS, 'embed') || el.getAttributeNS(R_NS, 'id') || el.getAttribute('r:embed') || el.getAttribute('r:id') : null);

const EMU_PX = 9525;                 // 914400 EMU / inch at 96 dpi
const px = (emu) => (Number(emu) || 0) / EMU_PX;

const nsAll = (el, name) => (el ? Array.from(el.getElementsByTagNameNS('*', name)) : []);
const nsFirst = (el, name) => (el ? el.getElementsByTagNameNS('*', name)[0] || null : null);
const childrenNamed = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);

const SCHEME = {
  dk1: '#000000', lt1: '#ffffff', dk2: '#44546a', lt2: '#e7e6e6',
  accent1: '#4472c4', accent2: '#ed7d31', accent3: '#a5a5a5', accent4: '#ffc000',
  accent5: '#5b9bd5', accent6: '#70ad47', hlink: '#0563c1', folHlink: '#954f72',
  tx1: '#000000', tx2: '#44546a', bg1: '#ffffff', bg2: '#e7e6e6'
};

function colorOf(node) {
  if (!node) return null;
  const srgb = nsFirst(node, 'srgbClr');
  if (srgb) return '#' + srgb.getAttribute('val');
  const scheme = nsFirst(node, 'schemeClr');
  if (scheme) return SCHEME[scheme.getAttribute('val')] || '#333333';
  const sys = nsFirst(node, 'sysClr');
  if (sys) return '#' + (sys.getAttribute('lastClr') || '000000');
  return null;
}

function xfrmOf(sp) {
  const spPr = nsFirst(sp, 'spPr') || nsFirst(sp, 'grpSpPr') || sp;
  const xf = nsFirst(spPr, 'xfrm');
  if (!xf) return null;
  const off = nsFirst(xf, 'off'), ext = nsFirst(xf, 'ext');
  if (!off || !ext) return null;
  return {
    x: px(off.getAttribute('x')), y: px(off.getAttribute('y')),
    w: px(ext.getAttribute('cx')), h: px(ext.getAttribute('cy')),
    rot: (Number(xf.getAttribute('rot')) || 0) / 60000,
    flipH: xf.getAttribute('flipH') === '1', flipV: xf.getAttribute('flipV') === '1'
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function textBodyHtml(txBody, defaultColor) {
  if (!txBody) return '';
  const bodyPr = nsFirst(txBody, 'bodyPr');
  const anchor = bodyPr?.getAttribute('anchor') || 't';
  const paras = childrenNamed(txBody, 'p');
  let html = '';
  for (const p of paras) {
    const pPr = nsFirst(p, 'pPr');
    const align = pPr?.getAttribute('algn');
    const lvl = Number(pPr?.getAttribute('lvl') || 0);
    const bullet = !!nsFirst(pPr, 'buChar') || !!nsFirst(pPr, 'buAutoNum');
    const cssAlign = { ctr: 'center', r: 'right', just: 'justify', l: 'left' }[align] || 'left';
    let inner = '';
    for (const node of Array.from(p.children)) {
      if (node.localName === 'r') {
        const rPr = nsFirst(node, 'rPr');
        const t = nsFirst(node, 't')?.textContent ?? '';
        const size = rPr?.getAttribute('sz') ? Number(rPr.getAttribute('sz')) / 100 : null;
        const bold = rPr?.getAttribute('b') === '1';
        const ital = rPr?.getAttribute('i') === '1';
        const und = rPr?.getAttribute('u') && rPr.getAttribute('u') !== 'none';
        const col = colorOf(nsFirst(rPr, 'solidFill')) || defaultColor || '#000000';
        const font = nsFirst(rPr, 'latin')?.getAttribute('typeface');
        const style = [
          size ? `font-size:${size}pt` : '',
          bold ? 'font-weight:700' : '',
          ital ? 'font-style:italic' : '',
          und ? 'text-decoration:underline' : '',
          `color:${col}`,
          font ? `font-family:'${font}',Calibri,Segoe UI,sans-serif` : ''
        ].filter(Boolean).join(';');
        inner += `<span style="${style}">${escapeHtml(t)}</span>`;
      } else if (node.localName === 'br') inner += '<br>';
      else if (node.localName === 'fld') inner += escapeHtml(nsFirst(node, 't')?.textContent ?? '');
    }
    if (!inner) inner = '<span>&nbsp;</span>';
    html += `<p style="text-align:${cssAlign};margin:0 0 .28em 0;padding-left:${lvl * 22}px">${bullet ? '<span style="opacity:.7">•&nbsp;</span>' : ''}${inner}</p>`;
  }
  const just = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start';
  return `<div style="display:flex;flex-direction:column;justify-content:${just};height:100%">${html}</div>`;
}

function geomCss(sp) {
  const prst = nsFirst(sp, 'prstGeom')?.getAttribute('prst');
  if (!prst) return '';
  if (/ellipse|circle/.test(prst)) return 'border-radius:50%;';
  if (/roundRect/.test(prst)) return 'border-radius:12px;';
  return '';
}

async function relsFor(zip, slidePath) {
  const dir = slidePath.replace(/\/[^/]+$/, '');
  const base = slidePath.split('/').pop();
  const file = zip.file(`${dir}/_rels/${base}.rels`);
  const map = {};
  if (!file) return map;
  const xml = new DOMParser().parseFromString(await file.async('string'), 'application/xml');
  for (const r of nsAll(xml, 'Relationship')) {
    map[r.getAttribute('Id')] = { target: r.getAttribute('Target'), type: r.getAttribute('Type') };
  }
  return map;
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

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', emf: null, wmf: null, tiff: null };

async function mediaDataUrl(zip, path) {
  const f = zip.file(path);
  if (!f) return null;
  const ext = path.split('.').pop().toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;                    // EMF/WMF can't be shown in a browser
  const b64 = await f.async('base64');
  return `data:${mime};base64,${b64}`;
}

async function tableHtml(frame) {
  const tbl = nsFirst(frame, 'tbl');
  if (!tbl) return '';
  const grid = nsAll(nsFirst(tbl, 'tblGrid'), 'gridCol').map((c) => px(c.getAttribute('w')));
  const total = grid.reduce((a, b) => a + b, 0) || 1;
  let html = '<table style="width:100%;height:100%;border-collapse:collapse;table-layout:fixed"><colgroup>' +
    grid.map((w) => `<col style="width:${(w / total) * 100}%">`).join('') + '</colgroup><tbody>';
  for (const tr of childrenNamed(tbl, 'tr')) {
    html += `<tr style="height:${px(tr.getAttribute('h'))}px">`;
    for (const tc of childrenNamed(tr, 'tc')) {
      const fill = colorOf(nsFirst(nsFirst(tc, 'tcPr'), 'solidFill'));
      html += `<td style="border:1px solid #9aa0a6;padding:4px 6px;vertical-align:middle;${fill ? `background:${fill};` : ''}font-size:11pt">${textBodyHtml(nsFirst(tc, 'txBody'), '#111')}</td>`;
    }
    html += '</tr>';
  }
  return html + '</tbody></table>';
}

async function renderShape(zip, slideDir, rels, sp, out) {
  const local = sp.localName;

  if (local === 'grpSp') {
    for (const child of Array.from(sp.children)) {
      if (['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp'].includes(child.localName)) await renderShape(zip, slideDir, rels, child, out);
    }
    return;
  }

  const xf = xfrmOf(sp);
  if (!xf) {
    // still emit text without geometry so nothing is silently dropped
    const tx = nsFirst(sp, 'txBody');
    if (tx) out.push(`<div class="sh" style="left:6%;top:6%;width:88%;height:auto">${textBodyHtml(tx, '#000')}</div>`);
    return;
  }

  const style = `left:${xf.x}px;top:${xf.y}px;width:${xf.w}px;height:${xf.h}px;` +
    (xf.rot ? `transform:rotate(${xf.rot}deg);` : '');

  if (local === 'pic') {
    const embed = relId(nsFirst(sp, 'blip'));
    const rel = rels[embed];
    const src = rel ? await mediaDataUrl(zip, resolve(slideDir, rel.target)) : null;
    out.push(src
      ? `<div class="sh" style="${style}"><img src="${src}" style="width:100%;height:100%;object-fit:fill"></div>`
      : `<div class="sh" style="${style};background:#f0f0f0;border:1px dashed #bbb"></div>`);
    return;
  }

  if (local === 'graphicFrame') {
    const t = await tableHtml(sp);
    out.push(`<div class="sh" style="${style}">${t}</div>`);
    return;
  }

  const spPr = nsFirst(sp, 'spPr');
  /*
   * The shape's own fill is a direct child of spPr. Looking anywhere inside
   * it found the OUTLINE's <a:noFill/> - "no line" - and took it to mean no
   * fill, so every filled shape without an outline vanished from the slide.
   * A shape that names no fill at all takes its theme's (p:style fillRef).
   */
  const ownFill = childrenNamed(spPr, 'solidFill')[0] || null;
  const noFill = childrenNamed(spPr, 'noFill').length > 0;
  const styled = nsFirst(nsFirst(sp, 'style'), 'fillRef');
  const fill = colorOf(ownFill) ||
    (!noFill && !childrenNamed(spPr, 'gradFill').length && !childrenNamed(spPr, 'pattFill').length &&
      styled && Number(styled.getAttribute('idx')) > 0 ? colorOf(styled) : null) ||
    colorOf(childrenNamed(childrenNamed(spPr, 'gradFill')[0] || null, 'gsLst')[0] || null);
  const ln = childrenNamed(spPr, 'ln')[0] || null;
  const lnRef = nsFirst(nsFirst(sp, 'style'), 'lnRef');
  const lnColor = childrenNamed(ln, 'noFill').length ? null
    : colorOf(childrenNamed(ln, 'solidFill')[0] || null) ||
      (lnRef && Number(lnRef.getAttribute('idx')) > 0 ? colorOf(lnRef) : null) ||
      (ln?.getAttribute('w') ? '#000000' : null);
  const lnW = !lnColor ? 0 : ln?.getAttribute('w') ? Math.max(1, px(ln.getAttribute('w'))) : 1;
  const box = [
    fill && !noFill ? `background:${fill};` : '',
    lnW ? `border:${lnW}px solid ${lnColor || '#000'};` : '',
    geomCss(sp)
  ].join('');
  out.push(`<div class="sh" style="${style}${box}">${textBodyHtml(nsFirst(sp, 'txBody'), fill ? '#ffffff' : '#000000')}</div>`);
}

/**
 * @returns {Promise<{widthPx:number,heightPx:number,slides:string[]}>}
 */
export async function pptxToSlides(arrayBuffer, { finalLook: last = true } = {}) {
  const JSZip = window.JSZip;
  const zip = await JSZip.loadAsync(arrayBuffer);
  // a blank video poster or an empty first GIF frame would be a black box or nothing
  try { await fixSlideMedia(zip); } catch (e) { console.warn('[pptx] slide media left as it was:', e?.message || e); }
  // and an animated slide as it looks after the last click (a deck already done is left alone: its animations are gone)
  if (last) { try { await finalLook(zip); } catch (e) { console.warn('[pptx] animations left as they were:', e?.message || e); } }

  const presFile = zip.file('ppt/presentation.xml');
  if (!presFile) throw new Error(t('Not a PowerPoint file (ppt/presentation.xml missing)'));
  const pres = new DOMParser().parseFromString(await presFile.async('string'), 'application/xml');
  const sz = nsFirst(pres, 'sldSz');
  const widthPx = px(sz?.getAttribute('cx') || 12192000);
  const heightPx = px(sz?.getAttribute('cy') || 6858000);

  const presRels = await relsFor(zip, 'ppt/presentation.xml');
  const ids = nsAll(nsFirst(pres, 'sldIdLst'), 'sldId');
  const paths = ids
    .map((n) => presRels[relId(n)])
    .filter(Boolean)
    .map((r) => resolve('ppt', r.target));

  const slides = [];
  for (const path of paths) {
    const f = zip.file(path);
    if (!f) continue;
    const dir = path.replace(/\/[^/]+$/, '');
    const rels = await relsFor(zip, path);
    const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
    const tree = nsFirst(doc, 'spTree');
    const out = [];

    const bgFill = colorOf(nsFirst(nsFirst(doc, 'bg'), 'solidFill')) || '#ffffff';

    for (const child of Array.from(tree?.children || [])) {
      if (['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp'].includes(child.localName)) {
        await renderShape(zip, dir, rels, child, out);
      }
    }
    slides.push(`<section class="slide" style="background:${bgFill}">${out.join('')}</section>`);
  }
  if (!slides.length) throw new Error(t('No slides found in this presentation'));
  return { widthPx, heightPx, slides };
}

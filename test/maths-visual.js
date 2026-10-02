'use strict';
const path = require('node:path'), fs = require('node:fs/promises');
async function run(win, app) {
  const js = (c) => win.webContents.executeJavaScript(`(async()=>{${c}})()`, true);
  const shot = async (n) => fs.writeFile(path.join(__dirname, 'out', n + '.png'), (await win.webContents.capturePage()).toPNG());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  win.setSize(1366, 820); await sleep(900);
  const r = await js(`
    const a = window.app; a.newBoard(true); a.surface.cam.x = 0; a.surface.cam.y = 0; a.surface.cam.z = 1;
    const c = a.surface.cam.viewport(a.surface.width, a.surface.height);
    const m1 = await a.commitMath({ at: { x: c.x + 380, y: c.y + 200 } }, 'x = \\\\frac{-b \\\\pm \\\\sqrt{b^2-4ac}}{2a}');
    const m2 = await a.commitMath({ at: { x: c.x + 380, y: c.y + 380 } }, 'T(n) = 2T\\\\left(\\\\frac{n}{2}\\\\right) + \\\\Theta(n) \\\\Rightarrow O(n \\\\log n)');
    a.store.update(m2.id, { color: '#0078d4' }, 'c');
    const m3 = await a.commitMath({ at: { x: c.x + 900, y: c.y + 260 } }, '\\\\sum_{i=1}^{n} i = \\\\frac{n(n+1)}{2}');
    a.store.update(m3.id, { color: '#e81123' }, 'c');
    a.setSelection([]); a.surface.invalidate();
    await new Promise(r => setTimeout(r, 300));
    return { m1: [Math.round(m1.w), Math.round(m1.h)], m2: [Math.round(m2.w), Math.round(m2.h)] };
  `);
  console.log('MATHS', JSON.stringify(r));
  await sleep(500); await shot('maths-board');
  await js(`const a = window.app; const o = a.store.objects.find(o => o.type === 'math'); a.beginMathEdit(o);`);
  await sleep(700); await shot('maths-editor');
  await js(`const a = window.app; a.mathEditor.value = '\\\\frac{a}{'; `);
  await sleep(500); await shot('maths-error');
  await js(`const a = window.app; a.mathEditor.cancel(); a.settings.theme = 'dark'; a.applyTheme(); a.surface.invalidate();`);
  await sleep(900); await shot('maths-dark');
  await js(`const a = window.app; a.beginMathEdit(null); a.mathEditor.value = '\\\\int_0^1 x^2\\\\,dx = \\\\tfrac13';`);
  await sleep(700); await shot('maths-new-dark');
  const T = {
    a: 'Merge sort runs in $O(n \\log n)$ time, and $\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$.\nA ticket costs $5 and $10 with tax.',
    n: 'Pythagoras: $a^2 + b^2 = c^2$',
    s: 'Area $= \\pi r^2$',
    r1: 'Red: $e^{i\\pi} + 1 = 0$ and ', r2: 'bold too'
  };
  await js(`const a = window.app; a.mathEditor.cancel(); a.settings.theme = 'light'; a.applyTheme(); a.newBoard(true);
    a.surface.cam.x = 0; a.surface.cam.y = 0; a.surface.cam.z = 1;
    const c = a.surface.cam.viewport(a.surface.width, a.surface.height);
    a.store.add({ id: 'it1', type: 'text', x: c.x + 60, y: c.y + 80, w: 620, h: 120, rotation: 0, fontSize: 28, color: '#201f1e', text: ${JSON.stringify(T.a)} }, 'a');
    a.store.add({ id: 'in1', type: 'note', x: c.x + 760, y: c.y + 60, w: 260, h: 260, rotation: 0, color: '#ffd94a', align: 'center', font: 'ui', text: ${JSON.stringify(T.n)} }, 'a');
    a.store.add({ id: 'is1', type: 'shape', kind: 'rect', x: c.x + 60, y: c.y + 300, w: 360, h: 140, rotation: 0, stroke: '#0078d4', fill: '#bfdbfe', lineWidth: 3, text: ${JSON.stringify(T.s)}, textColor: '#201f1e' }, 'a');
    a.store.add({ id: 'it2', type: 'text', x: c.x + 480, y: c.y + 380, w: 560, h: 60, rotation: 0, fontSize: 30, color: '#e81123',
      text: ${JSON.stringify(T.r1 + T.r2)}, runs: [{ t: ${JSON.stringify(T.r1)} }, { t: ${JSON.stringify(T.r2)}, b: 1 }] }, 'a');
    a.store.add({ id: 'tb1', type: 'table', x: c.x + 60, y: c.y + 480, w: 420, h: 120, rows: 2, cols: 2, rotation: 0,
      cells: { '0,0': 'n', '0,1': 'cost', '1,0': '$2^k$', '1,1': '$\\\\Theta(n^2)$' } }, 'a');
    a.setSelection([]);`);
  await sleep(1500); await shot('maths-inline');
  await js(`const a = window.app; a.settings.theme = 'dark'; a.applyTheme();`);
  await sleep(1200); await shot('maths-inline-dark');
  app.exit(0);
}
module.exports = { run };

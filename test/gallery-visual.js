'use strict';
const path = require('node:path'), fs = require('node:fs/promises');
async function run(win, app) {
  const js = (c) => win.webContents.executeJavaScript(`(async()=>{${c}})()`, true);
  const shot = async (n) => fs.writeFile(path.join(__dirname, 'out', n + '.png'), (await win.webContents.capturePage()).toPNG());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  win.setSize(1366, 820); await sleep(800);
  await js(`
    const a = window.app;
    for (const b of await board.boards.list()) await board.boards.delete?.(b.id);
    const stroke = (id, pts, color, w) => {
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { id, type: 'stroke', tool: 'pen', color, width: w, effect: 'none', hue: 0, opacity: 1, rotation: 0,
        points: pts.map(([px, py]) => ({ x: px, y: py, p: 0.5 })), bbox: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } };
    };
    const wave = (x0, y0, amp, n, step) => Array.from({ length: n }, (_, i) => [x0 + i * step, y0 + Math.sin(i / 3) * amp]);
    const boards = [
      ['Lecture 1 – Sorting', [stroke('s1', wave(40, 120, 40, 60, 12), '#201f1e', 4), stroke('s2', wave(40, 260, 20, 60, 12), '#e81123', 6),
        { id: 'n1', type: 'note', x: 820, y: 60, w: 200, h: 200, color: '#ffd94a', text: 'Quick sort\\nO(n log n)', rotation: 0, align: 'center', font: 'ui' }]],
      ['Lecture 2 – Graphs', [stroke('g1', wave(60, 200, 80, 70, 10), '#0078d4', 5),
        { id: 'r1', type: 'shape', shape: 'ellipse', x: 200, y: 340, w: 180, h: 120, stroke: '#107c10', fill: null, width: 4, rotation: 0 },
        { id: 't1', type: 'text', x: 460, y: 360, w: 300, h: 50, text: 'BFS vs DFS', fontSize: 40, color: '#201f1e', rotation: 0 }]],
      ['Quiz review', [{ id: 'n2', type: 'note', x: 60, y: 60, w: 220, h: 220, color: '#9fe7a4', text: 'Q1 ✔', rotation: 0, align: 'center', font: 'ui' },
        { id: 'n3', type: 'note', x: 320, y: 60, w: 220, h: 220, color: '#ffb3c7', text: 'Q2 ?', rotation: 0, align: 'center', font: 'ui' }]],
      ['Lab 3', [stroke('l1', wave(40, 160, 60, 80, 9), '#8764b8', 7)]],
      ['Untitled board', []]
    ];
    const ids = [];
    for (const [name, objects] of boards) {
      const order = objects.map((o) => o.id);
      await a.loadBoard({ id: 'vis-' + ids.length, name, objects, order, pages: [], camera: { x: 0, y: 0, z: 1 } });
      await a.persist({ force: true });
      ids.push(a.store.doc.id);
    }
    const F = await import('./js/core/folders.js');
    const s = a.settings;
    const cse = F.createFolder(s, 'CSE221 Algorithms');
    const phy = F.createFolder(s, 'Physics');
    const notes = F.createFolder(s, 'Meeting notes');
    const spring = F.createFolder(s, 'Spring 2026', cse);
    F.setFolderColour(s, cse, '#2f8fd8'); F.setFolderColour(s, phy, '#3fae5a'); F.setFolderColour(s, notes, '#f28c28');
    F.moveBoard(s, ids[3], phy);
    a.saveSettings();
    a.boardFolder = null;
    await a.panels.boards();
  `);
  await sleep(900);
  await sleep(4000); await js(`document.getElementById('toasts').innerHTML=''`);
  await shot('gallery-light');
  await js(`window.app.settings.theme = 'dark'; window.app.applyTheme(); await window.app.panels.boards();`);
  await sleep(700);
  await shot('gallery-dark');
  await js(`const r = document.querySelector('[data-colour-folder]'); r.closest('.tile-wrap').querySelector('.ft-actions').style.opacity = 1; r.click();`);
  await sleep(500);
  await shot('gallery-colour');
  await js(`window.app.dismissOverlay?.(); window.app.settings.theme = 'light'; window.app.applyTheme(); document.getElementById('toasts').innerHTML='';`);
  win.setSize(420, 860); await sleep(900);
  await js(`await window.app.panels.boards();`); await sleep(600);
  await shot('gallery-phone');
  app.exit(0);
}
module.exports = { run };

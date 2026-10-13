#!/bin/sh
# Proves a board survives the machine going down.
#
# Launch 1 makes a board and is SIGKILLed - no clean quit, no chance to flush,
# which is what a PC restart does to a running app. Launch 2 must reopen it.
set -e
cd "$(dirname "$0")/.."
PROFILE="${PROFILE:-/tmp/gazboard-restart-test}"
rm -rf "$PROFILE"
rm -rf "${PROFILE}-custom"

cat > /tmp/gb-restart-1.js <<'JS'
'use strict';
module.exports.run = async (win, app) => {
  const js = (c) => win.webContents.executeJavaScript(`(async()=>{${c}})()`, true);
  await new Promise(r => setTimeout(r, 1200));
  const customDir = app.getPath('userData') + '-custom';
  const out = await js(`
    const a = window.app;
    const changed = await window.board.storage.apply({ path: ${JSON.stringify(customDir)}, mode: 'empty' });
    if (!changed.ok) throw new Error(changed.error);
    a.newBoard(true);
    a.store.rename('Work in progress');
    a.store.add({ id:'w1', type:'text', x:80, y:80, w:420, h:60, text:'three hours of notes',
      fontSize:32, color:'#201f1e', align:'left', valign:'top', rotation:0, font:'hand', background:'none' });
    await a.persist();
    return a.store.doc.id;
  `);
  console.log('CREATED ' + out);
  process.kill(process.pid, 'SIGKILL');     // the power goes out
};
JS

cat > /tmp/gb-restart-2.js <<'JS'
'use strict';
module.exports.run = async (win, app) => {
  const js = (c) => win.webContents.executeJavaScript(`(async()=>{${c}})()`, true);
  await new Promise(r => setTimeout(r, 1600));
  const out = await js(`
    const a = window.app;
    const list = await window.board.boards.list();
    const storage = await window.board.storage.get();
    return { name: a.store.doc.name, objects: a.store.objects.length, boards: list.length, storage: storage.current };
  `);
  console.log('REOPENED ' + JSON.stringify(out));
  app.exit(0);
};
JS

echo "launch 1 - make a board, then kill the process"
GAZBOARD_USER_DATA="$PROFILE" GAZBOARD_TEST=/tmp/gb-restart-1.js \
  xvfb-run -a pnpm exec electron . --smoke --no-sandbox 2>/dev/null | grep '^CREATED' || true

echo "launch 2 - it must come back"
RESULT=$(GAZBOARD_USER_DATA="$PROFILE" GAZBOARD_TEST=/tmp/gb-restart-2.js \
  xvfb-run -a pnpm exec electron . --smoke --no-sandbox 2>/dev/null | grep '^REOPENED' || true)
echo "$RESULT"

echo "$RESULT" | grep -q '"name":"Work in progress"' || { echo "FAIL: the board did not come back"; exit 1; }
echo "$RESULT" | grep -q '"objects":1' || { echo "FAIL: the board came back empty"; exit 1; }
echo "$RESULT" | grep -q '"boards":1' || { echo "FAIL: junk boards were left behind"; exit 1; }
echo "$RESULT" | grep -Fq "\"storage\":\"${PROFILE}-custom\"" || { echo "FAIL: custom storage setting did not survive restart"; exit 1; }
echo "PASS - the board survived a hard restart, with no litter"

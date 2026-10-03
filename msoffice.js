'use strict';
/*
 * Microsoft Office as the converter (Windows, beta, off unless switched on).
 *
 * LibreOffice reads Word, Excel and PowerPoint files well but not exactly:
 * with a font it does not have, lines wrap differently and a page spills onto
 * the next, and a wide spreadsheet is cut into a left half and a right half.
 * Microsoft Office drawing its own file has none of that - it is what the file
 * was made with - so when Office is on this computer and the setting is on,
 * the file is opened in it out of sight and saved as a PDF, exactly as
 * File > Save as PDF would. Slower to start (Word or Excel has to load), exact
 * once it has.
 *
 * It is driven through PowerShell, which every Windows has, so nothing is
 * installed and nothing is bundled. The script is careful with the person's
 * own Office: the file is opened read-only, nothing is saved over it, and an
 * Office that was already open with their work in it is left open.
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');

const WORD = ['.doc', '.docx', '.docm', '.dot', '.dotx', '.rtf', '.odt', '.txt'];
const EXCEL = ['.xls', '.xlsx', '.xlsm', '.xlsb', '.ods', '.csv'];
const POWERPOINT = ['.ppt', '.pptx', '.pptm', '.pps', '.ppsx', '.odp'];

/** Which Office program opens this file, or null. */
function officeApp(ext) {
  const e = String(ext || '').toLowerCase();
  if (WORD.includes(e)) return 'word';
  if (EXCEL.includes(e)) return 'excel';
  if (POWERPOINT.includes(e)) return 'powerpoint';
  return null;
}

/*
 * Exit codes the caller reads: 0 done, 3 that Office program is not on this
 * computer, 4 it is there but could not open or save the file.
 */
const SCRIPT = String.raw`
param([string]$In, [string]$Out, [string]$Kind, [string]$FitWide = '0')
$ErrorActionPreference = 'Stop'
function Free($o) { if ($o -ne $null) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o) } catch {} } }
$app = $null; $file = $null
try {
  try {
    if ($Kind -eq 'word') { $app = New-Object -ComObject Word.Application }
    elseif ($Kind -eq 'excel') { $app = New-Object -ComObject Excel.Application }
    else { $app = New-Object -ComObject PowerPoint.Application }
  } catch { [Console]::Error.WriteLine("not installed: $($_.Exception.Message)"); exit 3 }
  try {
    if ($Kind -eq 'word') {
      $app.Visible = $false
      $app.DisplayAlerts = 0
      $file = $app.Documents.Open($In, $false, $true, $false)
      $file.ExportAsFixedFormat($Out, 17)
      $file.Close(0)
    } elseif ($Kind -eq 'excel') {
      $app.Visible = $false
      $app.DisplayAlerts = $false
      $app.ScreenUpdating = $false
      $file = $app.Workbooks.Open($In, 0, $true)
      if ($FitWide -eq '1') {
        try { $app.PrintCommunication = $false } catch {}
        foreach ($ws in $file.Worksheets) {
          try { $ws.PageSetup.Zoom = $false; $ws.PageSetup.FitToPagesWide = 1; $ws.PageSetup.FitToPagesTall = $false } catch {}
        }
        try { $app.PrintCommunication = $true } catch {}
      }
      $file.ExportAsFixedFormat(0, $Out)
      $file.Close($false)
    } else {
      # ReadOnly, not Untitled, no window
      $file = $app.Presentations.Open($In, -1, 0, 0)
      $file.SaveAs($Out, 32)
      $file.Close()
    }
    $file = $null
  } catch { [Console]::Error.WriteLine("could not convert: $($_.Exception.Message)"); exit 4 }
} finally {
  if ($file -ne $null) { try { if ($Kind -eq 'excel') { $file.Close($false) } elseif ($Kind -eq 'word') { $file.Close(0) } else { $file.Close() } } catch {} }
  Free $file
  if ($app -ne $null) {
    # only close an Office this script opened: one with someone's work still in it stays
    try {
      $left = if ($Kind -eq 'word') { $app.Documents.Count } elseif ($Kind -eq 'excel') { $app.Workbooks.Count } else { $app.Presentations.Count }
      if ($left -eq 0) { $app.Quit() }
    } catch {}
    Free $app
  }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
exit 0
`;

/**
 * Convert with Microsoft Office. Resolves to the PDF bytes, or rejects with
 * an Error whose `code` is 'absent' (no Office for this file), 'failed',
 * 'timeout' or 'unsupported'.
 */
async function convertWithMsOffice(filePath, { fitWide = true, timeoutMs = 180000, platform = process.platform, run = spawn } = {}) {
  const kind = officeApp(path.extname(filePath));
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (platform !== 'win32') throw fail('unsupported', 'Microsoft Office conversion is only on Windows');
  if (!kind) throw fail('unsupported', 'Not an Office file');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gazboard-office-'));
  const script = path.join(dir, 'convert.ps1');
  const out = path.join(dir, 'out.pdf');
  try {
    // the BOM tells Windows PowerShell 5 the script is UTF-8
    await fsp.writeFile(script, '﻿' + SCRIPT, 'utf8');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-In', filePath, '-Out', out, '-Kind', kind, '-FitWide', fitWide ? '1' : '0'];
    const code = await new Promise((resolve, reject) => {
      const child = run('powershell.exe', args, { windowsHide: true });
      let err = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} reject(fail('timeout', 'Microsoft Office took too long')); }, timeoutMs);
      child.stderr?.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => { clearTimeout(timer); reject(fail('absent', e.message)); });
      child.on('close', (c) => { clearTimeout(timer); resolve({ c, err }); });
    });
    if (code.c === 3) throw fail('absent', code.err.trim() || 'Microsoft Office is not installed');
    if (code.c !== 0) throw fail('failed', code.err.trim() || ('exit ' + code.c));
    if (!fs.existsSync(out)) throw fail('failed', 'Office made no PDF');
    return await fsp.readFile(out);
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { convertWithMsOffice, officeApp, OFFICE_SCRIPT: SCRIPT };

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('responsive controls wrap and the history drawer never shrinks or translates the main panel', () => {
  const styles = read('renderer/styles.css');

  assert.match(styles, /#action-row\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(styles, /\.s-seg\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(styles, /\.ai-text, \.user-bubble, \.ts-text\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /#panel-wrap\.sidebar-open\s*\{[^}]*transform:\s*none/);
  assert.doesNotMatch(styles, /#panel-wrap\.sidebar-open\s*\{[^}]*width:\s*min\(420px/);
});

test('speech remains in transcript history and never writes interim or final text into the manual composer', () => {
  const renderer = read('renderer/renderer.js');
  const transcriptHandler = section(renderer, "  cue.on('transcript', ({ channel, text }) => {", '  let statusTimer = null;');

  assert.doesNotMatch(renderer, /function autoFillInputFromSTT\(/);
  assert.doesNotMatch(renderer, /function showInterimInInput\(/);
  assert.doesNotMatch(transcriptHandler, /input\.value|composer\.classList|answerThis/);
  assert.match(transcriptHandler, /appendTranscriptHistoryTurn\(channel, text, false\)/);
});

test('the visible toolbar exposes an accessible Quit action and live screenshot privacy control', () => {
  const html = read('renderer/index.html');
  const renderer = read('renderer/renderer.js');

  assert.match(html, /<button class="tb-quit" id="quit-btn"[^>]*aria-label="Quit cue"[^>]*>Quit<\/button>/);
  assert.match(html, /<button class="tb-privacy" id="screenshot-privacy-btn"[^>]*aria-pressed="true"[^>]*>Screen-share protection: on \(best effort\)<\/button>/);
  assert.match(renderer, /cue\.contentProtectionGet\(\)/);
  assert.match(renderer, /cue\.contentProtectionSet\(/);
  assert.match(renderer, /cue\.on\('content-protection:changed'/);
});

test('content protection defaults on and can only be changed through a sender-validated IPC bridge', () => {
  const main = read('main.js');
  const preload = read('preload.js');

  assert.match(main, /let contentProtectionEnabled\s*=\s*!process\.env\.CUE_NO_PROTECT/);
  assert.match(main, /function isCueRenderer\(event\)/);
  assert.match(main, /ipcMain\.handle\('content-protection:get', \(event\) => \{\s*assertCueRenderer\(event\)/);
  assert.match(main, /ipcMain\.handle\('content-protection:set', \(event, enabled\) => \{\s*assertCueRenderer\(event\)/);
  assert.match(main, /win\.setContentProtection\(contentProtectionEnabled\)/);
  assert.match(main, /win\.isContentProtected\(\)/);
  assert.match(main, /send\('content-protection:changed', contentProtectionSnapshot\(\)\)/);
  assert.match(preload, /contentProtectionGet:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('content-protection:get'\)/);
  assert.match(preload, /contentProtectionSet:\s*\(enabled\)\s*=>\s*ipcRenderer\.invoke\('content-protection:set', !!enabled\)/);
  assert.match(preload, /allowed\s*=\s*\[[\s\S]*?'content-protection:changed'/);
});

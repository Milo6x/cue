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

test('responsive controls wrap and compact history stays below the main panel without covering it', () => {
  const html = read('renderer/index.html');
  const renderer = read('renderer/renderer.js');
  const styles = read('renderer/styles.css');
  const historyBase = section(styles, '.transcript-sidebar {', '.transcript-sidebar.hidden');
  const wideLayout = section(styles, '@media (min-width: 980px)', '@media (max-width: 520px)');
  const showHistory = section(renderer, '  function showSidebar() {', '  function hideSidebar() {');

  assert.match(styles, /#action-row\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(styles, /\.s-seg\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(styles, /\.ai-text, \.user-bubble, \.ts-text\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /html, body\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /#app\s*\{[^}]*min-height:\s*100%/);
  assert.match(styles, /#panel-wrap\.sidebar-open\s*\{[^}]*transform:\s*none/);
  assert.doesNotMatch(styles, /#panel-wrap\.sidebar-open\s*\{[^}]*width:\s*min\(420px/);
  assert.match(historyBase, /position:\s*relative/);
  assert.match(historyBase, /width:\s*min\(624px, calc\(100vw - 20px\)\)/);
  assert.match(historyBase, /max-height:\s*min\(300px, calc\(100vh - 120px\)\)/);
  assert.doesNotMatch(historyBase, /position:\s*(?:fixed|absolute)/);
  assert.match(wideLayout, /\.transcript-sidebar\s*\{[^}]*position:\s*fixed/);
  assert.match(wideLayout, /#panel-wrap\.sidebar-open\s*\{[^}]*margin-right:\s*260px/);
  assert.match(html, /<\/div>\s*<\/div>\s*<!-- Transcript history card—below the main panel at compact widths -->\s*<div id="transcript-sidebar"/);
  assert.match(html, /id="close-sidebar-btn"[\s\S]*id="clear-transcript-btn"/);
  assert.match(showHistory, /matchMedia\('\(min-width: 980px\)'\)/);
  assert.match(showHistory, /sidebar\.scrollIntoView\(\{ behavior: 'smooth', block: 'nearest' \}\)/);
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

  assert.match(main, /let contentProtectionEnabled\s*=\s*process\.env\.CUE_NO_PROTECT\s*!==\s*'1'/);
  assert.doesNotMatch(main, /contentProtectionEnabled\s*=\s*!process\.env\.CUE_NO_PROTECT/);
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

test('toolbar buttons retain a visible keyboard focus indicator', () => {
  const styles = read('renderer/styles.css');

  assert.match(styles, /#toolbar button:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  assert.match(styles, /#toolbar button:focus-visible\s*\{[^}]*outline-offset:\s*2px/);
});

test('manual composer has no obsolete speech auto-fill state or custom undo interception', () => {
  const renderer = read('renderer/renderer.js');
  const styles = read('renderer/styles.css');
  const obsoleteRendererState = /inputFromSTT|sttFillTimer|questionFinalizeTimer|softClearTimer|userSpeechStart|lastSTTValue|saveToQuestionHistory|restoreLastQuestion|hardClearSTTFill|cancelSoftClear/;
  const obsoleteComposerClass = /stt-filling|stt-ready|stt-accumulating|stt-dimmed/;

  assert.doesNotMatch(renderer, obsoleteRendererState);
  assert.doesNotMatch(renderer, obsoleteComposerClass);
  assert.doesNotMatch(styles, obsoleteComposerClass);
  assert.doesNotMatch(renderer, /\(e\.metaKey \|\| e\.ctrlKey\)[\s\S]{0,100}e\.key === 'z'/);
});

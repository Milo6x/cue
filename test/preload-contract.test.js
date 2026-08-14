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

test('preload exposes deterministic capture and diagnostics bridge methods', () => {
  const preload = read('preload.js');

  assert.match(preload, /captureSet:\s*\(active\)\s*=>\s*ipcRenderer\.invoke\('capture:set', !!active\)/);
  assert.match(preload, /captureToggle:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('capture:toggle'\)/);
  assert.match(preload, /diagnosticsGet:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('diagnostics:get'\)/);
  assert.match(preload, /diagnosticsReport:\s*\(event\)\s*=>\s*ipcRenderer\.send\('diagnostics:report', event\)/);
  assert.match(preload, /captureRemoteStopAck:\s*\(id, result\)\s*=>\s*ipcRenderer\.send\('capture:remote-stop-result', \{ id, \.\.\.result \}\)/);
  assert.match(preload, /allowed\s*=\s*\[[\s\S]*?'diagnostics:changed'/);
  assert.match(preload, /allowed\s*=\s*\[[\s\S]*?'capture:remote-stop'/);
});

test('renderer routes capture lifecycle through the coordinator, not toggle side effects', () => {
  const renderer = read('renderer/renderer.js');
  const buttonHandler = section(renderer, "$('#stop-btn').addEventListener('click'", '// Transcript toggle removed');
  const captureStateHandler = section(renderer, "cue.on('capture:state'", '// ---- real-time transcript display');
  const micEndedHandler = section(renderer, 'micTrackEnded = () => {', "if (micTrack.addEventListener)");
  const systemEndedHandler = section(renderer, 'sysTrackEnded = () => {', "if (sysTrack.addEventListener)");

  assert.match(renderer, /new CueCapture\.CaptureCoordinator\(/);
  assert.match(renderer, /setPipelineActive:\s*\(active\)\s*=>\s*cue\.captureSet\(active\)/);
  assert.match(buttonHandler, /captureCoordinator\.snapshot\(\)\.session\.state/);
  assert.match(buttonHandler, /captureCoordinator\.(start|stop)\(\)/);
  assert.doesNotMatch(buttonHandler, /cue\.captureToggle|startSystemAudio\(|startMic\(|stopMic\(|stopSystemAudio\(/);
  assert.doesNotMatch(captureStateHandler, /startMic\(|startSystemAudio\(|stopMic\(|stopSystemAudio\(/);
  assert.match(micEndedHandler, /captureFailure\('microphone', error\)/);
  assert.doesNotMatch(micEndedHandler, /stopMic\(/);
  assert.match(micEndedHandler, /Listening continues on any remaining source\. Stop, then start listening to reconnect the microphone\./);
  assert.match(systemEndedHandler, /captureFailure\('system', error\)/);
  assert.doesNotMatch(systemEndedHandler, /stopSystemAudio\(/);
  assert.match(systemEndedHandler, /Listening continues on any remaining source\. Stop, then start listening to reconnect meeting audio\./);
  assert.match(renderer, /cue\.on\('capture:remote-stop', async \(\{ id \}\) => \{[\s\S]{0,500}await captureCoordinator\.stop\(\)[\s\S]{0,500}await cue\.captureSet\(false\)[\s\S]{0,500}cue\.captureRemoteStopAck\(id, \{ stopped: true \}\)/);
  assert.match(read('renderer/index.html'), /<script src="capture-status-tracker\.js"><\/script>\s*<script src="renderer\.js"><\/script>/);
});

test('main serializes deterministic capture state requests', () => {
  const main = read('main.js');

  assert.match(main, /function requestCaptureState\(targetState\)/);
  assert.match(main, /return captureController\.request\(targetState\)/);
  assert.match(main, /ipcMain\.handle\('capture:set', \(_event, active\) => requestCaptureState\(active\)\)/);
  assert.match(main, /ipcMain\.handle\('capture:toggle', \(\) => captureController\.toggle\(\)\)/);
});

test('renderer registers worklet resources before connecting them', () => {
  const renderer = read('renderer/renderer.js');

  assert.match(renderer, /micWorklet = \{ source, node \};\s*node\.port\.onmessage[\s\S]{0,120}source\.connect\(node\)/);
  assert.match(renderer, /sysWorklet = \{ source, node \};\s*node\.port\.onmessage[\s\S]{0,120}source\.connect\(node\)/);
});

test('renderer releases a failed worklet before using the legacy fallback', () => {
  const renderer = read('renderer/renderer.js');

  assert.match(renderer, /catch \(workletError\) \{\s*if \(workletError && workletError\.category\) throw workletError;\s*disconnectWorklet\(micWorklet\);\s*micWorklet = null;/);
  assert.match(renderer, /catch \(workletError\) \{\s*if \(workletError && workletError\.category\) throw workletError;\s*disconnectWorklet\(sysWorklet\);\s*sysWorklet = null;/);
});

test('renderer exposes a compact, live diagnostics pane that copies only the supplied safe summary', () => {
  const html = read('renderer/index.html');
  const renderer = read('renderer/renderer.js');
  const styles = read('renderer/styles.css');

  assert.match(html, /<button class="s-tab" data-tab="health">Health<\/button>/);
  assert.match(html, /data-pane="health"/);
  assert.match(html, /id="diagnostics-mic-permission"/);
  assert.match(html, /id="diagnostics-mic-capture"/);
  assert.match(html, /id="diagnostics-screen-permission"/);
  assert.match(html, /id="diagnostics-system-capture"/);
  assert.match(html, /id="diagnostics-stt-provider"/);
  assert.match(html, /id="diagnostics-ai-provider"/);
  assert.match(html, /id="diagnostics-last-failure"/);
  assert.match(html, /id="diagnostics-copy"/);
  assert.match(html, /keys, transcripts, audio, and screenshots are never included/i);

  assert.match(renderer, /cue\.diagnosticsGet\(\)/);
  assert.equal((renderer.match(/cue\.on\('diagnostics:changed'/g) || []).length, 1, 'subscribe only once');
  assert.match(renderer, /const copySummary = diagnosticsSummary;/);
  assert.match(renderer, /navigator\.clipboard\.writeText\(copySummary\)/);
  assert.doesNotMatch(renderer, /navigator\.clipboard\.writeText\([^)]*innerHTML/);
  assert.match(renderer, /DIAGNOSTICS_STATE_CLASSES/);
  assert.match(renderer, /aria-live/);
  assert.match(styles, /\.diagnostics-row/);
});

test('renderer ignores an old clipboard result after the diagnostics settings session changes', () => {
  const renderer = read('renderer/renderer.js');
  const openSettings = section(renderer, '  function openSettings() {', '  function closeSettings() {');
  const closeSettings = section(renderer, '  function closeSettings() {', "  $('#more-btn').addEventListener");
  const copyHandler = section(renderer, "  $('#diagnostics-copy').addEventListener", "  cue.on('diagnostics:changed'");

  assert.match(renderer, /let diagnosticsSessionVersion = 0;/);
  assert.match(openSettings, /diagnosticsSessionVersion \+= 1;/);
  assert.match(closeSettings, /diagnosticsSessionVersion \+= 1;/);
  assert.match(copyHandler, /const copySessionVersion = diagnosticsSessionVersion;/);
  assert.match(copyHandler, /const copySummary = diagnosticsSummary;/);
  assert.match(copyHandler, /navigator\.clipboard\.writeText\(copySummary\)/);
  assert.match(copyHandler, /if \(!isCurrentDiagnosticsSession\(copySessionVersion, copySummary\)\) return;/);
  assert.match(copyHandler, /setTimeout\(\(\) => \{\s*if \(!isCurrentDiagnosticsSession\(copySessionVersion, copySummary\)\) return;/);
});

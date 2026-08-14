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

test('capture PCM crosses the bridge only as a metadata envelope validated by main', () => {
  const preload = read('preload.js');
  const main = read('main.js');

  assert.match(preload, /micPcm:\s*\(packet\)\s*=>\s*ipcRenderer\.send\('mic:pcm', packet\)/);
  assert.match(preload, /systemPcm:\s*\(packet\)\s*=>\s*ipcRenderer\.send\('system:pcm', packet\)/);
  assert.match(main, /const \{ normalizeCapturePacket \} = require\('\.\/src\/capture-pcm'\)/);
  assert.match(main, /function routeCapturePacket\(event, channel, packet\)/);
  assert.match(main, /if \(!isCueRenderer\(event\) \|\| !state\.capturing\) return;/);
  assert.match(main, /const normalized = normalizeCapturePacket\(packet\);/);
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

  assert.match(renderer, /micWorklet = \{ source, node, sink \};\s*node\.port\.onmessage[\s\S]{0,300}source\.connect\(node\)/);
  assert.match(renderer, /sysWorklet = \{ source, node, sink \};\s*node\.port\.onmessage[\s\S]{0,300}source\.connect\(node\)/);
});

test('renderer reports actual audio context metadata and mixes every worklet channel to mono', () => {
  const renderer = read('renderer/renderer.js');
  const worklet = read('renderer/audio-worklet-processor.js');

  assert.match(renderer, /await audioCtx\.resume\(\)/);
  assert.match(renderer, /await sysCtx\.resume\(\)/);
  assert.match(renderer, /sampleRate: audioCtx\.sampleRate/);
  assert.match(renderer, /sampleRate: sysCtx\.sampleRate/);
  assert.match(worklet, /for \(let channel = 0; channel < input\.length; channel \+= 1\)/);
  assert.match(worklet, /channelData\[frame\]/);
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

  assert.match(html, /<button[^>]*data-tab="health"[^>]*>Health<\/button>/);
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
  assert.match(renderer, /writeDiagnosticsSummary\(copySummary\)/);
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
  assert.match(copyHandler, /writeDiagnosticsSummary\(copySummary\)/);
  assert.match(copyHandler, /if \(!isCurrentDiagnosticsSession\(copySessionVersion, copySummary\)\) return;/);
  assert.match(copyHandler, /setTimeout\(\(\) => \{\s*if \(!isCurrentDiagnosticsSession\(copySessionVersion, copySummary\)\) return;/);
});

test('renderer refreshes live diagnostics through the safe main-process summary without feedback loops', () => {
  const renderer = read('renderer/renderer.js');
  const refresh = section(renderer, '  async function refreshDiagnostics(expectedFingerprint = null)', '  function settingsFocusableElements() {');
  const changedHandler = section(renderer, "  cue.on('diagnostics:changed'", '  // Tab switching');

  assert.match(renderer, /let diagnosticsRefreshTimer = null;/);
  assert.match(renderer, /function diagnosticFingerprint\(snapshot\)/);
  assert.match(renderer, /function scheduleDiagnosticsRefresh\(snapshot\)/);
  assert.match(refresh, /renderDiagnosticsLoading\(/);
  assert.match(refresh, /const report = await cue\.diagnosticsGet\(\)/);
  assert.match(refresh, /applyDiagnosticsReport\(report\)/);
  assert.match(changedHandler, /scheduleDiagnosticsRefresh\(snapshot\)/);
  assert.doesNotMatch(changedHandler, /renderDiagnostics\(snapshot\)/);
  assert.equal((renderer.match(/cue\.on\('diagnostics:changed'/g) || []).length, 1, 'subscribe only once');
  assert.match(renderer, /expectedFingerprint === lastDiagnosticsFingerprint/);
});

test('settings is an accessible keyboard modal with visible two-row tab navigation', () => {
  const html = read('renderer/index.html');
  const renderer = read('renderer/renderer.js');
  const styles = read('renderer/styles.css');

  assert.match(html, /id="settings" class="glass" role="dialog" aria-modal="true" aria-labelledby="settings-title"/);
  assert.match(html, /id="settings-title"/);
  assert.match(html, /class="s-tabs" role="tablist"/);
  for (const tab of ['keys', 'transcription', 'profile', 'prep', 'style', 'qa', 'health']) {
    assert.match(html, new RegExp(`id="settings-tab-${tab}"[\\s\\S]*?role="tab"[\\s\\S]*?aria-controls="settings-pane-${tab}"`));
    assert.match(html, new RegExp(`id="settings-pane-${tab}"[\\s\\S]*?role="tabpanel"[\\s\\S]*?aria-labelledby="settings-tab-${tab}"`));
  }
  assert.match(renderer, /function activateSettingsTab\(/);
  assert.match(renderer, /ArrowRight/);
  assert.match(renderer, /ArrowLeft/);
  assert.match(renderer, /Home/);
  assert.match(renderer, /End/);
  assert.match(renderer, /function trapSettingsFocus\(/);
  assert.match(renderer, /settingsReturnFocus/);
  assert.match(styles, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(styles, /\.s-tabs[^}]*overflow-x:\s*auto/);
  assert.match(styles, /#settings :is\(button, input, textarea, select\):focus-visible/);
  assert.match(styles, /\.diagnostics-note, \.diagnostics-message \{\s*color: var\(--tx-2\)/);
  assert.match(styles, /\.diagnostics-state \{[\s\S]*?color: var\(--tx-2\)/);
});

test('diagnostics clipboard writes time out and restore the current controls', () => {
  const renderer = read('renderer/renderer.js');
  const copyHandler = section(renderer, "  $('#diagnostics-copy').addEventListener", "  cue.on('diagnostics:changed'");

  assert.match(renderer, /const DIAGNOSTICS_CLIPBOARD_TIMEOUT_MS = \d+;/);
  assert.match(renderer, /function writeDiagnosticsSummary\(summary\)/);
  assert.match(renderer, /Promise\.race\(/);
  assert.match(copyHandler, /await writeDiagnosticsSummary\(copySummary\)/);
  assert.match(copyHandler, /button\.disabled = !diagnosticsSummary;/);
});

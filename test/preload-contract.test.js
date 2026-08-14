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
  assert.match(preload, /allowed\s*=\s*\[[\s\S]*?'diagnostics:changed'/);
});

test('renderer routes capture lifecycle through the coordinator, not toggle side effects', () => {
  const renderer = read('renderer/renderer.js');
  const buttonHandler = section(renderer, "$('#stop-btn').addEventListener('click'", '// Transcript toggle removed');
  const captureStateHandler = section(renderer, "cue.on('capture:state'", '// ---- real-time transcript display');

  assert.match(renderer, /new CueCapture\.CaptureCoordinator\(/);
  assert.match(renderer, /setPipelineActive:\s*\(active\)\s*=>\s*cue\.captureSet\(active\)/);
  assert.match(buttonHandler, /captureCoordinator\.snapshot\(\)\.session\.state/);
  assert.match(buttonHandler, /captureCoordinator\.(start|stop)\(\)/);
  assert.doesNotMatch(buttonHandler, /cue\.captureToggle|startSystemAudio\(|startMic\(|stopMic\(|stopSystemAudio\(/);
  assert.doesNotMatch(captureStateHandler, /startMic\(|startSystemAudio\(|stopMic\(|stopSystemAudio\(/);
});

test('main serializes deterministic capture state requests', () => {
  const main = read('main.js');

  assert.match(main, /function requestCaptureState\(targetState\)/);
  assert.match(main, /ipcMain\.handle\('capture:set', \(_event, active\) => requestCaptureState\(active\)\)/);
  assert.match(main, /ipcMain\.handle\('capture:toggle', \(\) => requestCaptureState\(!desiredCaptureState\)\)/);
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

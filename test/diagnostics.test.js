const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createDiagnosticsGetHandler, createDiagnosticsStore } = require('../src/diagnostics');
const DEFAULT_CAPTURE_TELEMETRY = { sampleRate: null, channelCount: null, packets: 0, frames: 0, signal: 'unknown' };

test('reports a fixed, credential-free runtime snapshot and summary', () => {
  const diagnostics = createDiagnosticsStore({ appVersion: '0.2.2', platform: 'darwin', arch: 'arm64' });

  diagnostics.updatePermissions({ mic: 'granted', screen: 'denied' });
  diagnostics.updateProviders({
    chat: { provider: 'openai', model: 'gpt-4o-mini', ready: true },
    stt: { provider: 'local', state: 'ready' }
  });
  const { snapshot, summary } = diagnostics.read();

  assert.deepEqual(snapshot.app, { version: '0.2.2', platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(snapshot.permissions, { microphone: 'granted', screen: 'denied' });
  assert.deepEqual(snapshot.chat, { provider: 'openai', model: 'gpt-4o-mini', ready: true });
  assert.deepEqual(snapshot.stt, { provider: 'local', state: 'ready' });
  assert.match(summary, /cue 0\.2\.2.*darwin\/arm64/);
  assert.match(summary, /Microphone: off.*System capture: off.*Chat: ready.*Transcription: ready/);
  assert.doesNotMatch(summary, /openai|gpt-4o-mini/i);
});

test('records only bounded capture signal telemetry without retaining renderer audio data', () => {
  const diagnostics = createDiagnosticsStore({ appVersion: '1.0.0', platform: 'darwin', arch: 'arm64' });

  assert.equal(diagnostics.recordCaptureAudio('system', {
    sampleRate: 48000,
    channelCount: 2,
    packets: 3,
    frames: 12288,
    signal: 'present',
    pcm: Buffer.from('private audio'),
    transcript: 'private transcript'
  }), true);

  assert.deepEqual(diagnostics.snapshot().capture.system.telemetry, {
    sampleRate: 48000,
    channelCount: 2,
    packets: 3,
    frames: 12288,
    signal: 'present'
  });
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private|transcript|audio/i);
});

test('only accepts allowlisted renderer diagnostics fields and never retains nested data', () => {
  const diagnostics = createDiagnosticsStore({ appVersion: '1.0.0', platform: 'win32', arch: 'x64' });
  const hostile = Object.create({ inherited: 'Bearer inherited-secret' });
  hostile.type = 'capture';
  hostile.channel = 'microphone';
  hostile.state = 'failed';
  hostile.category = 'permission';
  hostile.message = 'Allow microphone access.';
  hostile.trackLabel = 'Built-in Microphone';
  hostile.transcript = 'private meeting transcript';
  hostile.audio = Buffer.from('private audio');
  hostile.screenshot = 'data:image/png;base64,private-image';
  hostile.headers = { Authorization: 'Bearer private-token', Cookie: 'session=private-cookie' };
  hostile.nested = { apiKey: 'sk-private-key' };

  assert.equal(diagnostics.report(hostile), true);
  const snapshot = diagnostics.snapshot();

  assert.deepEqual(snapshot.capture.microphone, {
    state: 'failed',
    category: 'permission',
    message: 'Permission was denied. Allow cue in System Settings and try again.',
    trackLabel: 'Built-in Microphone',
    telemetry: DEFAULT_CAPTURE_TELEMETRY
  });
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /transcript|private|authorization|cookie|apikey/i);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.capture.microphone, 'nested'), false);
});

test('maps only the two explicit capture channels from a renderer coordinator snapshot', () => {
  const diagnostics = createDiagnosticsStore({ appVersion: '1.0.0', platform: 'darwin', arch: 'arm64' });

  assert.equal(diagnostics.report({
    type: 'capture',
    snapshot: {
      session: { state: 'ready', transcript: 'never retain this' },
      microphone: {
        state: 'ready', trackLabel: 'MacBook Microphone', errorCategory: null, errorMessage: null,
        audio: 'data:audio/wav;base64,private'
      },
      system: {
        state: 'failed', trackLabel: null, errorCategory: 'permission', errorMessage: 'Allow Screen & System Audio Recording.',
        screenshot: 'data:image/png;base64,private'
      },
      apiKeys: { openai: 'sk-private-key' }
    }
  }), true);

  assert.deepEqual(diagnostics.snapshot().capture, {
    microphone: { state: 'ready', category: null, message: null, trackLabel: 'MacBook Microphone', telemetry: DEFAULT_CAPTURE_TELEMETRY },
    system: { state: 'failed', category: 'permission', message: 'Permission was denied. Allow cue in System Settings and try again.', trackLabel: null, telemetry: DEFAULT_CAPTURE_TELEMETRY }
  });
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /transcript|private|data:image|data:audio|screenshot|apikey/i);
});

test('redacts and rejects unsafe failure text without exposing mutable internal state', () => {
  const changes = [];
  const diagnostics = createDiagnosticsStore({
    appVersion: '1.0.0', platform: 'linux', arch: 'x64', onChange: (snapshot) => changes.push(snapshot)
  });
  const huge = 'x'.repeat(20_000);

  assert.equal(diagnostics.report({ type: 'failure', category: 'network', message: huge }), true);
  assert.equal(diagnostics.snapshot().lastFailure.message, 'Could not reach the provider. Check your connection and try again.');
  assert.equal(diagnostics.report({ type: 'failure', category: 'network', message: 'Request failed: Bearer token-value; api_key=sk-private' }), true);
  assert.equal(diagnostics.report({ type: 'failure', category: 'network', message: `transcript: ${huge}` }), true);
  const beforeMutation = diagnostics.snapshot();
  beforeMutation.capture.microphone.state = 'tampered';
  beforeMutation.lastFailure.message = 'tampered';
  const afterMutation = diagnostics.snapshot();

  assert.equal(afterMutation.capture.microphone.state, 'off');
  assert.equal(afterMutation.lastFailure.message, 'Could not reach the provider. Check your connection and try again.');
  assert.doesNotMatch(afterMutation.lastFailure.message, /token-value|sk-private|api_key/i);
  assert.ok(afterMutation.lastFailure.at);
  assert.ok(changes.length >= 1);
  assert.equal(diagnostics.report(new Proxy({}, { get() { throw new Error('do not inspect arbitrary fields'); } })), false);
});

test('keeps only known state values when fed malformed or prototype-like reports', () => {
  const diagnostics = createDiagnosticsStore({ appVersion: '1.0.0', platform: 'darwin', arch: 'arm64' });

  assert.equal(diagnostics.report({ type: 'capture', channel: '__proto__', state: 'ready', message: 'nope' }), false);
  assert.equal(diagnostics.report({ type: 'capture', channel: 'system', state: 'stealing', category: 'secret', message: 'data:audio/wav;base64,abc' }), true);
  const snapshot = diagnostics.snapshot();

  assert.deepEqual(snapshot.capture.system, { state: 'off', category: null, message: null, trackLabel: null, telemetry: DEFAULT_CAPTURE_TELEMETRY });
  assert.equal(Object.getPrototypeOf(snapshot.capture), Object.prototype);
});

test('does not expose credential-shaped identifiers as provider or model state', () => {
  const diagnostics = createDiagnosticsStore({ appVersion: '1.0.0', platform: 'darwin', arch: 'arm64' });

  diagnostics.updateProviders({
    chat: { provider: 'openai', model: 'sk-private-key', ready: true },
    stt: { provider: 'AIza-private-key', state: 'ready' }
  });

  assert.deepEqual(diagnostics.snapshot().chat, { provider: 'openai', model: null, ready: true });
  assert.deepEqual(diagnostics.snapshot().stt, { provider: null, state: 'ready' });
});

test('does not expose a credential-shaped renderer track label', () => {
  const diagnostics = createDiagnosticsStore({ appVersion: '1.0.0', platform: 'darwin', arch: 'arm64' });

  diagnostics.report({ type: 'capture', channel: 'microphone', state: 'ready', trackLabel: 'sk-private-track-label' });

  assert.equal(diagnostics.snapshot().capture.microphone.trackLabel, null);
});

test('rejects an oversized track label before trimming it into an allowed value', () => {
  const diagnostics = createDiagnosticsStore({ appVersion: '1.0.0', platform: 'darwin', arch: 'arm64' });

  diagnostics.report({
    type: 'capture',
    channel: 'microphone',
    state: 'ready',
    trackLabel: `${' '.repeat(121)}Built-in Microphone`
  });

  assert.equal(diagnostics.snapshot().capture.microphone.trackLabel, null);
});

test('diagnostics get handler serves only the live main renderer sender', async () => {
  const webContents = { isDestroyed: () => false };
  let currentWindow = { isDestroyed: () => false, webContents };
  const diagnostics = createDiagnosticsStore({ appVersion: '1.0.0', platform: 'darwin', arch: 'arm64' });
  let permissionReads = 0;
  let providerRefreshes = 0;
  const handler = createDiagnosticsGetHandler({
    getWindow: () => currentWindow,
    getDiagnostics: () => diagnostics,
    getPermissionStatus: async () => { permissionReads += 1; return { mic: 'granted', screen: 'granted' }; },
    refreshProviders: () => { providerRefreshes += 1; }
  });

  const result = await handler({ sender: webContents });
  assert.deepEqual(result.snapshot.permissions, { microphone: 'granted', screen: 'granted' });
  assert.equal(permissionReads, 1);
  assert.equal(providerRefreshes, 1);

  await assert.rejects(() => handler({ sender: {} }), /main cue window/i);
  currentWindow = { isDestroyed: () => true, webContents };
  await assert.rejects(() => handler({ sender: webContents }), /main cue window/i);
  currentWindow = null;
  await assert.rejects(() => handler({ sender: webContents }), /main cue window/i);
  assert.equal(permissionReads, 1);
  assert.equal(providerRefreshes, 1);
});

test('normalizes renderer failure detail to a fixed category recovery message', () => {
  const diagnostics = createDiagnosticsStore({ appVersion: '1.0.0', platform: 'darwin', arch: 'arm64' });
  const payloads = [
    'X-Custom-Token: private-random-value',
    'x-auth-token=private-random-value',
    'access_token=private-random-value',
    'client_secret=private-random-value',
    'private sentence that did not come from cue\n\u0000\u001b[31m'
  ];

  for (const message of payloads) {
    diagnostics.report({ type: 'failure', category: 'network', message });
    const lastFailure = diagnostics.snapshot().lastFailure;
    assert.equal(lastFailure.message, 'Could not reach the provider. Check your connection and try again.');
    assert.doesNotMatch(JSON.stringify(lastFailure), /private-random-value|x-custom-token|x-auth-token|access_token|client_secret|\u001b/i);
  }
});

test('retains an allowlisted capture channel with the last categorized failure and summary', () => {
  const diagnostics = createDiagnosticsStore({ appVersion: '1.0.0', platform: 'darwin', arch: 'arm64' });

  assert.equal(diagnostics.report({
    type: 'capture-channel-ended',
    channel: 'microphone',
    category: 'device',
    message: 'private track data'
  }), true);
  const { snapshot, summary } = diagnostics.read();

  assert.deepEqual(snapshot.lastFailure, {
    category: 'device',
    channel: 'microphone',
    message: 'The microphone or system-audio device is unavailable. Check the selected input and try again.',
    at: snapshot.lastFailure.at
  });
  assert.match(summary, /Last failure: device \(microphone\)/);
  assert.doesNotMatch(JSON.stringify(snapshot), /private track data/);
  assert.equal(diagnostics.report({ type: 'capture-channel-ended', channel: '__proto__', category: 'device' }), false);
});

test('preserves provider model category and disconnected STT state', () => {
  const diagnostics = createDiagnosticsStore({ appVersion: '1.0.0', platform: 'darwin', arch: 'arm64' });

  diagnostics.recordFailure('model', 'arbitrary private model error');
  diagnostics.updateProviders({ stt: { provider: 'openai-realtime', state: 'disconnected' } });

  assert.equal(diagnostics.snapshot().lastFailure.category, 'model');
  assert.equal(diagnostics.snapshot().lastFailure.message, 'The selected model is unavailable. Choose a current model in Settings and try again.');
  assert.deepEqual(diagnostics.snapshot().stt, { provider: 'openai-realtime', state: 'disconnected' });
});

test('main records an unready LLM as a diagnostics configuration failure before returning', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf('if (!llm.ready) {');
  const end = main.indexOf('\n    let imageDataUrl', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = main.slice(start, end);

  assert.match(block, /recordDiagnosticsFailure\('configuration', new Error\(message\)\)/);
  assert.ok(block.indexOf("recordDiagnosticsFailure('configuration'") < block.indexOf("send('llm:error'"));
});

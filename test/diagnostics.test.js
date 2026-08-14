const assert = require('node:assert/strict');
const test = require('node:test');

const { createDiagnosticsStore } = require('../src/diagnostics');

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
    message: 'Allow microphone access.',
    trackLabel: 'Built-in Microphone'
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
    microphone: { state: 'ready', category: null, message: null, trackLabel: 'MacBook Microphone' },
    system: { state: 'failed', category: 'permission', message: 'Allow Screen & System Audio Recording.', trackLabel: null }
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
  assert.equal(diagnostics.snapshot().lastFailure.message.length, 320);
  assert.equal(diagnostics.report({ type: 'failure', category: 'network', message: 'Request failed: Bearer token-value; api_key=sk-private' }), true);
  assert.equal(diagnostics.report({ type: 'failure', category: 'network', message: `transcript: ${huge}` }), true);
  const beforeMutation = diagnostics.snapshot();
  beforeMutation.capture.microphone.state = 'tampered';
  beforeMutation.lastFailure.message = 'tampered';
  const afterMutation = diagnostics.snapshot();

  assert.equal(afterMutation.capture.microphone.state, 'off');
  assert.equal(afterMutation.lastFailure.message, 'An operation failed. Check diagnostics state and try again.');
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

  assert.deepEqual(snapshot.capture.system, { state: 'off', category: null, message: null, trackLabel: null });
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

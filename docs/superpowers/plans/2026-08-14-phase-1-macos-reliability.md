# Phase 1 macOS Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify an Apple Silicon version of cue whose microphone and meeting-audio channels fail independently, whose transcript and diagnostics are trustworthy, and whose manual answers cannot hang silently.

**Architecture:** Keep browser media capture in the sandboxed renderer and privileged transcription/AI work in the main process. Add small testable modules for capture coordination, transcript normalization, provider errors/request policy, and sanitized diagnostics, then connect them through the existing preload allowlist and settings UI.

**Tech Stack:** Electron 33, Node.js 22, CommonJS, Chromium MediaDevices/AudioWorklet, Node's built-in test runner, electron-builder, macOS ScreenCaptureKit loopback.

---

## File Map

**Create:**

- `renderer/capture-coordinator.js` — renderer-compatible state machine for independent microphone/system channels and pipeline activation.
- `src/transcript-ledger.js` — validates, sequences, timestamps, caps, and formats finalized transcript turns.
- `src/provider-errors.js` — converts raw provider failures into stable categories and safe user messages.
- `src/request-policy.js` — inactivity timeout, cancellation, and pre-token retry policy for streamed answers.
- `src/diagnostics.js` — canonical sanitized diagnostic state and copyable summary.
- `scripts/verify-macos-app.js` — verifies the packaged app's architecture, metadata, and required files.
- `test/capture-coordinator.test.js`
- `test/transcript-ledger.test.js`
- `test/provider-errors.test.js`
- `test/request-policy.test.js`
- `test/diagnostics.test.js`
- `test/preload-contract.test.js`
- `test/macos-package.test.js`

**Modify:**

- `renderer/index.html` — load the coordinator and add the Diagnostics tab.
- `renderer/renderer.js` — use the coordinator, report structured channel state, and render diagnostics.
- `renderer/styles.css` — compact diagnostic rows and state badges.
- `preload.js` — explicit `capture:set`, diagnostic snapshot/report, and diagnostic event bridge methods.
- `main.js` — deterministic capture IPC, transcript ledger, diagnostics updates, and request policy integration.
- `src/llm.js` — throw categorized provider errors and forward abort signals.
- `package.json` — packaged-app verification script.
- `electron-builder.cjs` — only if the package tests expose an allowlist/metadata defect.
- `test/llm.test.js` — preserve provider-specific regressions while asserting categorized errors.
- `test/build-config.test.js` — assert new modules/scripts ship in the app.
- `README.md` — reconcile macOS support and document setup, diagnostics, recovery, signing, and Phase 2 boundary.

## Task 1: Establish the clean baseline

**Files:**

- Inspect: `package-lock.json`
- Inspect: `test/*.test.js`

- [ ] **Step 1: Confirm the branch contains only the approved design and plan**

Run:

```bash
git status --short --branch
git log -2 --oneline
```

Expected: branch `codex/phase1-macos-reliability`; no production-code changes.

- [ ] **Step 2: Install the locked dependencies**

Run:

```bash
npm ci
```

Expected: exit 0. Record audit warnings separately; do not change dependency versions inside the reliability work unless a runtime blocker is proven.

- [ ] **Step 3: Run the full baseline suite and syntax checks**

Run:

```bash
npm test
for file in main.js preload.js electron-builder.cjs renderer/*.js src/*.js scripts/*.js test/*.js; do node --check "$file"; done
```

Expected: 130 tests pass at the starting commit and all files parse. If upstream drift changes the count, save the exact count in the execution notes.

## Task 2: Add an independent capture coordinator

**Files:**

- Create: `renderer/capture-coordinator.js`
- Create: `test/capture-coordinator.test.js`
- Modify: `renderer/index.html`

- [ ] **Step 1: Write the failing coordinator tests**

Create tests that exercise real state transitions with dependency functions rather than browser mocks:

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { CaptureCoordinator } = require('../renderer/capture-coordinator');

function driver(name, behavior = {}) {
  return {
    startCalls: 0,
    stopCalls: 0,
    async start() {
      this.startCalls += 1;
      if (behavior.startError) throw behavior.startError;
      return { trackLabel: name };
    },
    async stop() { this.stopCalls += 1; }
  };
}

test('keeps microphone ready when system audio fails', async () => {
  const mic = driver('Built-in Microphone');
  const system = driver('Meeting', { startError: Object.assign(new Error('denied'), { category: 'permission' }) });
  const pipelineCalls = [];
  const coordinator = new CaptureCoordinator({
    channels: { microphone: mic, system },
    setPipelineActive: async (active) => { pipelineCalls.push(active); return active; }
  });

  const snapshot = await coordinator.start();

  assert.equal(snapshot.session, 'ready');
  assert.equal(snapshot.channels.microphone.state, 'ready');
  assert.equal(snapshot.channels.system.state, 'failed');
  assert.deepEqual(pipelineCalls, [true]);
});

test('returns to off and cleans partial resources when both channels fail', async () => {
  const mic = driver('mic', { startError: new Error('no mic') });
  const system = driver('system', { startError: new Error('no loopback') });
  const coordinator = new CaptureCoordinator({ channels: { microphone: mic, system }, setPipelineActive: async () => true });

  const snapshot = await coordinator.start();

  assert.equal(snapshot.session, 'off');
  assert.equal(mic.stopCalls, 1);
  assert.equal(system.stopCalls, 1);
});

test('deduplicates concurrent starts and makes stop idempotent', async () => {
  const mic = driver('mic');
  const system = driver('system');
  const coordinator = new CaptureCoordinator({ channels: { microphone: mic, system }, setPipelineActive: async (active) => active });

  await Promise.all([coordinator.start(), coordinator.start()]);
  await Promise.all([coordinator.stop(), coordinator.stop()]);

  assert.equal(mic.startCalls, 1);
  assert.equal(system.startCalls, 1);
  assert.equal(mic.stopCalls, 1);
  assert.equal(system.stopCalls, 1);
  assert.equal(coordinator.snapshot().session, 'off');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/capture-coordinator.test.js
```

Expected: FAIL with `Cannot find module '../renderer/capture-coordinator'`.

- [ ] **Step 3: Implement the minimal coordinator**

Use a browser/CommonJS wrapper so the same production class is loaded by Electron and Node tests:

```js
(function exposeCaptureCoordinator(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CueCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createModule() {
  const initialChannel = () => ({ state: 'off', category: null, message: null, trackLabel: null });

  class CaptureCoordinator {
    constructor({ channels, setPipelineActive, onChange = () => {} }) {
      this.channels = channels;
      this.setPipelineActive = setPipelineActive;
      this.onChange = onChange;
      this.state = { session: 'off', channels: { microphone: initialChannel(), system: initialChannel() } };
      this.startPromise = null;
      this.stopPromise = null;
    }

    snapshot() { return JSON.parse(JSON.stringify(this.state)); }

    _publish() { const value = this.snapshot(); this.onChange(value); return value; }

    start() {
      if (this.startPromise) return this.startPromise;
      if (this.state.session === 'ready') return Promise.resolve(this.snapshot());
      this.startPromise = this._start().finally(() => { this.startPromise = null; });
      return this.startPromise;
    }

    async _start() {
      this.state.session = 'starting';
      for (const name of Object.keys(this.channels)) this.state.channels[name] = { ...initialChannel(), state: 'starting' };
      this._publish();
      const names = Object.keys(this.channels);
      const results = await Promise.allSettled(names.map((name) => this.channels[name].start()));
      results.forEach((result, index) => {
        const name = names[index];
        this.state.channels[name] = result.status === 'fulfilled'
          ? { ...initialChannel(), state: 'ready', trackLabel: result.value?.trackLabel || null }
          : { ...initialChannel(), state: 'failed', category: result.reason?.category || 'capture', message: result.reason?.message || String(result.reason) };
      });
      const usable = names.some((name) => this.state.channels[name].state === 'ready');
      if (!usable || !(await this.setPipelineActive(true))) {
        await Promise.allSettled(names.map((name) => this.channels[name].stop()));
        this.state.session = 'off';
      } else {
        this.state.session = 'ready';
      }
      return this._publish();
    }

    stop() {
      if (this.stopPromise) return this.stopPromise;
      if (this.state.session === 'off') return Promise.resolve(this.snapshot());
      this.stopPromise = this._stop().finally(() => { this.stopPromise = null; });
      return this.stopPromise;
    }

    async _stop() {
      this.state.session = 'stopping';
      this._publish();
      await this.setPipelineActive(false);
      await Promise.allSettled(Object.values(this.channels).map((channel) => channel.stop()));
      this.state = { session: 'off', channels: { microphone: initialChannel(), system: initialChannel() } };
      return this._publish();
    }
  }

  return { CaptureCoordinator };
});
```

Load it before `renderer.js`:

```html
<script src="icons.js"></script>
<script src="capture-coordinator.js"></script>
<script src="renderer.js"></script>
```

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
node --test test/capture-coordinator.test.js
npm test
```

Expected: focused tests and the full suite pass.

- [ ] **Step 5: Commit the coordinator**

```bash
git add renderer/capture-coordinator.js renderer/index.html test/capture-coordinator.test.js
git commit -m "feat: coordinate audio channels independently"
```

## Task 3: Integrate deterministic capture IPC and channel drivers

**Files:**

- Modify: `main.js:425-486,610-619`
- Modify: `preload.js:13-22,35-43`
- Modify: `renderer/renderer.js:560-760,930-965,1740-1760`
- Create: `test/preload-contract.test.js`

- [ ] **Step 1: Write the failing preload contract test**

Read the source as the existing build tests do and assert the deterministic contract:

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('preload exposes deterministic capture and diagnostics methods', () => {
  assert.match(preload, /captureSet:\s*\(active\)\s*=>\s*ipcRenderer\.invoke\('capture:set',\s*!!active\)/);
  assert.match(preload, /diagnosticsGet:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('diagnostics:get'\)/);
  assert.match(preload, /diagnosticsReport:\s*\(event\)\s*=>\s*ipcRenderer\.send\('diagnostics:report',\s*event\)/);
  assert.match(preload, /'diagnostics:changed'/);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/preload-contract.test.js
```

Expected: FAIL because `captureSet`, `diagnosticsGet`, and `diagnosticsReport` do not exist.

- [ ] **Step 3: Add deterministic bridge and main-process IPC**

Replace toggle-only use with an explicit setter while retaining `captureToggle` temporarily for compatibility:

```js
// preload.js
captureSet: (active) => ipcRenderer.invoke('capture:set', !!active),
diagnosticsGet: () => ipcRenderer.invoke('diagnostics:get'),
diagnosticsReport: (event) => ipcRenderer.send('diagnostics:report', event),
```

Add `diagnostics:changed` to the existing event allowlist.

In `main.js`, extract the existing serialized transition logic:

```js
function requestCaptureState(targetState) {
  desiredCaptureState = !!targetState;
  if (!desiredCaptureState && !state.capturing && localWhisperTranscriber) {
    localWhisperTranscriber.forceStop().catch(() => {});
  }
  captureTransition = captureTransition
    .catch(() => state.capturing)
    .then(() => setCapturing(desiredCaptureState));
  return captureTransition;
}

ipcMain.handle('capture:set', (_event, active) => requestCaptureState(active));
ipcMain.handle('capture:toggle', () => requestCaptureState(!desiredCaptureState));
```

- [ ] **Step 4: Convert renderer media functions into coordinator drivers**

`startMic()` and `startSystemAudio()` must return `{ trackLabel }` on success and throw categorized errors after cleaning partial resources. Use this error helper in the renderer:

```js
function captureError(category, message, cause) {
  const error = new Error(message);
  error.category = category;
  error.cause = cause;
  return error;
}
```

Attach `track.onended` to stop only its own driver and report `state: 'failed', category: 'ended'`. Instantiate the coordinator once:

```js
const captureCoordinator = new CueCapture.CaptureCoordinator({
  channels: {
    microphone: { start: startMic, stop: stopMic },
    system: { start: startSystemAudio, stop: stopSystemAudio }
  },
  setPipelineActive: (active) => cue.captureSet(active),
  onChange: (snapshot) => {
    cue.diagnosticsReport({ type: 'capture', snapshot });
    renderCaptureSnapshot(snapshot);
  }
});

$('#stop-btn').addEventListener('click', () => {
  const action = captureCoordinator.snapshot().session === 'off' ? captureCoordinator.start() : captureCoordinator.stop();
  action.catch((error) => showStatus(error.message));
});
```

Remove the duplicate `startMic()`/`stopMic()` calls currently present inside the `capture:state` handler. That handler reflects main-process pipeline state only; it must not initiate renderer capture.

- [ ] **Step 5: Run tests and syntax checks**

Run:

```bash
node --test test/capture-coordinator.test.js test/preload-contract.test.js
node --check main.js
node --check preload.js
node --check renderer/renderer.js
npm test
```

Expected: all pass with no syntax errors.

- [ ] **Step 6: Commit deterministic capture integration**

```bash
git add main.js preload.js renderer/renderer.js test/preload-contract.test.js
git commit -m "fix: make macOS capture startup deterministic"
```

## Task 4: Create the ordered transcript ledger

**Files:**

- Create: `src/transcript-ledger.js`
- Create: `test/transcript-ledger.test.js`
- Modify: `main.js:51-116,285-354,487-530,621-624,785-795`

- [ ] **Step 1: Write failing ledger tests**

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { createTranscriptLedger, formatTranscriptForPrompt } = require('../src/transcript-ledger');

test('sequences and timestamps valid final turns', () => {
  let now = 1000;
  const ledger = createTranscriptLedger({ maxTurns: 2, now: () => ++now });
  assert.equal(ledger.append('you', '  Hello  ').seq, 1);
  assert.equal(ledger.append('them', 'How are you?').seq, 2);
  assert.equal(ledger.append('them', '...'), null);
  assert.equal(ledger.append('unknown', 'ignored'), null);
  assert.deepEqual(ledger.list().map(({ channel, text, seq, ts }) => ({ channel, text, seq, ts })), [
    { channel: 'you', text: 'Hello', seq: 1, ts: 1001 },
    { channel: 'them', text: 'How are you?', seq: 2, ts: 1002 }
  ]);
});

test('caps old turns and formats source labels', () => {
  const ledger = createTranscriptLedger({ maxTurns: 2, now: () => 1 });
  ledger.append('you', 'one');
  ledger.append('them', 'two');
  ledger.append('you', 'three');
  assert.deepEqual(ledger.list().map((turn) => turn.text), ['two', 'three']);
  assert.equal(formatTranscriptForPrompt(ledger.list()), 'Meeting: two\nYou: three');
});

test('clear removes turns and restarts sequence numbers', () => {
  const ledger = createTranscriptLedger();
  ledger.append('you', 'before');
  ledger.clear();
  assert.equal(ledger.append('them', 'after').seq, 1);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/transcript-ledger.test.js
```

Expected: FAIL because `src/transcript-ledger.js` does not exist.

- [ ] **Step 3: Implement the ledger**

```js
const VALID_CHANNELS = new Set(['you', 'them']);
const PUNCTUATION_ONLY = /^[?!.,;:\-…]+$/;

function normalizeText(text) {
  const value = String(text || '').trim();
  if (value.length < 2 || PUNCTUATION_ONLY.test(value)) return null;
  return value;
}

function createTranscriptLedger({ maxTurns = 200, now = Date.now } = {}) {
  const turns = [];
  let nextSequence = 1;
  return {
    append(channel, text) {
      const normalized = normalizeText(text);
      if (!VALID_CHANNELS.has(channel) || !normalized) return null;
      const turn = { channel, text: normalized, ts: now(), seq: nextSequence++ };
      turns.push(turn);
      if (turns.length > maxTurns) turns.splice(0, turns.length - maxTurns);
      return { ...turn };
    },
    list() { return turns.map((turn) => ({ ...turn })); },
    clear() { turns.splice(0, turns.length); nextSequence = 1; },
    get length() { return turns.length; }
  };
}

function formatTranscriptForPrompt(turns) {
  return (turns || []).map((turn) => `${turn.channel === 'them' ? 'Meeting' : 'You'}: ${turn.text}`).join('\n');
}

module.exports = { createTranscriptLedger, formatTranscriptForPrompt, normalizeText };
```

- [ ] **Step 4: Integrate the ledger into every STT path**

Replace the raw array and all three manual `transcript.push` paths with one helper:

```js
const { createTranscriptLedger } = require('./src/transcript-ledger');
const MAX_TRANSCRIPT_TURNS = 200;
const transcript = createTranscriptLedger({ maxTurns: MAX_TRANSCRIPT_TURNS });

function publishTranscript(channel, text) {
  const turn = transcript.append(channel, text);
  if (!turn) return null;
  send('transcript', turn);
  send('stt:final', { channel, text: turn.text, ts: turn.ts, seq: turn.seq });
  return turn;
}
```

Pass `transcript.list()` to `detectCategory`, `buildInterviewContext`, mode prompt builders, and app-link snapshots. Change clear IPC to `transcript.clear()`.

- [ ] **Step 5: Run focused, context, and full tests**

Run:

```bash
node --test test/transcript-ledger.test.js test/context.test.js test/prompts.test.js
npm test
```

Expected: ledger tests and the complete existing suite pass.

- [ ] **Step 6: Commit the ledger**

```bash
git add src/transcript-ledger.js main.js test/transcript-ledger.test.js
git commit -m "feat: make conversation transcripts ordered and validated"
```

## Task 5: Categorize provider failures safely

**Files:**

- Create: `src/provider-errors.js`
- Create: `test/provider-errors.test.js`
- Modify: `src/llm.js:20-85,330-359`
- Modify: `test/llm.test.js`

- [ ] **Step 1: Write failing classification tests**

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyProviderError, ProviderRequestError } = require('../src/provider-errors');

test('classifies authentication without exposing a key', () => {
  const raw = Object.assign(new Error('401 invalid api key sk-secret-value'), { status: 401 });
  const result = classifyProviderError(raw, { provider: 'openai', model: 'gpt-4o-mini' });
  assert.equal(result.category, 'authentication');
  assert.equal(result.retryable, false);
  assert.match(result.message, /OpenAI credentials were rejected/);
  assert.doesNotMatch(result.message, /sk-secret-value/);
});

test('marks network and 5xx failures retryable but quota failures final', () => {
  assert.equal(classifyProviderError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), { provider: 'anthropic' }).retryable, true);
  assert.equal(classifyProviderError(Object.assign(new Error('bad gateway'), { status: 502 }), { provider: 'openai' }).retryable, true);
  assert.equal(classifyProviderError(Object.assign(new Error('quota'), { status: 429 }), { provider: 'gemini' }).retryable, false);
});

test('ProviderRequestError carries stable metadata and a safe message', () => {
  const error = ProviderRequestError.from(Object.assign(new Error('model missing'), { status: 404 }), { provider: 'gemini', model: 'old-model' });
  assert.equal(error.category, 'model');
  assert.equal(error.retryable, false);
  assert.match(error.message, /old-model/);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/provider-errors.test.js
```

Expected: FAIL because `src/provider-errors.js` does not exist.

- [ ] **Step 3: Implement categories and redaction**

Use the existing quota/not-found detection logic, move it into `provider-errors.js`, and add these stable categories:

```js
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{6,}\b/g,
  /\bAIza[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[^\s]+/gi,
  /\bapi[-_ ]?key\s*[:=]\s*[^\s,;]+/gi
];

function redactSecrets(value) {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[redacted]'), String(value || ''));
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EAI_AGAIN', 'ETIMEDOUT']);

function providerLabel(provider) {
  const labels = { azure: 'Azure AI Foundry', openai: 'OpenAI', gemini: 'Gemini', anthropic: 'Anthropic' };
  return labels[provider] || (provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'Provider');
}

function statusOf(error) {
  return Number(error?.status || error?.statusCode || error?.response?.status) || null;
}

function retryDelaySeconds(text) {
  const match = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)\s*s/i.exec(text);
  return match ? Number(match[1]) : null;
}

function classifyProviderError(error, { provider, model } = {}) {
  const label = providerLabel(provider);
  const status = statusOf(error);
  const code = error?.code || error?.error?.code || null;
  const raw = redactSecrets(error?.message || error || '');
  const text = `${raw} ${status || ''} ${code || ''}`.toLowerCase();
  if (error?.category === 'configuration') {
    return { category: 'configuration', retryable: false, provider, model, status, message: raw || `Complete the ${label} settings.` };
  }
  if (status === 401 || /invalid api key|unauthorized|authentication/.test(text)) {
    return { category: 'authentication', retryable: false, provider, model, status, message: `${label} credentials were rejected. Update the key in Settings and try again.` };
  }
  if (status === 403 || /permission denied|forbidden/.test(text)) {
    return { category: 'permission', retryable: false, provider, model, status, message: `${label} denied access to this request. Check the key permissions and selected model.` };
  }
  if (status === 429 || code === 'RESOURCE_EXHAUSTED' || /quota|rate limit|too many requests|resource_exhausted/.test(text)) {
    const seconds = retryDelaySeconds(raw);
    const wait = seconds ? ` Wait about ${Math.ceil(seconds)}s` : ' Wait a moment';
    return { category: 'quota', retryable: false, provider, model, status: status || 429, message: `${label} free-tier quota exhausted (429 Too Many Requests).${wait} and try again, or add billing to your ${label} account. You can also switch providers or models in Settings.` };
  }
  if (status === 404 || /model not found|is not found for api version|\b404\b/.test(text)) {
    const modelText = model ? ` "${redactSecrets(model)}"` : '';
    return { category: 'model', retryable: false, provider, model, status: status || 404, message: `${label} model${modelText} is unavailable (404) — it may have been renamed, retired, or misspelled. Open Settings and choose a current model.` };
  }
  if (status === 408 || (status && status >= 500)) {
    return { category: 'service', retryable: true, provider, model, status, message: `${label} is temporarily unavailable. cue will retry once.` };
  }
  if (NETWORK_CODES.has(code) || /socket hang up|network|fetch failed|connection reset/.test(text)) {
    return { category: 'network', retryable: true, provider, model, status, message: `${label} could not be reached. Check your connection and try again.` };
  }
  return { category: 'unknown', retryable: false, provider, model, status, message: raw || `Unknown ${label} error.` };
}

class ProviderRequestError extends Error {
  constructor({ category, message, retryable, provider, model, status, cause }) {
    super(message, { cause });
    this.name = 'ProviderRequestError';
    Object.assign(this, { category, retryable, provider, model, status });
  }
  static from(error, context) {
    return new ProviderRequestError({ ...classifyProviderError(error, context), cause: error });
  }
}

module.exports = { classifyProviderError, ProviderRequestError, redactSecrets };
```

- [ ] **Step 4: Integrate categorized errors into `createLLM`**

In the `createLLM().stream()` catch block:

```js
} catch (error) {
  if (error instanceof ProviderRequestError) throw error;
  throw ProviderRequestError.from(error, { provider, model });
}
```

Keep `formatProviderErrorMessage`, `isQuotaError`, and `CURRENT_GEMINI_DEFAULT` exports compatible by delegating to the new module, so existing callers and tests do not break.

```js
function formatProviderErrorMessage(error, provider, model) {
  const classified = classifyProviderError(error, { provider, model });
  if (['authentication', 'permission', 'quota', 'model'].includes(classified.category)) return classified.message;
  return redactSecrets(error?.message || error) || classified.message;
}

function isQuotaError(error) {
  return classifyProviderError(error).category === 'quota';
}
```

- [ ] **Step 5: Run provider and full tests**

Run:

```bash
node --test test/provider-errors.test.js test/llm.test.js
npm test
```

Expected: categorized-error tests and all existing provider regressions pass.

- [ ] **Step 6: Commit provider error handling**

```bash
git add src/provider-errors.js src/llm.js test/provider-errors.test.js test/llm.test.js
git commit -m "fix: classify AI provider failures safely"
```

## Task 6: Add bounded streamed-answer request policy

**Files:**

- Create: `src/request-policy.js`
- Create: `test/request-policy.test.js`
- Modify: `main.js:487-558`
- Modify: `src/llm.js` provider stream functions

- [ ] **Step 1: Write failing policy tests with a fake clock-independent timeout**

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { runStreamWithPolicy } = require('../src/request-policy');

test('retries one temporary failure before the first token', async () => {
  let attempts = 0;
  const tokens = [];
  const result = await runStreamWithPolicy({
    operation: async ({ onToken }) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('reset'), { retryable: true });
      onToken('ready');
      return 'ready';
    },
    onToken: (token) => tokens.push(token),
    inactivityMs: 100,
    sleep: async () => {}
  });
  assert.equal(result, 'ready');
  assert.equal(attempts, 2);
  assert.deepEqual(tokens, ['ready']);
});

test('does not retry after a token has streamed', async () => {
  let attempts = 0;
  await assert.rejects(() => runStreamWithPolicy({
    operation: async ({ onToken }) => {
      attempts += 1;
      onToken('partial');
      throw Object.assign(new Error('reset'), { retryable: true });
    },
    onToken: () => {},
    inactivityMs: 100,
    sleep: async () => {}
  }), /reset/);
  assert.equal(attempts, 1);
});

test('times out a silent operation and aborts it', async () => {
  let receivedSignal;
  await assert.rejects(() => runStreamWithPolicy({
    operation: ({ signal }) => { receivedSignal = signal; return new Promise(() => {}); },
    onToken: () => {},
    inactivityMs: 10,
    maxAttempts: 1
  }), (error) => error.category === 'timeout');
  assert.equal(receivedSignal.aborted, true);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/request-policy.test.js
```

Expected: FAIL because `src/request-policy.js` does not exist.

- [ ] **Step 3: Implement timeout, abort, and retry-before-token**

```js
async function runStreamWithPolicy({ operation, onToken, inactivityMs = 25000, maxAttempts = 2, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let timer;
    let emitted = false;
    const timeout = new Promise((_, reject) => {
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('The model stopped responding. Try again.'), { category: 'timeout', retryable: true }));
        }, inactivityMs);
      };
      controller.armTimeout = arm;
      arm();
    });
    try {
      const result = await Promise.race([
        operation({
          signal: controller.signal,
          onToken(token) { emitted = true; controller.armTimeout(); onToken(token); }
        }),
        timeout
      ]);
      return result;
    } catch (error) {
      lastError = error;
      controller.abort();
      if (attempt >= maxAttempts || emitted || !error.retryable) throw error;
      await sleep(250 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

module.exports = { runStreamWithPolicy };
```

- [ ] **Step 4: Forward abort signals through providers**

Add `signal` to provider argument destructuring. Pass it using each SDK's request-options position; for the OpenAI-compatible route:

```js
const stream = await client.chat.completions.create(
  { model, messages, stream: true, max_tokens: maxTokens },
  { signal }
);
```

For providers whose SDK version does not accept an abort option, stop forwarding tokens after `signal.aborted` and preserve the policy's timeout cleanup. Add a focused provider test before each provider-specific change.

Use these exact transport rules:

```js
function emitToken(onToken, signal, token) {
  if (!signal?.aborted && token) onToken(token);
}

// OpenAI, Custom, Groq, MiniMax, and Azure (OpenAI SDK request options)
const stream = await client.chat.completions.create(request, { signal });

// Anthropic SDK request options
const stream = await client.messages.create(request, { signal });

// Ollama's native fetch
const response = await fetch(url, { method: 'POST', headers, body, signal });

// Gemini: the installed SDK has no public AbortSignal request option. Break the
// async iterator on abort; JavaScript then calls the iterator's return cleanup.
for await (const chunk of stream) {
  if (signal?.aborted) throw Object.assign(new Error('Request cancelled.'), { name: 'AbortError' });
  emitToken(onToken, signal, chunk && chunk.text);
}
```

Extend the existing OpenAI stub in `test/llm.test.js` to capture the second `requestOptions` argument and assert that the same `AbortSignal` reaches it. Add one Gemini regression whose fake async iterator records that its `return()` cleanup runs after abort.

- [ ] **Step 5: Replace the inline `main.js` watchdog**

Reject empty context before sending `llm:start`, except when the user typed explicit text or the selected mode requires a screenshot:

```js
const turns = transcript.list();
if (!userText?.trim() && !def.needsScreen && turns.length === 0) {
  send('status', { message: 'No conversation yet. Start listening and speak, or type a question.' });
  return;
}

await runStreamWithPolicy({
  operation: ({ onToken, signal }) => llm.stream({ system, turns: [{ role: 'user', text: built }], imageDataUrl, onToken, signal }),
  onToken: (text) => send('llm:token', { text }),
  inactivityMs: STREAM_INACTIVITY_MS
});
```

Keep `state.busy = false` in the existing `finally` block and remove the old local watchdog.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test test/request-policy.test.js test/provider-errors.test.js test/llm.test.js
node --check main.js
npm test
```

Expected: timeout/retry tests pass, provider tests pass, and no regression remains.

- [ ] **Step 7: Commit the request policy**

```bash
git add src/request-policy.js src/llm.js main.js test/request-policy.test.js test/llm.test.js
git commit -m "fix: bound and recover streamed AI answers"
```

## Task 7: Add sanitized diagnostics state

**Files:**

- Create: `src/diagnostics.js`
- Create: `test/diagnostics.test.js`
- Modify: `main.js`
- Modify: `preload.js`

- [ ] **Step 1: Write failing diagnostic-store tests**

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { createDiagnosticsStore } = require('../src/diagnostics');

test('stores statuses but strips forbidden fields, secrets, and transcript text', () => {
  const store = createDiagnosticsStore({ now: () => 1234, appVersion: '0.2.2', platform: 'darwin', arch: 'arm64' });
  store.update({
    type: 'failure', channel: 'microphone', category: 'permission', message: 'denied for sk-secret-value',
    apiKey: 'sk-secret', authorization: 'Bearer secret', transcript: 'private words', audio: Buffer.from('private')
  });
  const snapshot = store.snapshot();
  assert.equal(snapshot.lastFailure.message, 'denied for [redacted]');
  assert.equal(snapshot.lastFailure.at, 1234);
  assert.doesNotMatch(JSON.stringify(snapshot), /sk-secret|Bearer secret|private words|private/);
});

test('copy summary contains version and states but never credentials', () => {
  const store = createDiagnosticsStore({ appVersion: '0.2.2', platform: 'darwin', arch: 'arm64' });
  store.update({ type: 'provider', chat: { name: 'openai', model: 'gpt-4o-mini', ready: true }, stt: { name: 'local', state: 'ready' } });
  const text = store.summary();
  assert.match(text, /cue 0\.2\.2/);
  assert.match(text, /darwin arm64/);
  assert.match(text, /OpenAI/i);
  assert.doesNotMatch(text, /api.?key|authorization/i);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/diagnostics.test.js
```

Expected: FAIL because `src/diagnostics.js` does not exist.

- [ ] **Step 3: Implement the allowlist-only store**

The store must construct new objects from allowed keys rather than recursively deleting known secrets:

```js
const { redactSecrets } = require('./provider-errors');

function createDiagnosticsStore({ now = Date.now, appVersion = 'unknown', platform = process.platform, arch = process.arch } = {}) {
  const state = {
    app: { version: appVersion, platform, arch },
    permissions: { microphone: 'unknown', screen: 'unknown' },
    capture: { microphone: { state: 'off' }, system: { state: 'off' } },
    provider: { chat: { name: null, model: null, ready: false }, stt: { name: null, state: 'off' } },
    lastFailure: null
  };
  return {
    update(event = {}) {
      if (event.type === 'permissions') state.permissions = { microphone: event.microphone || 'unknown', screen: event.screen || 'unknown' };
      if (event.type === 'capture' && event.snapshot?.channels) {
        for (const name of ['microphone', 'system']) {
          const source = event.snapshot.channels[name] || {};
          state.capture[name] = { state: source.state || 'off', category: source.category || null, message: source.message || null, trackLabel: source.trackLabel || null };
        }
      }
      if (event.type === 'provider') state.provider = {
        chat: { name: event.chat?.name || null, model: event.chat?.model || null, ready: !!event.chat?.ready },
        stt: { name: event.stt?.name || null, state: event.stt?.state || 'off' }
      };
      if (event.type === 'failure') state.lastFailure = { channel: event.channel || null, category: event.category || 'unknown', message: redactSecrets(event.message || 'Unknown failure'), at: now() };
    },
    snapshot() { return JSON.parse(JSON.stringify(state)); },
    summary() { return buildDiagnosticSummary(state); }
  };
}

function buildDiagnosticSummary(state) {
  const lines = [
    `cue ${state.app.version}`,
    `${state.app.platform} ${state.app.arch}`,
    `Microphone permission: ${state.permissions.microphone}`,
    `Microphone capture: ${state.capture.microphone.state}`,
    `Screen/system permission: ${state.permissions.screen}`,
    `Meeting audio: ${state.capture.system.state}`,
    `Speech provider: ${state.provider.stt.name || 'not configured'} (${state.provider.stt.state})`,
    `AI provider: ${state.provider.chat.name || 'not configured'} / ${state.provider.chat.model || 'default'} (${state.provider.chat.ready ? 'ready' : 'not ready'})`
  ];
  if (state.lastFailure) lines.push(`Last failure: ${state.lastFailure.category} / ${state.lastFailure.channel || 'app'} / ${state.lastFailure.message}`);
  return lines.join('\n');
}

module.exports = { createDiagnosticsStore, buildDiagnosticSummary };
```

- [ ] **Step 4: Connect diagnostics in `main.js`**

Create one store after `app.whenReady`, update permissions after checks, update provider readiness from `createLLM`/STT settings, and record categorized capture/STT/LLM failures. Add:

```js
ipcMain.handle('diagnostics:get', async () => {
  const permissions = await getPermissionStatus();
  diagnostics.update({ type: 'permissions', microphone: permissions.mic, screen: permissions.screen });
  return { snapshot: diagnostics.snapshot(), summary: diagnostics.summary() };
});

ipcMain.on('diagnostics:report', (_event, event) => {
  diagnostics.update(event);
  send('diagnostics:changed', diagnostics.snapshot());
});
```

Do not forward arbitrary renderer event fields into logs or the snapshot.

- [ ] **Step 5: Run diagnostics, bridge, and full tests**

Run:

```bash
node --test test/diagnostics.test.js test/preload-contract.test.js
npm test
```

Expected: diagnostics are safe, bridge methods remain allowlisted, and all tests pass.

- [ ] **Step 6: Commit diagnostics state**

```bash
git add src/diagnostics.js main.js preload.js test/diagnostics.test.js test/preload-contract.test.js
git commit -m "feat: expose privacy-safe runtime diagnostics"
```

## Task 8: Render the diagnostics tab

**Files:**

- Modify: `renderer/index.html:107-218`
- Modify: `renderer/renderer.js` settings initialization and capture/STT/LLM handlers
- Modify: `renderer/styles.css:478-560`
- Modify: `test/preload-contract.test.js`

- [ ] **Step 1: Extend the source-level UI contract test**

Add assertions:

```js
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

test('settings includes a diagnostics pane wired to live snapshots', () => {
  assert.match(html, /data-tab="diagnostics"/);
  assert.match(html, /id="diagnostics-grid"/);
  assert.match(html, /id="diagnostics-copy"/);
  assert.match(renderer, /cue\.diagnosticsGet\(\)/);
  assert.match(renderer, /cue\.on\('diagnostics:changed'/);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/preload-contract.test.js
```

Expected: FAIL because the diagnostics pane does not exist.

- [ ] **Step 3: Add compact diagnostics markup**

Add one tab and pane:

```html
<button class="s-tab" data-tab="diagnostics">Health</button>

<div class="s-body s-tab-pane hidden" data-pane="diagnostics">
  <div class="s-note">Live status only. API keys, transcript text, audio, and screenshots are never included.</div>
  <div id="diagnostics-grid" class="diagnostics-grid" aria-live="polite"></div>
  <div id="diagnostics-failure" class="diagnostics-failure hidden"></div>
  <button id="diagnostics-copy" class="s-action">Copy diagnostic summary</button>
  <div id="diagnostics-copy-status" class="s-status"></div>
</div>
```

- [ ] **Step 4: Render fixed rows and copy only the supplied safe summary**

```js
function diagnosticRow(label, value, state) {
  return `<div class="diagnostic-row"><span>${escapeHtml(label)}</span><strong class="diagnostic-state ${escapeHtml(state || '')}">${escapeHtml(value || 'Unknown')}</strong></div>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function renderDiagnostics(snapshot) {
  const grid = document.getElementById('diagnostics-grid');
  if (!grid || !snapshot) return;
  grid.innerHTML = [
    diagnosticRow('Microphone permission', snapshot.permissions.microphone, snapshot.permissions.microphone),
    diagnosticRow('Microphone capture', snapshot.capture.microphone.state, snapshot.capture.microphone.state),
    diagnosticRow('Screen/system permission', snapshot.permissions.screen, snapshot.permissions.screen),
    diagnosticRow('Meeting audio', snapshot.capture.system.state, snapshot.capture.system.state),
    diagnosticRow('Speech provider', snapshot.provider.stt.name || 'Not configured', snapshot.provider.stt.state),
    diagnosticRow('AI provider', snapshot.provider.chat.name || 'Not configured', snapshot.provider.chat.ready ? 'ready' : 'failed')
  ].join('');
}
```

On settings open, call `cue.diagnosticsGet()`, render `result.snapshot`, and retain `result.summary` only for `navigator.clipboard.writeText`. Subscribe to `diagnostics:changed` for live updates.

- [ ] **Step 5: Add restrained diagnostic styles**

```css
.diagnostics-grid { display: flex; flex-direction: column; gap: 6px; }
.diagnostic-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid rgba(255,255,255,.1); border-radius: var(--r-8); background: rgba(0,0,0,.18); }
.diagnostic-row span { color: var(--tx-mut); font-size: 12px; }
.diagnostic-state { color: var(--tx-2); font-size: 11px; font-weight: 600; text-transform: capitalize; }
.diagnostic-state.ready, .diagnostic-state.granted { color: #86efac; }
.diagnostic-state.failed, .diagnostic-state.denied { color: #fca5a5; }
.diagnostic-state.starting, .diagnostic-state.stopping { color: #fcd34d; }
.diagnostics-failure { color: #fca5a5; font-size: 11.5px; line-height: 1.45; padding: 9px 10px; border-radius: var(--r-8); background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.22); }
.diagnostics-failure.hidden { display: none; }
```

- [ ] **Step 6: Run tests and syntax checks**

Run:

```bash
node --test test/preload-contract.test.js test/diagnostics.test.js
node --check renderer/renderer.js
npm test
```

Expected: UI contract, diagnostics, and full suite pass.

- [ ] **Step 7: Commit the diagnostic UI**

```bash
git add renderer/index.html renderer/renderer.js renderer/styles.css test/preload-contract.test.js
git commit -m "feat: add live capture diagnostics"
```

## Task 9: Verify packaged macOS contents and launchability

**Files:**

- Create: `scripts/verify-macos-app.js`
- Create: `test/macos-package.test.js`
- Modify: `package.json`
- Modify: `test/build-config.test.js`
- Modify: `electron-builder.cjs` only if the failing test proves a packaging defect

- [ ] **Step 1: Write failing package contract tests**

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');
const builder = require('../electron-builder.cjs');

test('mac verification command is available', () => {
  assert.equal(pkg.scripts['verify:mac-app'], 'node scripts/verify-macos-app.js');
});

test('packaged allowlist includes reliability modules', () => {
  assert.ok(builder.files.includes('src/**/*'));
  assert.ok(builder.files.includes('renderer/**/*'));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'renderer', 'capture-coordinator.js')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'diagnostics.js')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'request-policy.js')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'transcript-ledger.js')));
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/macos-package.test.js
```

Expected: FAIL because `verify:mac-app` and its script do not exist.

- [ ] **Step 3: Implement the verifier**

Accept the `.app` path as the first argument and fail on any missing condition:

```js
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const appPath = path.resolve(process.argv[2] || 'dist/mac-arm64/cue.app');
const required = [
  'Contents/MacOS/cue',
  'Contents/Info.plist',
  'Contents/Resources/app/renderer/capture-coordinator.js',
  'Contents/Resources/app/src/diagnostics.js',
  'Contents/Resources/app/src/provider-errors.js',
  'Contents/Resources/app/src/request-policy.js',
  'Contents/Resources/app/src/transcript-ledger.js'
];

for (const relative of required) {
  const target = path.join(appPath, relative);
  if (!fs.existsSync(target)) throw new Error(`Missing packaged file: ${relative}`);
}
const executable = path.join(appPath, 'Contents', 'MacOS', 'cue');
const fileOutput = execFileSync('/usr/bin/file', [executable], { encoding: 'utf8' });
if (!/arm64/.test(fileOutput)) throw new Error(`Expected arm64 executable: ${fileOutput.trim()}`);
const bundleId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
if (bundleId !== 'com.cue.overlay') throw new Error(`Unexpected bundle identifier: ${bundleId}`);
console.log(`Verified ${appPath} (${bundleId}, arm64)`);
```

Add:

```json
"verify:mac-app": "node scripts/verify-macos-app.js"
```

- [ ] **Step 4: Run tests, build, and verify the package**

Run:

```bash
node --test test/macos-package.test.js test/build-config.test.js
npm run pack -- --mac --arm64
npm run verify:mac-app -- dist/mac-arm64/cue.app
```

Expected: tests pass, electron-builder exits 0, and verifier prints `Verified ... (com.cue.overlay, arm64)`.

- [ ] **Step 5: Perform noninteractive launch smoke test**

Run:

```bash
open -na "$PWD/dist/mac-arm64/cue.app"
sleep 5
pgrep -afil "$PWD/dist/mac-arm64/cue.app/Contents/MacOS/cue"
```

Expected: one live main process from the exact packaged path. If the permission gate is shown, that counts as a successful launch but not as audio acceptance.

- [ ] **Step 6: Commit package verification**

```bash
git add scripts/verify-macos-app.js test/macos-package.test.js test/build-config.test.js package.json package-lock.json electron-builder.cjs
git commit -m "test: verify Apple Silicon app packaging"
```

Only add `electron-builder.cjs` or `package-lock.json` if their diff is required and reviewed.

## Task 10: Reconcile and expand the documentation

**Files:**

- Modify: `README.md:45-50,75-100,106-145,179-236,245-270`
- Verify: `electron-builder.cjs`
- Verify: `main.js` permission labels and supported macOS version

- [ ] **Step 1: Write the documentation acceptance checklist before editing**

Use these exact assertions during review:

```text
[ ] No section says meeting audio is Windows-only.
[ ] macOS minimum for system-audio loopback matches code and verified package behavior.
[ ] Microphone and Screen & System Audio Recording locations are named.
[ ] One-channel failure and Diagnostics recovery steps are described.
[ ] AI and speech-to-text provider requirements are distinct.
[ ] Personal ad-hoc build and public notarized release are not conflated.
[ ] Automatic answers and continuous screen awareness are explicitly Phase 2.
```

- [ ] **Step 2: Update README against the verified code and package**

Replace the contradictory platform paragraphs with one canonical statement:

```md
### macOS listening support

On macOS 14.4 or later, cue captures your microphone as **You** and meeting/system audio as **Meeting** using ScreenCaptureKit loopback. The channels are independent: if one cannot start, the other continues and the Health tab shows the exact permission or device problem.

Grant cue access in **System Settings → Privacy & Security → Microphone** and **Screen & System Audio Recording**. Permission grants are tied to the exact app signature; replacing an ad-hoc personal build can require granting access again.
```

Add a Health-tab table with `off`, `starting`, `ready`, `failed`, and `stopping`; add recovery steps for denied permission, missing device, ended track, provider authentication, quota, unavailable model, network, and timeout.

Document local versus cloud speech-to-text accurately and state that the Health summary excludes keys, transcript text, audio, and screenshots.

Add a clear boundary:

```md
> Phase 1 is user-started listening with manual answers. Automatic answers and continuous screen-change awareness are planned for Phase 2; this build does not claim those behaviors.
```

- [ ] **Step 3: Run a contradiction and secret-language scan**

Run:

```bash
rg -n "Windows only|Windows-only|meeting audio.*Windows|automatic answers|continuous screen|Screen & System Audio Recording|ad-hoc|notari" README.md
git diff --check
```

Expected: no Windows-only meeting-audio claim remains; Phase 2 wording appears exactly as a limitation; no whitespace errors.

- [ ] **Step 4: Re-run code-derived documentation checks**

Run:

```bash
node --test test/build-config.test.js test/macos-package.test.js test/preload-contract.test.js
npm test
```

Expected: documented scripts, files, and interface names match the code and all tests pass.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain reliable macOS listening and recovery"
```

## Task 11: Final automated and manual acceptance

**Files:**

- Verify: all changed source, tests, docs, and packaged artifact
- Create outside Git: `dist/mac-arm64/cue.app`

- [ ] **Step 1: Inspect the final branch scope**

Run:

```bash
git status --short
git diff origin/main...HEAD --stat
git diff origin/main...HEAD --check
git log --oneline --decorate origin/main..HEAD
```

Expected: only Phase 1 source/tests/docs plus the approved spec and plan; no generated app or API-key files tracked.

- [ ] **Step 2: Run the complete automated gate**

Run:

```bash
for file in main.js preload.js electron-builder.cjs renderer/*.js src/*.js scripts/*.js test/*.js; do node --check "$file"; done
npm test
npm run pack -- --mac --arm64
npm run verify:mac-app -- dist/mac-arm64/cue.app
```

Expected: syntax checks pass, full suite passes, package builds, and app verifier passes.

- [ ] **Step 3: Launch the exact packaged app**

Run:

```bash
open -na "$PWD/dist/mac-arm64/cue.app"
sleep 5
pgrep -afil "$PWD/dist/mac-arm64/cue.app/Contents/MacOS/cue"
```

Expected: packaged cue stays running. Record whether the permissions gate or overlay appears.

- [ ] **Step 4: Complete the user-assisted audio acceptance checklist**

With a meeting or locally playing spoken-audio sample:

```text
[ ] Start listening returns promptly.
[ ] User speech appears under You.
[ ] Computer/meeting speech appears under Meeting.
[ ] Denying or stopping one channel leaves the other working.
[ ] What should I say? produces a transcript-grounded response.
[ ] Stop releases the microphone indicator and system capture.
[ ] Restart works without relaunching cue.
[ ] Health shows permissions, channel states, provider/model, and last failure.
[ ] Copied Health summary contains no API keys, transcript text, audio, or screenshots.
```

Do not mark audio acceptance complete until the user confirms the audible-input checks on the packaged build.

- [ ] **Step 5: Commit any test-first corrections, then push**

For each observed defect, first add a failing regression test, verify RED, implement the minimum fix, verify GREEN, and make a focused commit. When all gates pass:

```bash
git status --short
git push origin codex/phase1-macos-reliability
```

Expected: clean branch pushed to `Milo6x/cue`.

- [ ] **Step 6: Report evidence without overstating readiness**

Report:

```text
Automated: exact test count, syntax result, package verifier result.
Packaged launch: exact app path and running-process evidence.
Manual audio: PASS only for checks actually confirmed on the user's Mac.
Distribution: personal ad-hoc build; not publicly notarized unless credentials were supplied and notarization verified.
Deferred: automatic answers and continuous screen-change awareness remain Phase 2.
```

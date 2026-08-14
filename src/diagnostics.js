const { redactSecrets } = require('./provider-errors');

const CAPTURE_CHANNELS = new Set(['microphone', 'system']);
const CAPTURE_STATES = new Set(['off', 'starting', 'ready', 'failed']);
const PERMISSION_STATES = new Set(['granted', 'denied', 'restricted', 'not-determined', 'unknown']);
const FAILURE_CATEGORIES = new Set(['authentication', 'busy', 'cancelled', 'capture', 'configuration', 'device', 'llm', 'network', 'permission', 'quota', 'service', 'stt', 'timeout', 'unknown', 'unsupported']);
const STT_STATES = new Set(['off', 'starting', 'ready', 'connected', 'transcribing', 'stopping', 'error', 'unavailable']);
const UNSAFE_TEXT_RE = /\b(?:transcript|screenshot|cookie|session(?:id)?|password)\b|data:(?:audio|image)|base64/i;
const SAFE_ID_RE = /^[A-Za-z0-9._:/-]{1,180}$/;
const SAFE_TRACK_LABEL_RE = /^[A-Za-z0-9 ._()\-]{1,120}$/;

function readOwn(value, key) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    return value[key];
  } catch (_) {
    return undefined;
  }
}

function safeId(value) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) return null;
  return redactSecrets(value) === value ? value : null;
}

function safeMessage(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || UNSAFE_TEXT_RE.test(raw)) return null;
  const redacted = redactSecrets(raw)
    .replace(/\bBearer\s+\[redacted\]/gi, '[redacted credential]')
    .replace(/\b(?:authorization|api[-_]?key|x-(?:goog-)?api-key)\b\s*[:=]\s*(?:\[redacted\]|[^;,\r\n]*)/gi, '[redacted credential]');
  return redacted.slice(0, 320) || null;
}

function safeTrackLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  return SAFE_TRACK_LABEL_RE.test(label) && !UNSAFE_TEXT_RE.test(label) ? label : null;
}

function cloneSnapshot(state) {
  return {
    app: { ...state.app },
    permissions: { ...state.permissions },
    capture: {
      microphone: { ...state.capture.microphone },
      system: { ...state.capture.system }
    },
    chat: { ...state.chat },
    stt: { ...state.stt },
    lastFailure: state.lastFailure ? { ...state.lastFailure } : null
  };
}

function createDiagnosticsStore({ appVersion, platform, arch, onChange } = {}) {
  const state = {
    app: {
      version: safeId(String(appVersion || 'unknown')) || 'unknown',
      platform: safeId(String(platform || process.platform)) || 'unknown',
      arch: safeId(String(arch || process.arch)) || 'unknown'
    },
    permissions: { microphone: 'unknown', screen: 'unknown' },
    capture: {
      microphone: { state: 'off', category: null, message: null, trackLabel: null },
      system: { state: 'off', category: null, message: null, trackLabel: null }
    },
    chat: { provider: null, model: null, ready: false },
    stt: { provider: null, state: 'off' },
    lastFailure: null
  };

  function emit() {
    if (typeof onChange !== 'function') return;
    try { onChange(cloneSnapshot(state)); } catch (_) {}
  }

  function updatePermissions(value) {
    const mic = readOwn(value, 'mic');
    const screen = readOwn(value, 'screen');
    state.permissions.microphone = PERMISSION_STATES.has(mic) ? mic : 'unknown';
    state.permissions.screen = PERMISSION_STATES.has(screen) ? screen : 'unknown';
    emit();
  }

  function updateProviders(value) {
    const chat = readOwn(value, 'chat');
    const stt = readOwn(value, 'stt');
    const chatProvider = safeId(readOwn(chat, 'provider'));
    const chatModel = safeId(readOwn(chat, 'model'));
    const sttProvider = safeId(readOwn(stt, 'provider'));
    const sttState = readOwn(stt, 'state');
    state.chat.provider = chatProvider;
    state.chat.model = chatModel;
    state.chat.ready = readOwn(chat, 'ready') === true;
    state.stt.provider = sttProvider;
    state.stt.state = STT_STATES.has(sttState) ? sttState : 'off';
    emit();
  }

  function updateCapture(channel, value) {
    if (!CAPTURE_CHANNELS.has(channel)) return false;
    const target = state.capture[channel];
    const captureState = readOwn(value, 'state');
    const category = readOwn(value, 'category');
    const message = safeMessage(readOwn(value, 'message'));
    const trackLabel = safeTrackLabel(readOwn(value, 'trackLabel'));
    if (CAPTURE_STATES.has(captureState)) target.state = captureState;
    if (FAILURE_CATEGORIES.has(category)) target.category = category;
    if (message !== null) target.message = message;
    if (trackLabel !== null) target.trackLabel = trackLabel;
    if (captureState === 'off' || captureState === 'ready') {
      target.category = null;
      target.message = null;
    }
    emit();
    return true;
  }

  function recordFailure(category, message) {
    const safeCategory = FAILURE_CATEGORIES.has(category) ? category : 'unknown';
    const safe = safeMessage(message) || 'An operation failed. Check diagnostics state and try again.';
    state.lastFailure = { category: safeCategory, message: safe, at: new Date().toISOString() };
    emit();
  }

  function report(event) {
    const type = readOwn(event, 'type');
    if (type === 'capture') {
      const snapshot = readOwn(event, 'snapshot');
      if (snapshot && typeof snapshot === 'object') {
        // This deliberately selects only the fixed coordinator fields instead
        // of copying or recursively serializing a renderer-owned snapshot.
        for (const channel of CAPTURE_CHANNELS) {
          const source = readOwn(snapshot, channel);
          if (!source || typeof source !== 'object') continue;
          updateCapture(channel, {
            state: readOwn(source, 'state'),
            category: readOwn(source, 'errorCategory'),
            message: readOwn(source, 'errorMessage'),
            trackLabel: readOwn(source, 'trackLabel')
          });
        }
        return true;
      }
      const channel = readOwn(event, 'channel');
      return updateCapture(channel, event);
    }
    if (type === 'capture-channel-ended') {
      const channel = readOwn(event, 'channel');
      const category = readOwn(event, 'category');
      const message = readOwn(event, 'message');
      const updated = updateCapture(channel, { state: 'failed', category, message });
      if (updated) recordFailure(category, message);
      return updated;
    }
    if (type === 'failure') {
      recordFailure(readOwn(event, 'category'), readOwn(event, 'message'));
      return true;
    }
    return false;
  }

  function summary() {
    return `cue ${state.app.version} · ${state.app.platform}/${state.app.arch} · Microphone: ${state.capture.microphone.state} · System capture: ${state.capture.system.state} · Microphone permission: ${state.permissions.microphone} · Screen permission: ${state.permissions.screen} · Chat: ${state.chat.ready ? 'ready' : 'not ready'} · Transcription: ${state.stt.state}`;
  }

  return {
    snapshot: () => cloneSnapshot(state),
    read: () => ({ snapshot: cloneSnapshot(state), summary: summary() }),
    updatePermissions,
    updateProviders,
    updateCapture,
    recordFailure,
    report
  };
}

module.exports = { createDiagnosticsStore };

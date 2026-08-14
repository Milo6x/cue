// Bounds a streamed answer without letting a stalled provider wedge cue's UI.

const { ProviderRequestError } = require('./provider-errors');

const DEFAULT_INACTIVITY_MS = 25_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(makeCancelledError());
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      done(makeCancelledError());
    };
    function done(error) {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.floor(number));
}

function makeCancelledError() {
  const error = new Error('Request was cancelled.');
  error.name = 'AbortError';
  error.code = 'CUE_REQUEST_CANCELLED';
  error.category = 'cancelled';
  error.retryable = false;
  return error;
}

function makeTimeoutError() {
  const error = new Error('The model stopped responding. Try again.');
  error.code = 'CUE_STREAM_TIMEOUT';
  error.category = 'timeout';
  error.retryable = true;
  return error;
}

function shouldRetry(error, attempt, maxAttempts, emitted, externallyAborted) {
  const finalCategories = new Set(['cancelled', 'authentication', 'permission', 'quota', 'model', 'configuration']);
  const retryablePolicyTimeout = error && error.code === 'CUE_STREAM_TIMEOUT';
  const retryableProviderFailure = error instanceof ProviderRequestError && error.retryable === true;
  return attempt < maxAttempts
    && !emitted
    && !externallyAborted
    && (retryablePolicyTimeout || retryableProviderFailure)
    && !finalCategories.has(error.category);
}

function waitForRetry(sleep, delayMs, signal) {
  if (!signal) return Promise.resolve().then(() => sleep(delayMs));
  if (signal.aborted) return Promise.reject(makeCancelledError());
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(makeCancelledError());
  signal.addEventListener('abort', onAbort, { once: true });
  return Promise.race([
    Promise.resolve().then(() => sleep(delayMs, signal)),
    aborted
  ]).finally(() => signal.removeEventListener('abort', onAbort));
}

async function runStreamWithPolicy(options = {}) {
  const {
    operation,
    onToken,
    inactivityMs = DEFAULT_INACTIVITY_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    sleep = defaultSleep,
    signal: externalSignal
  } = options || {};
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  if (typeof onToken !== 'function') throw new TypeError('onToken must be a function');
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');

  const timeoutMs = normalizePositiveInteger(inactivityMs, DEFAULT_INACTIVITY_MS);
  const attempts = Math.min(DEFAULT_MAX_ATTEMPTS, normalizePositiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS));
  const retryDelay = Math.max(0, Number.isFinite(Number(retryDelayMs)) ? Number(retryDelayMs) : DEFAULT_RETRY_DELAY_MS);

  if (externalSignal && externalSignal.aborted) throw makeCancelledError();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (externalSignal && externalSignal.aborted) throw makeCancelledError();
    const controller = new AbortController();
    let active = true;
    let emitted = false;
    let timer = null;
    let rejectTimeout;
    let rejectExternalAbort;
    const externalAbort = new Promise((_, reject) => { rejectExternalAbort = reject; });
    const onExternalAbort = () => {
      if (!active) return;
      active = false;
      controller.abort();
      rejectExternalAbort(makeCancelledError());
    };
    if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort, { once: true });

    const clearAttemptTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
    const rearm = () => {
      if (!active) return;
      clearAttemptTimer();
      timer = setTimeout(() => {
        if (!active) return;
        active = false;
        controller.abort();
        rejectTimeout(makeTimeoutError());
      }, timeoutMs);
    };
    rearm();
    const wrappedToken = token => {
      if (!active || controller.signal.aborted) return;
      emitted = true;
      rearm();
      onToken(token);
    };

    let failure = null;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation({ onToken: wrappedToken, signal: controller.signal, attempt })),
        timeout,
        externalAbort
      ]);
    } catch (error) {
      failure = error;
    } finally {
      active = false;
      clearAttemptTimer();
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      controller.abort();
    }
    if (!shouldRetry(failure, attempt, attempts, emitted, !!(externalSignal && externalSignal.aborted))) throw failure;
    await waitForRetry(sleep, retryDelay * attempt, externalSignal);
  }
}

module.exports = { runStreamWithPolicy, defaultSleep };

const assert = require('node:assert/strict');
const test = require('node:test');

const { runStreamWithPolicy } = require('../src/request-policy');
const { ProviderRequestError } = require('../src/provider-errors');

function retryableError(message = 'temporary failure') {
  const error = new Error(message);
  error.code = 'ECONNRESET';
  return ProviderRequestError.from(error, { provider: 'openai' });
}

function finalError(category) {
  const error = new Error(category + ' failure');
  error.category = category;
  error.retryable = false;
  return error;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('retries one temporary pre-token failure exactly once', async () => {
  let attempts = 0;
  const tokens = [];
  const delays = [];

  const result = await runStreamWithPolicy({
    operation: async ({ onToken, attempt }) => {
      attempts += 1;
      if (attempt === 1) throw retryableError();
      onToken('answer');
      return 'answer';
    },
    onToken: token => tokens.push(token),
    sleep: async ms => delays.push(ms)
  });

  assert.equal(result, 'answer');
  assert.equal(attempts, 2);
  assert.deepEqual(tokens, ['answer']);
  assert.deepEqual(delays, [250]);
});

test('does not retry a failure after a token', async () => {
  let attempts = 0;
  await assert.rejects(() => runStreamWithPolicy({
    operation: async ({ onToken }) => {
      attempts += 1;
      onToken('partial');
      throw retryableError();
    },
    onToken: () => {},
    sleep: async () => assert.fail('must not sleep')
  }), error => error.category === 'network');
  assert.equal(attempts, 1);
});

test('does not retry a plain error that merely claims to be retryable', async () => {
  let attempts = 0;
  const error = new Error('not a classified provider error');
  error.category = 'network';
  error.retryable = true;
  await assert.rejects(() => runStreamWithPolicy({
    operation: async () => { attempts += 1; throw error; },
    onToken: () => {},
    sleep: async () => assert.fail('must not sleep')
  }), returned => returned === error);
  assert.equal(attempts, 1);
});

test('clamps configured attempts to one retry total', async () => {
  let attempts = 0;
  await assert.rejects(() => runStreamWithPolicy({
    operation: async () => { attempts += 1; throw retryableError(); },
    onToken: () => {},
    maxAttempts: 99,
    sleep: async () => {}
  }), error => error instanceof ProviderRequestError && error.category === 'network');
  assert.equal(attempts, 2);
});

for (const category of ['authentication', 'permission', 'quota', 'model', 'configuration']) {
  test(`does not retry ${category} errors`, async () => {
    let attempts = 0;
    await assert.rejects(() => runStreamWithPolicy({
      operation: async () => { attempts += 1; throw finalError(category); },
      onToken: () => {}
    }), error => error.category === category);
    assert.equal(attempts, 1);
  });
}

test('silent operation times out once and aborts its signal', async () => {
  let receivedSignal;
  await assert.rejects(() => runStreamWithPolicy({
    operation: ({ signal }) => { receivedSignal = signal; return new Promise(() => {}); },
    onToken: () => {},
    inactivityMs: 10,
    maxAttempts: 1
  }), error => error.code === 'CUE_STREAM_TIMEOUT' && error.category === 'timeout' && error.retryable === true);
  assert.equal(receivedSignal.aborted, true);
});

test('silent operation retries only up to maxAttempts', async () => {
  let attempts = 0;
  const signals = [];
  await assert.rejects(() => runStreamWithPolicy({
    operation: ({ signal }) => {
      attempts += 1;
      signals.push(signal);
      return new Promise(() => {});
    },
    onToken: () => {},
    inactivityMs: 10,
    maxAttempts: 2,
    sleep: async () => {}
  }), error => error.code === 'CUE_STREAM_TIMEOUT');
  assert.equal(attempts, 2);
  assert.deepEqual(signals.map(signal => signal.aborted), [true, true]);
});

test('ignores a late token after timeout', async () => {
  let emit;
  const tokens = [];
  await assert.rejects(() => runStreamWithPolicy({
    operation: ({ onToken }) => {
      emit = onToken;
      return new Promise(() => {});
    },
    onToken: token => tokens.push(token),
    inactivityMs: 10,
    maxAttempts: 1
  }), error => error.category === 'timeout');
  emit('late');
  assert.deepEqual(tokens, []);
});

test('rearms the inactivity deadline after each token', async () => {
  const done = deferred();
  const tokens = [];
  const result = await runStreamWithPolicy({
    operation: ({ onToken }) => {
      setTimeout(() => onToken('a'), 8);
      setTimeout(() => onToken('b'), 16);
      setTimeout(() => done.resolve('ab'), 24);
      return done.promise;
    },
    onToken: token => tokens.push(token),
    inactivityMs: 12,
    maxAttempts: 1
  });
  assert.equal(result, 'ab');
  assert.deepEqual(tokens, ['a', 'b']);
});

test('external pre-abort is cancelled without starting an operation', async () => {
  const controller = new AbortController();
  controller.abort();
  let started = false;
  await assert.rejects(() => runStreamWithPolicy({
    operation: async () => { started = true; },
    onToken: () => {},
    signal: controller.signal
  }), error => error.category === 'cancelled' && error.retryable === false);
  assert.equal(started, false);
});

test('external mid-flight abort cancels the policy and underlying signal', async () => {
  const controller = new AbortController();
  const started = deferred();
  let receivedSignal;
  const pending = runStreamWithPolicy({
    operation: ({ signal }) => {
      receivedSignal = signal;
      started.resolve();
      return new Promise(() => {});
    },
    onToken: () => {},
    signal: controller.signal,
    inactivityMs: 1000
  });
  await started.promise;
  controller.abort();
  await assert.rejects(() => pending, error => error.category === 'cancelled' && error.retryable === false);
  assert.equal(receivedSignal.aborted, true);
});

test('cancellation during retry backoff prevents a second operation', async () => {
  const controller = new AbortController();
  const sleepStarted = deferred();
  let attempts = 0;
  const pending = runStreamWithPolicy({
    operation: async () => {
      attempts += 1;
      throw retryableError();
    },
    onToken: () => {},
    signal: controller.signal,
    sleep: () => {
      sleepStarted.resolve();
      return new Promise(resolve => { sleepStarted.release = resolve; });
    }
  });
  await sleepStarted.promise;
  controller.abort();
  sleepStarted.release();
  await assert.rejects(() => pending, error => error.category === 'cancelled' && error.retryable === false);
  assert.equal(attempts, 1);
});

test('onToken failure cleans up without retrying', async () => {
  let attempts = 0;
  await assert.rejects(() => runStreamWithPolicy({
    operation: async ({ onToken }) => {
      attempts += 1;
      onToken('answer');
      return 'answer';
    },
    onToken: () => { throw new Error('renderer failed'); }
  }), /renderer failed/);
  assert.equal(attempts, 1);
});

test('concurrent calls keep their attempt state independent', async () => {
  const first = runStreamWithPolicy({ operation: async ({ onToken }) => { onToken('one'); return 'one'; }, onToken: () => {} });
  const second = runStreamWithPolicy({ operation: async ({ onToken }) => { onToken('two'); return 'two'; }, onToken: () => {} });
  assert.deepEqual(await Promise.all([first, second]), ['one', 'two']);
});

test('normalizes invalid attempt and timeout values safely', async () => {
  let attempts = 0;
  await assert.rejects(() => runStreamWithPolicy({
    operation: async () => { attempts += 1; throw retryableError(); },
    onToken: () => {},
    maxAttempts: 0,
    inactivityMs: 0
  }), error => error.category === 'network');
  assert.equal(attempts, 1);
});

test('validates the required callbacks', async () => {
  await assert.rejects(() => runStreamWithPolicy({ onToken: () => {} }), /operation must be a function/);
  await assert.rejects(() => runStreamWithPolicy({ operation: async () => {} }), /onToken must be a function/);
});

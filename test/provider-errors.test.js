const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyProviderError,
  ProviderRequestError,
  redactSecrets,
  isQuotaError,
  formatProviderErrorMessage
} = require('../src/provider-errors');

test('classifies rejected credentials and redacts an OpenAI key', () => {
  const source = new Error('401 invalid api key sk-secret-value');
  const classified = classifyProviderError(source, { provider: 'openai', model: 'gpt-4o-mini' });
  const wrapped = ProviderRequestError.from(source, { provider: 'openai', model: 'gpt-4o-mini' });

  assert.equal(classified.category, 'authentication');
  assert.equal(classified.retryable, false);
  assert.deepEqual(Object.keys(classified).sort(), ['category', 'message', 'model', 'provider', 'retryable', 'status']);
  assert.equal(classified.provider, 'openai');
  assert.equal(classified.model, 'gpt-4o-mini');
  assert.doesNotMatch(classified.message, /sk-secret-value/);
  assert.equal(wrapped.name, 'ProviderRequestError');
  assert.equal(wrapped.category, 'authentication');
  assert.equal(wrapped.retryable, false);
  assert.equal(wrapped.status, 401);
  assert.notEqual(wrapped.cause, source);
  assert.doesNotMatch(wrapped.cause.message, /sk-secret-value/);
  assert.doesNotMatch(JSON.stringify(wrapped.cause), /sk-secret-value/);
  assert.doesNotMatch(wrapped.message, /sk-secret-value/);
  assert.match(wrapped.message, /credentials were rejected/i);
});

test('classifies 403 permission failures before generic text fallbacks', () => {
  const error = Object.assign(new Error('Forbidden for this model'), { status: 403 });
  const classified = classifyProviderError(error, { provider: 'anthropic', model: 'claude-test' });

  assert.equal(classified.category, 'permission');
  assert.equal(classified.retryable, false);
  assert.match(formatProviderErrorMessage(error, 'anthropic', 'claude-test'), /permissions.*selected model/i);
});

test('uses an explicit HTTP status before conflicting provider text', () => {
  const cases = [
    [503, 'quota exhausted', 'service', true],
    [403, 'invalid api key', 'permission', false],
    [404, 'quota exhausted', 'model', false],
    [429, 'model missing', 'quota', false],
    [401, 'forbidden', 'authentication', false],
    [408, 'model missing', 'service', true]
  ];

  for (const [status, message, category, retryable] of cases) {
    const classified = classifyProviderError(Object.assign(new Error(message), { status }));
    assert.equal(classified.category, category, `${status} ${message}`);
    assert.equal(classified.retryable, retryable, `${status} ${message}`);
  }
});

test('recognizes quota shapes, preserves retry delay, and does not mark quota retryable', () => {
  const error = Object.assign(new Error('RESOURCE_EXHAUSTED {"retryDelay":"38s"}'), { code: 'RESOURCE_EXHAUSTED' });
  const classified = classifyProviderError(error, { provider: 'gemini' });

  assert.equal(classified.category, 'quota');
  assert.equal(classified.retryable, false);
  assert.equal(isQuotaError(error), true);
  assert.match(formatProviderErrorMessage(error, 'gemini'), /free-tier quota exhausted \(429 Too Many Requests\)\. Wait about 38s/);
  assert.equal(classifyProviderError(new Error('rate_limit_exceeded')).category, 'quota');
  assert.equal(classifyProviderError(Object.assign(new Error('nope'), { status: 429 })).category, 'quota');
});

test('turns a 404 model failure into a safe actionable message', () => {
  const error = Object.assign(new Error('exception parsing response {"api_key":"not-for-display"}'), { status: 404 });
  const wrapped = ProviderRequestError.from(error, { provider: 'gemini', model: 'gemini-2.0-flash' });

  assert.equal(wrapped.category, 'model');
  assert.equal(wrapped.retryable, false);
  assert.match(wrapped.message, /model "gemini-2\.0-flash" is unavailable \(404\)/);
  assert.match(wrapped.message, /Settings/);
  assert.doesNotMatch(wrapped.message, /exception parsing response|not-for-display/);
});

test('marks service, network, and explicit policy timeouts retryable', () => {
  assert.deepEqual(
    classifyProviderError(Object.assign(new Error('upstream failure'), { status: 503 })).category,
    'service'
  );
  assert.equal(classifyProviderError(Object.assign(new Error('upstream failure'), { status: 503 })).retryable, true);
  assert.equal(classifyProviderError(new Error('socket hang up')).category, 'network');
  assert.equal(classifyProviderError(new Error('socket hang up')).retryable, true);
  assert.equal(classifyProviderError(new Error('Network Error')).category, 'network');
  assert.equal(classifyProviderError(new Error('network connection failed')).category, 'network');
  const timeout = classifyProviderError(Object.assign(new Error('policy threshold'), { category: 'timeout' }));
  assert.equal(timeout.category, 'timeout');
  assert.equal(timeout.retryable, true);
});

test('keeps AbortError cancellation out of automatic retry', () => {
  for (const error of [
    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    Object.assign(new Error('request stopped'), { code: 'ABORT_ERR' })
  ]) {
    const classified = classifyProviderError(error, { provider: 'openai' });
    assert.equal(classified.category, 'cancelled');
    assert.equal(classified.retryable, false);
    assert.equal(classified.message, 'Request was cancelled.');
  }
  const policyTimeout = classifyProviderError(Object.assign(new Error('Request timed out.'), { name: 'AbortError', category: 'timeout' }));
  assert.equal(policyTimeout.category, 'timeout');
  assert.equal(policyTimeout.retryable, true);
});

test('classifies installed OpenAI and Anthropic APIUserAbortError shapes as cancelled', () => {
  const OpenAI = require('openai');
  const Anthropic = require('@anthropic-ai/sdk');
  for (const [provider, error] of [
    ['openai', new OpenAI.APIUserAbortError()],
    ['azure', new OpenAI.APIUserAbortError()],
    ['anthropic', new Anthropic.APIUserAbortError()]
  ]) {
    assert.equal(error.name, 'Error');
    assert.equal(error.message, 'Request was aborted.');
    const classified = classifyProviderError(error, { provider });
    assert.equal(classified.category, 'cancelled');
    assert.equal(classified.retryable, false);
    assert.equal(classified.message, 'Request was cancelled.');
  }
  const ordinaryError = classifyProviderError(new Error('Request was aborted.'), { provider: 'openai' });
  assert.equal(ordinaryError.category, 'unknown');
  assert.equal(ordinaryError.retryable, false);
});

test('infers transient transport failures when no explicit HTTP status exists', () => {
  const cases = [
    [new Error('got status: 503 Service Unavailable'), 'service', true],
    [Object.assign(new Error('upstream failed'), { code: 503 }), 'service', true],
    [new Error('got status: 408 Request Timeout'), 'service', true],
    [Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }), 'timeout', true],
    [new Error('request timed out'), 'timeout', true],
    [Object.assign(new Error('socket failed'), { code: 'ETIMEDOUT' }), 'timeout', true]
  ];

  for (const [error, category, retryable] of cases) {
    const classified = classifyProviderError(error);
    assert.equal(classified.category, category, error.message);
    assert.equal(classified.retryable, retryable, error.message);
  }
});

test('maps provider status codes without a numeric HTTP status', () => {
  const cases = [
    ['UNAUTHENTICATED', 'authentication', false],
    ['permission_denied', 'permission', false],
    ['NOT_FOUND', 'model', false],
    ['DEADLINE_EXCEEDED', 'timeout', true],
    ['unavailable', 'service', true],
    ['RESOURCE_EXHAUSTED', 'quota', false]
  ];

  for (const [code, category, retryable] of cases) {
    const classified = classifyProviderError(Object.assign(new Error('provider code'), { code }));
    assert.equal(classified.category, category, code);
    assert.equal(classified.retryable, retryable, code);
  }
});

test('keeps unknown errors non-retryable and redacts secrets without hiding useful text', () => {
  const message = 'Unexpected response. Authorization: Bearer bearer-secret-value; api_key=api-secret-value; model gemini-2.5-flash';
  const wrapped = ProviderRequestError.from(new Error(message), { provider: 'gemini' });

  assert.equal(wrapped.category, 'unknown');
  assert.equal(wrapped.retryable, false);
  assert.match(wrapped.message, /Unexpected response/);
  assert.match(wrapped.message, /gemini-2\.5-flash/);
  assert.doesNotMatch(wrapped.message, /bearer-secret-value|api-secret-value/);
  assert.doesNotMatch(redactSecrets('Bearer xyz-secret-token'), /xyz-secret-token/);
  assert.doesNotMatch(redactSecrets('AIzaSyA-secret-value'), /AIzaSyA-secret-value/);
  assert.doesNotMatch(redactSecrets('{"Authorization":"top-secret-value","api-key":"header-key-value"}'), /top-secret-value|header-key-value/);
  assert.doesNotMatch(redactSecrets("{'Authorization':'single-secret-value','api_key':'json-key-value'}"), /single-secret-value|json-key-value/);
  assert.doesNotMatch(redactSecrets('Authorization: Basic dXNlcjpwYXNz'), /Basic|dXNlcjpwYXNz/);
  const lineDelimitedHeader = redactSecrets('authorization: Token abc def\nUseful surrounding text');
  assert.doesNotMatch(lineDelimitedHeader, /Token|abc|def/);
  assert.match(lineDelimitedHeader, /Useful surrounding text/);
  const assignmentHeader = redactSecrets('Authorization = Token opaque secret value; next=safe');
  assert.doesNotMatch(assignmentHeader, /Token|opaque|secret|value/);
  assert.match(assignmentHeader, /next=safe/);
  assert.doesNotMatch(redactSecrets('authorization = Basic lower-case secret'), /Basic|lower-case|secret/);
  const commaDelimitedKey = redactSecrets('api_key=secret, model=gpt-4o-mini');
  assert.doesNotMatch(commaDelimitedKey, /secret/);
  assert.match(commaDelimitedKey, /model=gpt-4o-mini/);
  assert.doesNotMatch(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature-value'), /eyJhbGciOiJIUzI1NiJ9/);
});

test('redacts named provider API keys in messages and sanitized causes', () => {
  const credentials = '"x-api-key":"x secret value"; x-goog-api-key=goog secret value; OPENAI_API_KEY: openai secret value; ANTHROPIC_API_KEY = anthropic secret value; GEMINI_API_KEY=gemini secret value; vendor_api_key: vendor secret value; next=safe';
  const redacted = redactSecrets(credentials);
  const wrapped = ProviderRequestError.from(new Error(credentials), { provider: 'openai' });

  assert.doesNotMatch(redacted, /x secret|goog secret|openai secret|anthropic secret|gemini secret|vendor secret/);
  assert.match(redacted, /next=safe/);
  assert.doesNotMatch(wrapped.message, /x secret|goog secret|openai secret|anthropic secret|gemini secret|vendor secret/);
  assert.doesNotMatch(wrapped.cause.message, /x secret|goog secret|openai secret|anthropic secret|gemini secret|vendor secret/);
});

test('bounds huge provider text before safe classification output', () => {
  const huge = `useful prefix ${'x'.repeat(10_000)} sk-huge-secret-value`;
  const error = Object.assign(new Error(huge), { response: { data: { body: huge } } });
  const classified = classifyProviderError(error);

  assert.equal(classified.category, 'unknown');
  assert.match(classified.message, /useful prefix/);
  assert.ok(classified.message.length <= 8_192);
  assert.doesNotMatch(classified.message, /sk-huge-secret-value/);
});

test('selectively serializes known bounded provider body fields', () => {
  const responseBody = new Proxy({
    details: [{ retryDelay: '38s', message: `useful prefix ${'x'.repeat(9_000_000)}` }],
    unknown: 'must not be read'
  }, {
    get(target, property) {
      if (property === 'unknown') throw new Error('unknown bulk field was read');
      return target[property];
    }
  });
  const error = Object.assign(new Error('RESOURCE_EXHAUSTED'), {
    code: 'RESOURCE_EXHAUSTED',
    response: { data: responseBody }
  });
  const classified = classifyProviderError(error, { provider: 'gemini' });

  assert.equal(classified.category, 'quota');
  assert.ok(classified.message.length <= 8_192);
  assert.match(classified.message, /Wait about 38s/);
});

test('sanitizes the cause without copying a provider request or response', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature-value';
  const source = Object.assign(new Error(`Network Error Authorization: Bearer bearer-secret ${jwt} sk-secret-value`), {
    code: 'ECONNRESET',
    response: { data: { api_key: 'response-secret-value' } },
    request: { headers: { Authorization: 'request-secret-value' } }
  });
  const wrapped = ProviderRequestError.from(source, { provider: 'openai' });

  assert.equal(wrapped.category, 'network');
  assert.equal(wrapped.cause.code, 'ECONNRESET');
  assert.doesNotMatch(wrapped.cause.message, /bearer-secret|sk-secret-value|eyJhbGci/);
  assert.doesNotMatch(JSON.stringify(wrapped.cause), /response-secret-value|request-secret-value|bearer-secret|sk-secret-value|eyJhbGci/);
  assert.equal(wrapped.cause.request, undefined);
  assert.equal(wrapped.cause.response, undefined);
});

test('preserves an existing ProviderRequestError instead of double-wrapping it', () => {
  const original = ProviderRequestError.from(new Error('fetch failed'), { provider: 'openai', model: 'gpt-4o-mini' });
  assert.equal(ProviderRequestError.from(original, { provider: 'gemini' }), original);
});

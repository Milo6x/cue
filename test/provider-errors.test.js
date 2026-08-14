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

test('marks service, network, and timeout errors retryable', () => {
  assert.deepEqual(
    classifyProviderError(Object.assign(new Error('upstream failure'), { status: 503 })).category,
    'service'
  );
  assert.equal(classifyProviderError(Object.assign(new Error('upstream failure'), { status: 503 })).retryable, true);
  assert.equal(classifyProviderError(new Error('socket hang up')).category, 'network');
  assert.equal(classifyProviderError(new Error('socket hang up')).retryable, true);
  assert.equal(classifyProviderError(new Error('Network Error')).category, 'network');
  assert.equal(classifyProviderError(new Error('network connection failed')).category, 'network');
  assert.equal(classifyProviderError(new Error('request timed out')).category, 'timeout');
  assert.equal(classifyProviderError(new Error('request timed out')).retryable, true);
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
  assert.doesNotMatch(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature-value'), /eyJhbGciOiJIUzI1NiJ9/);
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

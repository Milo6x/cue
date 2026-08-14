const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { OPTIONAL_API_KEY_PLACEHOLDER } = require('../src/openai-compatible');

let capturedClientOptions = null;
let capturedCompletionRequest = null;
let capturedCompletionOptions = null;
let capturedCompletionRequests = null;
let capturedAnthropicRequestOptions = null;
let capturedGeminiRequest = null;
let openAICompletionErrors = null;
let openAICompletionStream = null;
const originalModuleLoad = Module._load;

Module._load = function loadWithOpenAIStub(request, parent, isMain) {
  if (request === 'openai') {
    return class FakeOpenAI {
      constructor(clientOptions) {
        capturedClientOptions = clientOptions;
        this.chat = {
          completions: {
            create: async (completionRequest, completionOptions) => {
              capturedCompletionRequest = completionRequest;
              capturedCompletionOptions = completionOptions;
              capturedCompletionRequests.push({ completionRequest, completionOptions });
              if (openAICompletionErrors.length) throw openAICompletionErrors.shift();
              if (openAICompletionStream) return openAICompletionStream;
              return [{ choices: [{ delta: { content: 'ok' } }] }];
            }
          }
        };
      }
    };
  }
  if (request === '@anthropic-ai/sdk') {
    return class FakeAnthropic {
      constructor() {
        this.messages = {
          create: async (_request, requestOptions) => {
            capturedAnthropicRequestOptions = requestOptions;
            return [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }];
          }
        };
      }
    };
  }
  if (request === '@google/genai') {
    return {
      GoogleGenAI: class FakeGoogleGenAI {
        constructor() {
          this.models = {
            generateContentStream: async requestOptions => {
              capturedGeminiRequest = requestOptions;
              return (async function* () { yield { text: 'ok' }; })();
            }
          };
        }
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const {
  createLLM,
  completionTokenLimitParameter,
  consumeGeminiStream,
  formatProviderErrorMessage,
  isQuotaError,
  CURRENT_GEMINI_DEFAULT
} = require('../src/llm');
const { ProviderRequestError } = require('../src/provider-errors');

test.after(() => {
  Module._load = originalModuleLoad;
});

function createCustomSettings(overrides = {}) {
  return {
    provider: 'custom',
    smart: false,
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { custom: 'gateway-token' },
    models: { custom: { fast: 'openclaw/default', smart: 'openclaw/default' } },
    ...overrides
  };
}

test.beforeEach(() => {
  capturedClientOptions = null;
  capturedCompletionRequest = null;
  capturedCompletionOptions = null;
  capturedCompletionRequests = [];
  capturedAnthropicRequestOptions = null;
  capturedGeminiRequest = null;
  openAICompletionErrors = [];
  openAICompletionStream = null;
});

test('routes the Custom provider through the configured OpenAI-compatible endpoint', async () => {
  const receivedTokens = [];
  const llm = createLLM(createCustomSettings());

  assert.equal(llm.ready, true);
  assert.equal(llm.model, 'openclaw/default');

  const response = await llm.stream({
    system: 'Be concise.',
    turns: [{ role: 'user', text: 'Hello' }],
    onToken: (token) => receivedTokens.push(token)
  });

  assert.deepEqual(capturedClientOptions, {
    apiKey: 'gateway-token',
    baseURL: 'http://127.0.0.1:18789/v1'
  });
  assert.equal(capturedCompletionRequest.model, 'openclaw/default');
  assert.equal(capturedCompletionRequest.max_tokens, 700);
  assert.equal('max_completion_tokens' in capturedCompletionRequest, false);
  assert.equal(response, 'ok');
  assert.deepEqual(receivedTokens, ['ok']);
});

test('forwards AbortSignal to OpenAI-compatible transports and suppresses aborted tokens', async () => {
  const controller = new AbortController();
  controller.abort();
  const receivedTokens = [];
  const llm = createLLM(createCustomSettings());

  await llm.stream({
    system: '',
    turns: [{ role: 'user', text: 'Hello' }],
    onToken: token => receivedTokens.push(token),
    signal: controller.signal
  });

  assert.equal(capturedCompletionOptions.signal, controller.signal);
  assert.deepEqual(receivedTokens, []);
});

test('Gemini stream cancellation closes its iterator without emitting a late token', async () => {
  const controller = new AbortController();
  controller.abort();
  let returned = 0;
  const iterator = {
    async next() { return { done: false, value: { text: 'late' } }; },
    async return() { returned += 1; return { done: true }; },
    [Symbol.asyncIterator]() { return this; }
  };
  const receivedTokens = [];

  await assert.rejects(
    () => consumeGeminiStream(iterator, token => receivedTokens.push(token), controller.signal),
    error => error.category === 'cancelled' && error.retryable === false
  );
  assert.equal(returned, 1);
  assert.deepEqual(receivedTokens, []);
});

test('Gemini cancellation closes a hanging next call promptly', async () => {
  const controller = new AbortController();
  let returned = 0;
  const iterator = {
    next() { return new Promise(() => {}); },
    async return() { returned += 1; return { done: true }; },
    [Symbol.asyncIterator]() { return this; }
  };
  const receivedTokens = [];
  const pending = consumeGeminiStream(iterator, token => receivedTokens.push(token), controller.signal);
  controller.abort();

  await assert.rejects(
    () => Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini cancellation did not settle promptly')), 30))
    ]),
    error => error.category === 'cancelled' && error.retryable === false
  );
  assert.equal(returned, 1);
  assert.deepEqual(receivedTokens, []);
});

test('Gemini cancellation returns promptly while an actual generator is blocked in next', async () => {
  const controller = new AbortController();
  let releaseNext;
  let nextStarted;
  let cleaned = 0;
  let markCleaned;
  const cleanupFinished = new Promise(resolve => { markCleaned = resolve; });
  async function* stream() {
    try {
      nextStarted();
      yield { text: await new Promise(resolve => { releaseNext = resolve; }) };
    } finally {
      cleaned += 1;
      markCleaned();
    }
  }
  const started = new Promise(resolve => { nextStarted = resolve; });
  const receivedTokens = [];
  const pending = consumeGeminiStream(stream(), token => receivedTokens.push(token), controller.signal);
  await started;
  controller.abort();

  try {
    await assert.rejects(
      () => Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini generator cancellation did not settle promptly')), 30))
      ]),
      error => error.category === 'cancelled' && error.retryable === false
    );
  } finally {
    releaseNext('late');
    await Promise.race([
      cleanupFinished,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini generator cleanup did not finish')), 30))
    ]);
    await pending.catch(() => {});
  }
  assert.equal(cleaned, 1);
  assert.deepEqual(receivedTokens, []);
});

test('forwards AbortSignal through Gemini config', async () => {
  const controller = new AbortController();
  const llm = createLLM({
    provider: 'gemini',
    smart: false,
    apiKeys: { gemini: 'test-key' },
    models: { gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' } }
  });
  await llm.stream({ system: '', turns: [{ role: 'user', text: 'Hello' }], onToken: () => {}, signal: controller.signal });
  assert.equal(capturedGeminiRequest.config.abortSignal, controller.signal);
});

test('forwards AbortSignal to Anthropic request options', async () => {
  const controller = new AbortController();
  const receivedTokens = [];
  const llm = createLLM({
    provider: 'anthropic',
    smart: false,
    apiKeys: { anthropic: 'test-key' },
    models: { anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-haiku-latest' } }
  });

  await llm.stream({ system: '', turns: [{ role: 'user', text: 'Hello' }], onToken: token => receivedTokens.push(token), signal: controller.signal });

  assert.equal(capturedAnthropicRequestOptions.signal, controller.signal);
  assert.deepEqual(receivedTokens, ['ok']);
});

test('allows an unauthenticated local Custom endpoint', async () => {
  const llm = createLLM(createCustomSettings({ apiKeys: { custom: '' } }));
  await llm.stream({ system: '', turns: [], onToken: () => {} });

  assert.equal(capturedClientOptions.apiKey, OPTIONAL_API_KEY_PLACEHOLDER);
});

test('does not apply the Custom Base URL to official OpenAI requests', async () => {
  const llm = createLLM({
    provider: 'openai',
    smart: false,
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { openai: 'official-openai-key' },
    models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }
  });

  await llm.stream({ system: '', turns: [], onToken: () => {} });

  assert.deepEqual(capturedClientOptions, { apiKey: 'official-openai-key' });
  assert.equal(capturedCompletionRequest.max_completion_tokens, 700);
  assert.equal('max_tokens' in capturedCompletionRequest, false);
});

test('uses max_completion_tokens for current official OpenAI chat models', async () => {
  const controller = new AbortController();
  const llm = createLLM({
    provider: 'openai',
    smart: false,
    apiKeys: { openai: 'official-openai-key' },
    models: { openai: { fast: 'gpt-5.6-luna', smart: 'gpt-5.6-luna' } }
  });

  await llm.stream({ system: '', turns: [], onToken: () => {}, signal: controller.signal });

  assert.equal(capturedCompletionRequest.max_completion_tokens, 700);
  assert.equal('max_tokens' in capturedCompletionRequest, false);
  assert.equal(capturedCompletionOptions.signal, controller.signal);
});

test('keeps compatible token-limit fields deterministic by provider and model', () => {
  assert.equal(completionTokenLimitParameter('openai', 'gpt-5.6-luna'), 'max_completion_tokens');
  assert.equal(completionTokenLimitParameter('openai', 'gpt-4o-mini'), 'max_completion_tokens');
  assert.equal(completionTokenLimitParameter('custom', 'gpt-5.6-luna'), 'max_tokens');
  assert.equal(completionTokenLimitParameter('groq', 'gpt-5.6-luna'), 'max_tokens');
  assert.equal(completionTokenLimitParameter('minimax', 'MiniMax-M3'), 'max_tokens');
  assert.equal(completionTokenLimitParameter('azure', 'gpt-5.6-luna'), 'max_completion_tokens');
});

test('retries max_tokens only when OpenAI rejects max_completion_tokens before streaming', async () => {
  const controller = new AbortController();
  const unsupportedParameter = Object.assign(
    new Error("Unsupported parameter: 'max_completion_tokens' is not supported with this model. Use 'max_tokens' instead."),
    { status: 400 }
  );
  openAICompletionErrors.push(unsupportedParameter);
  const llm = createLLM({
    provider: 'openai',
    smart: false,
    apiKeys: { openai: 'official-openai-key' },
    models: { openai: { fast: 'gpt-5.6-luna', smart: 'gpt-5.6-luna' } }
  });

  await llm.stream({ system: '', turns: [], onToken: () => {}, signal: controller.signal });

  assert.equal(capturedCompletionRequests.length, 2);
  assert.equal(capturedCompletionRequests[0].completionRequest.max_completion_tokens, 700);
  assert.equal('max_tokens' in capturedCompletionRequests[0].completionRequest, false);
  assert.equal(capturedCompletionRequests[1].completionRequest.max_tokens, 700);
  assert.equal('max_completion_tokens' in capturedCompletionRequests[1].completionRequest, false);
  assert.equal(capturedCompletionRequests[1].completionOptions.signal, controller.signal);
});

test('does not retry an OpenAI request after a token has streamed', async () => {
  const unsupportedParameter = Object.assign(
    new Error("Unsupported parameter: 'max_completion_tokens' is not supported with this model. Use 'max_tokens' instead."),
    { status: 400 }
  );
  openAICompletionStream = (async function* () {
    yield { choices: [{ delta: { content: 'first' } }] };
    throw unsupportedParameter;
  })();
  const receivedTokens = [];
  const llm = createLLM({
    provider: 'openai',
    smart: false,
    apiKeys: { openai: 'official-openai-key' },
    models: { openai: { fast: 'gpt-5.6-luna', smart: 'gpt-5.6-luna' } }
  });

  await assert.rejects(
    () => llm.stream({ system: '', turns: [], onToken: token => receivedTokens.push(token) })
  );

  assert.deepEqual(receivedTokens, ['first']);
  assert.equal(capturedCompletionRequests.length, 1);
});

test('reports incomplete Custom endpoint settings without making a request', () => {
  const llm = createLLM(createCustomSettings({ baseUrl: '' }));

  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /Set a Base URL/);
  assert.equal(capturedClientOptions, null);
});

test('requires a model for the Custom provider', () => {
  const llm = createLLM(createCustomSettings({
    models: { custom: { fast: '', smart: '' } }
  }));

  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /Set a Fast or Smart model/);
});

test('createLLM: incomplete settings reject with a categorized configuration error', async () => {
  const llm = createLLM(createCustomSettings({ baseUrl: '' }));

  await assert.rejects(
    () => llm.stream({ system: '', turns: [], onToken: () => {} }),
    error => error instanceof ProviderRequestError && error.category === 'configuration' && error.retryable === false && /Set a Base URL/.test(error.message)
  );
});

test('createLLM: wraps an OpenAI-compatible network failure with retry metadata', async () => {
  openAICompletionErrors.push(new Error('socket hang up'));
  const llm = createLLM(createCustomSettings());

  await assert.rejects(
    () => llm.stream({ system: '', turns: [], onToken: () => {} }),
    error => error instanceof ProviderRequestError && error.category === 'network' && error.retryable === true && /try again/i.test(error.message)
  );
});

// ---- MiniMax (PR #22) -----------------------------------------------------
// MiniMax is OpenAI-compatible and region-split, so these assert the regional
// gateway selection rather than any new transport.

function minimaxSettings(overrides) {
  return Object.assign({
    provider: 'minimax',
    smart: true,
    apiKeys: { minimax: 'test-key' },
    models: { minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' } }
  }, overrides || {});
}

test('selects the MiniMax model for the active tier and reports readiness', () => {
  const smart = createLLM(minimaxSettings({ smart: true }));
  assert.equal(smart.provider, 'minimax');
  assert.equal(smart.model, 'MiniMax-M3');
  assert.equal(smart.ready, true);

  const fast = createLLM(minimaxSettings({ smart: false }));
  assert.equal(fast.model, 'MiniMax-M2.7');
});

test('routes MiniMax to the global OpenAI-compatible endpoint by default', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'global_en' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimax.io/v1');
  assert.equal(capturedClientOptions.apiKey, 'test-key');
});

test('routes MiniMax to the China endpoint when that region is selected', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'cn_zh' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimaxi.com/v1');
});

test('falls back to the global endpoint for an unknown region', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'unknown' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimax.io/v1');
});

// ---- Gemini 404/429 error mapping ------------------------------------------
// Reproduces the exact bug-report clusters: "Error: got status: 404 Not Found.
// {"error":{"message":"exception parsing response","code":404,"status":"Not
// Found"}}" (dead/misspelled model) and 429 quota exhaustion, and asserts they
// come out as actionable in-app messages instead of the raw provider JSON.

function geminiApiError({ status, body }) {
  const err = new Error(`got status: ${status}. ${JSON.stringify(body)}`);
  err.name = 'ApiError';
  err.status = status; // matches @google/genai's ApiError shape
  return err;
}

test('formatProviderErrorMessage: maps a Gemini 404 to an actionable "model unavailable" message', () => {
  const error = geminiApiError({
    status: 404,
    body: { error: { message: 'exception parsing response', code: 404, status: 'Not Found' } }
  });
  const message = formatProviderErrorMessage(error, 'gemini', 'gemini-2.0-flash');
  assert.match(message, /Gemini/);
  assert.match(message, /model "gemini-2\.0-flash"/);
  assert.match(message, /unavailable \(404\)/);
  assert.match(message, /Settings/);
  assert.doesNotMatch(message, /exception parsing response/);
});

test('formatProviderErrorMessage: 404 message still works without a model id', () => {
  const error = geminiApiError({ status: 404, body: { error: { message: 'not found', code: 404 } } });
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /OpenAI model is unavailable \(404\)/);
});

test('formatProviderErrorMessage: maps a Gemini 429 to a free-tier quota message', () => {
  const error = geminiApiError({
    status: 429,
    body: { error: { message: 'You exceeded your current quota', code: 429, status: 'RESOURCE_EXHAUSTED' } }
  });
  const message = formatProviderErrorMessage(error, 'gemini', 'gemini-2.5-flash');
  assert.match(message, /Gemini free-tier quota exhausted \(429/);
  assert.match(message, /billing/);
  assert.doesNotMatch(message, /RESOURCE_EXHAUSTED/);
});

test('formatProviderErrorMessage: surfaces retry-after when the 429 body carries a RetryInfo delay', () => {
  const error = geminiApiError({
    status: 429,
    body: {
      error: {
        message: 'Resource exhausted',
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '38s' }]
      }
    }
  });
  const message = formatProviderErrorMessage(error, 'gemini');
  assert.match(message, /Wait about 38s/);
});

test('formatProviderErrorMessage: 429 without a retry delay falls back to a generic wait hint', () => {
  const error = new Error('429 Too Many Requests');
  error.status = 429;
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /Wait a moment/);
});

test('formatProviderErrorMessage: an OpenAI-style quota 429 (no numeric status) is still recognized', () => {
  // Matches the literal text one of the bug reports pasted in.
  const error = new Error('429 You exceeded your current quota, please check your plan and billing details.');
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /OpenAI free-tier quota exhausted/);
});

test('formatProviderErrorMessage: an unrecognized error passes its raw message through unchanged', () => {
  const error = new Error('socket hang up');
  assert.equal(formatProviderErrorMessage(error, 'anthropic'), 'socket hang up');
});

test('isQuotaError: agrees with formatProviderErrorMessage on what counts as quota', () => {
  assert.equal(isQuotaError(geminiApiError({ status: 429, body: {} })), true);
  assert.equal(isQuotaError(geminiApiError({ status: 404, body: {} })), false);
  assert.equal(isQuotaError(new Error('insufficient_quota')), true);
});

// ---- Gemini model selection / self-healing migration -----------------------

function geminiSettings(overrides) {
  return Object.assign({
    provider: 'gemini',
    smart: false,
    apiKeys: { gemini: 'test-key' }
  }, overrides || {});
}

test('createLLM: falls back to CURRENT_GEMINI_DEFAULT when no model is configured', () => {
  const llm = createLLM(geminiSettings({ models: {} }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
  assert.equal(llm.ready, true);
});

test('createLLM: a fresh install (store.js DEFAULTS shape) resolves to the current default', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' } }
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: self-heals a settings file saved with the retired gemini-2.0-flash default', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-2.0-flash', smart: 'gemini-2.0-flash' } }
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: self-heals a legacy gemini-1.5-* model saved before the 2.0-flash migration existed', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-1.5-flash', smart: 'gemini-1.5-pro' } },
    smart: true
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: leaves a user-chosen current Gemini model alone', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-3.5-flash', smart: 'gemini-3.5-flash' } }
  }));
  assert.equal(llm.model, 'gemini-3.5-flash');
});

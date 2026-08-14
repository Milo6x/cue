// Shared, safe classification for errors returned before an LLM stream starts.
// Keep retry decisions here so callers do not infer them from provider wording.

const PROVIDER_LABELS = {
  azure: 'Azure AI Foundry',
  openai: 'OpenAI',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  minimax: 'MiniMax'
};

function providerLabel(provider) {
  if (!provider) return 'Provider';
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  return String(provider).charAt(0).toUpperCase() + String(provider).slice(1);
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted API key]')
    .replace(/\bAIza[A-Za-z0-9_-]+/g, '[redacted API key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/((?:api[-_]key)\s*[=:]\s*["']?)[^\s,"'}\]]+/gi, '$1[redacted]')
    .replace(/((?:"api[-_]key"\s*:\s*")[^"]+("))/gi, '$1[redacted]$2')
    .replace(/((?:authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]');
}

function errorDetails(error) {
  const statusValue = error && (error.status ?? error.statusCode ?? error.response?.status);
  const rawMessage = error && (error.message || String(error));
  const code = error && (error.code ?? error.error?.code ?? error.response?.data?.error?.code);
  const body = error && (error.response?.data ?? error.error ?? '');
  const text = [rawMessage, statusValue, code, safeStringify(body)].filter(Boolean).join(' ');
  const numericStatus = Number(statusValue);
  const messageStatus = /\b([45]\d\d)\b/.exec(text);
  const status = Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599
    ? numericStatus
    : messageStatus ? Number(messageStatus[1]) : null;
  return { status, code, text, rawMessage: rawMessage || '' };
}

function safeStringify(value) {
  if (typeof value === 'string') return value;
  try { return value ? JSON.stringify(value) : ''; } catch (_) { return ''; }
}

function isQuotaError(error) {
  return classifyProviderError(error).category === 'quota';
}

function extractRetryDelaySeconds(rawMessage) {
  const match = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)\s*s/i.exec(String(rawMessage || ''));
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function formatRetryWait(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function classifyProviderError(error, context = {}) {
  if (error instanceof ProviderRequestError) {
    return { category: error.category, retryable: error.retryable, status: error.status };
  }

  const { status, code, text, rawMessage } = errorDetails(error);
  const normalizedCode = String(code || '').toLowerCase();
  const normalizedText = text.toLowerCase();
  const explicitCategory = error && error.category;

  if (explicitCategory === 'configuration' || context.ready === false || context.configurationError) {
    return { category: 'configuration', retryable: false, status, rawMessage };
  }
  if (status === 401 || /\b401\b|invalid (?:api )?key|invalid[_ -]?api[_ -]?key|unauthori[sz]ed|authentication (?:failed|required)/i.test(text)) {
    return { category: 'authentication', retryable: false, status, rawMessage };
  }
  if (status === 403 || /\b403\b|forbidden|permission(?:s)? (?:denied|required)|not permitted/i.test(text)) {
    return { category: 'permission', retryable: false, status, rawMessage };
  }
  if (status === 429 || normalizedCode === '429' || normalizedCode === 'insufficient_quota' || normalizedCode === 'rate_limit_exceeded' ||
    normalizedCode === 'resource_exhausted' || /\b429\b|insufficient_quota|rate_limit_exceeded|resource_exhausted|quota|rate[ -]?limit|too many requests|exceeded your current quota/i.test(text)) {
    return { category: 'quota', retryable: false, status: status || 429, rawMessage };
  }
  if (status === 404 || normalizedCode === '404' || /\b404\b|model not found|model.*(?:retired|unavailable)|is not found for api version/i.test(text)) {
    return { category: 'model', retryable: false, status: status || 404, rawMessage };
  }
  if (status === 408 || (status !== null && status >= 500 && status <= 599)) {
    return { category: 'service', retryable: true, status, rawMessage };
  }
  if (explicitCategory === 'timeout' || /\btimeout\b|timed out|abort(?:ed)?(?:error)?|abort_err/i.test(text)) {
    return { category: 'timeout', retryable: true, status, rawMessage };
  }
  if (/econnreset|econnrefused|enetunreach|eai_again|etimedout|fetch failed|socket hang up|connection reset/i.test(`${normalizedCode} ${normalizedText}`)) {
    return { category: 'network', retryable: true, status, rawMessage };
  }
  return { category: 'unknown', retryable: false, status, rawMessage };
}

function formatProviderErrorMessage(error, provider, model) {
  const { category, status, rawMessage } = classifyProviderError(error, { provider, model });
  const label = providerLabel(provider);

  if (category === 'configuration') return redactSecrets(rawMessage || `Complete the ${label} provider settings.`);
  if (category === 'authentication') return `${label} credentials were rejected. Update your API key in Settings and try again.`;
  if (category === 'permission') return `${label} denied permission for the selected model. Check your key permissions and selected model in Settings.`;
  if (category === 'quota') {
    const retrySeconds = extractRetryDelaySeconds(rawMessage);
    const waitHint = retrySeconds ? ` Wait about ${formatRetryWait(retrySeconds)}` : ' Wait a moment';
    return `${label} free-tier quota exhausted (429 Too Many Requests).${waitHint} and try again, or add billing to your ${label} account. You can also switch providers or models in Settings.`;
  }
  if (category === 'model') {
    const modelHint = model ? ` "${redactSecrets(model)}"` : '';
    return `${label} model${modelHint} is unavailable (${status || 404}) — it may have been renamed, retired by the provider, or misspelled. Open Settings and pick a current model for ${label} (or clear the field to use cue's default), then try again.`;
  }
  if (category === 'timeout') return `${label} request timed out. Try again.`;
  if (category === 'service') return `${label} service is temporarily unavailable${status ? ` (${status})` : ''}. Try again.`;
  if (category === 'network') return `Could not reach ${label}. Check your connection and try again.`;
  return redactSecrets(rawMessage || 'Unknown LLM error.');
}

class ProviderRequestError extends Error {
  constructor(error, context = {}) {
    const classification = classifyProviderError(error, context);
    super(redactSecrets(formatProviderErrorMessage(error, context.provider, context.model)));
    this.name = 'ProviderRequestError';
    this.category = classification.category;
    this.retryable = classification.retryable;
    this.provider = context.provider || null;
    this.model = context.model || null;
    this.status = classification.status ?? null;
    this.cause = error;
  }

  static from(error, context = {}) {
    if (error instanceof ProviderRequestError) return error;
    return new ProviderRequestError(error, context);
  }
}

module.exports = {
  classifyProviderError,
  ProviderRequestError,
  redactSecrets,
  isQuotaError,
  formatProviderErrorMessage,
  providerLabel
};

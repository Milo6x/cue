// Shared, safe classification for errors returned before an LLM stream starts.
// Keep retry decisions here so callers do not infer them from provider wording.

const PROVIDER_LABELS = {
  azure: 'Azure AI Foundry',
  openai: 'OpenAI',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  minimax: 'MiniMax'
};
const MAX_ERROR_TEXT_LENGTH = 8 * 1024;
const SECRET_FIELD_NAME = '(?:authorization|api[-_]key|x-(?:goog-)?api-key|(?:[a-z][a-z0-9-]*)_api_key)';
const QUOTED_JSON_SECRET_FIELD_RE = new RegExp(`(["']${SECRET_FIELD_NAME}["']\\s*:\\s*["'])[^"']*(["'])`, 'gi');
const QUOTED_SECRET_FIELD_VALUE_RE = new RegExp(`(\\b${SECRET_FIELD_NAME}\\s*[:=]\\s*["'])[^"']*(["'])`, 'gi');
const PLAIN_SECRET_FIELD_VALUE_RE = new RegExp(`(\\b${SECRET_FIELD_NAME}\\s*[:=]\\s*)(?!["'])[^;\\r\\n]*`, 'gi');

function providerLabel(provider) {
  if (!provider) return 'Provider';
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  return String(provider).charAt(0).toUpperCase() + String(provider).slice(1);
}

function redactSecrets(value) {
  return String(value || '')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted API key]')
    .replace(/\bAIza[A-Za-z0-9_-]+/g, '[redacted API key]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(QUOTED_JSON_SECRET_FIELD_RE, '$1[redacted]$2')
    .replace(QUOTED_SECRET_FIELD_VALUE_RE, '$1[redacted]$2')
    .replace(PLAIN_SECRET_FIELD_VALUE_RE, '$1[redacted]');
}

function clipErrorText(value) {
  const text = String(value || '');
  return text.length > MAX_ERROR_TEXT_LENGTH ? text.slice(0, MAX_ERROR_TEXT_LENGTH) : text;
}

function errorDetails(error) {
  const statusValue = error && (error.status ?? error.statusCode ?? error.response?.status);
  const rawMessage = clipErrorText(error && (error.message || String(error)));
  const code = error && (error.code ?? error.error?.code ?? error.response?.data?.error?.code);
  const body = error && (error.response?.data ?? error.error ?? '');
  const text = clipErrorText([rawMessage, statusValue, code, safeStringify(body)].filter(Boolean).join(' '));
  const numericStatus = Number(statusValue);
  const messageStatus = /\b([45]\d\d)\b/.exec(text);
  const status = Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599
    ? numericStatus
    : messageStatus ? Number(messageStatus[1]) : null;
  const explicitStatus = Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599 ? numericStatus : null;
  return { status, explicitStatus, code, text, rawMessage: rawMessage || '' };
}

function safeStringify(value) {
  if (typeof value === 'string') return clipErrorText(value);
  try { return value ? clipErrorText(JSON.stringify(value)) : ''; } catch (_) { return ''; }
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
    return {
      category: error.category,
      retryable: error.retryable,
      provider: error.provider,
      model: error.model,
      status: error.status,
      message: error.message
    };
  }

  const { status, explicitStatus, code, text, rawMessage } = errorDetails(error);
  const normalizedCode = String(code || '').toLowerCase();
  const normalizedText = text.toLowerCase();
  const explicitCategory = error && error.category;
  const errorName = String((error && error.name) || '').toLowerCase();
  const provider = context.provider || null;
  const model = context.model || null;
  let category = 'unknown';
  let retryable = false;
  let classifiedStatus = status;

  if (explicitCategory === 'configuration' || context.ready === false || context.configurationError) {
    category = 'configuration';
  } else if (explicitStatus === 401) {
    category = 'authentication';
  } else if (explicitStatus === 403) {
    category = 'permission';
  } else if (explicitStatus === 404) {
    category = 'model';
  } else if (explicitStatus === 408 || (explicitStatus !== null && explicitStatus >= 500 && explicitStatus <= 599)) {
    category = 'service';
    retryable = true;
  } else if (explicitStatus === 429) {
    category = 'quota';
    classifiedStatus = 429;
  } else if (errorName === 'aborterror' || normalizedCode === 'abort_err' || /\baborterror\b|\babort_err\b/i.test(text)) {
    category = 'cancelled';
  } else if (normalizedCode === 'unauthenticated') {
    category = 'authentication';
  } else if (normalizedCode === 'permission_denied') {
    category = 'permission';
  } else if (normalizedCode === 'resource_exhausted' || normalizedCode === 'insufficient_quota' || normalizedCode === 'rate_limit_exceeded' || normalizedCode === '429') {
    category = 'quota';
    classifiedStatus = status || 429;
  } else if (normalizedCode === 'not_found' || normalizedCode === '404') {
    category = 'model';
    classifiedStatus = status || 404;
  } else if (explicitCategory === 'timeout' || normalizedCode === 'deadline_exceeded' || normalizedCode === 'etimedout') {
    category = 'timeout';
    retryable = true;
  } else if (normalizedCode === 'unavailable') {
    category = 'service';
    retryable = true;
  } else if (/\b401\b|invalid (?:api )?key|invalid[_ -]?api[_ -]?key|unauthori[sz]ed|authentication (?:failed|required)/i.test(text)) {
    category = 'authentication';
  } else if (/\b403\b|forbidden|permission(?:s)? (?:denied|required)|not permitted/i.test(text)) {
    category = 'permission';
  } else if (/\b429\b|insufficient_quota|rate_limit_exceeded|resource_exhausted|quota|rate[ -]?limit|too many requests|exceeded your current quota/i.test(text)) {
    category = 'quota';
    classifiedStatus = status || 429;
  } else if (/\b404\b|model not found|model.*(?:retired|unavailable)|is not found for api version/i.test(text)) {
    category = 'model';
    classifiedStatus = status || 404;
  } else if (/econnreset|econnrefused|enetunreach|eai_again|fetch failed|socket hang up|connection reset|\bnetwork(?:\s+connection)?\s+(?:error|failed)\b/i.test(`${normalizedCode} ${normalizedText}`)) {
    category = 'network';
    retryable = true;
  }

  const classification = { category, retryable, provider, model, status: classifiedStatus };
  return { ...classification, message: formatClassifiedMessage(classification, rawMessage) };
}

function formatClassifiedMessage({ category, status, provider, model }, rawMessage) {
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
  if (category === 'cancelled') return 'Request was cancelled.';
  if (category === 'timeout') return `${label} request timed out. Try again.`;
  if (category === 'service') return `${label} service is temporarily unavailable${status ? ` (${status})` : ''}. Try again.`;
  if (category === 'network') return `Could not reach ${label}. Check your connection and try again.`;
  return redactSecrets(rawMessage || 'Unknown LLM error.');
}

function formatProviderErrorMessage(error, provider, model) {
  return classifyProviderError(error, { provider, model }).message;
}

function sanitizedCause(error) {
  const { status, code, rawMessage } = errorDetails(error);
  const cause = new Error(redactSecrets(rawMessage || 'Provider request failed.'));
  cause.name = redactSecrets((error && error.name) || 'Error');
  if (status !== null) cause.status = status;
  if (code !== null && code !== undefined) cause.code = redactSecrets(code);
  return cause;
}

class ProviderRequestError extends Error {
  constructor(error, context = {}) {
    const classification = classifyProviderError(error, context);
    super(classification.message);
    this.name = 'ProviderRequestError';
    this.category = classification.category;
    this.retryable = classification.retryable;
    this.provider = classification.provider;
    this.model = classification.model;
    this.status = classification.status ?? null;
    this.cause = sanitizedCause(error);
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

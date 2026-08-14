// Streaming Speech-to-Text via OpenAI Realtime API (WebSocket transcription session)
// or Deepgram Nova streaming. Falls back to batch Whisper/Gemini if streaming unavailable.
//
// This module manages a persistent WebSocket connection for real-time transcription
// with sub-200ms latency, interim results, and automatic reconnection.

const { buildVocabPrompt, looksLikeHallucination } = require('./stt');
const { pcmToWav } = require('./wav');
const { CURRENT_GEMINI_DEFAULT } = require('./llm');

const DEFAULT_OPENAI_REALTIME_MODEL = 'gpt-live-transcribe';
const DEFAULT_OPENAI_REALTIME_LANGUAGES = ['en'];
const DEFAULT_OPENAI_REALTIME_DELAY = 'medium';

function normalizeRealtimeLanguages(languages) {
  const normalized = (Array.isArray(languages) ? languages : [])
    .filter((language) => typeof language === 'string')
    .map((language) => language.trim().toLowerCase())
    .filter(Boolean);
  return normalized.length ? Array.from(new Set(normalized)) : DEFAULT_OPENAI_REALTIME_LANGUAGES;
}

function buildRealtimeKeywords(vocabPrompt) {
  return Array.from(new Set(String(vocabPrompt || '')
    .split(',')
    .map((keyword) => keyword.replace(/[<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)))
    .slice(0, 60);
}

function buildOpenAIRealtimeSession(options = {}) {
  const languages = normalizeRealtimeLanguages(options.languages);
  const keywords = buildRealtimeKeywords(options.vocabPrompt);
  const prompt = `Live interview audio. Expected terminology: ${keywords.join(', ')}`.slice(0, 850);

  return {
    type: 'transcription',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: {
          model: options.model || DEFAULT_OPENAI_REALTIME_MODEL,
          languages,
          prompt,
          keywords,
          delay: options.delay || DEFAULT_OPENAI_REALTIME_DELAY
        }
      }
    }
  };
}

function isNuisanceOpenAIRealtimeFinal(transcript, languages) {
  const text = String(transcript || '').trim();
  if (looksLikeHallucination(text) || /^[\p{P}\p{S}\s]+$/u.test(text)) return true;

  // Cue's cloud streaming default is English. A lone Hangul glyph is a known
  // ambient-audio false positive in that mode, but remains valid if Korean is
  // ever explicitly configured as an expected input language.
  return languages.length === 1 && languages[0] === 'en' && /^[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]$/u.test(text);
}

function normalizeTranscriptForComparison(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')
    .trim();
}

function reconcileOpenAIRealtimeTranscript(providerTranscript, accumulatedDeltas) {
  const provider = String(providerTranscript || '').trim();
  const accumulated = String(accumulatedDeltas || '').trim();
  if (!accumulated) return provider;
  if (!provider) return accumulated;

  const providerComparable = normalizeTranscriptForComparison(provider);
  const accumulatedComparable = normalizeTranscriptForComparison(accumulated);
  if (providerComparable === accumulatedComparable) return provider;

  const providerWords = providerComparable.split(/\s+/).filter(Boolean).length;
  const accumulatedWords = accumulatedComparable.split(/\s+/).filter(Boolean).length;
  const providerIsShorterFragment = providerComparable.length < accumulatedComparable.length &&
    (accumulatedComparable.endsWith(providerComparable) ||
      (providerWords < accumulatedWords && accumulatedComparable.includes(providerComparable)));
  if (providerIsShorterFragment) return accumulated;

  return providerWords >= accumulatedWords || providerComparable.length >= accumulatedComparable.length
    ? provider
    : accumulated;
}

// ============================================================================
// OpenAI Realtime Transcription Session (WebSocket)
// Uses the dedicated transcription session type for lowest latency streaming STT
// ============================================================================

class OpenAIRealtimeSTT {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model = options.model || DEFAULT_OPENAI_REALTIME_MODEL;
    this.languages = normalizeRealtimeLanguages(options.languages);
    this.vocabPrompt = options.vocabPrompt || '';
    this.delay = options.delay || DEFAULT_OPENAI_REALTIME_DELAY;
    this.ws = null;
    this.connected = false;
    this.reconnecting = false;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectDelay = 1000;
    this._pendingAudio = [];
    this._sessionReady = false;
    this._stopped = false;
    this._transcriptionItems = new Map();
    this._transcriptionOrder = [];
    this._transcriptionResults = new Map();
    this._transcriptionDeltas = new Map();
    this._transcriptionSequence = 0;
    this._handledTranscriptionIds = new Set();
    this._handledTranscriptionOrder = [];
    this._maxTrackedTranscriptions = 64;
    this._maxHandledTranscriptions = 128;
    this._maxDeltaItems = 64;
    this._maxDeltaCharsPerItem = 12000;
    this._reorderTimeoutMs = Number.isFinite(options.reorderTimeoutMs) && options.reorderTimeoutMs > 0
      ? options.reorderTimeoutMs
      : 15000;
    this._reorderTimer = null;
    this._reorderTimerItemId = null;
  }

  async connect() {
    if (this.ws && this.connected) return;
    this._resetTranscriptionOrder();
    this._stopped = false;

    try {
      const WebSocket = require('ws');
      // GA transcription endpoint: use ?intent=transcription (NOT ?model=)
      // The transcription model goes inside the session config
      const url = 'wss://api.openai.com/v1/realtime?intent=transcription';

      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      this.ws.on('open', () => {
        if (this._stopped) return;
        this.connected = true;
        this._reconnectAttempts = 0;
        this.onStatusChange('connected');

        // Configure the transcription session (GA format)
        this._sendEvent({
          type: 'session.update',
          session: buildOpenAIRealtimeSession({
            model: this.model,
            languages: this.languages,
            vocabPrompt: this.vocabPrompt,
            delay: this.delay
          })
        });
      });

      this.ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          this._handleEvent(event);
        } catch (e) {
          // ignore parse errors
        }
      });

      this.ws.on('close', (code) => {
        this.connected = false;
        this._sessionReady = false;
        this._resetTranscriptionOrder();
        if (this._stopped) return;
        this.onStatusChange('disconnected');
        if (code !== 1000 && !this.reconnecting) {
          this._attemptReconnect();
        }
      });

      this.ws.on('error', (err) => {
        if (this._stopped) return;
        this.onError({ provider: 'openai-realtime', message: err.message, status: null });
      });

    } catch (e) {
      if (this._stopped) return;
      this.onError({ provider: 'openai-realtime', message: e.message, status: null });
    }
  }

  _handleEvent(event) {
    if (this._stopped) return;
    switch (event.type) {
      case 'session.updated':
        this._sessionReady = true;
        this._flushPendingAudio();
        break;

      case 'conversation.item.input_audio_transcription.delta':
        this._appendTranscriptionDelta(event.item_id, event.delta);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this._completeTranscription(event.item_id, event.transcript);
        break;

      case 'conversation.item.input_audio_transcription.failed':
        this._failTranscription(event.item_id, event.error);
        break;

      case 'conversation.item.created':
        this._trackTranscriptionItem(event.item?.id, event.previous_item_id);
        break;

      case 'input_audio_buffer.speech_started':
        break;

      case 'input_audio_buffer.speech_stopped':
        break;

      case 'input_audio_buffer.committed':
        this._trackTranscriptionItem(event.item_id, event.previous_item_id);
        break;

      case 'error':
        this._sessionReady = false;
        this._transcriptionDeltas.clear();
        this.onError({
          provider: 'openai-realtime',
          message: event.error?.message || 'Unknown realtime error',
          status: event.error?.code
        });
        break;
    }
  }

  _normalizeTranscriptionItemId(value) {
    if (typeof value !== 'string') return null;
    const id = value.trim();
    return id && id.length <= 512 ? id : null;
  }

  _appendTranscriptionDelta(rawItemId, rawDelta) {
    const delta = typeof rawDelta === 'string' ? rawDelta : '';
    if (!delta) return;
    const itemId = this._normalizeTranscriptionItemId(rawItemId);
    if (itemId && this._handledTranscriptionIds.has(itemId)) return;

    if (!itemId) {
      this.onInterim(delta);
      return;
    }

    if (!this._transcriptionDeltas.has(itemId) && this._transcriptionDeltas.size >= this._maxDeltaItems) {
      this._transcriptionDeltas.delete(this._transcriptionDeltas.keys().next().value);
    }
    const accumulated = ((this._transcriptionDeltas.get(itemId) || '') + delta)
      .slice(0, this._maxDeltaCharsPerItem);
    this._transcriptionDeltas.set(itemId, accumulated);
    this.onInterim(accumulated);
  }

  _trackTranscriptionItem(rawItemId, rawPreviousItemId) {
    const itemId = this._normalizeTranscriptionItemId(rawItemId);
    if (!itemId || this._handledTranscriptionIds.has(itemId)) return;
    const previousItemId = this._normalizeTranscriptionItemId(rawPreviousItemId);
    const existing = this._transcriptionItems.get(itemId);

    if (existing) {
      if (previousItemId) existing.previousItemId = previousItemId;
    } else {
      this._transcriptionItems.set(itemId, {
        itemId,
        previousItemId,
        sequence: this._transcriptionSequence++
      });
    }

    this._rebuildTranscriptionOrder();
    while (this._transcriptionOrder.length > this._maxTrackedTranscriptions) {
      this._skipTranscriptionItem(this._transcriptionOrder[0]);
    }
    this._flushOrderedTranscriptions();
  }

  _rebuildTranscriptionOrder() {
    const entries = Array.from(this._transcriptionItems.values());
    const children = new Map();
    for (const entry of entries) {
      const siblings = children.get(entry.previousItemId) || [];
      siblings.push(entry);
      children.set(entry.previousItemId, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort((a, b) => a.sequence - b.sequence);
    }

    const roots = entries.filter((entry) => {
      const previous = entry.previousItemId;
      return !previous || previous === 'root' || this._handledTranscriptionIds.has(previous) || !this._transcriptionItems.has(previous);
    }).sort((a, b) => {
      const aKnownRoot = !a.previousItemId || a.previousItemId === 'root' || this._handledTranscriptionIds.has(a.previousItemId);
      const bKnownRoot = !b.previousItemId || b.previousItemId === 'root' || this._handledTranscriptionIds.has(b.previousItemId);
      return Number(bKnownRoot) - Number(aKnownRoot) || a.sequence - b.sequence;
    });

    const ordered = [];
    const visited = new Set();
    const visit = (entry) => {
      if (!entry || visited.has(entry.itemId)) return;
      visited.add(entry.itemId);
      ordered.push(entry.itemId);
      for (const child of children.get(entry.itemId) || []) visit(child);
    };
    for (const root of roots) visit(root);
    for (const entry of entries.sort((a, b) => a.sequence - b.sequence)) visit(entry);
    this._transcriptionOrder = ordered;
  }

  _completeTranscription(rawItemId, transcript) {
    const itemId = this._normalizeTranscriptionItemId(rawItemId);
    const accumulated = itemId ? this._transcriptionDeltas.get(itemId) : '';
    if (itemId) this._transcriptionDeltas.delete(itemId);
    if (itemId && this._handledTranscriptionIds.has(itemId)) return;
    const text = reconcileOpenAIRealtimeTranscript(transcript, accumulated);
    const result = { text: isNuisanceOpenAIRealtimeFinal(text, this.languages) ? null : text };

    // The committed event normally precedes completion on the same WebSocket. If
    // an ID is missing or unknown, holding it cannot improve ordering and would
    // risk buffering it forever, so preserve the legacy immediate fallback.
    if (!itemId || !this._transcriptionItems.has(itemId)) {
      if (result.text) this.onTranscript(result.text);
      return;
    }

    this._transcriptionResults.set(itemId, result);
    this._flushOrderedTranscriptions();
  }

  _failTranscription(rawItemId, error) {
    const itemId = this._normalizeTranscriptionItemId(rawItemId);
    if (itemId) this._transcriptionDeltas.delete(itemId);
    if (itemId && !this._handledTranscriptionIds.has(itemId)) {
      if (this._transcriptionItems.has(itemId)) {
        this._transcriptionResults.set(itemId, { text: null });
        this._flushOrderedTranscriptions();
      } else {
        this._rememberHandledTranscription(itemId);
      }
    }
    this.onError({
      provider: 'openai-realtime',
      message: error?.message || 'Realtime transcription failed',
      status: error?.code
    });
  }

  _flushOrderedTranscriptions() {
    this._rebuildTranscriptionOrder();
    while (this._transcriptionOrder.length > 0) {
      const itemId = this._transcriptionOrder[0];
      const item = this._transcriptionItems.get(itemId);
      const previous = item?.previousItemId;
      const missingPredecessor = previous && previous !== 'root' &&
        !this._handledTranscriptionIds.has(previous) && !this._transcriptionItems.has(previous);
      const result = this._transcriptionResults.get(itemId);
      if (missingPredecessor || !result) break;

      this._transcriptionItems.delete(itemId);
      this._transcriptionResults.delete(itemId);
      this._rememberHandledTranscription(itemId);
      if (result.text) this.onTranscript(result.text);
      this._rebuildTranscriptionOrder();
    }

    if (this._transcriptionOrder.length > 0) this._scheduleReorderTimeout(this._transcriptionOrder[0]);
    else this._clearReorderTimeout();
  }

  _scheduleReorderTimeout(itemId) {
    if (this._reorderTimer && this._reorderTimerItemId === itemId) return;
    this._clearReorderTimeout();
    this._reorderTimerItemId = itemId;
    this._reorderTimer = setTimeout(() => {
      this._reorderTimer = null;
      this._reorderTimerItemId = null;
      if (this._stopped) return;
      const item = this._transcriptionItems.get(itemId);
      const previous = item?.previousItemId;
      if (previous && previous !== 'root' && !this._transcriptionItems.has(previous)) {
        this._rememberHandledTranscription(previous);
      }
      if (!this._transcriptionResults.has(itemId)) this._skipTranscriptionItem(itemId);
      this._flushOrderedTranscriptions();
    }, this._reorderTimeoutMs);
    if (typeof this._reorderTimer.unref === 'function') this._reorderTimer.unref();
  }

  _skipTranscriptionItem(itemId) {
    if (!itemId) return;
    this._transcriptionItems.delete(itemId);
    this._transcriptionResults.delete(itemId);
    this._transcriptionDeltas.delete(itemId);
    this._rememberHandledTranscription(itemId);
    this._rebuildTranscriptionOrder();
  }

  _rememberHandledTranscription(itemId) {
    if (!itemId || this._handledTranscriptionIds.has(itemId)) return;
    this._transcriptionDeltas.delete(itemId);
    this._handledTranscriptionIds.add(itemId);
    this._handledTranscriptionOrder.push(itemId);
    while (this._handledTranscriptionOrder.length > this._maxHandledTranscriptions) {
      this._handledTranscriptionIds.delete(this._handledTranscriptionOrder.shift());
    }
  }

  _clearReorderTimeout() {
    if (this._reorderTimer) clearTimeout(this._reorderTimer);
    this._reorderTimer = null;
    this._reorderTimerItemId = null;
  }

  _resetTranscriptionOrder() {
    this._clearReorderTimeout();
    this._transcriptionItems.clear();
    this._transcriptionOrder = [];
    this._transcriptionResults.clear();
    this._transcriptionDeltas.clear();
    this._transcriptionSequence = 0;
    this._handledTranscriptionIds.clear();
    this._handledTranscriptionOrder = [];
  }

  sendAudio(pcmBuffer) {
    if (this._stopped) return;
    if (!this.connected || !this._sessionReady) {
      // Buffer audio until session is ready (max 5 seconds worth)
      this._pendingAudio.push(pcmBuffer);
      if (this._pendingAudio.length > 80) this._pendingAudio.shift();
      return;
    }

    // Resample 16kHz -> 24kHz (linear interpolation) since the API requires 24kHz
    const resampled = this._resample16to24(Buffer.from(pcmBuffer));
    const b64 = resampled.toString('base64');
    this._sendEvent({
      type: 'input_audio_buffer.append',
      audio: b64
    });
  }

  _resample16to24(pcm16kHz) {
    // Linear interpolation from 16000 Hz to 24000 Hz (ratio 2:3)
    const srcSamples = pcm16kHz.length / 2;
    const dstSamples = Math.floor(srcSamples * 24000 / 16000);
    const out = Buffer.alloc(dstSamples * 2);
    for (let i = 0; i < dstSamples; i++) {
      const srcPos = i * 16000 / 24000;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const s0 = idx < srcSamples ? pcm16kHz.readInt16LE(idx * 2) : 0;
      const s1 = (idx + 1) < srcSamples ? pcm16kHz.readInt16LE((idx + 1) * 2) : s0;
      const sample = Math.round(s0 + (s1 - s0) * frac);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
    }
    return out;
  }

  _flushPendingAudio() {
    if (this._stopped) return;
    while (this._pendingAudio.length > 0) {
      const chunk = this._pendingAudio.shift();
      const resampled = this._resample16to24(Buffer.from(chunk));
      const b64 = resampled.toString('base64');
      this._sendEvent({
        type: 'input_audio_buffer.append',
        audio: b64
      });
    }
  }

  _sendEvent(event) {
    if (this.ws && this.ws.readyState === 1) { // WebSocket.OPEN
      this.ws.send(JSON.stringify(event));
    }
  }

  _attemptReconnect() {
    if (this._stopped) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this.onError({ provider: 'openai-realtime', message: 'Max reconnection attempts reached', status: null });
      return;
    }
    this.reconnecting = true;
    this._reconnectAttempts++;
    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    setTimeout(() => {
      if (this._stopped) return;
      this.reconnecting = false;
      this.connect();
    }, Math.min(delay, 16000));
  }

  disconnect() {
    this._stopped = true;
    this._sessionReady = false;
    this._pendingAudio = [];
    this._resetTranscriptionOrder();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    this.connected = false;
  }
}

// ============================================================================
// Deepgram Nova Streaming STT (WebSocket)
// Ultra-low latency, supports interim results, speaker diarization, punctuation
// ============================================================================

class DeepgramStreamingSTT {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model = options.model || 'nova-3';
    this.ws = null;
    this.connected = false;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectDelay = 1000;
    this._keepAliveInterval = null;
    this._committed = ''; // is_final segments not yet closed out by speech_final
  }

  async connect() {
    if (this.ws && this.connected) return;

    try {
      const WebSocket = require('ws');
      const params = new URLSearchParams({
        model: this.model,
        language: 'en',
        smart_format: 'true',
        interim_results: 'true',
        utterance_end_ms: '1000',
        vad_events: 'true',
        encoding: 'linear16',
        sample_rate: '16000',
        channels: '1',
        endpointing: '300',
        punctuate: 'true'
      });

      const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

      this.ws = new WebSocket(url, {
        headers: { 'Authorization': `Token ${this.apiKey}` }
      });

      this.ws.on('open', () => {
        this.connected = true;
        this._reconnectAttempts = 0;
        this.onStatusChange('connected');
        // Keep-alive every 3 seconds to prevent timeout
        this._keepAliveInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 3000);
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch (e) { /* ignore */ }
      });

      this.ws.on('close', (code) => {
        this.connected = false;
        this._clearKeepAlive();
        this.onStatusChange('disconnected');
        if (code !== 1000) this._attemptReconnect();
      });

      this.ws.on('error', (err) => {
        this.onError({ provider: 'deepgram', message: err.message, status: null });
      });

    } catch (e) {
      this.onError({ provider: 'deepgram', message: e.message, status: null });
    }
  }

  _handleMessage(msg) {
    if (msg.type === 'Results') {
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const text = (alt.transcript || '').trim();

      // Deepgram splits one spoken sentence into several is_final segments and only sets
      // speech_final on the last one. Accumulate the is_final pieces and emit a single turn
      // at speech_final so a sentence is not fragmented across transcript rows.
      if (msg.speech_final) {
        const full = ((this._committed || '') + ' ' + text).trim();
        this._committed = '';
        if (full && !looksLikeHallucination(full)) this.onTranscript(full);
        this.onInterim('');
        return;
      }
      if (!text) return;
      if (msg.is_final) {
        this._committed = ((this._committed || '') + ' ' + text).trim();
        this.onInterim(this._committed);
      } else {
        this.onInterim(((this._committed || '') + ' ' + text).trim());
      }
    } else if (msg.type === 'UtteranceEnd') {
      // Safety net: if endpointing never produced a speech_final, flush whatever is_final
      // segments we accumulated so the turn is not silently dropped.
      this._flushCommitted();
    } else if (msg.type === 'Error') {
      this.onError({ provider: 'deepgram', message: msg.description || msg.message, status: msg.variant });
    }
  }

  _flushCommitted() {
    const full = (this._committed || '').trim();
    this._committed = '';
    if (full && !looksLikeHallucination(full)) this.onTranscript(full);
    this.onInterim('');
  }

  sendAudio(pcmBuffer) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(Buffer.from(pcmBuffer));
    }
  }

  _clearKeepAlive() {
    if (this._keepAliveInterval) { clearInterval(this._keepAliveInterval); this._keepAliveInterval = null; }
  }

  _attemptReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this.onError({ provider: 'deepgram', message: 'Max reconnection attempts reached', status: null });
      return;
    }
    this._reconnectAttempts++;
    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    setTimeout(() => this.connect(), Math.min(delay, 16000));
  }

  disconnect() {
    this._flushCommitted();
    this._clearKeepAlive();
    if (this.ws) {
      // Send CloseStream message for clean shutdown
      try { this.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) { /* ignore */ }
      this.ws.close(1000);
      this.ws = null;
    }
    this.connected = false;
  }
}

// ============================================================================
// Batch STT (enhanced version of the original — used as fallback)
// Supports Whisper and Gemini with better error handling
// ============================================================================

async function transcribeBatchOpenAI(apiKey, wav, model) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({
    file,
    model: model || 'whisper-1',
    response_format: 'text',
    language: 'en'
  });
  return (typeof res === 'string' ? res : res.text || '').trim();
}

async function transcribeBatchGemini(apiKey, wav) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: CURRENT_GEMINI_DEFAULT,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

// ============================================================================
// Unified Streaming STT Factory
// Creates the best available streaming STT based on the user's API keys.
// Priority: Deepgram (lowest latency) > OpenAI Realtime > Batch fallback
// ============================================================================

function createStreamingSTT(settings, channel, callbacks) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const { onTranscript, onInterim, onError, onStatusChange } = callbacks;

  if (selectedProvider === 'local' || selectedProvider === 'gemini') {
    return { type: 'batch', provider: selectedProvider, instance: null };
  }

  // Priority 1: Deepgram (purpose-built for streaming STT, lowest latency)
  if ((selectedProvider === 'auto' || selectedProvider === 'deepgram') && keys.deepgram) {
    const stt = new DeepgramStreamingSTT(keys.deepgram, {
      model: 'nova-3',
      onTranscript: (text) => onTranscript(channel, text),
      onInterim: (text) => onInterim(channel, text),
      onError,
      onStatusChange: (status) => onStatusChange(channel, status)
    });
    return { type: 'streaming', provider: 'deepgram', instance: stt };
  }

  // Priority 2: OpenAI Realtime API (excellent quality, slightly higher latency)
  if ((selectedProvider === 'auto' || selectedProvider === 'openai') && keys.openai) {
    const stt = new OpenAIRealtimeSTT(keys.openai, {
      vocabPrompt: buildVocabPrompt(settings),
      onTranscript: (text) => onTranscript(channel, text),
      onInterim: (text) => onInterim(channel, text),
      onError,
      onStatusChange: (status) => onStatusChange(channel, status)
    });
    return { type: 'streaming', provider: 'openai-realtime', instance: stt };
  }

  // Priority 3: Batch fallback (Gemini or Whisper via old system)
  return {
    type: 'batch',
    provider: selectedProvider === 'auto' && keys.gemini ? 'gemini' : 'none',
    instance: null
  };
}

module.exports = {
  OpenAIRealtimeSTT,
  DeepgramStreamingSTT,
  buildOpenAIRealtimeSession,
  createStreamingSTT,
  transcribeBatchOpenAI,
  transcribeBatchGemini
};

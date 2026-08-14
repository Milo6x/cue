const test = require('node:test');
const assert = require('node:assert');
const { looksLikeHallucination, buildVocabPrompt } = require('../src/stt');
const {
  DeepgramStreamingSTT,
  OpenAIRealtimeSTT,
  buildOpenAIRealtimeSession
} = require('../src/stt-streaming');

test('looksLikeHallucination drops Whisper silence artifacts', () => {
  ['', '   ', 'Thank you for watching.', 'thanks for watching', 'Bye-bye!', '👍👍'].forEach((s) => {
    assert.equal(looksLikeHallucination(s), true, JSON.stringify(s));
  });
});

test('looksLikeHallucination keeps real speech', () => {
  ['Tell me about your experience with Kubernetes.', 'You know, I led the migration.'].forEach((s) => {
    assert.equal(looksLikeHallucination(s), false, JSON.stringify(s));
  });
});

test('buildVocabPrompt seeds base vocab and resume proper nouns, capped', () => {
  const p = buildVocabPrompt({ resumeText: 'Optum EKS Terraform', jobDescription: 'AWS SRE' });
  assert.ok(p.includes('Kubernetes'));
  assert.ok(p.includes('Optum'));
  assert.ok(p.length <= 850);
  assert.ok(buildVocabPrompt(undefined).length > 0);
  assert.ok(buildVocabPrompt({ resumeText: 'Xyzzy '.repeat(4000) }).length <= 850);
});

test('Deepgram accumulates is_final segments into one turn at speech_final', () => {
  const finals = [];
  const d = new DeepgramStreamingSTT('k', { onTranscript: (t) => finals.push(t) });
  d._handleMessage({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'Tell me about' }] } });
  d._handleMessage({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'your experience' }] } });
  d._handleMessage({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'with Kubernetes.' }] } });
  assert.deepEqual(finals, ['Tell me about your experience with Kubernetes.']);
});

test('Deepgram flushes pending segments on UtteranceEnd when speech_final never arrives', () => {
  const finals = [];
  const d = new DeepgramStreamingSTT('k', { onTranscript: (t) => finals.push(t) });
  d._handleMessage({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'hello there' }] } });
  d._handleMessage({ type: 'UtteranceEnd' });
  assert.deepEqual(finals, ['hello there']);
  d._handleMessage({ type: 'UtteranceEnd' });
  assert.deepEqual(finals, ['hello there'], 'no duplicate emit on a second UtteranceEnd');
});

test('Deepgram drops hallucinated finals', () => {
  const finals = [];
  const d = new DeepgramStreamingSTT('k', { onTranscript: (t) => finals.push(t) });
  d._handleMessage({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'Thank you.' }] } });
  assert.deepEqual(finals, []);
});

test('OpenAI realtime defaults to live transcription with English context tuned for accuracy', () => {
  const session = buildOpenAIRealtimeSession({
    vocabPrompt: buildVocabPrompt({ resumeText: 'Optum EKS Terraform' })
  });
  const transcription = session.audio.input.transcription;

  assert.equal(transcription.model, 'gpt-live-transcribe');
  assert.deepEqual(transcription.languages, ['en']);
  assert.equal(transcription.delay, 'medium');
  assert.ok(transcription.prompt.includes('Kubernetes'));
  assert.ok(transcription.keywords.includes('Optum'));
  assert.equal(Object.hasOwn(transcription, 'language'), false);
});

test('OpenAI realtime drops shared hallucinations, punctuation, and unexpected single-character Hangul without dropping words or numbers', () => {
  const finals = [];
  const stt = new OpenAIRealtimeSTT('k', { onTranscript: (text) => finals.push(text) });

  [' ', '…', '?!', '한', 'Thank you for watching.', 'I', '42'].forEach((transcript) => {
    stt._handleEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript });
  });

  assert.deepEqual(finals, ['I', '42']);
});

test('OpenAI realtime ignores deltas and finals received after disconnect', () => {
  const interim = [];
  const finals = [];
  const stt = new OpenAIRealtimeSTT('k', {
    onInterim: (text) => interim.push(text),
    onTranscript: (text) => finals.push(text)
  });

  stt.disconnect();
  stt._handleEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'late' });
  stt._handleEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'late final' });

  assert.deepEqual(interim, []);
  assert.deepEqual(finals, []);
});

test('OpenAI realtime holds buffered audio until its transcription configuration is accepted', () => {
  const errors = [];
  const stt = new OpenAIRealtimeSTT('k', { onError: (error) => errors.push(error) });
  let flushes = 0;
  stt._flushPendingAudio = () => { flushes++; };

  stt._handleEvent({ type: 'session.created' });
  assert.equal(stt._sessionReady, false);
  assert.equal(flushes, 0);

  stt._handleEvent({ type: 'error', error: { message: 'bad configuration', code: 'invalid_request_error' } });
  assert.equal(stt._sessionReady, false);
  assert.deepEqual(errors, [{ provider: 'openai-realtime', message: 'bad configuration', status: 'invalid_request_error' }]);

  stt._handleEvent({ type: 'session.updated' });
  assert.equal(stt._sessionReady, true);
  assert.equal(flushes, 1);
});

test('OpenAI realtime emits completed turns in committed chronology when completions arrive out of order', () => {
  const finals = [];
  const stt = new OpenAIRealtimeSTT('k', { onTranscript: (text) => finals.push(text) });

  stt._handleEvent({ type: 'input_audio_buffer.committed', item_id: 'item-a', previous_item_id: 'root' });
  stt._handleEvent({ type: 'input_audio_buffer.committed', item_id: 'item-b', previous_item_id: 'item-a' });
  stt._handleEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-b', transcript: 'second' });
  assert.deepEqual(finals, []);

  stt._handleEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-a', transcript: 'first' });
  assert.deepEqual(finals, ['first', 'second']);
});

test('OpenAI realtime transcription failure unblocks later turns and ignores the failed item late final', () => {
  const finals = [];
  const errors = [];
  const stt = new OpenAIRealtimeSTT('k', {
    onTranscript: (text) => finals.push(text),
    onError: (error) => errors.push(error)
  });

  stt._handleEvent({ type: 'input_audio_buffer.committed', item_id: 'item-a', previous_item_id: 'root' });
  stt._handleEvent({ type: 'input_audio_buffer.committed', item_id: 'item-b', previous_item_id: 'item-a' });
  stt._handleEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-b', transcript: 'second' });
  stt._handleEvent({
    type: 'conversation.item.input_audio_transcription.failed',
    item_id: 'item-a',
    error: { message: 'could not transcribe', code: 'transcription_failed' }
  });

  assert.deepEqual(finals, ['second']);
  assert.deepEqual(errors, [{ provider: 'openai-realtime', message: 'could not transcribe', status: 'transcription_failed' }]);

  stt._handleEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-a', transcript: 'late first' });
  assert.deepEqual(finals, ['second']);
});

test('OpenAI realtime bounds a turn whose predecessor ID never arrives and falls back for finals without IDs', async () => {
  const finals = [];
  const stt = new OpenAIRealtimeSTT('k', {
    reorderTimeoutMs: 10,
    onTranscript: (text) => finals.push(text)
  });

  stt._handleEvent({ type: 'input_audio_buffer.committed', item_id: 'item-b', previous_item_id: 'missing-item-a' });
  stt._handleEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-b', transcript: 'tracked second' });
  assert.deepEqual(finals, []);

  stt._handleEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'fallback without id' });
  assert.deepEqual(finals, ['fallback without id']);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(finals, ['fallback without id', 'tracked second']);
});

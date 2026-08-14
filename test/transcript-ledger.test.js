const test = require('node:test');
const assert = require('node:assert/strict');

const { createTranscriptLedger, formatTranscriptForPrompt, normalizeText } = require('../src/transcript-ledger');

test('appends normalized valid turns with timestamps and sequences', () => {
  let time = 100;
  const ledger = createTranscriptLedger({ now: () => time++ });

  assert.deepEqual(ledger.append('them', '  Tell me about yourself.  '), {
    channel: 'them', text: 'Tell me about yourself.', ts: 100, seq: 1
  });
  assert.deepEqual(ledger.append('you', 'I build reliable products.'), {
    channel: 'you', text: 'I build reliable products.', ts: 101, seq: 2
  });
  assert.equal(ledger.append('other', 'Not a participant'), null);
  assert.equal(ledger.append('them', ' ?!… '), null);
  assert.equal(ledger.append('them', 'x'), null);
  assert.equal(normalizeText(42), '42');
  assert.equal(normalizeText('  hello  '), 'hello');
  assert.equal(ledger.length, 2);
});

test('caps oldest turns while retaining monotonic sequences and formats prompt labels', () => {
  const ledger = createTranscriptLedger({ maxTurns: 2, now: () => 123 });
  ledger.append('them', 'First question');
  ledger.append('you', 'First answer');
  ledger.append('them', 'Second question');

  const turns = ledger.list();
  assert.deepEqual(turns, [
    { channel: 'you', text: 'First answer', ts: 123, seq: 2 },
    { channel: 'them', text: 'Second question', ts: 123, seq: 3 }
  ]);
  assert.equal(formatTranscriptForPrompt(turns), 'You: First answer\nMeeting: Second question');
});

test('clear removes turns and restarts the sequence', () => {
  const ledger = createTranscriptLedger({ now: () => 123 });
  ledger.append('them', 'Before clear');
  ledger.clear();

  assert.equal(ledger.length, 0);
  assert.deepEqual(ledger.append('you', 'After clear'), {
    channel: 'you', text: 'After clear', ts: 123, seq: 1
  });
});

test('returned turns cannot mutate ledger state', () => {
  const ledger = createTranscriptLedger({ now: () => 123 });
  const appended = ledger.append('them', 'Original');
  appended.text = 'Changed append result';
  const listed = ledger.list();
  listed[0].text = 'Changed list result';

  assert.deepEqual(ledger.list(), [
    { channel: 'them', text: 'Original', ts: 123, seq: 1 }
  ]);
});

test('normalizes unsafe maxTurns to a bounded minimum', () => {
  for (const maxTurns of [0, -1, Number.NaN, Infinity, 'two']) {
    const ledger = createTranscriptLedger({ maxTurns, now: () => 123 });
    ledger.append('them', 'First');
    ledger.append('you', 'Second');
    assert.equal(ledger.length, 1, `maxTurns ${String(maxTurns)} must not be unbounded`);
    assert.equal(ledger.list()[0].text, 'Second');
  }
});

test('formats empty and malformed turn lists safely', () => {
  assert.equal(formatTranscriptForPrompt([]), '');
  assert.equal(formatTranscriptForPrompt(null), '');
  assert.equal(formatTranscriptForPrompt([
    { channel: 'them', text: '  Meeting question  ' },
    { channel: 'unknown', text: 'Do not include' },
    { channel: 'you', text: '!' },
    null,
    { channel: 'you', text: '  My answer  ' }
  ]), 'Meeting: Meeting question\nYou: My answer');
});

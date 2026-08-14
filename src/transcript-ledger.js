const VALID_CHANNELS = new Set(['you', 'them']);

function normalizeText(text) {
  if (text === null || text === undefined) return null;
  const normalized = String(text).trim();
  if (!normalized || normalized.length <= 1 || /^[?!.,;:\-…]+$/.test(normalized)) return null;
  return normalized;
}

function normalizeMaxTurns(maxTurns) {
  return Number.isFinite(maxTurns) && Number.isInteger(maxTurns) && maxTurns > 0
    ? maxTurns
    : 1;
}

function createTranscriptLedger({ maxTurns = 200, now = Date.now } = {}) {
  const limit = normalizeMaxTurns(maxTurns);
  const clock = typeof now === 'function' ? now : Date.now;
  const turns = [];
  let nextSequence = 1;

  function copy(turn) {
    return { ...turn };
  }

  return {
    append(channel, text) {
      if (!VALID_CHANNELS.has(channel)) return null;
      const normalized = normalizeText(text);
      if (!normalized) return null;

      const turn = { channel, text: normalized, ts: clock(), seq: nextSequence++ };
      turns.push(turn);
      if (turns.length > limit) turns.splice(0, turns.length - limit);
      return copy(turn);
    },
    list() {
      return turns.map(copy);
    },
    clear() {
      turns.splice(0, turns.length);
      nextSequence = 1;
    },
    get length() {
      return turns.length;
    }
  };
}

function formatTranscriptForPrompt(turns) {
  if (!Array.isArray(turns)) return '';
  return turns.flatMap((turn) => {
    if (!turn || !VALID_CHANNELS.has(turn.channel)) return [];
    const text = normalizeText(turn.text);
    if (!text) return [];
    return `${turn.channel === 'them' ? 'Meeting' : 'You'}: ${text}`;
  }).join('\n');
}

module.exports = { createTranscriptLedger, formatTranscriptForPrompt, normalizeText };

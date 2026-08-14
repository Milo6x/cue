const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 192_000;
const MAX_CHANNEL_COUNT = 32;
const MAX_PACKET_BYTES = 256 * 1024;
const NORMALIZED_SAMPLE_RATE = 16_000;

function isSupportedSampleRate(value) {
  return Number.isInteger(value) && value >= MIN_SAMPLE_RATE && value <= MAX_SAMPLE_RATE;
}

function isSupportedChannelCount(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_CHANNEL_COUNT;
}

function resampleMonoPcm16(input, sourceRate, targetRate) {
  const source = Buffer.from(input || []);
  if (!isSupportedSampleRate(sourceRate) || !isSupportedSampleRate(targetRate) || source.length % 2 !== 0) {
    throw new RangeError('PCM must be complete 16-bit mono samples at a supported sample rate.');
  }
  if (sourceRate === targetRate) return Buffer.from(source);

  const sourceFrames = source.length / 2;
  if (sourceFrames === 0) return Buffer.alloc(0);
  const outputFrames = Math.round(sourceFrames * targetRate / sourceRate);
  const output = Buffer.alloc(outputFrames * 2);
  for (let outputIndex = 0; outputIndex < outputFrames; outputIndex += 1) {
    const sourcePosition = outputIndex * sourceRate / targetRate;
    const lowerIndex = Math.min(Math.floor(sourcePosition), Math.max(0, sourceFrames - 1));
    const upperIndex = Math.min(lowerIndex + 1, Math.max(0, sourceFrames - 1));
    const fraction = sourcePosition - lowerIndex;
    const lower = source.readInt16LE(lowerIndex * 2);
    const upper = source.readInt16LE(upperIndex * 2);
    const sample = Math.round(lower + (upper - lower) * fraction);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), outputIndex * 2);
  }
  return output;
}

function normalizeCapturePacket(value) {
  if (!value || typeof value !== 'object') return null;
  const { pcm, sampleRate, channelCount } = value;
  if (!(pcm instanceof ArrayBuffer) || pcm.byteLength === 0 || pcm.byteLength > MAX_PACKET_BYTES || pcm.byteLength % 2 !== 0) return null;
  if (!isSupportedSampleRate(sampleRate) || !isSupportedChannelCount(channelCount)) return null;

  return {
    pcm: resampleMonoPcm16(Buffer.from(pcm), sampleRate, NORMALIZED_SAMPLE_RATE),
    sampleRate,
    channelCount
  };
}

module.exports = {
  MAX_PACKET_BYTES,
  NORMALIZED_SAMPLE_RATE,
  isSupportedChannelCount,
  isSupportedSampleRate,
  normalizeCapturePacket,
  resampleMonoPcm16
};

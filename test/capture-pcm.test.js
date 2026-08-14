const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeCapturePacket, resampleMonoPcm16 } = require('../src/capture-pcm');

function pcmWithConstantSample(sample, frames) {
  const pcm = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index += 1) pcm.writeInt16LE(sample, index * 2);
  return pcm;
}

test('resamples mono PCM16 from 16 kHz, 44.1 kHz, and 48 kHz without changing duration or a constant amplitude', () => {
  for (const sourceRate of [16000, 44100, 48000]) {
    const source = pcmWithConstantSample(12000, sourceRate);
    const output = resampleMonoPcm16(source, sourceRate, 24000);

    assert.equal(output.length, 24000 * 2, `${sourceRate} Hz must remain one second`);
    assert.equal(output.readInt16LE(0), 12000);
    assert.equal(output.readInt16LE(output.length - 2), 12000);
  }
});

test('normalizes a bounded renderer capture packet to 16 kHz mono PCM and retains only safe telemetry', () => {
  const source = pcmWithConstantSample(8000, 4800);
  const normalized = normalizeCapturePacket({
    pcm: source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength),
    sampleRate: 48000,
    channelCount: 2,
    transcript: 'never accepted'
  });

  assert.ok(normalized);
  assert.equal(normalized.pcm.length, 1600 * 2);
  assert.equal(normalized.sampleRate, 48000);
  assert.equal(normalized.channelCount, 2);
  assert.equal(normalized.pcm.readInt16LE(0), 8000);
  assert.equal(Object.hasOwn(normalized, 'transcript'), false);
});

test('rejects malformed, oversized, and non-ArrayBuffer capture packets', () => {
  assert.equal(normalizeCapturePacket({ pcm: Buffer.alloc(8), sampleRate: 16000, channelCount: 1 }), null);
  assert.equal(normalizeCapturePacket({ pcm: new ArrayBuffer(7), sampleRate: 16000, channelCount: 1 }), null);
  assert.equal(normalizeCapturePacket({ pcm: new ArrayBuffer(8), sampleRate: 1, channelCount: 1 }), null);
  assert.equal(normalizeCapturePacket({ pcm: new ArrayBuffer(512 * 1024), sampleRate: 16000, channelCount: 1 }), null);
});

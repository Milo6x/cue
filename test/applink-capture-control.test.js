const assert = require('node:assert/strict');
const test = require('node:test');
const { controlCapture } = require('../src/applink-capture-control');

test('rejects remote capture starts because meeting audio needs a cue user gesture', async () => {
  await assert.rejects(
    () => controlCapture(true, { requestStop: async () => ({ stopped: true }) }),
    /started from cue.*user gesture/i
  );
});

test('waits for the renderer stop acknowledgement before reporting stopped', async () => {
  let requested = false;
  const result = await controlCapture(false, {
    requestStop: async () => {
      requested = true;
      return { stopped: true };
    }
  });

  assert.equal(requested, true);
  assert.deepEqual(result, { capturing: false });
});

test('does not claim a remote stop succeeded when renderer acknowledgement fails', async () => {
  await assert.rejects(
    () => controlCapture(false, { requestStop: async () => { throw new Error('cue window is unavailable'); } }),
    /cue window is unavailable/
  );
});

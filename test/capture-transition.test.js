const assert = require('node:assert/strict');
const test = require('node:test');
const { createCaptureTransitionController } = require('../src/capture-transition');

test('uses the latest explicit capture request when true false true arrives before work runs', async () => {
  let active = false;
  const applied = [];
  const controller = createCaptureTransitionController({
    readState: () => active,
    setCapturing: async (next) => {
      applied.push(next);
      active = next;
      return active;
    }
  });

  await Promise.all([controller.request(true), controller.request(false), controller.request(true)]);

  assert.deepEqual(applied, [true, true, true]);
  assert.equal(active, true);
  assert.equal(controller.desired, true);
});

test('runs force-stop only for an explicit inactive request while inactive', async () => {
  let forceStops = 0;
  const controller = createCaptureTransitionController({
    readState: () => false,
    setCapturing: async (next) => next,
    forceStop: () => { forceStops += 1; }
  });

  await controller.request(false);
  assert.equal(forceStops, 1);
});

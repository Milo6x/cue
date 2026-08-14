const assert = require('node:assert/strict');
const test = require('node:test');
const { CaptureStatusTracker } = require('../renderer/capture-status-tracker');

const off = {
  session: { state: 'off' },
  microphone: { state: 'off', errorCategory: null, errorMessage: null },
  system: { state: 'off', errorCategory: null, errorMessage: null }
};

test('retains the highest-priority startup failure through terminal off', () => {
  const tracker = new CaptureStatusTracker();
  const failed = {
    session: { state: 'starting' },
    microphone: { state: 'failed', errorCategory: 'device', errorMessage: 'Choose a working microphone.' },
    system: { state: 'failed', errorCategory: 'permission', errorMessage: 'Allow Screen & System Audio Recording.' }
  };

  assert.equal(tracker.select(failed), 'Allow Screen & System Audio Recording.');
  assert.equal(tracker.select(off), 'Allow Screen & System Audio Recording.');
});

test('retains a partial channel failure while the sibling is ready', () => {
  const tracker = new CaptureStatusTracker();
  const partial = {
    session: { state: 'ready' },
    microphone: { state: 'ready', errorCategory: null, errorMessage: null },
    system: { state: 'failed', errorCategory: 'busy', errorMessage: 'Meeting audio is busy.' }
  };

  assert.equal(tracker.select(partial), 'Meeting audio is busy.');
  assert.equal(tracker.select({ ...partial, system: { state: 'off', errorCategory: null, errorMessage: null } }), 'Meeting audio is busy.');
});

test('clears a retained capture failure when the user takes the next capture action', () => {
  const tracker = new CaptureStatusTracker();
  tracker.select({
    session: { state: 'off' },
    microphone: { state: 'failed', errorCategory: 'permission', errorMessage: 'Allow microphone access.' },
    system: { state: 'off', errorCategory: null, errorMessage: null }
  });

  tracker.clear();
  assert.equal(tracker.select(off), null);
});

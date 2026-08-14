const assert = require('node:assert/strict');
const test = require('node:test');
const { CaptureCoordinator } = require('../renderer/capture-coordinator');

function createDrivers({ microphoneStart, systemStart } = {}) {
  const calls = {
    microphone: { start: 0, stop: 0 },
    system: { start: 0, stop: 0 }
  };

  return {
    calls,
    channels: {
      microphone: {
        async start() {
          calls.microphone.start += 1;
          return microphoneStart ? microphoneStart() : { trackLabel: 'Built-in Microphone' };
        },
        async stop() {
          calls.microphone.stop += 1;
        }
      },
      system: {
        async start() {
          calls.system.start += 1;
          return systemStart ? systemStart() : { trackLabel: 'Zoom Audio' };
        },
        async stop() {
          calls.system.stop += 1;
        }
      }
    }
  };
}

test('keeps microphone ready when system audio fails', async () => {
  const drivers = createDrivers({
    systemStart: async () => {
      throw { category: 'permission', message: 'System audio access was denied' };
    }
  });
  const pipelineCalls = [];
  const coordinator = new CaptureCoordinator({
    channels: drivers.channels,
    setPipelineActive: async (active) => {
      pipelineCalls.push(active);
      return true;
    }
  });

  await coordinator.start();

  assert.deepEqual(pipelineCalls, [true]);
  assert.deepEqual(coordinator.snapshot(), {
    session: { state: 'ready' },
    microphone: {
      state: 'ready',
      trackLabel: 'Built-in Microphone',
      errorCategory: null,
      errorMessage: null
    },
    system: {
      state: 'failed',
      trackLabel: null,
      errorCategory: 'permission',
      errorMessage: 'System audio access was denied'
    }
  });
});

test('returns to off and cleans both drivers when both channels fail', async () => {
  const drivers = createDrivers({
    microphoneStart: async () => { throw new Error('Microphone unavailable'); },
    systemStart: async () => { throw { category: 'device', message: 'System audio unavailable' }; }
  });
  const pipelineCalls = [];
  const coordinator = new CaptureCoordinator({
    channels: drivers.channels,
    setPipelineActive: async (active) => {
      pipelineCalls.push(active);
      return true;
    }
  });

  await coordinator.start();

  assert.deepEqual(pipelineCalls, []);
  assert.deepEqual(drivers.calls, {
    microphone: { start: 1, stop: 1 },
    system: { start: 1, stop: 1 }
  });
  assert.deepEqual(coordinator.snapshot(), {
    session: { state: 'off' },
    microphone: { state: 'off', trackLabel: null, errorCategory: null, errorMessage: null },
    system: { state: 'off', trackLabel: null, errorCategory: null, errorMessage: null }
  });
});

test('deduplicates concurrent starts and concurrent stops', async () => {
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const drivers = createDrivers({
    microphoneStart: async () => {
      await startGate;
      return { trackLabel: 'Built-in Microphone' };
    },
    systemStart: async () => {
      await startGate;
      return { trackLabel: 'Zoom Audio' };
    }
  });
  const coordinator = new CaptureCoordinator({
    channels: drivers.channels,
    setPipelineActive: async () => true
  });

  const firstStart = coordinator.start();
  const secondStart = coordinator.start();
  releaseStart();
  await Promise.all([firstStart, secondStart]);

  await Promise.all([coordinator.stop(), coordinator.stop()]);

  assert.deepEqual(drivers.calls, {
    microphone: { start: 1, stop: 1 },
    system: { start: 1, stop: 1 }
  });
  assert.equal(coordinator.snapshot().session.state, 'off');
});

test('keeps capture off when stop interrupts an in-flight start', async () => {
  let releaseMicrophone;
  let releaseSystem;
  const microphoneGate = new Promise((resolve) => { releaseMicrophone = resolve; });
  const systemGate = new Promise((resolve) => { releaseSystem = resolve; });
  const drivers = createDrivers({
    microphoneStart: async () => {
      await microphoneGate;
      return { trackLabel: 'Built-in Microphone' };
    },
    systemStart: async () => {
      await systemGate;
      return { trackLabel: 'Zoom Audio' };
    }
  });
  const pipelineCalls = [];
  const changes = [];
  const coordinator = new CaptureCoordinator({
    channels: drivers.channels,
    setPipelineActive: async (active) => {
      pipelineCalls.push(active);
      return true;
    },
    onChange: (snapshot) => changes.push(snapshot)
  });

  const starting = coordinator.start();
  const stopping = coordinator.stop();
  releaseMicrophone();
  releaseSystem();
  await Promise.all([starting, stopping]);

  assert.deepEqual(coordinator.snapshot(), {
    session: { state: 'off' },
    microphone: { state: 'off', trackLabel: null, errorCategory: null, errorMessage: null },
    system: { state: 'off', trackLabel: null, errorCategory: null, errorMessage: null }
  });
  assert.equal(pipelineCalls.at(-1), false);
  assert.deepEqual(drivers.calls, {
    microphone: { start: 1, stop: 1 },
    system: { start: 1, stop: 1 }
  });
  assert.ok(!changes.some((snapshot) => snapshot.session.state === 'ready'));
});

test('starts a new lifecycle only after an interrupted start has stopped', async () => {
  let releaseMicrophone;
  let releaseSystem;
  const microphoneGate = new Promise((resolve) => { releaseMicrophone = resolve; });
  const systemGate = new Promise((resolve) => { releaseSystem = resolve; });
  let microphoneStarts = 0;
  let systemStarts = 0;
  const drivers = createDrivers({
    microphoneStart: async () => {
      microphoneStarts += 1;
      if (microphoneStarts === 1) await microphoneGate;
      return { trackLabel: 'Built-in Microphone' };
    },
    systemStart: async () => {
      systemStarts += 1;
      if (systemStarts === 1) await systemGate;
      return { trackLabel: 'Zoom Audio' };
    }
  });
  const pipelineCalls = [];
  const coordinator = new CaptureCoordinator({
    channels: drivers.channels,
    setPipelineActive: async (active) => {
      pipelineCalls.push(active);
      return true;
    }
  });

  const firstStart = coordinator.start();
  const stopping = coordinator.stop();
  const secondStart = coordinator.start();
  releaseMicrophone();
  releaseSystem();
  await Promise.all([firstStart, stopping, secondStart]);

  assert.equal(coordinator.snapshot().session.state, 'ready');
  assert.deepEqual(drivers.calls, {
    microphone: { start: 2, stop: 1 },
    system: { start: 2, stop: 1 }
  });
  assert.deepEqual(pipelineCalls, [false, true]);
});

test('cleans partial resources when pipeline activation is unavailable', async () => {
  const drivers = createDrivers();
  const pipelineCalls = [];
  const coordinator = new CaptureCoordinator({
    channels: drivers.channels,
    setPipelineActive: async (active) => {
      pipelineCalls.push(active);
      return false;
    }
  });

  await coordinator.start();

  assert.deepEqual(pipelineCalls, [true]);
  assert.deepEqual(drivers.calls, {
    microphone: { start: 1, stop: 1 },
    system: { start: 1, stop: 1 }
  });
  assert.equal(coordinator.snapshot().session.state, 'off');
});

test('isolates snapshots from caller and change-listener mutations', async () => {
  const drivers = createDrivers();
  const changes = [];
  const coordinator = new CaptureCoordinator({
    channels: drivers.channels,
    setPipelineActive: async () => true,
    onChange: (snapshot) => changes.push(snapshot)
  });

  const initial = coordinator.snapshot();
  initial.microphone.state = 'failed';
  await coordinator.start();
  const beforeMutation = coordinator.snapshot();
  changes[changes.length - 1].microphone.trackLabel = 'tampered';
  const afterMutation = coordinator.snapshot();

  assert.equal(beforeMutation.microphone.trackLabel, 'Built-in Microphone');
  assert.equal(afterMutation.microphone.trackLabel, 'Built-in Microphone');
  assert.equal(coordinator.snapshot().microphone.state, 'ready');
});

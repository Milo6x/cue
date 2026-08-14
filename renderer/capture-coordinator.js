(function exposeCaptureCoordinator(root) {
  class CaptureCoordinator {
    constructor({ channels, setPipelineActive, onChange = () => {} }) {
      this.channels = channels;
      this.setPipelineActive = setPipelineActive;
      this.onChange = onChange;
      this.startPromise = null;
      this.stopPromise = null;
      this.teardownPromise = null;
      this.lifecycleVersion = 0;
      this.state = this.createOffState();
    }

    snapshot() {
      return this.copyState();
    }

    start() {
      if (this.stopPromise) return this.stopPromise.then(() => this.start());
      if (this.startPromise) return this.startPromise;
      if (this.state.session.state === 'ready') return Promise.resolve(this.snapshot());

      const lifecycleVersion = this.lifecycleVersion;
      this.startPromise = this.startSession(lifecycleVersion).finally(() => {
        this.startPromise = null;
      });
      return this.startPromise;
    }

    stop() {
      if (this.stopPromise) return this.stopPromise;
      if (this.state.session.state === 'off') return Promise.resolve(this.snapshot());

      this.lifecycleVersion += 1;
      this.stopPromise = this.stopSession(this.startPromise).finally(() => {
        this.stopPromise = null;
      });
      return this.stopPromise;
    }

    async startSession(lifecycleVersion) {
      this.state.session.state = 'starting';
      this.setChannelStarting('microphone');
      this.setChannelStarting('system');
      this.publish();

      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.channels.microphone.start()),
        Promise.resolve().then(() => this.channels.system.start())
      ]);

      if (!this.isCurrentLifecycle(lifecycleVersion)) return this.snapshot();

      this.applyChannelResult('microphone', results[0]);
      this.applyChannelResult('system', results[1]);
      this.publish();

      const hasUsableChannel = ['microphone', 'system'].some(
        (name) => this.state[name].state === 'ready'
      );
      if (!hasUsableChannel) {
        await this.cleanupAfterFailedStart();
        return this.snapshot();
      }

      let pipelineActive = false;
      try {
        pipelineActive = await this.setPipelineActive(true);
      } catch (_) {
        pipelineActive = false;
      }

      if (!this.isCurrentLifecycle(lifecycleVersion)) {
        return this.snapshot();
      }

      if (!pipelineActive) {
        await this.cleanupAfterFailedStart();
        return this.snapshot();
      }

      this.state.session.state = 'ready';
      this.publish();
      return this.snapshot();
    }

    async stopSession(interruptedStart) {
      this.state.session.state = 'stopping';
      this.publish();
      if (interruptedStart) await interruptedStart;
      if (this.state.session.state !== 'off') await this.teardown();
      return this.snapshot();
    }

    isCurrentLifecycle(lifecycleVersion) {
      return lifecycleVersion === this.lifecycleVersion;
    }

    async cleanupAfterFailedStart() {
      await this.teardown();
    }

    teardown() {
      if (this.teardownPromise) return this.teardownPromise;

      this.teardownPromise = this.performTeardown().finally(() => {
        this.teardownPromise = null;
      });
      return this.teardownPromise;
    }

    async performTeardown() {
      this.state.session.state = 'stopping';
      this.publish();
      await Promise.allSettled([
        Promise.resolve().then(() => this.setPipelineActive(false)),
        Promise.resolve().then(() => this.channels.microphone.stop()),
        Promise.resolve().then(() => this.channels.system.stop())
      ]);
      this.state = this.createOffState();
      this.publish();
    }

    setChannelStarting(name) {
      this.state[name] = {
        state: 'starting',
        trackLabel: null,
        errorCategory: null,
        errorMessage: null
      };
    }

    applyChannelResult(name, result) {
      if (result.status === 'fulfilled') {
        this.state[name] = {
          state: 'ready',
          trackLabel: result.value && result.value.trackLabel ? result.value.trackLabel : null,
          errorCategory: null,
          errorMessage: null
        };
        return;
      }

      const reason = result.reason;
      const details = reason && (typeof reason === 'object' || typeof reason === 'function')
        ? reason
        : {};
      this.state[name] = {
        state: 'failed',
        trackLabel: null,
        errorCategory: details.category || 'capture',
        errorMessage: this.safeMessage(details.message == null ? reason : details.message)
      };
    }

    safeMessage(message) {
      if (typeof message === 'string') return message;
      if (message == null) return null;
      try {
        return String(message);
      } catch (_) {
        return null;
      }
    }

    createOffState() {
      return {
        session: { state: 'off' },
        microphone: { state: 'off', trackLabel: null, errorCategory: null, errorMessage: null },
        system: { state: 'off', trackLabel: null, errorCategory: null, errorMessage: null }
      };
    }

    copyState() {
      return JSON.parse(JSON.stringify(this.state));
    }

    publish() {
      try {
        this.onChange(this.copyState());
      } catch (_) {
        // State observers cannot interrupt capture lifecycle cleanup.
      }
    }
  }

  const api = { CaptureCoordinator };
  root.CueCapture = root.CueCapture || {};
  root.CueCapture.CaptureCoordinator = CaptureCoordinator;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));

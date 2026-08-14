(function exposeCaptureCoordinator(root) {
  class CaptureCoordinator {
    constructor({ channels, setPipelineActive, onChange = () => {} }) {
      this.channels = channels;
      this.setPipelineActive = setPipelineActive;
      this.onChange = onChange;
      this.startPromise = null;
      this.stopPromise = null;
      this.state = this.createOffState();
    }

    snapshot() {
      return this.copyState();
    }

    start() {
      if (this.startPromise) return this.startPromise;
      if (this.state.session.state === 'ready') return Promise.resolve(this.snapshot());
      if (this.stopPromise) return this.stopPromise.then(() => this.start());

      this.startPromise = this.startSession().finally(() => {
        this.startPromise = null;
      });
      return this.startPromise;
    }

    stop() {
      if (this.stopPromise) return this.stopPromise;
      if (this.state.session.state === 'off') return Promise.resolve(this.snapshot());

      this.stopPromise = this.stopSession().finally(() => {
        this.stopPromise = null;
      });
      return this.stopPromise;
    }

    async startSession() {
      this.state.session.state = 'starting';
      this.setChannelStarting('microphone');
      this.setChannelStarting('system');
      this.publish();

      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.channels.microphone.start()),
        Promise.resolve().then(() => this.channels.system.start())
      ]);

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

      if (!pipelineActive) {
        await this.cleanupAfterFailedStart();
        return this.snapshot();
      }

      this.state.session.state = 'ready';
      this.publish();
      return this.snapshot();
    }

    async stopSession() {
      this.state.session.state = 'stopping';
      this.publish();
      await this.setPipelineActive(false);
      await Promise.allSettled([
        Promise.resolve().then(() => this.channels.microphone.stop()),
        Promise.resolve().then(() => this.channels.system.stop())
      ]);
      this.state = this.createOffState();
      this.publish();
      return this.snapshot();
    }

    async cleanupAfterFailedStart() {
      this.state.session.state = 'stopping';
      this.publish();
      await Promise.allSettled([
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

      const reason = result.reason || {};
      this.state[name] = {
        state: 'failed',
        trackLabel: null,
        errorCategory: reason.category || 'capture',
        errorMessage: this.safeMessage(reason.message)
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
      this.onChange(this.copyState());
    }
  }

  const api = { CaptureCoordinator };
  root.CueCapture = root.CueCapture || {};
  root.CueCapture.CaptureCoordinator = CaptureCoordinator;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));

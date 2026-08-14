(function exposeCaptureStatusTracker(root) {
  class CaptureStatusTracker {
    constructor() {
      this.message = null;
    }

    select(snapshot) {
      const failures = ['microphone', 'system']
        .map((name) => snapshot && snapshot[name])
        .filter((channel) => channel && channel.state === 'failed' && channel.errorMessage);
      if (failures.length) {
        failures.sort((a, b) => this.priority(b.errorCategory) - this.priority(a.errorCategory));
        this.message = failures[0].errorMessage;
      }
      return this.message;
    }

    clear() {
      this.message = null;
    }

    priority(category) {
      return ({ permission: 4, device: 3, busy: 2, unsupported: 1, capture: 0 })[category] ?? 0;
    }
  }

  const api = { CaptureStatusTracker };
  root.CueCaptureStatus = root.CueCaptureStatus || {};
  root.CueCaptureStatus.CaptureStatusTracker = CaptureStatusTracker;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));

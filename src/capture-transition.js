function createCaptureTransitionController({ readState, setCapturing, forceStop = () => {} }) {
  let desired = false;
  let transition = Promise.resolve(false);

  return {
    get desired() { return desired; },
    set desired(next) { desired = !!next; },
    request(targetState) {
      desired = !!targetState;
      if (!desired && !readState()) forceStop();
      transition = transition
        .catch(() => readState())
        .then(() => setCapturing(desired));
      return transition;
    },
    toggle() {
      return this.request(!desired);
    }
  };
}

module.exports = { createCaptureTransitionController };

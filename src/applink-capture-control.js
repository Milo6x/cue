const REMOTE_START_MESSAGE = 'Listening must be started from cue because macOS requires a user gesture for meeting audio.';

async function controlCapture(active, { requestStop }) {
  if (active) throw new Error(REMOTE_START_MESSAGE);
  if (typeof requestStop !== 'function') throw new Error('cue cannot stop listening because the cue window is unavailable.');
  const result = await requestStop();
  if (!result || result.stopped !== true) throw new Error('cue could not confirm that listening stopped.');
  return { capturing: false };
}

module.exports = { controlCapture, REMOTE_START_MESSAGE };

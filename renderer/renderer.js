/* cue renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const cue = window.cue; // exposed by preload
  const $ = (s) => document.querySelector(s);
  const isWindows = cue.platform === 'win32';
  const isMac = cue.platform === 'darwin';

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('logo', { size: 18 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14 });
  $('#stop-btn').innerHTML = icon('stop-square', { size: 15 });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('sparkles', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="followup"] .ic').innerHTML = icon('message-circle', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });
  const clearIC = document.querySelector('#clear-transcript-btn .ic');
  if (clearIC) clearIC.innerHTML = icon('trash-2', { size: 15 });

  const screenshotPrivacyButton = $('#screenshot-privacy-btn');
  function renderContentProtection(snapshot) {
    if (!screenshotPrivacyButton || !snapshot) return;
    const blocked = snapshot.enabled === true;
    const unavailable = snapshot.supported === false;
    screenshotPrivacyButton.textContent = unavailable
      ? 'Screen-share protection unavailable'
      : (blocked ? 'Screen-share protection: on (best effort)' : 'Screenshots allowed for support');
    screenshotPrivacyButton.setAttribute('aria-pressed', String(blocked));
    screenshotPrivacyButton.setAttribute('aria-label', blocked
      ? 'Best-effort screen-share protection is on. Activate to allow screenshots for support.'
      : 'Screenshots are allowed for support. Activate to turn on best-effort screen-share protection.');
    screenshotPrivacyButton.disabled = unavailable;
  }
  async function refreshContentProtection() {
    try {
      renderContentProtection(await cue.contentProtectionGet());
    } catch (_) {
      renderContentProtection({ enabled: false, supported: false });
    }
  }
  if (screenshotPrivacyButton) {
    screenshotPrivacyButton.addEventListener('click', async () => {
      const nextEnabled = screenshotPrivacyButton.getAttribute('aria-pressed') !== 'true';
      try {
        renderContentProtection(await cue.contentProtectionSet(nextEnabled));
      } catch (_) {
        void refreshContentProtection();
      }
    });
  }
  cue.on('content-protection:changed', renderContentProtection);
  $('#quit-btn').addEventListener('click', () => cue.quit());

  // ---- state -------------------------------------------------------------
  let settings = null;
  let whisperOverview = null;
  let busy = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;
  let responseCount = 0;
  const MAX_RESPONSES = 20;

  const messages = $('#messages');

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // minimal, safe markdown: fenced code, bullets, inline code, bold, paragraphs
  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (!inCode) { flushP(); if (inList) { html += '</ul>'; inList = false; } html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flushP(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (line.trim() === '') { flushP(); if (inList) { html += '</ul>'; inList = false; } continue; }
      buf.push(line.trim());
    }
    flushP(); if (inList) html += '</ul>'; if (inCode) html += '</code></pre>';
    return html;
  }

  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function startAi(small) {
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.dataset.raw += t;
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = t;
    // Guard: caretEl must be a child of aiEl
    if (caretEl && caretEl.parentNode === aiEl) {
      aiEl.insertBefore(span, caretEl);
    } else {
      aiEl.appendChild(span);
    }
  }

  function finalizeAi() {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null;
  }

  let busyFailsafe = null;
  function setBusy(v) {
    busy = v;
    $('#send-btn').classList.toggle('busy', v);
    clearTimeout(busyFailsafe);
    // Failsafe: main has a 25s stream watchdog that always sends llm:done/llm:error, but if a
    // terminal event is ever lost the whole UI stays frozen — self-clear after a generous window.
    if (v) busyFailsafe = setTimeout(() => { busy = false; $('#send-btn').classList.toggle('busy', false); }, 40000);
  }

  // ---- transcript helpers ------------------------------------------------
  // NOTE: The old transcript-list element was renamed to ts-list.
  // These helpers are now deprecated but kept for compatibility.
  // The main sidebar uses appendTranscriptHistoryTurn() instead.
  let transcriptInterimEl = null;

  // FIX #1: Updated to use ts-list instead of non-existent transcript-list

  function clearTranscriptInterim() {
    if (transcriptInterimEl) {
      transcriptInterimEl.remove();
      transcriptInterimEl = null;
    }
  }

  // ---- toast helper ------------------------------------------------------
  // FIX #7: Toast queue system — ensures latest toast wins cleanly without stacking
  let toastTimer = null;
  let toastFadeTimer = null;
  function showToast(message, ms) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.getElementById('app').appendChild(el);
    }
    // Clear any pending timers to prevent overlap
    clearTimeout(toastTimer);
    clearTimeout(toastFadeTimer);
    // Immediately update content (no stacking)
    el.textContent = message;
    el.classList.add('show');
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, ms);
  }

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    cue.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', () => runMode(btn.dataset.mode, ''));
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  // Speech stays in the transcript; the composer is manual-only.
  function updateSendButtonState() {
    const sendBtn = document.getElementById('send-btn');
    if (!sendBtn) return;
    const hasText = input.value.trim().length > 0;
    sendBtn.classList.toggle('has-text', hasText);
  }

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  
  input.addEventListener('input', () => {
    syncPlaceholder();
    updateSendButtonState();
  });
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    input.value = '';
    syncPlaceholder();
    updateSendButtonState();
    
    // Text is always typed in the manual composer; speech stays in transcript history.
    runMode('ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    // Keep Cmd/Ctrl-Z native so textarea undo behaves like normal typed input.
    if (e.key === 'Escape' && input.value.trim()) {
      e.preventDefault();
      input.value = '';
      syncPlaceholder();
      updateSendButtonState();
      showToast('Cleared', 1500);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); send(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runMode('assist', ''); }
  });
  
  // FIX #13: Global keyboard shortcut for force-answer (Ctrl+Shift+A / Cmd+Shift+A)
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+A / Cmd+Shift+A: Force answer current question immediately
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (input.value.trim()) {
        send();
      } else {
        showToast('No question to answer', 1500);
      }
    }
  });
  
  // FIX #4: Add tooltip with keyboard shortcuts to send button
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) {
    const forceKey = isWindows ? 'Ctrl+Shift+A' : '⌘⇧A';
    sendBtn.title = `Send · ${forceKey} to force answer`;
  }

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    await cue.settingsSet({ smart: settings.smart });
  });

  // Hide / collapse
  function toggleHide() {
    const collapsed = $('#panel').classList.toggle('collapsed');
    $('#hide-btn').classList.toggle('collapsed', collapsed);
    $('#live-dot').style.display = collapsed ? 'none' : '';
  }
  $('#hide-btn').addEventListener('click', toggleHide);
  cue.on('hide:toggle', toggleHide);

  let captureCoordinator = null;

  // Stop = start/stop listening. The coordinator starts display capture directly in this
  // click handler's call chain, preserving the user gesture required by getDisplayMedia.
  $('#stop-btn').addEventListener('click', async () => {
    if (!captureCoordinator) return;
    clearCaptureFailureStatus();
    try {
      if (captureCoordinator.snapshot().session.state === 'off') await captureCoordinator.start();
      else await captureCoordinator.stop();
    } catch (error) {
      showStatus(captureErrorMessage(error, 'Listening could not be changed. Please try again.'), { persistent: true });
    }
  });

  // Transcript toggle removed — sidebar now auto-opens with listening

  // Clear transcript
  const clearTranscriptBtn = document.getElementById('clear-transcript-btn');
  if (clearTranscriptBtn) {
    clearTranscriptBtn.addEventListener('click', async () => {
      await cue.clearTranscript();
      clearMessages();
      // Also clear the floating interim bar
      if (interimEl) { interimEl.textContent = ''; interimEl.classList.remove('show'); }
      // FIX #1: Use ts-list instead of non-existent transcript-list
      const list = document.getElementById('ts-list');
      if (list) list.innerHTML = '<div class="ts-placeholder">Conversation history will appear here when listening.</div>';
      transcriptInterimEl = null;
      clearTranscriptSidebar(); // clear the history sidebar too
      showToast('Transcript cleared', 2500);
    });
  }

  // ---- capture channel drivers ------------------------------------------
  function captureError(category, message, cause) {
    const error = new Error(message);
    error.category = category;
    if (cause) error.cause = cause;
    return error;
  }

  function safeDisconnect(node) {
    try { if (node) node.disconnect(); } catch (_) {}
  }

  function disconnectWorklet(worklet) {
    if (!worklet) return;
    if (worklet._legacy) {
      worklet.proc.onaudioprocess = null;
      safeDisconnect(worklet.proc); safeDisconnect(worklet.node); safeDisconnect(worklet.sink);
      return;
    }
    worklet.node.port.onmessage = null;
    safeDisconnect(worklet.node); safeDisconnect(worklet.source); safeDisconnect(worklet.sink);
  }

  function mixAudioBufferToMonoPcm(audioBuffer) {
    const channelCount = Math.max(1, audioBuffer.numberOfChannels || 1);
    const channels = [];
    for (let channel = 0; channel < channelCount; channel += 1) {
      channels.push(audioBuffer.getChannelData(channel));
    }
    const pcm = new Int16Array(audioBuffer.length);
    for (let frame = 0; frame < audioBuffer.length; frame += 1) {
      let sum = 0;
      for (const channelData of channels) sum += channelData[frame] || 0;
      const sample = Math.max(-1, Math.min(1, sum / channels.length));
      pcm[frame] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return { pcm: pcm.buffer, channelCount };
  }

  function stopTracks(stream) {
    if (!stream) return;
    stream.getTracks().forEach((track) => { try { track.stop(); } catch (_) {} });
  }

  function captureFailure(channel, error) {
    cue.diagnosticsReport({
      type: 'capture-channel-ended',
      channel,
      category: error.category || 'capture',
      message: error.message
    });
    if (!captureCoordinator) {
      showStatus('Listening could not be updated. Please try again.', { persistent: true });
      return Promise.resolve();
    }
    return captureCoordinator.channelFailed(channel, error).catch(() => {
      cue.log('[capture] coordinator could not update capture state');
      showStatus('Listening could not be updated. Please try again.', { persistent: true });
    });
  }

  function captureErrorMessage(error, fallback) {
    return error && typeof error.message === 'string' && error.message ? error.message : fallback;
  }

  function microphoneError(error) {
    const name = error && error.name;
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return captureError('device', 'No microphone was found. Connect one or select a working default microphone, then try again.', error);
    }
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return captureError('permission', 'Microphone permission was denied. System Settings → Privacy & Security → Microphone → allow cue, then try again.', error);
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return captureError('busy', 'The microphone is busy in another app. Close the other app and try again.', error);
    }
    return captureError('capture', 'Microphone capture could not be started. Check your microphone and try again.', error);
  }

  function systemAudioError(error) {
    const name = error && error.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return captureError('permission', 'System audio permission was denied. System Settings → Privacy & Security → Screen & System Audio Recording → allow cue, then try again.', error);
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return captureError('busy', 'Meeting audio is busy in another app. Close the other app and try again.', error);
    }
    if (name === 'AbortError') {
      return captureError('cancelled', 'Meeting audio sharing was cancelled. You can try listening again whenever you are ready.', error);
    }
    return captureError('capture', 'Meeting audio capture could not be started. Check access and try again.', error);
  }

  // ---- capture: microphone ----------------------------------------------
  let audioCtx = null, micStream = null, micWorklet = null, micTrack = null, micTrackEnded = null;
  let micGeneration = 0;
  async function startMic() {
    if (micStream) return { trackLabel: (micTrack && micTrack.label) || null };
    const generation = micGeneration;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 16000 }
      });
      if (generation !== micGeneration) {
        stopTracks(stream);
        throw captureError('cancelled', 'Microphone startup was cancelled.');
      }
      micStream = stream;
      micTrack = stream.getAudioTracks()[0] || null;
      if (!micTrack) {
        await stopMic();
        throw captureError('device', 'No microphone audio track was available. Select a working default microphone in System Settings, then try again.');
      }
      micTrackEnded = () => {
        const error = captureError('device', 'Your microphone connection ended. Listening continues on any remaining source. Stop, then start listening to reconnect the microphone.');
        void captureFailure('microphone', error);
      };
      if (micTrack.addEventListener) micTrack.addEventListener('ended', micTrackEnded, { once: true });
      else micTrack.onended = micTrackEnded;
      cue.log('microphone capture started');
      audioCtx = new AudioContext({ sampleRate: 16000 });
      await audioCtx.resume();
      if (audioCtx.state !== 'running') {
        throw captureError('capture', 'Microphone audio processing is suspended. Try listening again.');
      }
      try {
        await audioCtx.audioWorklet.addModule('audio-worklet-processor.js');
        if (generation !== micGeneration) throw captureError('cancelled', 'Microphone startup was cancelled.');
        const source = audioCtx.createMediaStreamSource(micStream);
        const node = new AudioWorkletNode(audioCtx, 'cue-audio-processor');
        const sink = audioCtx.createGain(); sink.gain.value = 0;
        micWorklet = { source, node, sink };
        node.port.onmessage = (event) => {
          const packet = event.data;
          if (!packet || !(packet.pcm instanceof ArrayBuffer)) return;
          cue.micPcm({ pcm: packet.pcm, sampleRate: audioCtx.sampleRate, channelCount: packet.channelCount });
        };
        source.connect(node); node.connect(sink); sink.connect(audioCtx.destination);
      } catch (workletError) {
        if (workletError && workletError.category) throw workletError;
        disconnectWorklet(micWorklet);
        micWorklet = null;
        const node = audioCtx.createMediaStreamSource(micStream);
        const proc = audioCtx.createScriptProcessor(4096, 1, 1);
        const sink = audioCtx.createGain(); sink.gain.value = 0;
        micWorklet = { _legacy: true, proc, node, sink };
        node.connect(proc); proc.connect(sink); sink.connect(audioCtx.destination);
        proc.onaudioprocess = (event) => {
          const packet = mixAudioBufferToMonoPcm(event.inputBuffer);
          cue.micPcm({ pcm: packet.pcm, sampleRate: audioCtx.sampleRate, channelCount: packet.channelCount });
        };
      }
      return { trackLabel: micTrack.label || null };
    } catch (error) {
      await stopMic();
      const categorized = error && error.category ? error : microphoneError(error);
      cue.log('microphone capture failed: ' + categorized.category);
      throw categorized;
    }
  }

  async function stopMic() {
    micGeneration += 1;
    const worklet = micWorklet, context = audioCtx, stream = micStream, track = micTrack, ended = micTrackEnded;
    micWorklet = null; audioCtx = null; micStream = null; micTrack = null; micTrackEnded = null;
    if (track && ended) {
      try {
        if (track.removeEventListener) track.removeEventListener('ended', ended);
        else if (track.onended === ended) track.onended = null;
      } catch (_) {}
    }
    disconnectWorklet(worklet);
    stopTracks(stream);
    if (context) { try { await context.close(); } catch (_) {} }
  }

  // ---- capture: system/meeting audio ------------------------------------
  let sysStream = null, sysCtx = null, sysWorklet = null, sysTrack = null, sysTrackEnded = null, sysStarting = null;
  let sysGeneration = 0;
  async function startSystemAudio() {
    if (sysStream) return { trackLabel: (sysTrack && sysTrack.label) || null };
    if (sysStarting) return sysStarting;
    const generation = sysGeneration;
    const start = startSystemAudioSession(generation);
    sysStarting = start;
    try {
      return await start;
    } finally {
      if (sysStarting === start) sysStarting = null;
    }
  }

  async function startSystemAudioSession(generation) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      throw captureError('unsupported', 'Meeting audio capture is not available on this device build.');
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (generation !== sysGeneration) {
        stopTracks(stream);
        throw captureError('cancelled', 'Meeting audio startup was cancelled.');
      }
      sysStream = stream;
      stream.getVideoTracks().forEach((track) => { try { track.stop(); } catch (_) {} });
      sysTrack = stream.getAudioTracks()[0] || null;
      if (!sysTrack) {
        await stopSystemAudio();
        throw captureError('unsupported', 'No system-audio track was available. Meeting audio capture needs macOS 14.4+; make sure audio sharing is enabled, then try again.');
      }
      sysTrackEnded = () => {
        const error = captureError('device', 'Your meeting-audio connection ended. Listening continues on any remaining source. Stop, then start listening to reconnect meeting audio.');
        void captureFailure('system', error);
      };
      if (sysTrack.addEventListener) sysTrack.addEventListener('ended', sysTrackEnded, { once: true });
      else sysTrack.onended = sysTrackEnded;
      cue.log('system audio capture started');
      sysCtx = new AudioContext({ sampleRate: 16000 });
      await sysCtx.resume();
      if (sysCtx.state !== 'running') {
        throw captureError('capture', 'Meeting audio processing is suspended. Try listening again.');
      }
      try {
        await sysCtx.audioWorklet.addModule('audio-worklet-processor.js');
        if (generation !== sysGeneration) throw captureError('cancelled', 'Meeting audio startup was cancelled.');
        const source = sysCtx.createMediaStreamSource(new MediaStream([sysTrack]));
        const node = new AudioWorkletNode(sysCtx, 'cue-audio-processor');
        const sink = sysCtx.createGain(); sink.gain.value = 0;
        sysWorklet = { source, node, sink };
        node.port.onmessage = (event) => {
          const packet = event.data;
          if (!packet || !(packet.pcm instanceof ArrayBuffer)) return;
          cue.systemPcm({ pcm: packet.pcm, sampleRate: sysCtx.sampleRate, channelCount: packet.channelCount });
        };
        source.connect(node); node.connect(sink); sink.connect(sysCtx.destination);
      } catch (workletError) {
        if (workletError && workletError.category) throw workletError;
        disconnectWorklet(sysWorklet);
        sysWorklet = null;
        const node = sysCtx.createMediaStreamSource(new MediaStream([sysTrack]));
        const proc = sysCtx.createScriptProcessor(4096, 1, 1);
        const sink = sysCtx.createGain(); sink.gain.value = 0;
        sysWorklet = { _legacy: true, proc, node, sink };
        node.connect(proc); proc.connect(sink); sink.connect(sysCtx.destination);
        proc.onaudioprocess = (event) => {
          const packet = mixAudioBufferToMonoPcm(event.inputBuffer);
          cue.systemPcm({ pcm: packet.pcm, sampleRate: sysCtx.sampleRate, channelCount: packet.channelCount });
        };
      }
      return { trackLabel: sysTrack.label || null };
    } catch (error) {
      await stopSystemAudio();
      const categorized = error && error.category ? error : systemAudioError(error);
      cue.log('system audio capture failed: ' + categorized.category);
      throw categorized;
    }
  }

  async function stopSystemAudio() {
    sysGeneration += 1;
    const worklet = sysWorklet, context = sysCtx, stream = sysStream, track = sysTrack, ended = sysTrackEnded;
    sysWorklet = null; sysCtx = null; sysStream = null; sysTrack = null; sysTrackEnded = null; sysStarting = null;
    if (track && ended) {
      try {
        if (track.removeEventListener) track.removeEventListener('ended', ended);
        else if (track.onended === ended) track.onended = null;
      } catch (_) {}
    }
    disconnectWorklet(worklet);
    stopTracks(stream);
    if (context) { try { await context.close(); } catch (_) {} }
  }

  function renderCaptureSnapshot(snapshot) {
    const listening = snapshot.session.state === 'ready';
    $('#stop-btn').classList.toggle('active', listening);
    composer.classList.toggle('listening', listening);
    const historyBtn = document.getElementById('history-btn');
    if (historyBtn) historyBtn.classList.toggle('listening', listening);
    setLiveDotState(listening ? 'idle' : 'off');
    updateSttStatus({ active: listening });
    const failureMessage = captureStatusTracker.select(snapshot);
    if (failureMessage) showStatus(failureMessage, { persistent: true });
  }

  const captureStatusTracker = new CueCaptureStatus.CaptureStatusTracker();
  captureCoordinator = new CueCapture.CaptureCoordinator({
    channels: {
      microphone: { start: startMic, stop: stopMic },
      system: { start: startSystemAudio, stop: stopSystemAudio }
    },
    setPipelineActive: (active) => cue.captureSet(active),
    onChange: (snapshot) => {
      cue.diagnosticsReport({ type: 'capture', snapshot });
      renderCaptureSnapshot(snapshot);
    }
  });

  cue.on('capture:remote-stop', async ({ id }) => {
    try {
      await captureCoordinator.stop();
      await cue.captureSet(false);
      cue.captureRemoteStopAck(id, { stopped: true });
    } catch (error) {
      cue.captureRemoteStopAck(id, { stopped: false, error: captureErrorMessage(error, 'cue could not stop listening.') });
    }
  });

  // ---- STT / VAD status helpers ------------------------------------------
  // Live dot states: 'off' | 'idle' | 'speaking' | 'transcribing'
  function setLiveDotState(dotState) {
    const dot = document.getElementById('live-dot');
    if (!dot) return;
    dot.classList.remove('off', 'idle', 'speaking', 'transcribing');
    dot.classList.add(dotState);
    const labels = {
      off:          'Not listening',
      idle:         'Listening — silence detected',
      speaking:     'Speech detected',
      transcribing: 'Transcribing…'
    };
    dot.title = labels[dotState] || '';
  }

  let sttState = 'disconnected';

  function updateSttStatus({ active, streaming } = {}) {
    const label = document.getElementById('stt-status');
    if (!label) return;
    if (active === false) {
      sttState = 'disconnected';
      label.textContent = 'off';
    } else if (active === true) {
      sttState = streaming ? 'connecting' : 'batch';
      label.textContent = sttState;
    }
    label.className = 'stt-status stt-' + sttState;
  }

  // ---- transcript history sidebar (hidden by default, manual toggle) ----
  let tsSidebarInterimEl = null;
  let sidebarOpen = false;
  // Track last committed row per channel — all chunks from same speaker go in one row
  const tsLastRow = { you: null, them: null };
  const tsRowTimer = { you: null, them: null };
  const TS_SENTENCE_GAP_MS = 10000; // 10s silence = new row

  function showSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    const historyBtn = document.getElementById('history-btn');
    if (sidebar) {
      sidebar.classList.remove('hidden');
      if (!window.matchMedia('(min-width: 980px)').matches) {
        requestAnimationFrame(() => sidebar.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      }
    }
    if (historyBtn) historyBtn.classList.add('active');
    const panelWrap = document.getElementById('panel-wrap');
    if (panelWrap) panelWrap.classList.add('sidebar-open');
    sidebarOpen = true;
  }

  function hideSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    const historyBtn = document.getElementById('history-btn');
    if (sidebar) sidebar.classList.add('hidden');
    if (historyBtn) historyBtn.classList.remove('active');
    const panelWrap = document.getElementById('panel-wrap');
    if (panelWrap) panelWrap.classList.remove('sidebar-open');
    sidebarOpen = false;
  }

  function toggleSidebar() {
    if (sidebarOpen) {
      hideSidebar();
    } else {
      showSidebar();
      // FIX #7: Scroll to bottom when opening sidebar
      const list = document.getElementById('ts-list');
      if (list) {
        requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight;
        });
      }
    }
  }

  // History button toggle
  const historyBtn = document.getElementById('history-btn');
  if (historyBtn) {
    historyBtn.innerHTML = icon('message-square-text', { size: 15 });
    historyBtn.addEventListener('click', toggleSidebar);
  }

  // Close sidebar button
  const closeSidebarBtn = document.getElementById('close-sidebar-btn');
  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', hideSidebar);
  }

  function appendTranscriptHistoryTurn(channel, text, isInterim) {
    const list = document.getElementById('ts-list');
    if (!list) return;

    // Remove placeholder on first real turn
    const ph = list.querySelector('.ts-placeholder');
    if (ph) ph.remove();

    if (isInterim) {
      // Update the single floating interim row
      if (!tsSidebarInterimEl) {
        tsSidebarInterimEl = document.createElement('div');
        tsSidebarInterimEl.className = 'ts-turn ts-' + channel + ' ts-interim-row';
        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';
        const txt = document.createElement('span');
        txt.className = 'ts-text ts-interim';
        tsSidebarInterimEl.appendChild(chLabel);
        tsSidebarInterimEl.appendChild(txt);
        list.appendChild(tsSidebarInterimEl);
      }
      tsSidebarInterimEl.querySelector('.ts-text').textContent = text;
    } else {
      // Remove interim row
      if (tsSidebarInterimEl) { tsSidebarInterimEl.remove(); tsSidebarInterimEl = null; }

      const existingRow = tsLastRow[channel];
      const useExisting = existingRow && existingRow.isConnected;

      if (useExisting) {
        // Append to existing row — accumulates sentence fragments
        const txt = existingRow.querySelector('.ts-text');
        if (txt) {
          txt.textContent = txt.textContent ? txt.textContent + ' ' + text : text;
        }
      } else {
        // Start a new row (no buttons — just clean history view)
        const row = document.createElement('div');
        row.className = 'ts-turn ts-' + channel;

        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';

        const txt = document.createElement('span');
        txt.className = 'ts-text';
        txt.textContent = text;

        row.appendChild(chLabel);
        row.appendChild(txt);
        list.appendChild(row);
        tsLastRow[channel] = row;
      }

      // Reset silence timer
      clearTimeout(tsRowTimer[channel]);
      tsRowTimer[channel] = setTimeout(() => { tsLastRow[channel] = null; }, TS_SENTENCE_GAP_MS);

      // When THIS channel speaks, reset the OTHER channel's row
      const other = channel === 'you' ? 'them' : 'you';
      clearTimeout(tsRowTimer[other]);
      tsLastRow[other] = null;

      list.scrollTop = list.scrollHeight;
    }
  }

  function clearTranscriptSidebar() {
    const list = document.getElementById('ts-list');
    if (list) list.innerHTML = '<div class="ts-placeholder">Conversation history will appear here when listening.</div>';
    tsSidebarInterimEl = null;
    tsLastRow.you = null; tsLastRow.them = null;
    clearTimeout(tsRowTimer.you); clearTimeout(tsRowTimer.them);
  }

  // ---- events from main --------------------------------------------------
  cue.on('capture:state', ({ active, streaming, mode }) => {
    if (active && mode === 'local') {
      sttState = 'local';
      const label = document.getElementById('stt-status');
      if (label) { label.textContent = 'local'; label.className = 'stt-status stt-local'; }
    } else {
      updateSttStatus({ active, streaming });
    }
  });

  // ---- real-time transcript display (interim + final) ----
  let interimEl = null;
  function getOrCreateInterimEl() {
    if (!interimEl) {
      interimEl = document.createElement('div');
      interimEl.className = 'interim-transcript';
      // Insert into panel-main (the left column), before the action row
      const panelMain = document.getElementById('panel-main');
      const actionRow = document.getElementById('action-row');
      if (panelMain && actionRow && actionRow.parentNode === panelMain) {
        panelMain.insertBefore(interimEl, actionRow);
      } else if (panelMain) {
        panelMain.appendChild(interimEl);
      } else {
        document.getElementById('panel').appendChild(interimEl);
      }
    }
    return interimEl;
  }
  cue.on('stt:interim', ({ channel, text }) => {
    setLiveDotState('transcribing');
    const el = getOrCreateInterimEl();
    const label = channel === 'them' ? 'Them' : 'You';
    el.textContent = `${label}: ${text}`;
    el.classList.add('show');
    appendTranscriptHistoryTurn(channel, text, true); // update sidebar interim
    
  });
  cue.on('stt:final', ({ channel, text }) => {
    setLiveDotState('idle');
    // Clear interim when we get a final
    if (interimEl) { interimEl.textContent = ''; interimEl.classList.remove('show'); }
    clearTranscriptInterim();
    // sidebar: the final turn is added via the 'transcript' event below
  });
  cue.on('stt:status', ({ channel, status, provider }) => {
    cue.log(`[stt] ${provider || channel || 'unknown'} ${status}`);
    if (provider === 'local') {
      const label = document.getElementById('stt-status');
      const localLabels = {
        loading: 'loading local',
        ready: 'local',
        transcribing: 'local',
        stopping: 'stopping',
        off: 'off',
        error: 'error'
      };
      sttState = status === 'ready' || status === 'transcribing' ? 'local' : status;
      if (label) {
        label.textContent = localLabels[status] || status;
        label.className = 'stt-status stt-' + sttState;
      }
      if (status === 'loading') $('#stop-btn').classList.add('active');
      if (status === 'off' || status === 'error') $('#stop-btn').classList.remove('active');
      if (status === 'loading' || status === 'transcribing' || status === 'stopping') setLiveDotState('transcribing');
      if (status === 'ready') setLiveDotState('idle');
      if (status === 'off') setLiveDotState('off');
      return;
    }
    if (status === 'connected') {
      sttState = 'streaming';
      const label = document.getElementById('stt-status');
      if (label) { label.textContent = sttState; label.className = 'stt-status stt-streaming'; }
    }
  });
  cue.on('vad:state', ({ channel, speaking }) => {
    setLiveDotState(speaking ? 'speaking' : 'idle');
  });
  cue.on('llm:start', ({ userBubble, small, category }) => {
    responseCount++;
    if (responseCount > MAX_RESPONSES) {
      const oldest = messages.querySelector('.response-group');
      if (oldest) oldest.remove();
      responseCount = MAX_RESPONSES;
    }
    const group = document.createElement('div');
    group.className = 'response-group';
    const sep = document.createElement('div');
    sep.className = 'response-sep';
    sep.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    group.appendChild(sep);
    if (userBubble) {
      const b = document.createElement('div');
      b.className = 'user-bubble';
      b.textContent = userBubble;
      group.appendChild(b);
    }
    if (category) {
      const pill = document.createElement('div');
      pill.className = 'category-pill';
      pill.textContent = category.charAt(0).toUpperCase() + category.slice(1);
      group.appendChild(pill);
    }
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    group.appendChild(aiEl);
    messages.appendChild(group);
    // Use requestAnimationFrame so the DOM is fully updated before scrolling
    requestAnimationFrame(() => {
      if (sep && sep.isConnected) sep.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    setBusy(true);
  });
  cue.on('llm:token', ({ text }) => appendToken(text));
  cue.on('llm:done', () => { finalizeAi(); setBusy(false); });
  cue.on('llm:error', ({ message }) => {
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(); setBusy(false);
  });
  cue.on('transcript', ({ channel, text }) => {
    if (!text || text.trim().length < 2 || /^[?!.,;:\-…]+$/.test(text.trim())) return;
    appendTranscriptHistoryTurn(channel, text, false);
  });
  let statusTimer = null;
  let persistentCaptureStatus = null;
  function statusElement() {
    let el = document.getElementById('cue-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cue-status';
      // Insert into panel-main before the action row
      const panelMain = document.getElementById('panel-main');
      const actionRow = document.getElementById('action-row');
      if (panelMain && actionRow && actionRow.parentNode === panelMain) {
        panelMain.insertBefore(el, actionRow);
      } else if (panelMain) {
        panelMain.appendChild(el);
      } else {
        document.getElementById('panel').appendChild(el);
      }
    }
    return el;
  }
  function clearCaptureFailureStatus() {
    captureStatusTracker.clear();
    persistentCaptureStatus = null;
    clearTimeout(statusTimer);
    const el = document.getElementById('cue-status');
    if (el) el.classList.remove('show');
  }
  function showStatus(message, { persistent = false } = {}) {
    if (persistent) persistentCaptureStatus = message;
    if (!persistent && persistentCaptureStatus) message = persistentCaptureStatus;
    const el = statusElement();
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    if (!persistentCaptureStatus) statusTimer = setTimeout(() => el.classList.remove('show'), 11000);
  }
  cue.on('status', ({ message }) => {
    cue.log('[status] ' + message);
    showStatus(message);
    if (sttState !== 'disconnected') {
      const lower = message.toLowerCase();
      if (lower.includes('error') || lower.includes(' off')) {
        sttState = 'error';
        const label = document.getElementById('stt-status');
        if (label) { label.textContent = sttState; label.className = 'stt-status stt-error'; }
      }
    }
  });

  // ---- prep status & smart tooltip helpers -------------------------------


  // ---- AI rules: live char counter + soft cap ---------------------------
  function updateAiRulesCounter() {
    const el = document.getElementById('ai-rules');
    const counter = document.getElementById('ai-rules-count');
    if (!el || !counter) return;
    const n = el.value.length;
    const cap = 2000;
    counter.textContent = String(n);
    counter.classList.toggle('over', n >= cap);
    counter.parentElement.classList.toggle('s-counter-warn', n >= cap - 100);
  }
  const aiRulesEl = document.getElementById('ai-rules');
  if (aiRulesEl) aiRulesEl.addEventListener('input', updateAiRulesCounter);
  function updatePrepStatus() {
    if (!settings) return;
    const fields = {
      resume:  !!(settings.resumeText && settings.resumeText.trim()),
      jd:      !!(settings.jobDescription && settings.jobDescription.trim()),
      stories: !!(settings.starStories && settings.starStories.trim()),
      salary:  !!(settings.salaryTarget && settings.salaryTarget.trim())
    };
    document.querySelectorAll('#prep-status .prep-item').forEach((el) => {
      const loaded = fields[el.dataset.field];
      el.classList.toggle('loaded', loaded);
      el.classList.toggle('missing', !loaded);
      el.title = loaded
        ? el.textContent.trim() + ' loaded'
        : el.textContent.trim() + ' not set — add in Settings';
    });
  }

  function updateSmartTooltip() {
    if (!settings) return;
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    const fast = m.fast || 'fast model';
    const smart = m.smart || 'smart model';
    const btn = document.getElementById('smart-toggle');
    if (btn) btn.title = 'Fast: ' + fast + ' · Smart: ' + smart + ' (higher quality, ~2× slower)';
  }

  // ---- microphone permission banner --------------------------------------
  function showMicPermissionBanner() {
    let banner = document.getElementById('mic-perm-banner');
    if (banner) { banner.classList.add('show'); return; }
    banner = document.createElement('div');
    banner.id = 'mic-perm-banner';
    banner.className = 'show';
    banner.innerHTML =
      '<div class="mic-perm-text">' +
        '<strong>🎙️ Microphone access required</strong><br>' +
        'cue needs microphone permission to hear you during calls. Grant access in System Settings, then restart cue.' +
      '</div>' +
      '<div class="mic-perm-actions"></div>';
    const actions = banner.querySelector('.mic-perm-actions');
    if (cue.platform === 'darwin') {
      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open Microphone Settings';
      openBtn.addEventListener('click', () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'));
      actions.appendChild(openBtn);
    }
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.className = 'dismiss';
    dismissBtn.addEventListener('click', () => banner.classList.remove('show'));
    actions.appendChild(dismissBtn);
    const panel = document.getElementById('panel');
    panel.insertBefore(banner, document.getElementById('action-row'));
  }

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  const DIAGNOSTICS_STATE_CLASSES = new Set(['neutral', 'ok', 'warn', 'error']);
  const DIAGNOSTICS_REFRESH_DELAY_MS = 90;
  const DIAGNOSTICS_CLIPBOARD_TIMEOUT_MS = 3500;
  let diagnosticsSummary = '';
  let diagnosticsFetchVersion = 0;
  let diagnosticsSessionVersion = 0;
  let diagnosticsCopyTimer = null;
  let diagnosticsRefreshTimer = null;
  let lastDiagnosticsFingerprint = null;
  let pendingDiagnosticsFingerprint = null;
  let settingsReturnFocus = null;

  function diagnosticOwn(value, key) {
    if (!value || typeof value !== 'object') return undefined;
    try {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
      return value[key];
    } catch (_) {
      return undefined;
    }
  }

  function diagnosticText(value, fallback) {
    if (typeof value === 'string') return value.length <= 180 ? value : value.slice(0, 177) + '…';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return fallback;
  }

  function diagnosticLabel(value, fallback) {
    const text = diagnosticText(value, fallback);
    return text.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function captureDiagnosticLabel(capture, state, fallback) {
    const label = diagnosticLabel(state, fallback);
    const telemetry = diagnosticOwn(capture, 'telemetry') || {};
    const sampleRate = diagnosticOwn(telemetry, 'sampleRate');
    const channelCount = diagnosticOwn(telemetry, 'channelCount');
    const frames = diagnosticOwn(telemetry, 'frames');
    const signal = diagnosticOwn(telemetry, 'signal');
    if (state !== 'ready' || !Number.isInteger(sampleRate) || !Number.isInteger(channelCount)) return label;
    const details = [Math.round(sampleRate / 1000) + ' kHz', channelCount + ' ch'];
    if (signal === 'present' || signal === 'silent') details.push(signal);
    if (Number.isSafeInteger(frames) && frames > 0) details.push(frames.toLocaleString('en-US') + ' frames');
    return label + ' · ' + details.join(' · ');
  }

  function diagnosticFingerprint(snapshot) {
    const permissions = diagnosticOwn(snapshot, 'permissions') || {};
    const capture = diagnosticOwn(snapshot, 'capture') || {};
    const microphone = diagnosticOwn(capture, 'microphone') || {};
    const system = diagnosticOwn(capture, 'system') || {};
    const microphoneTelemetry = diagnosticOwn(microphone, 'telemetry') || {};
    const systemTelemetry = diagnosticOwn(system, 'telemetry') || {};
    const stt = diagnosticOwn(snapshot, 'stt') || {};
    const chat = diagnosticOwn(snapshot, 'chat') || {};
    const failure = diagnosticOwn(snapshot, 'lastFailure') || {};
    const values = [
      diagnosticOwn(permissions, 'microphone'), diagnosticOwn(permissions, 'screen'),
      diagnosticOwn(microphone, 'state'), diagnosticOwn(system, 'state'),
      diagnosticOwn(microphoneTelemetry, 'sampleRate'), diagnosticOwn(microphoneTelemetry, 'channelCount'), diagnosticOwn(microphoneTelemetry, 'packets'), diagnosticOwn(microphoneTelemetry, 'frames'), diagnosticOwn(microphoneTelemetry, 'signal'),
      diagnosticOwn(systemTelemetry, 'sampleRate'), diagnosticOwn(systemTelemetry, 'channelCount'), diagnosticOwn(systemTelemetry, 'packets'), diagnosticOwn(systemTelemetry, 'frames'), diagnosticOwn(systemTelemetry, 'signal'),
      diagnosticOwn(stt, 'provider'), diagnosticOwn(stt, 'state'),
      diagnosticOwn(chat, 'provider'), diagnosticOwn(chat, 'ready'),
      diagnosticOwn(failure, 'category'), diagnosticOwn(failure, 'channel'), diagnosticOwn(failure, 'message')
    ];
    return values.map((value) => diagnosticText(value, '')).join('\u001f');
  }

  function diagnosticStateClass(kind, value) {
    const states = {
      permission: { ok: ['granted'], warn: ['not-determined', 'unknown'], error: ['denied', 'restricted'] },
      capture: { ok: ['ready'], warn: ['starting'], error: ['failed'] },
      stt: { ok: ['ready', 'connected', 'transcribing'], warn: ['starting', 'stopping'], error: ['disconnected', 'error', 'unavailable'] },
      chat: { ok: [true], error: [false] }
    };
    const allowed = states[kind] || {};
    for (const state of ['ok', 'warn', 'error']) {
      if ((allowed[state] || []).includes(value)) return state;
    }
    return 'neutral';
  }

  function setDiagnosticState(id, text, state) {
    const target = $('#' + id);
    if (!target) return;
    target.textContent = text;
    target.className = 'diagnostics-state ' + (DIAGNOSTICS_STATE_CLASSES.has(state) ? state : 'neutral');
  }

  function setDiagnosticsCopyStatus(text, state) {
    const target = $('#diagnostics-copy-status');
    if (!target) return;
    target.textContent = text;
    target.className = 's-status ' + (DIAGNOSTICS_STATE_CLASSES.has(state) ? state : 'neutral');
    target.setAttribute('aria-live', 'polite');
  }

  function renderDiagnostics(snapshot) {
    const permissions = diagnosticOwn(snapshot, 'permissions') || {};
    const capture = diagnosticOwn(snapshot, 'capture') || {};
    const microphone = diagnosticOwn(capture, 'microphone') || {};
    const system = diagnosticOwn(capture, 'system') || {};
    const stt = diagnosticOwn(snapshot, 'stt') || {};
    const chat = diagnosticOwn(snapshot, 'chat') || {};
    const failure = diagnosticOwn(snapshot, 'lastFailure') || null;

    const microphonePermission = diagnosticOwn(permissions, 'microphone');
    const screenPermission = diagnosticOwn(permissions, 'screen');
    const microphoneState = diagnosticOwn(microphone, 'state');
    const systemState = diagnosticOwn(system, 'state');
    const sttState = diagnosticOwn(stt, 'state');
    const sttProvider = diagnosticOwn(stt, 'provider');
    const chatReady = diagnosticOwn(chat, 'ready');
    const chatProvider = diagnosticOwn(chat, 'provider');

    setDiagnosticState('diagnostics-mic-permission', diagnosticLabel(microphonePermission, 'Unknown'), diagnosticStateClass('permission', microphonePermission));
    setDiagnosticState('diagnostics-mic-capture', captureDiagnosticLabel(microphone, microphoneState, 'Off'), diagnosticStateClass('capture', microphoneState));
    setDiagnosticState('diagnostics-screen-permission', diagnosticLabel(screenPermission, 'Unknown'), diagnosticStateClass('permission', screenPermission));
    setDiagnosticState('diagnostics-system-capture', captureDiagnosticLabel(system, systemState, 'Off'), diagnosticStateClass('capture', systemState));
    setDiagnosticState('diagnostics-stt-provider', diagnosticLabel(sttState, 'Off') + (typeof sttProvider === 'string' ? ' · ' + diagnosticText(sttProvider, '') : ''), diagnosticStateClass('stt', sttState));
    const chatLabel = chatReady === true
      ? 'Ready' + (typeof chatProvider === 'string' ? ' · ' + diagnosticText(chatProvider, '') : '')
      : (chatReady === false ? 'Not ready' : 'Unknown');
    setDiagnosticState('diagnostics-ai-provider', chatLabel, diagnosticStateClass('chat', chatReady));

    const failureTarget = $('#diagnostics-last-failure');
    if (failureTarget) {
      const message = diagnosticOwn(failure, 'message');
      failureTarget.textContent = typeof message === 'string' && message ? diagnosticText(message, '') : 'No recent failure recorded.';
    }
  }

  function setDiagnosticsSummary(summary) {
    diagnosticsSummary = typeof summary === 'string' ? summary : '';
    const button = $('#diagnostics-copy');
    if (button) button.disabled = !diagnosticsSummary;
  }

  function renderDiagnosticsLoading(message) {
    for (const id of [
      'diagnostics-mic-permission', 'diagnostics-mic-capture',
      'diagnostics-screen-permission', 'diagnostics-system-capture',
      'diagnostics-stt-provider', 'diagnostics-ai-provider'
    ]) {
      setDiagnosticState(id, 'Refreshing…', 'neutral');
    }
    const failureTarget = $('#diagnostics-last-failure');
    if (failureTarget) failureTarget.textContent = message || 'Refreshing diagnostics…';
  }

  function applyDiagnosticsReport(report) {
    const snapshot = diagnosticOwn(report, 'snapshot');
    const summary = diagnosticOwn(report, 'summary');
    lastDiagnosticsFingerprint = diagnosticFingerprint(snapshot);
    pendingDiagnosticsFingerprint = null;
    renderDiagnostics(snapshot);
    setDiagnosticsSummary(summary);
    setDiagnosticsCopyStatus(diagnosticsSummary ? 'Ready to copy.' : 'Diagnostic summary is unavailable.', diagnosticsSummary ? 'ok' : 'error');
  }

  function isCurrentDiagnosticsSession(sessionVersion, summary) {
    return sessionVersion === diagnosticsSessionVersion
      && !scrim.classList.contains('hidden')
      && summary === diagnosticsSummary;
  }

  function writeDiagnosticsSummary(summary) {
    let timeoutId = null;
    const write = Promise.resolve().then(() => {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('Clipboard access is unavailable.');
      }
      return navigator.clipboard.writeText(summary);
    });
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Clipboard write timed out.')), DIAGNOSTICS_CLIPBOARD_TIMEOUT_MS);
    });
    return Promise.race([write, timeout]).finally(() => clearTimeout(timeoutId));
  }

  function queueDiagnosticsRefresh() {
    if (diagnosticsRefreshTimer) return;
    diagnosticsRefreshTimer = setTimeout(() => {
      diagnosticsRefreshTimer = null;
      const expectedFingerprint = pendingDiagnosticsFingerprint;
      if (scrim.classList.contains('hidden') || expectedFingerprint === lastDiagnosticsFingerprint) return;
      void refreshDiagnostics(expectedFingerprint);
    }, DIAGNOSTICS_REFRESH_DELAY_MS);
  }

  function scheduleDiagnosticsRefresh(snapshot) {
    if (scrim.classList.contains('hidden')) return;
    const fingerprint = diagnosticFingerprint(snapshot);
    if (fingerprint === lastDiagnosticsFingerprint) return;
    pendingDiagnosticsFingerprint = fingerprint;
    renderDiagnosticsLoading('Refreshing diagnostic summary…');
    setDiagnosticsSummary('');
    setDiagnosticsCopyStatus('Refreshing safe diagnostic summary…', 'neutral');
    queueDiagnosticsRefresh();
  }

  async function refreshDiagnostics(expectedFingerprint = null) {
    const requestVersion = ++diagnosticsFetchVersion;
    clearTimeout(diagnosticsRefreshTimer);
    diagnosticsRefreshTimer = null;
    if (!expectedFingerprint) pendingDiagnosticsFingerprint = null;
    clearTimeout(diagnosticsCopyTimer);
    const copyButton = $('#diagnostics-copy');
    if (copyButton) copyButton.textContent = 'Copy diagnostic summary';
    setDiagnosticsSummary('');
    renderDiagnosticsLoading('Loading diagnostics…');
    setDiagnosticsCopyStatus('Loading safe diagnostic summary…', 'neutral');
    try {
      const report = await cue.diagnosticsGet();
      if (requestVersion !== diagnosticsFetchVersion || scrim.classList.contains('hidden')) return;
      const reportFingerprint = diagnosticFingerprint(diagnosticOwn(report, 'snapshot'));
      const requiredFingerprint = pendingDiagnosticsFingerprint || expectedFingerprint;
      if (requiredFingerprint && reportFingerprint !== requiredFingerprint) {
        queueDiagnosticsRefresh();
        return;
      }
      applyDiagnosticsReport(report);
    } catch (_) {
      if (requestVersion !== diagnosticsFetchVersion || scrim.classList.contains('hidden')) return;
      renderDiagnosticsLoading('Diagnostics could not be loaded.');
      setDiagnosticsSummary('');
      setDiagnosticsCopyStatus('Could not load diagnostics. Try opening Settings again.', 'error');
    }
  }

  function settingsFocusableElements() {
    return Array.from($('#settings').querySelectorAll('button, input, textarea, select, [tabindex]'))
      .filter((element) => !element.disabled && element.tabIndex >= 0 && !element.closest('.hidden'));
  }

  function activeSettingsTab() {
    return document.querySelector('.s-tab[aria-selected="true"]') || document.querySelector('.s-tab.on');
  }

  function focusActiveSettingsTab() {
    const tab = activeSettingsTab();
    (tab || $('#s-close')).focus();
  }

  async function activateSettingsTab(tab, { focus = false } = {}) {
    if (!tab) return false;
    if (!tab.classList.contains('on') && !(await saveSettings())) return false;
    document.querySelectorAll('.s-tab').forEach((candidate) => {
      const selected = candidate === tab;
      candidate.classList.toggle('on', selected);
      candidate.setAttribute('aria-selected', String(selected));
      candidate.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('.s-tab-pane').forEach((pane) => pane.classList.add('hidden'));
    const pane = document.querySelector(`.s-tab-pane[data-pane="${tab.dataset.tab}"]`);
    if (pane) pane.classList.remove('hidden');
    if (focus) tab.focus();
    return true;
  }

  function trapSettingsFocus(event) {
    if (scrim.classList.contains('hidden')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSettings();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = settingsFocusableElements();
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openSettings() {
    if (scrim.classList.contains('hidden')) settingsReturnFocus = document.activeElement;
    diagnosticsSessionVersion += 1;
    fillSettings();
    scrim.classList.remove('hidden');
    refreshWhisperModels();
    void refreshDiagnostics();
    requestAnimationFrame(focusActiveSettingsTab);
  }
  function closeSettings() {
    if (scrim.classList.contains('hidden')) return;
    diagnosticsSessionVersion += 1;
    diagnosticsFetchVersion += 1;
    clearTimeout(diagnosticsRefreshTimer);
    diagnosticsRefreshTimer = null;
    pendingDiagnosticsFingerprint = null;
    saveSettings();
    scrim.classList.add('hidden');
    const restoreFocus = settingsReturnFocus;
    settingsReturnFocus = null;
    if (restoreFocus && typeof restoreFocus.focus === 'function' && document.contains(restoreFocus)) {
      requestAnimationFrame(() => restoreFocus.focus());
    }
  }
  $('#more-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', () => { void closeSettings(); });
  scrim.addEventListener('click', (e) => { if (e.target === scrim) void closeSettings(); });
  document.addEventListener('keydown', trapSettingsFocus);

  $('#diagnostics-copy').addEventListener('click', async () => {
    const button = $('#diagnostics-copy');
    if (!diagnosticsSummary || !button) return;
    const copySessionVersion = diagnosticsSessionVersion;
    const copySummary = diagnosticsSummary;
    button.disabled = true;
    button.textContent = 'Copying…';
    try {
      await writeDiagnosticsSummary(copySummary);
      if (!isCurrentDiagnosticsSession(copySessionVersion, copySummary)) return;
      button.textContent = 'Copied';
      setDiagnosticsCopyStatus('Safe diagnostic summary copied to clipboard.', 'ok');
    } catch (_) {
      if (!isCurrentDiagnosticsSession(copySessionVersion, copySummary)) return;
      button.textContent = 'Copy diagnostic summary';
      setDiagnosticsCopyStatus('Could not copy the diagnostic summary. Check clipboard access and try again.', 'error');
    } finally {
      if (!isCurrentDiagnosticsSession(copySessionVersion, copySummary)) return;
      clearTimeout(diagnosticsCopyTimer);
      diagnosticsCopyTimer = setTimeout(() => {
        if (!isCurrentDiagnosticsSession(copySessionVersion, copySummary)) return;
        if (!button) return;
        button.textContent = 'Copy diagnostic summary';
        button.disabled = !diagnosticsSummary;
      }, 1400);
    }
  });

  cue.on('diagnostics:changed', (snapshot) => {
    scheduleDiagnosticsRefresh(snapshot);
  });

  // Tab switching
  document.querySelectorAll('.s-tab').forEach((tab) => {
    tab.addEventListener('click', () => { void activateSettingsTab(tab); });
    tab.addEventListener('keydown', (event) => {
      const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const tabs = Array.from(document.querySelectorAll('.s-tab'));
      const current = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      void activateSettingsTab(tabs[next], { focus: true });
    });
  });

  function updateCustomProviderFields() {
    $('#custom-endpoint-settings').classList.toggle('hidden', settings.provider !== 'custom');
  }

  function fillSettings() {
    // Keys tab
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#key-deepgram').value = settings.apiKeys.deepgram || '';
    $('#key-custom').value = settings.apiKeys.custom || '';
    $('#base-url').value = settings.baseUrl || '';
    updateCustomProviderFields();
    $('#key-ollama').value = settings.apiKeys.ollama || '';
    $('#key-groq').value = settings.apiKeys.groq || '';
    $('#key-minimax').value = settings.apiKeys.minimax || '';
    document.querySelectorAll('#minimax-region-seg button').forEach((b) => b.classList.toggle('on', b.dataset.region === (settings.minimaxRegion || 'global_en')));
    $('#key-azure').value = settings.apiKeys.azure || '';
    $('#azure-endpoint').value = settings.azureEndpoint || '';
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    fillAppLinkCallers();
    $('#s-status').textContent = statusText();
    // Transcription tab
    document.querySelectorAll('#stt-provider-seg button').forEach((button) => {
      button.classList.toggle('on', button.dataset.sttProvider === (settings.sttProvider || 'auto'));
    });
    const localWhisper = settings.localWhisper || { modelId: 'base.en', language: 'auto', threads: 0 };
    $('#whisper-language').value = localWhisper.language || 'auto';
    $('#whisper-threads').value = Number(localWhisper.threads) || 0;
    // Profile tab
    $('#resume-text').value = settings.resumeText || '';
    $('#job-description').value = settings.jobDescription || '';
    // Interview Prep tab
    $('#star-stories').value = settings.starStories || '';
    $('#why-company').value = settings.whyCompany || '';
    $('#why-leaving').value = settings.whyLeaving || '';
    $('#work-style').value = settings.workStyle || '';
    // Style tab
    $('#ai-rules').value = settings.aiRules || '';
    updateAiRulesCounter();
    // Q&A tab
    $('#salary-target').value = settings.salaryTarget || '';
    $('#questions-to-ask').value = settings.questionsToAsk || '';
  }

  // Whoever cue has been told it may answer questions for. Empty is the normal
  // state — nothing appears here until something has asked and been allowed.
  async function fillAppLinkCallers() {
    const host = $('#applink-callers');
    if (!host || !cue.appLinkState) return;
    let state;
    try { state = await cue.appLinkState(); } catch (_) { return; }
    const callers = Object.entries((state && state.callers) || {});
    if (!callers.length) {
      host.innerHTML = '<div class="s-caller-empty">Nothing has asked yet.</div>';
      return;
    }
    host.innerHTML = '';
    for (const [id, scopes] of callers) {
      const allowed = Object.entries(scopes)
        .filter(([, record]) => record && record.decision === 'granted')
        .map(([scope]) => (scope === 'action' ? 'control' : 'read'));
      const name = (scopes.read && scopes.read.callerName) || (scopes.action && scopes.action.callerName) || id;

      const row = document.createElement('div');
      row.className = 's-caller';
      const label = document.createElement('span');
      label.textContent = name + ' — ' + (allowed.length ? allowed.join(' + ') : 'denied');
      label.title = id;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Forget';
      button.addEventListener('click', async () => {
        await cue.appLinkRevoke(id);
        fillAppLinkCallers();
      });
      row.append(label, button);
      host.append(row);
    }
  }

  const uploadResumeBtn = document.getElementById('upload-resume-btn');
  if (uploadResumeBtn) uploadResumeBtn.addEventListener('click', async () => {
    const res = await cue.pickProfileDocument();
    if (!res || res.canceled) return;
    if (res.error) { showStatus('Resume import failed: ' + res.error); return; }
    $('#resume-text').value = res.text || '';
    showStatus('Imported ' + res.fileName + ' — press Save to keep it.');
  });
  const uploadJdBtn = document.getElementById('upload-jd-btn');
  if (uploadJdBtn) uploadJdBtn.addEventListener('click', async () => {
    const res = await cue.pickProfileDocument();
    if (!res || res.canceled) return;
    if (res.error) { showStatus('Job description import failed: ' + res.error); return; }
    $('#job-description').value = res.text || '';
    showStatus('Imported ' + res.fileName + ' — press Save to keep it.');
  });

  function statusText() {
    const k = settings.apiKeys;
    const labels = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', deepgram: 'Deepgram', custom: 'Custom', ollama: 'Ollama', groq: 'Groq', minimax: 'MiniMax', azure: 'Azure AI Foundry' };
    const has = Object.keys(labels).filter((p) => k[p]).map((p) => labels[p]);
    // 'auto' walks the same fallback chain src/stt.js builds; an explicit choice
    // is reported as-is so the status line matches what will actually be used.
    const selectedSttProvider = settings.sttProvider || 'auto';
    const automaticStt = k.deepgram ? 'Deepgram (streaming)' : (k.openai ? 'OpenAI Realtime' : (k.groq ? 'Groq Whisper' : (k.gemini ? 'Gemini (batch)' : 'none')));
    const stt = selectedSttProvider === 'auto' ? automaticStt : selectedSttProvider;
    const ready = [
      settings.resumeText ? '✓ resume' : null,
      settings.jobDescription ? '✓ JD' : null,
      settings.starStories ? '✓ stories' : null,
      settings.salaryTarget ? '✓ salary' : null
    ].filter(Boolean);
    return `${labels[settings.provider] || settings.provider} · STT: ${stt}` + (ready.length ? ' · ' + ready.join(' · ') : '');
  }

  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.provider = b.dataset.provider;
    document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x === b));
    updateCustomProviderFields();
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
    updateSmartTooltip();
  }));
  document.querySelectorAll('#minimax-region-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.minimaxRegion = b.dataset.region;
    document.querySelectorAll('#minimax-region-seg button').forEach((x) => x.classList.toggle('on', x === b));
  }));

  document.querySelectorAll('#stt-provider-seg button').forEach((button) => button.addEventListener('click', () => {
    settings.sttProvider = button.dataset.sttProvider;
    document.querySelectorAll('#stt-provider-seg button').forEach((candidate) => {
      candidate.classList.toggle('on', candidate === button);
    });
    $('#s-status').textContent = statusText();
  }));

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const units = ['B', 'KB', 'MB', 'GB'];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** unitIndex);
    return `${value >= 10 || unitIndex < 2 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  function getSelectedWhisperModel() {
    if (!whisperOverview) return null;
    return whisperOverview.models.find((model) => model.id === $('#whisper-model').value) || null;
  }

  function renderWhisperModelState() {
    const model = getSelectedWhisperModel();
    if (!model) return;
    const language = model.englishOnly ? 'English only' : 'Multilingual';
    const recommendation = model.recommended ? ' · recommended default' : '';
    const partial = model.partialBytes > 0 && !model.installed
      ? ` · ${formatBytes(model.partialBytes)} ready to resume`
      : '';
    $('#whisper-model-detail').textContent = `${formatBytes(model.bytes)} · ${language} · ${model.quantization} · ${model.hardwareTier}${recommendation}${partial}`;

    const progressWrap = $('#whisper-progress-wrap');
    const progressPercent = model.bytes > 0 ? Math.floor((model.partialBytes / model.bytes) * 100) : 0;
    progressWrap.classList.toggle('hidden', !model.downloading);
    $('#whisper-progress').value = progressPercent;
    $('#whisper-progress-label').textContent = `${progressPercent}%`;
    $('#whisper-download').disabled = model.installed || model.downloading;
    $('#whisper-download').textContent = model.installed ? 'Installed' : (model.partialBytes ? 'Resume' : 'Download');
    $('#whisper-cancel').classList.toggle('hidden', !model.downloading);
    $('#whisper-import').disabled = model.downloading;
    $('#whisper-delete').disabled = (model.installedBytes === 0 && model.partialBytes === 0) || model.downloading;
  }

  async function refreshWhisperModels() {
    const status = $('#whisper-status');
    try {
      const previousSelection = $('#whisper-model').value || settings.localWhisper?.modelId || 'base.en';
      whisperOverview = await cue.whisperModels();
      const runtimeBadge = $('#whisper-runtime-status');
      runtimeBadge.classList.toggle('ready', whisperOverview.runtime.available);
      runtimeBadge.classList.toggle('error', !whisperOverview.runtime.available);
      runtimeBadge.textContent = whisperOverview.runtime.available
        ? `Ready · v${whisperOverview.runtime.version} · ${whisperOverview.runtime.target}`
        : 'Not prepared';
      runtimeBadge.title = whisperOverview.runtime.message || '';

      const select = $('#whisper-model');
      select.innerHTML = '';
      for (const model of whisperOverview.models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.label} — ${formatBytes(model.bytes)}${model.recommended ? ' (recommended)' : ''}${model.installed ? ' ✓' : ''}`;
        select.appendChild(option);
      }
      const selectionExists = whisperOverview.models.some((model) => model.id === previousSelection);
      select.value = selectionExists ? previousSelection : 'base.en';
      if (!settings.localWhisper) settings.localWhisper = {};
      settings.localWhisper.modelId = select.value;
      status.textContent = whisperOverview.runtime.available
        ? 'Model files are verified before they can be loaded.'
        : whisperOverview.runtime.message;
      renderWhisperModelState();
    } catch (error) {
      status.textContent = `Could not load local model information: ${error.message}`;
    }
  }

  $('#whisper-model').addEventListener('change', () => {
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value;
    renderWhisperModelState();
  });

  $('#whisper-download').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    model.downloading = true;
    renderWhisperModelState();
    $('#whisper-status').textContent = `Downloading ${model.id}. You can cancel and resume later.`;
    try {
      await cue.whisperModelDownload(model.id);
      $('#whisper-status').textContent = `${model.id} downloaded and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = error.message.includes('cancelled')
        ? `${model.id} download paused. Progress was kept.`
        : `Download failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  $('#whisper-cancel').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (model) await cue.whisperModelCancel(model.id);
  });

  $('#whisper-import').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    $('#whisper-status').textContent = `Verifying imported ${model.id}…`;
    try {
      const result = await cue.whisperModelImport(model.id);
      $('#whisper-status').textContent = result.cancelled ? 'Import cancelled.' : `${model.id} imported and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = `Import failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  $('#whisper-delete').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model || !window.confirm(`Delete the ${model.id} model (${formatBytes(model.bytes)}) from this computer?`)) return;
    try {
      await cue.whisperModelDelete(model.id);
      $('#whisper-status').textContent = `${model.id} deleted.`;
    } catch (error) {
      $('#whisper-status').textContent = `Delete failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  cue.on('whisper:download-progress', (progress) => {
    if (!whisperOverview) return;
    const model = whisperOverview.models.find((candidate) => candidate.id === progress.modelId);
    if (!model) return;
    model.partialBytes = progress.receivedBytes;
    model.downloading = true;
    if ($('#whisper-model').value === progress.modelId) {
      $('#whisper-progress-wrap').classList.remove('hidden');
      $('#whisper-progress').value = progress.percent;
      $('#whisper-progress-label').textContent = `${progress.percent}%`;
      $('#whisper-model-detail').textContent = `${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)}`;
    }
  });
  cue.on('whisper:models-changed', () => refreshWhisperModels());

  async function saveSettings() {
    // Keys
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    settings.apiKeys.deepgram = $('#key-deepgram').value.trim();
    settings.apiKeys.custom = $('#key-custom').value.trim();
    settings.baseUrl = $('#base-url').value.trim();
    settings.apiKeys.ollama = $('#key-ollama').value.trim();
    settings.apiKeys.groq = $('#key-groq').value.trim();
    settings.apiKeys.minimax = $('#key-minimax').value.trim();
    settings.apiKeys.azure = $('#key-azure').value.trim();
    settings.azureEndpoint = $('#azure-endpoint').value.trim();
    if (!settings.models[settings.provider]) settings.models[settings.provider] = {};
    settings.models[settings.provider].fast = $('#model-fast').value.trim();
    settings.models[settings.provider].smart = $('#model-smart').value.trim();
    // Transcription
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value || settings.localWhisper.modelId || 'base.en';
    settings.localWhisper.language = $('#whisper-language').value || 'auto';
    settings.localWhisper.threads = Math.max(0, Math.min(64, Number.parseInt($('#whisper-threads').value, 10) || 0));
    // Profile
    settings.resumeText = $('#resume-text').value.trim();
    settings.jobDescription = $('#job-description').value.trim();
    // Interview Prep
    settings.starStories = $('#star-stories').value.trim();
    settings.whyCompany = $('#why-company').value.trim();
    settings.whyLeaving = $('#why-leaving').value.trim();
    settings.workStyle = $('#work-style').value.trim();
    // Style tab
    settings.aiRules = $('#ai-rules').value.trim();
    // Q&A
    settings.salaryTarget = $('#salary-target').value.trim();
    settings.questionsToAsk = $('#questions-to-ask').value.trim();
    try {
      settings = await cue.settingsSet(settings);
      $('#s-status').textContent = statusText();
      updatePrepStatus();
      updateSmartTooltip();
      return true;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      $('#s-status').textContent = message;
      $('#base-url').focus();
      return false;
    }
  }

  // ---- example conversation (matches the reference screenshot) ------------
  function showExample() {
    clearMessages();
    addUserBubble('What should I say?');
    const ai = document.createElement('div');
    ai.className = 'ai-text';
    ai.textContent = '“A discounted cash flow model values a company by projecting future free cash flows and discounting them to present value using the weighted average cost of capital.”';
    messages.appendChild(ai);
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !scrim.classList.contains('hidden')) closeSettings();
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; cue.setIgnoreMouse(v); } }
  document.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #panel-wrap, #transcript-sidebar, #settings-scrim, #onboard-scrim, #consent-scrim'));
    setIgnore(!overUI);
  });
  setIgnore(true); // start fully click-through; hovering the panel re-enables it

  // ---- assistant access request ------------------------------------------
  // Shown here rather than as a native dialog because cue hides its dock icon:
  // an OS panel from an accessory app never comes forward and cannot be
  // clicked. Note the scrim is registered in the click-through selector above
  // and in styles.css — without both, this window stays transparent to the
  // mouse and the buttons do nothing.
  const consentScrim = $('#consent-scrim');
  let pendingConsentId = null;

  function answerConsent(allowed) {
    if (!pendingConsentId) return;
    cue.appLinkConsentRespond(pendingConsentId, allowed);
    pendingConsentId = null;
    consentScrim.classList.add('hidden');
  }

  cue.on('applink:consent-request', (request) => {
    pendingConsentId = request.id;
    $('#cs-title').textContent = request.message;
    $('#cs-body').textContent = request.detail;
    $('#cs-allow').textContent = request.allowLabel;
    consentScrim.classList.remove('hidden');
    // Do not wait for a mousemove to turn the mouse back on: the pointer may
    // already be still, and the sheet would be unclickable until it moved.
    setIgnore(false);
    $('#cs-deny').focus();
  });

  $('#cs-allow').addEventListener('click', () => answerConsent(true));
  $('#cs-deny').addEventListener('click', () => answerConsent(false));
  // Anything other than a deliberate Allow is a no, including Escape and
  // clicking away.
  consentScrim.addEventListener('click', (e) => { if (e.target === consentScrim) answerConsent(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pendingConsentId) { e.preventDefault(); answerConsent(false); }
  });

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const permissionHelp = isWindows
    ? 'cue needs microphone permission to hear you. Open Windows Privacy &amp; security settings, allow <strong>Microphone</strong> for cue, then come back here.'
    : 'cue needs two macOS permissions. Click each button, turn <strong>cue</strong> ON in the window that opens, then come back here.';
  const permissionButtons = isWindows
    ? [
        { label: 'Open Microphone settings', action: () => cue.openPane('ms-settings:privacy-microphone') }
      ]
    : [
        { label: 'Open Microphone settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
        { label: 'Open Screen & System Audio Recording settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
      ];
  const permissionRequirements = isWindows
    ? '<ul><li><strong>Microphone</strong> — to hear you</li></ul>'
    : '<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen &amp; System Audio Recording</strong> — to see your screen and hear meeting audio</li></ul>';
  const assistShortcut = isWindows ? '<span class="kbd">Ctrl</span> <span class="kbd">↵</span>' : '<span class="kbd">⌘</span> <span class="kbd">↵</span>';
  const solveShortcut = isWindows ? '<span class="kbd">Ctrl</span> <span class="kbd">H</span>' : '<span class="kbd">⌘</span> <span class="kbd">H</span>';
  const quitShortcut = isWindows ? '<span class="kbd">Ctrl</span><span class="kbd">⇧</span><span class="kbd">X</span>' : '<span class="kbd">⌘</span><span class="kbd">⇧</span><span class="kbd">X</span>';
  const OB_STEPS = [
    {
      icon: '👋',
      title: 'Welcome to cue',
      body: 'cue is a private AI copilot that floats over your screen. It can <strong>see your screen</strong>, <strong>hear your meetings</strong>, and help you answer questions or solve coding problems. Capture exclusion is best-effort; verify before sharing sensitive content.<br><br>This quick guide gets you running in about a minute.'
    },
    {
      icon: '🔐',
      title: 'Allow cue to see & hear',
      body: permissionHelp + permissionRequirements,
      buttons: permissionButtons
    },
    {
      icon: '🔑',
      title: 'Connect an AI provider',
      body: 'cue uses <strong>your own</strong> API key — pick <span class="hl">OpenAI</span>, <span class="hl">Anthropic</span>, <span class="hl">Google Gemini</span>, or <span class="hl">Azure AI Foundry</span>. Get a key from your provider, then paste it into cue\'s Settings.<br><br><strong>Tip:</strong> For the <em>best</em> real-time listening, add a <span class="hl">Deepgram</span> key (lowest latency streaming transcription). Otherwise, an OpenAI key enables streaming via the Realtime API, and Gemini/Whisper work as batch fallbacks.',
      buttons: [{ label: 'Open cue Settings', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      icon: '🫥',
      title: 'Screen-share privacy',
      body: 'cue excludes itself from ordinary macOS screen capture where supported, but hiding is not guaranteed across apps and capture methods. Verify before sharing sensitive content.'
    },
    {
      icon: '✨',
      title: 'You’re all set',
      body: 'How to use cue:<ul><li>' + assistShortcut + ' — <strong>Assist</strong> with whatever\'s on screen or being said</li><li>' + solveShortcut + ' — solve a coding problem on screen</li><li>Click <strong>▢</strong> in the top bar to start listening to a meeting</li><li>Type a question and press <span class="kbd">↵</span></li></ul>Reopen this guide anytime by clicking the <strong>cue logo</strong>. Quit with ' + quitShortcut + '.'
    }
  ];
  let obIndex = 0;
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    $('#ob-icon').textContent = step.icon;
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = step.body;
    const btns = $('#ob-buttons'); btns.innerHTML = '';
    (step.buttons || []).forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; el.addEventListener('click', b.action); btns.appendChild(el); });
    const dots = $('#ob-dots'); dots.innerHTML = '';
    OB_STEPS.forEach((_, i) => { const d = document.createElement('span'); if (i === obIndex) d.className = 'on'; dots.appendChild(d); });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Done' : 'Next';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  function showOnboard() { obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false); }
  async function finishOnboard() {
    obScrim.classList.add('hidden');
    if (settings && !settings.onboarded) { settings.onboarded = true; await cue.settingsSet({ onboarded: true }); }
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await cue.settingsGet();
    await refreshContentProtection();

    // R4: shortcut hints
    const sayHintEl = document.getElementById('say-shortcut-hint');
    const assistHintEl = document.getElementById('assist-shortcut-hint');
    if (sayHintEl) sayHintEl.textContent = isWindows ? 'Ctrl+Shift+↵' : '⌘⇧↵';
    if (assistHintEl) assistHintEl.textContent = isWindows ? 'Ctrl+↵' : '⌘↵';

    // R5: prep status
    updatePrepStatus();
    // R6: smart tooltip
    updateSmartTooltip();
    smartBtn.classList.toggle('on', !!settings.smart);
    showExample();
    syncPlaceholder();
    updateSendButtonState(); // Initialize send button state

    // Fix placeholder shortcut hint to match platform
    if (isWindows) {
      placeholder.innerHTML = 'Ask about your screen or conversation, or <span class="keycap">Ctrl</span><span class="keycap">⏎</span> for Assist';
    }

    const st = await cue.captureState();
    if (st.active) {
      await cue.captureSet(false);
      showStatus('Listening was reset after the window reloaded. Start listening when you are ready.');
    }
    renderCaptureSnapshot(captureCoordinator.snapshot());
    if (!settings.onboarded) showOnboard();
  })();
})();

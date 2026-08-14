<div align="center">

# cue

**An open-source AI copilot that floats over your screen — sees what you see, hears a meeting when you start listening, and tries to stay out of screen shares.**

A self-hosted alternative to Cluely. Bring your own AI and, when needed, speech-to-text provider credentials.

<img src="docs/tutorial.png" width="620" alt="cue first-run tutorial" />

</div>

---

> [!IMPORTANT]
> cue tries to stay out of screen recordings and shares, but this is **best-effort, not guaranteed**. On macOS 15.4+ modern capture tools can see it; Windows 10 builds older than 2004 show a black box instead of true exclusion; and a phone camera can always see the display. Using an assistant in a proctored exam, job interview, or recorded meeting can violate platform rules or consent laws. Use cue only for legitimate purposes such as your own notes, studying, accessibility, and practice.

## What Phase 1 does

cue has three independent inputs:

- **Screen** — captured only when a screen-based request needs it.
- **You** — your microphone.
- **Meeting** — meeting/system output audio, kept separate from You.

Phase 1 is deliberately a **user-started listening and manual-answer** flow. Click the Start/stop listening button in cue’s top bar; cue starts the available audio channels and builds the conversation. When you want a response, click **What should I say?** (or use its configured shortcut) to request one. **Automatic answers and continuous screen-change awareness are Phase 2 work and are not claimed here.**

| Feature | How to trigger | Inputs it can use |
|---|---|---|
| **Assist** | `⌘` `↵` (macOS) or `Ctrl` `Enter` (Windows), configurable | screen + recent conversation |
| **What should I say?** | button or configured shortcut, after you start listening | available You and Meeting conversation |
| **Follow-up questions** | button | accumulated conversation |
| **Recap** | button | accumulated conversation |
| **Ask anything** | type + `↵` | screen + conversation |
| **Solve a coding problem** | `⌘` `H` (macOS) or `Ctrl` `H` (Windows) | screen |

### Platform support

|  | macOS 14.4+ | Windows 11 / Windows 10 2004+ |
|---|---|---|
| Screen + coding help | ✅ | ✅ |
| Your microphone (**You**) | ✅ | ✅ |
| Meeting/system audio (**Meeting**) | ✅ ScreenCaptureKit loopback | ✅ loopback capture |
| Channel failures | ✅ microphone and Meeting fail independently | ✅ microphone and Meeting fail independently |
| Hidden from screen shares | ⚠️ best-effort; weaker on macOS 15.4+ | ⚠️ best-effort capture exclusion; not every capture path |
| Permissions to grant | Microphone; Screen & System Audio Recording | Microphone |

On macOS 14.4 and later, cue captures your microphone as **You** and meeting/system output as **Meeting** through ScreenCaptureKit loopback. A failure in one channel does not stop the other channel from listening. On older macOS, Meeting audio is unavailable; use macOS 14.4+ for the supported macOS listening flow. On both platforms, capture exclusion is best-effort rather than a guarantee; verify before sharing sensitive content because it does not cover every capture path.

## Install and run

### Run from source

Install Node.js 22.12 or newer. The lockfile supports either a clean, reproducible install with `npm ci` or a normal development install with `npm install`.

```bash
git clone https://github.com/Blueturboguy07/cue.git
cd cue
npm ci
npm start
```

`npm install` is also supported when you are intentionally updating local dependencies; do not use it as a substitute for the locked install in verification work.

Source runs need the local whisper.cpp runtime only if you select **Local** transcription:

```bash
npm run prepare:whisper
```

On macOS, that runtime preparation builds `whisper-server` and requires CMake plus Xcode command-line tools. Packaged builds include the pinned runtime.

### Build and inspect an Apple-silicon app

The package scripts use Electron Builder. This command makes an unpacked Apple-silicon app at `dist/mac-arm64/cue.app`:

```bash
npm run pack -- --mac --arm64
npm run verify:mac-app -- dist/mac-arm64/cue.app
```

`verify:mac-app` checks the bundle identifier, an arm64 executable, required reliability modules, and the code signature. It explicitly does **not** prove notarization or Gatekeeper distribution.

To create the configured macOS ZIP target instead, run:

```bash
npm run dist:mac -- --arm64
```

Windows commands remain available:

```bash
npm run pack:win
npm run dist:win
```

The Windows installer is unsigned and may produce a SmartScreen “Unknown publisher” warning.

### Signing and distribution status

Without `MAC_SIGN=1`, `electron-builder.cjs` requests the `identity: '-'` **ad-hoc** signature. That path is for a personal, locally launchable build; it is not a distributable public release and a downloaded build will not satisfy Gatekeeper.

For a Developer ID public-release candidate, set `MAC_SIGN=1` and make a **Developer ID Application** identity available in the keychain (or provide `CSC_LINK` in CI). Notarization is enabled only when all three of `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are also present; then Electron Builder enables the hardened runtime, notarizes, and staples the app. Do not put any of those credentials in source control or a diagnostic summary.

To assess a built app, run `spctl` against the bundle:

```bash
spctl --assess --type execute --verbose=4 dist/mac-arm64/cue.app
```

An ad-hoc local build is expected to be rejected by Gatekeeper assessment. A properly Developer ID-signed, notarized, and stapled release candidate is expected to be accepted; confirm that result on the actual artifact rather than inferring it from the build settings.

macOS privacy grants are tied to the exact app signature. An ad-hoc rebuild can require you to grant permissions again, even when System Settings still appears to show the old grant. This repository does not claim that a currently built artifact is signed, notarized, or ready for public distribution.

## First launch and listening

### 1. Grant macOS permissions

When prompted, allow cue. If a prompt does not appear, use these exact paths:

- **System Settings → Privacy & Security → Microphone** — enable cue for the **You** channel.
- **System Settings → Privacy & Security → Screen & System Audio Recording** — enable cue for screen capture and the **Meeting** loopback channel.

Quit and reopen cue if macOS asks. After an ad-hoc rebuild, turn cue off and back on in both locations, then reopen the rebuilt app.

### 2. Grant Windows microphone permission

On Windows, open **Settings → Privacy & security → Microphone** and enable both **Microphone access** and **Let desktop apps access your microphone**. Windows meeting audio uses loopback; no macOS-style Screen & System Audio Recording grant is needed.

### 3. Configure providers

Chat/AI and speech-to-text are separate settings. Open **Settings** from the `...` button, configure an AI provider for answers, then choose a speech-to-text provider in **Settings → Audio** for listening.

| Need | Supported configuration |
|---|---|
| AI answers | OpenAI, Anthropic, Gemini, Custom OpenAI-compatible endpoint, Ollama, Groq, MiniMax, or Azure AI |
| Local speech-to-text | Select **Local**, choose/download or import a whisper.cpp model; no cloud audio fallback is used |
| Cloud speech-to-text | Select **Deepgram**, **OpenAI**, or **Gemini** and provide that provider’s key |
| Automatic speech-to-text choice | Select **Auto**; it prioritizes Deepgram streaming, then OpenAI Realtime. With neither streaming credential, it enters batch mode; Gemini is the batch fallback surfaced by the streaming selector when a Gemini key is configured. |

Deepgram and OpenAI are streaming choices when their selected/available credentials permit it. OpenAI streaming uses `gpt-live-transcribe` with an English language hint, a vocabulary context built from your Profile resume and job description, and `medium` delay as the balanced accuracy/latency default. Gemini is batch transcription. In batch mode, the current Auto chain tries configured OpenAI, Groq, then Gemini credentials in that order, including after a streaming error. Local mode loads one selected whisper.cpp model for both You and Meeting, keeps audio on the computer, and reports local errors instead of silently sending audio to a cloud provider. An Anthropic, Custom, Ollama, MiniMax, or Azure AI chat configuration does not itself provide speech-to-text; configure one of the transcription choices separately.

### 4. Start listening, then ask manually

1. Click the Start/stop listening button in the top bar.
2. Check the live indicator or **Settings → Health**. Listening can be ready with only You or only Meeting when the other channel failed.
3. Speak or let meeting audio play. The separate channels build the conversation.
4. Click **What should I say?** when you want a suggested response. Cue does not send automatic answers in Phase 1.
5. Click the same top-bar button to stop listening.

## Health and recovery

Open **Settings → Health** for microphone permission, microphone capture, Screen & System Audio permission, Meeting audio, speech-to-text, AI-provider configuration, a categorized last failure, and a copyable safe summary. Health checks configuration presence only: it does not check credential validity, network reachability, or provider availability. An actual request reports authentication, quota, model, and network failures.

Capture has fixed states **off**, **starting**, **ready**, and **failed**. During shutdown, the listening session and speech-to-text can show **stopping**; streaming speech-to-text can also show **disconnected** while it reconnects or reports failure. A ready microphone with failed Meeting audio (or the reverse) is a partial, usable listening session rather than a reason to stop both channels.

| What Health reports | Recovery |
|---|---|
| Permission denied | Enable cue at the exact macOS paths above, quit/reopen it, and re-grant after an ad-hoc rebuild if necessary. |
| Missing microphone or no Meeting track | Check the selected/default input or that macOS 14.4+ is in use, then stop and start listening again. |
| An audio track ended or a device disconnected | The remaining channel can continue. Stop, then start listening to reconnect the failed channel. |
| Provider authentication or permission error | Update the selected AI or transcription provider credentials/permissions in Settings, then retry. |
| Provider quota | Wait or check billing, then choose another configured provider if appropriate. |
| Model unavailable | Select a current model in Settings and retry. |
| Network, service, or timeout | Check the connection, then retry; temporary provider failures can recover without changing capture permissions. |
| Local model/runtime problem | In **Settings → Audio**, download or import a verified model. For source runs, prepare the runtime with `npm run prepare:whisper`. |

The **Copy diagnostic summary** control is intentionally safe to share for support: it excludes API keys, transcript content, captured audio, and screenshots.

## How it works

cue is an [Electron](https://www.electronjs.org/) app. Screen capture uses Electron’s `desktopCapturer`; the renderer uses `getUserMedia` for You and `getDisplayMedia` for Meeting. On macOS, Electron starts with `MacLoopbackAudioForScreenShare` and `MacSckSystemAudioLoopbackOverride`, and its display-media handler requests `loopback` audio. Each capture channel has its own lifecycle, so a permission, device, or ended-track error is isolated to that channel.

Audio is transcribed by the separately selected local or cloud speech-to-text provider. The resulting conversation and an optional screenshot are sent only when a manual answer feature needs them. Responses stream into the panel.

The overlay uses Electron content protection. On macOS it requests `NSWindowSharingNone`; on Windows it uses `WDA_EXCLUDEFROMCAPTURE` (with the older Windows fallback described above). This is not a guarantee that every capture tool will exclude cue. Set `CUE_NO_PROTECT=1` only to disable content protection while debugging.

## Privacy

- Cue has no Cue account, hosted service, or telemetry.
- Provider settings are stored locally in `cue-data.json`. Keys and request data are sent only to the configured provider that needs them.
- In Local transcription mode, microphone and Meeting audio remain on the computer. Local mode does not silently fall back to cloud transcription.
- Captured utterances and the current transcript stay in memory; cue does not write captured audio to disk. Downloaded local models remain until you delete them in Settings.
- Screenshots are sent to the selected AI provider only when a screen-based request needs them.

## Security and release limitations

This revision pins Electron **33.2.1**. A current full `npm audit` reports high-severity findings against Electron, so this version should not be represented as production-safe. Upgrade and validate Electron, then independently verify signing, notarization, Gatekeeper behavior, and live audio acceptance before claiming a public macOS release. The bundled verifier checks app structure and signature integrity only; it is not a live microphone or Meeting-audio acceptance test.

## Contributing

Run the full test suite before submitting changes:

```bash
npm test
```

The test command is `node --test test/*.test.js`. For a packaged Apple-silicon check, also run the arm64 build and `verify:mac-app` commands above. Documentation changes that affect setup, permissions, provider choices, packaging, or recovery should update this README in the same change.

## Credits & license

Local transcription uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp), distributed under the MIT License. Its license notice is included in packaged runtimes.

**License: [GPL-3.0-or-later](LICENSE).**

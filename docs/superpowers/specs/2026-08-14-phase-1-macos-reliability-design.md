# Phase 1 macOS Reliability Design

**Status:** Approved in conversation on 2026-08-14  
**Target:** Apple Silicon macOS, starting from cue `f8d743a`  
**Repository:** `Milo6x/cue`  
**Branch:** `codex/phase1-macos-reliability`

## Goal

Produce a dependable macOS build of cue that can listen to the user's microphone and meeting/system audio independently, maintain an ordered conversation transcript, and return a useful answer from **What should I say?** without freezing or failing silently.

Phase 1 establishes the reliable capture, transcription, request, diagnostics, packaging, and test foundation required before adding automatic answers or continuous screen-change awareness.

## Scope

Phase 1 includes:

- independent microphone and system-audio capture lifecycles
- graceful degradation when either audio channel fails
- ordered, source-labelled transcript entries for **You** and **Meeting**
- manual **What should I say?** answers grounded in the recent transcript
- bounded AI requests with safe retry rules and actionable provider errors
- a diagnostics surface for permissions, audio channels, transcription, and AI configuration
- repeatable stop, restart, and failure recovery
- regression tests, the full existing suite, and an Apple Silicon packaged-app smoke test
- macOS setup and troubleshooting documentation that agrees with the shipped behavior

## Non-goals

The following are deliberately deferred to Phase 2:

- automatic answers triggered by questions or pauses
- continuous screen observation or screen-change detection
- background operation without a user-started listening session
- speaker diarization beyond the existing input-source labels
- cloud accounts, hosted AI credits, or server-side transcript storage
- a publicly downloadable notarized release without the user's Apple Developer credentials
- unrelated visual redesigns or broad refactors

## Existing Code Constraints

The design preserves cue's current Electron security boundary:

- Chromium media capture remains in `renderer/renderer.js` because `getUserMedia`, `getDisplayMedia`, `AudioContext`, and `AudioWorklet` require renderer APIs.
- Privileged state, transcription routing, transcript ownership, screenshots, and AI requests remain in `main.js` and `src/`.
- The renderer communicates only through the allowlisted bridge in `preload.js`; Node integration remains disabled.
- Existing providers and local whisper.cpp support remain available.
- Existing user settings and API-key storage are not migrated unless a test proves a migration is required.

The current renderer starts system audio before toggling main-process capture, starts the microphone after the main process reports an active state, and displays both channels through shared status UI. That coupling is the main reliability risk addressed in this phase.

## Architecture

### 1. Capture coordinator

Introduce a small, renderer-side capture coordinator with an explicit state for each channel:

- `off`
- `starting`
- `ready`
- `failed`
- `stopping`

The microphone and system-audio channels start and stop independently. The coordinator aggregates them into the session state but never treats one channel's failure as the other channel's failure.

The coordinator owns start/stop idempotency, concurrent-click protection, track-ended handling, and cleanup. It reports structured status objects through the existing bridge rather than relying on a single live dot or transient toast.

The listening session becomes active when the main-process transcription pipeline is ready and at least one requested audio channel is usable. If neither channel starts, the session returns to `off` with both failure reasons visible.

### 2. Audio-channel contract

Each captured PCM chunk keeps the existing source contract:

- microphone -> `you`
- system/meeting audio -> `them`

The main process accepts audio only while its capture session is active. Channel errors do not mutate or disable the other channel. Track-ended events immediately update diagnostics and release that channel's audio graph.

PCM and captured audio remain memory-only. Raw audio is never written to logs or disk.

### 3. Ordered transcript

The main process remains the canonical transcript owner. Finalized transcript entries gain a timestamp and stable sequence number at insertion time while preserving the existing `channel` and `text` fields.

The renderer displays:

- `You` for microphone entries
- `Meeting` for system-audio entries

AI prompt construction uses the ordered finalized transcript only. Interim text stays visible for responsiveness but is not sent to the AI. Empty, punctuation-only, duplicate interim, and malformed entries are rejected before prompt construction.

### 4. Manual answer request policy

**What should I say?** remains explicitly user-triggered in Phase 1. It uses a bounded recent transcript window and the existing interview/profile context.

The request policy provides:

- a first-response timeout so a provider cannot leave cue busy indefinitely
- an inactivity timeout that is rearmed as tokens arrive
- cancellation/cleanup when the request settles or the app closes
- at most one retry for a temporary network, timeout-before-first-token, HTTP 408, or HTTP 5xx failure
- no automatic retry after any response token has arrived
- no retry for invalid credentials, permission errors, quota exhaustion, invalid configuration, or missing/retired models
- one in-flight answer at a time

Provider errors are classified into actionable categories: configuration, authentication, permission, quota/rate limit, unavailable model, network, timeout, and unknown provider failure. Existing provider-specific detail is preserved when it is safe and useful.

### 5. Diagnostics surface

Add a compact diagnostics section to the existing settings interface rather than creating a separate window. It reports:

- microphone permission and capture state
- system/screen permission and capture state
- detected audio track names without stable hardware identifiers
- transcription provider and connection state
- chat provider and selected model readiness
- last failure category, user-facing message, channel, and time

Diagnostics must never show API-key values, authorization headers, raw audio, full request bodies, or transcript contents. A copyable diagnostic summary includes versions and statuses only.

### 6. Packaging and launch validation

The first personal build may be ad-hoc signed because no Apple Developer certificate is currently in scope. The build documentation must say that clearly and explain the narrow quarantine-removal step for the verified local artifact.

The packaged app must include all allowlisted renderer, source, and vendor files. A package test will inspect the bundle contents and app metadata. A local smoke test will launch the packaged Apple Silicon app, confirm that it stays running, and exercise the permission and basic UI path without claiming that automated tests can grant macOS privacy permissions.

Public distribution remains gated on Developer ID signing and notarization.

## Session Data Flow

1. The user presses **Start listening**.
2. The renderer coordinator starts microphone and system audio independently.
3. The main process starts the selected transcription pipeline once, with bounded startup and a structured state result.
4. Each usable channel sends labelled PCM chunks through the existing preload bridge.
5. VAD and the selected transcription provider produce interim and final results.
6. The main process timestamps and sequences valid final transcript entries and sends display events to the renderer.
7. The user presses **What should I say?**.
8. The main process validates that useful transcript context exists, builds the prompt, and executes the bounded request policy.
9. Tokens stream into the answer panel; completion or failure always releases busy state.
10. **Stop listening** prevents new audio, drains or bounds pending transcription according to the selected provider, releases both renderer audio graphs, and returns all capture states to `off`.

## Failure Handling

- Starting listening must not block the renderer while waiting for a permission prompt, audio device, local model, WebSocket, or AI provider.
- A system-audio failure leaves microphone capture active and shows the exact system-audio remedy.
- A microphone failure leaves system audio active when available and shows the exact microphone remedy.
- Permission messages name the macOS panel: **System Settings -> Privacy & Security -> Microphone** or **Screen & System Audio Recording**.
- Missing devices, ended tracks, denied permissions, unsupported loopback, and devices busy elsewhere receive distinct messages.
- A failed or cancelled start releases any partially created streams, contexts, nodes, and listeners.
- Repeated start/stop actions are idempotent and cannot create orphaned streams.
- Empty transcripts do not trigger an AI request; the UI asks the user to speak or type context.
- AI failure always clears busy state and leaves the previous transcript and answers intact.
- Logs contain structured event names and sanitized metadata only. Secrets, transcript text, raw audio, and captured images are excluded.

## Testing Strategy

Implementation follows test-first development. Every bug fix begins with a focused test that fails for the observed reason.

### Automated unit and integration tests

Tests will cover:

- independent channel transitions and aggregate session state
- one channel failing while the other continues
- duplicate start calls and start/stop races
- cleanup after partial startup and track-ended events
- ordered transcript timestamps, sequence numbers, and input filtering
- empty-transcript request rejection
- timeout cleanup and busy-state release
- temporary-failure retry before the first token
- no retry after streaming starts
- no retry for authentication, quota, configuration, or model errors
- provider-error classification and sanitized diagnostics
- bridge allowlists for new status events
- packaged file allowlist and macOS metadata

### Existing regression suite

The complete `npm test` suite and JavaScript syntax checks must pass. Any pre-existing failure will be reported separately rather than hidden by the Phase 1 changes.

### Packaged-app verification

On the user's Apple Silicon Mac:

- build the arm64 packaged app from the committed branch
- verify bundle structure and executable architecture
- launch the exact packaged app and confirm that it remains alive
- manually grant or confirm microphone and screen/system-audio permissions
- confirm the user's speech appears promptly in the `You` channel
- confirm meeting audio appears in the `Meeting` channel
- confirm **What should I say?** returns an answer using recent conversation
- confirm stop, restart, and one-channel failure recovery without restarting cue

Manual audio quality is acceptance evidence, not a substitute for automated regression tests.

## Acceptance Criteria

Phase 1 is complete only when all of the following are true:

1. Starting listening never freezes the interface.
2. Microphone and system audio operate and fail independently.
3. The transcript is ordered, source-labelled, and excludes unusable input.
4. **What should I say?** returns a usable answer from recent conversation or an actionable, correctly classified error.
5. Stop, restart, partial startup failure, and track loss recover without restarting the app.
6. No secrets, transcripts, raw audio, or screenshots appear in logs unintentionally.
7. Focused tests, the full test suite, syntax checks, package checks, and the Apple Silicon launch smoke test pass.
8. The README accurately documents macOS audio support, permissions, provider requirements, ad-hoc installation, diagnostics, and known limitations.
9. Any remaining limitation is documented and not represented as working.

## Documentation Changes

The README currently contradicts itself: one section says macOS 14.4+ system-audio loopback is supported while later platform and troubleshooting sections still call meeting audio Windows-only. Phase 1 will reconcile those sections against the verified packaged behavior.

Documentation will also include:

- a short macOS first-run checklist
- exact permission locations for current macOS
- how to interpret each diagnostics state
- provider and speech-to-text requirements
- stop/restart recovery guidance
- the difference between a personal ad-hoc build and a notarized public release
- an explicit Phase 2 note for automatic answers and screen awareness

## Delivery Boundary

Phase 1 ends with a committed and tested source branch plus a verified personal Apple Silicon app artifact. It does not claim public distribution readiness, commercial validation, or Phase 2 behavior.

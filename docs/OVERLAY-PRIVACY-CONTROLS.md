# Overlay controls and privacy state

The top toolbar exposes a visible **Quit** button and a screen-share privacy control.

- **Screen-share protection: on (best effort)** is the default. Cue requests Electron content protection for its overlay, but this does not guarantee exclusion from every screenshot or capture method.
- **Screenshots allowed for support** temporarily turns that request off so a support screenshot can include cue. Select the control again to restore protection.
- On Windows versions that do not support Electron content protection, the control reports that protection is unavailable and cannot claim that screenshots are blocked.

The state is owned by the main process. The renderer can read or change it only through the `content-protection:get` and `content-protection:set` preload APIs; both reject calls that do not originate from cue's live window. The renderer also listens for `content-protection:changed` so its label stays synchronized after startup and changes.

`CUE_NO_PROTECT=1` remains a development-only startup escape hatch. It starts cue with screenshots allowed for support; it does not make capture exclusion guarantees either way.

Speech recognition is shown in the live transcript and Conversation History. It never populates, clears, or submits the manual chat composer; type a prompt there to send it.

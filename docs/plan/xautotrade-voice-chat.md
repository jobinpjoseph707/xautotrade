# XAutoTrade — Voice chat with the agents (2026-09-23)

The Agents tab (chat) supports talking instead of typing, reading replies aloud, and picking which voice reads them — with a good Irish woman's voice auto-selected when the device has one.

## What it does
- **🎙 mic button** next to the message box: tap, speak — pauses are fine, it waits for a real ~3 second silence before sending (not a quick breath mid-sentence). Tap the mic again any time to send immediately with whatever's been captured so far, or tap it right after starting with nothing said yet to cancel silently.
- **🔊 Read replies aloud** toggle: when on, every agent reply is spoken automatically. Tap it again mid-speech ("⏹ Stop reading") to interrupt.
- **🗣 voice picker chip** (shows the current voice's short name): opens a sheet listing every voice installed on the device, Irish ones tagged **IRISH** and ranked first. Tap ▶ to preview any voice without changing the selection, tap a row to pick it — the choice is remembered (AsyncStorage) across sessions. If no Irish voice is installed, a banner explains how to add one instead of silently substituting something else:
  - **Windows**: Settings → Time & language → Language & region → Add a language → English (Ireland) → install its speech pack. The natural voice is named **"Orla"**; reload the page afterwards and it's auto-selected.
  - **macOS/iOS**: **"Moira"** (Irish English) is normally already installed.
- All of this is built on the browser's own Speech Recognition / Speech Synthesis APIs — no extra keys, no server round-trip, no new dependency. It only appears when the browser actually supports it.
- Agents also have a short **APP OVERVIEW** in their system prompt (server/src/chat/prompt.ts) so "what does this app do" gets a real answer.

## Pause tolerance (bug fix, 2026-09-23)
The browser's own end-of-speech detection is very trigger-happy — with `continuous: false` (the original implementation) it could cut off and send after well under a second of silence, mid-sentence. Fixed by setting `continuous: true` (so the browser itself never auto-ends the session) and running our own 3-second silence timer in `mobile/src/voice.ts` (`useVoiceInput`, `SILENCE_MS`), reset on every speech chunk and firing `recognition.stop()` only after real silence — the same shape as Claude Code's own voice input. A manual mic tap still finalizes/sends (or cancels, if nothing was said) immediately, bypassing the timer.

## How the default voice is picked
`mobile/src/voice.ts` scores every voice the browser reports (`speechSynthesis.getVoices()`): `en-IE`/`ga-IE` language or a name matching known Irish voices (Orla, Moira, Niamh, Aoife, Siobhán, Sabina, Colm, Erin) scores highest; common female-sounding names are nudged up, common male ones down; nearest accent family (en-GB) is the fallback. The top-scoring voice is the default the first time (no memory shows we're overriding a saved user choice); picking a different one persists it.

## Files
- mobile/src/voice.ts — `useVoiceInput` (mic, now pause-tolerant), `useVoices` (voice list + ranking + `isIrish`), `useVoiceOutput` (adds `voices`, `voiceURI`, `setVoice`, `preview`, `hasIrish`, `best`).
- mobile/src/screens/ChatScreen.tsx — mic button, voice picker chip + Sheet, updated listening copy.
- server/src/chat/prompt.ts — APP_OVERVIEW block.

## Tests
Server 170/170, e2e 127/127, UI regression 25/25, journal 12/12, voice.mjs now 27/27 (desk+phone: mic/toggle render, auto-picks the mocked Irish voice, picker tags it IRISH, preview speaks without changing selection, picking a voice updates the chip and is used for the next reply, a ~1.5s mid-sentence pause does NOT cut off or send, the mic only turns off and sends once real silence elapses, a manual stop still sends immediately, stopping before any speech sends nothing, no console errors — plus a third scenario with no Irish voice in the mock confirming the "how to add one" banner appears instead of a silent fallback).

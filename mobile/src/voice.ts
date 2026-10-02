/**
 * Voice for the Agents chat — speak instead of typing, and optionally have
 * replies read back. Built on the browser's own Speech Recognition (STT) and
 * Speech Synthesis (TTS) APIs: no server round-trip, no extra keys, and it
 * works everywhere this app actually ships (Expo web, and any phone/desktop
 * browser). Both are feature-detected — screens simply don't render voice
 * controls where the browser doesn't have them, rather than showing a broken
 * button.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
}

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function voiceInputSupported(): boolean {
  return recognitionCtor() != null;
}

export function voiceOutputSupported(): boolean {
  return typeof window !== 'undefined' && !!window.speechSynthesis;
}

/**
 * How long you can go quiet — mid-thought, choosing a word, a breath — before
 * it's treated as "done talking". The browser's own end-of-speech detection
 * is far more trigger-happy than this (it can cut you off after well under a
 * second), so `continuous` mode is used to stop the browser doing that at
 * all, and this timer decides it instead — the same shape as voice input in
 * Claude Code: it waits for a real pause, not the first breath.
 */
const SILENCE_MS = 3000;

/**
 * Mic in, transcript out. `interim` updates live while the user talks;
 * `onFinal` fires once, with the recognized text, after you've been quiet
 * for `SILENCE_MS`, or immediately when `stop()` is called.
 */
export function useVoiceInput(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const silenceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const clearSilence = () => {
    if (silenceRef.current != null) {
      clearTimeout(silenceRef.current);
      silenceRef.current = null;
    }
  };

  const stop = useCallback(() => {
    clearSilence();
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    recRef.current?.abort();
    clearSilence();
    const rec = new Ctor();
    // Keep the session open across pauses — our own silence timer below is
    // what actually decides when you've stopped talking, not the browser's.
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US';
    let finalText = '';
    const armSilenceTimer = () => {
      clearSilence();
      silenceRef.current = setTimeout(() => recRef.current?.stop(), SILENCE_MS);
    };
    rec.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else live += r[0].transcript;
      }
      setInterim((finalText + live).trim());
      armSilenceTimer(); // Speech just happened — push the auto-stop back out.
    };
    rec.onerror = (e) => {
      const code = (e as { error?: string } | undefined)?.error;
      // 'no-speech' and 'aborted' are routine (nothing was said yet; we cut it
      // off ourselves) — only a real failure is worth interrupting for.
      setError(code === 'not-allowed' || code === 'permission-denied' ? 'Microphone access was blocked.' : code === 'no-speech' || code === 'aborted' ? null : 'Voice input failed.');
      setListening(false);
      clearSilence();
    };
    rec.onend = () => {
      clearSilence();
      setListening(false);
      setInterim('');
      if (finalText.trim()) onFinalRef.current(finalText.trim());
    };
    recRef.current = rec;
    setError(null);
    setInterim('');
    setListening(true);
    rec.start();
    armSilenceTimer(); // Also stop on its own if nothing is ever said.
  }, []);

  useEffect(() => () => {
    clearSilence();
    recRef.current?.abort();
  }, []);

  return { listening, interim, error, start, stop, supported: voiceInputSupported() };
}

// ---------------------------------------------------------------------------
// Voice picking — the browser only ever offers whichever system voices are
// installed, so there is no way to conjure an Irish accent that isn't there.
// What we CAN do is find the best one already on the machine and default to
// it. Windows ships a proper Irish-English voice ("Microsoft Orla") once the
// Irish (Ireland) language pack is added under language settings; macOS ships
// "Moira" (Irish English) out of the box. Both show up here automatically.

const VOICE_PREF_KEY = 'xat.voice.uri';
/** Names of known Irish-English voices across Windows/macOS/mobile TTS engines. */
const IRISH_NAME = /\b(orla|moira|siobh[aá]n|aoife|niamh|una|sabina|colm|fiona\s*\(irish\)|erin)\b/i;
/** Common female-voice names, used only to steer the *default* pick — never to hide other voices. */
const FEMALE_NAME = /\b(orla|moira|siobh[aá]n|aoife|niamh|una|sabina|erin|hazel|susan|zira|samantha|karen|victoria|tessa|serena|kate|female|woman|aria|jenny|libby|maisie|sonia)\b/i;
const MALE_NAME = /\b(colm|daniel|david|mark|george|ryan|guy|male|man)\b/i;

export function isIrish(v: SpeechSynthesisVoice): boolean {
  return v.lang.toLowerCase() === 'en-ie' || v.lang.toLowerCase() === 'ga-ie' || IRISH_NAME.test(v.name);
}

/** Ranks voices for the "good Irish woman" default: Irish + female-sounding first, then nearest accent. */
function score(v: SpeechSynthesisVoice): number {
  const lang = v.lang.toLowerCase();
  let s = 0;
  if (isIrish(v)) s += 100;
  if (FEMALE_NAME.test(v.name)) s += 20;
  if (MALE_NAME.test(v.name) && !FEMALE_NAME.test(v.name)) s -= 40;
  if (lang.startsWith('en-gb')) s += 6; // nearest accent family absent a real Irish voice
  if (lang.startsWith('en')) s += 3;
  if (v.localService) s += 2; // on-device voices work offline and start instantly
  return s;
}

export function useVoices() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!voiceOutputSupported()) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.onvoiceschanged = load; // Chrome loads its voice list asynchronously.
    return () => {
      if (voiceOutputSupported()) window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  const ranked = useMemo(() => [...voices].sort((a, b) => score(b) - score(a)), [voices]);
  const best = ranked[0] ?? null;
  const hasIrish = voices.some(isIrish);
  return { voices: ranked, best, hasIrish };
}

/** Reads agent replies aloud, one at a time (a new one interrupts the last). */
export function useVoiceOutput() {
  const supported = voiceOutputSupported();
  const [speaking, setSpeaking] = useState(false);
  const { voices, best, hasIrish } = useVoices();
  const [voiceURI, setVoiceURIState] = useState<string | null>(null);
  const prefLoaded = useRef(false);

  // Restore a saved choice once.
  useEffect(() => {
    AsyncStorage.getItem(VOICE_PREF_KEY)
      .then((saved) => {
        if (saved) setVoiceURIState(saved);
      })
      .catch(() => undefined)
      .finally(() => {
        prefLoaded.current = true;
      });
  }, []);

  // Once voices are in and nothing has been chosen yet, default to the best match.
  useEffect(() => {
    if (!prefLoaded.current || voiceURI || !best) return;
    setVoiceURIState(best.voiceURI);
  }, [best, voiceURI]);

  const setVoice = useCallback((uri: string) => {
    setVoiceURIState(uri);
    AsyncStorage.setItem(VOICE_PREF_KEY, uri).catch(() => undefined);
  }, []);

  const speakWith = useCallback(
    (text: string, uri: string | null) => {
      if (!supported) return;
      const synth = window.speechSynthesis;
      synth.cancel();
      // Skip the raw action JSON — it's for the proposal card, not the ear.
      const clean = text.replace(/```xat-actions[\s\S]*?```/g, ' See the proposal below. ').replace(/[#*_`]/g, '');
      if (!clean.trim()) return;
      const u = new SpeechSynthesisUtterance(clean);
      const chosen = uri ? voices.find((v) => v.voiceURI === uri) : undefined;
      if (chosen) {
        u.voice = chosen;
        u.lang = chosen.lang;
      } else {
        u.lang = 'en-IE';
      }
      u.onstart = () => setSpeaking(true);
      u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      synth.speak(u);
    },
    [supported, voices],
  );

  const speak = useCallback((text: string) => speakWith(text, voiceURI), [speakWith, voiceURI]);
  /** Try a voice without changing the saved choice — for a "preview" button in a picker. */
  const preview = useCallback((uri: string) => speakWith("Hi, I'm listening — this is how I'll read your replies.", uri), [speakWith]);

  const stop = useCallback(() => {
    if (supported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  useEffect(() => () => { if (supported) window.speechSynthesis.cancel(); }, [supported]);

  return { supported, speaking, speak, preview, stop, voices, voiceURI, setVoice, hasIrish, best };
}

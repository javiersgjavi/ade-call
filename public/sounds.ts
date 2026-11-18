// Short tones that tell the user, without looking at the screen, what the call
// is doing: the tap on Call, the moment the line is open and they can speak,
// and a one-tap new session. Browsers only let a page start audio inside a
// user gesture, so the shared AudioContext is created (or resumed) at the tap
// and reused when the connection tone plays seconds later.
export const SOUNDS = {
  // Two soft notes on tapping Call: the call is being placed.
  call: [523.25, 659.25],
  // Two higher, rising notes when the line is open: you can speak now.
  connected: [783.99, 1046.5],
  // A new session started from the call.
  session: [659.25, 987.77]
} as const;
export type Sound = keyof typeof SOUNDS;

let context: AudioContext | null = null;

/** Creates or resumes the audio context; call it inside the tap. */
export function unlockSounds() {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume();
  } catch { context = null; }
}

/** Plays a sound; silent if the browser has no audio output or never allowed it. */
export function play(sound: Sound) {
  unlockSounds();
  if (!context) return;
  try {
    const now = context.currentTime;
    SOUNDS[sound].forEach((frequency, i) => {
      const start = now + i * 0.16, tone = context!.createOscillator(), gain = context!.createGain();
      tone.type = 'sine'; tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      tone.connect(gain).connect(context!.destination); tone.start(start); tone.stop(start + 0.32);
    });
  } catch { /* A missing tone never affects the call. */ }
}

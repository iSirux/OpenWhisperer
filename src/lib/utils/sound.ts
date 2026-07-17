// Audio utility for playing notification sounds

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/**
 * Plays a pleasant completion chime using Web Audio API
 * Creates a simple two-tone "ding-dong" sound
 */
export function playCompletionSound(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Create a pleasant two-note chime
    const frequencies = [523.25, 659.25]; // C5 and E5
    const duration = 0.15;
    const gap = 0.1;

    frequencies.forEach((freq, i) => {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(freq, now);

      const startTime = now + i * (duration + gap);

      // Envelope: quick attack, gradual decay
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(0.3, startTime + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    });
  } catch (error) {
    console.warn('Failed to play completion sound:', error);
  }
}

/**
 * Plays a distinct "resume" chime when the usage window resets and the smart
 * queue dispatches its first deferred session.
 * Creates a bright three-note ascending arpeggio (perfect-fourth climb) so it's
 * clearly different from the completion / repo / open-mic sounds.
 * Side-effect safe: no-op under SSR or when AudioContext is unavailable.
 */
export function playQueueResume(): void {
  try {
    if (typeof AudioContext === 'undefined') return;

    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Ascending arpeggio: G4 -> C5 -> F5 (stacked fourths, "unlock/resume" feel)
    const frequencies = [392.0, 523.25, 698.46];
    const duration = 0.13;
    const gap = 0.06;

    frequencies.forEach((freq, i) => {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      // Triangle wave for a softer, distinct timbre
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(freq, now);

      const startTime = now + i * (duration + gap);

      // Gentle attack, smooth decay
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(0.25, startTime + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    });
  } catch (error) {
    console.warn('Failed to play queue resume sound:', error);
  }
}

/**
 * Plays a distinct "question" chime when the agent asks the user a question
 * (the AskUserQuestion tool). Rising two-note motif with a questioning
 * up-inflection (perfect-fifth climb) played twice, so it clearly stands apart
 * from the completion / resume / repo / open-mic / voice-command sounds and
 * reads as "your input is needed".
 * Side-effect safe: no-op under SSR or when AudioContext is unavailable.
 */
export function playQuestionSound(): void {
  try {
    if (typeof AudioContext === 'undefined') return;

    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Rising fifth E5 -> B5, repeated — an interrogative "ba-ding? ba-ding?"
    const motif = [659.25, 987.77]; // E5, B5
    const noteDuration = 0.12;
    const noteGap = 0.05;
    const phraseGap = 0.14;
    const phrase = noteDuration * motif.length + noteGap;

    for (let rep = 0; rep < 2; rep++) {
      motif.forEach((freq, i) => {
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(freq, now);

        const startTime = now + rep * (phrase + phraseGap) + i * (noteDuration + noteGap);

        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(0.28, startTime + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + noteDuration);

        oscillator.start(startTime);
        oscillator.stop(startTime + noteDuration);
      });
    }
  } catch (error) {
    console.warn('Failed to play question sound:', error);
  }
}

/**
 * Plays a quick confirmation sound when a repo is selected
 * Creates a short ascending two-note "boop-beep" sound
 */
export function playRepoSelectedSound(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Create a quick ascending two-note sound (different from completion)
    const frequencies = [392.00, 523.25]; // G4 and C5 - ascending
    const duration = 0.08;
    const gap = 0.04;

    frequencies.forEach((freq, i) => {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(freq, now);

      const startTime = now + i * (duration + gap);

      // Quick envelope
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(0.25, startTime + 0.005);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    });
  } catch (error) {
    console.warn('Failed to play repo selected sound:', error);
  }
}

/**
 * Plays a distinctive "wake up" sound when open mic detects a wake command
 * Creates an ascending three-note arpeggio to indicate activation
 */
export function playOpenMicTriggerSound(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Ascending arpeggio: C5 -> E5 -> G5 (major chord)
    const frequencies = [523.25, 659.25, 783.99];
    const duration = 0.1;
    const gap = 0.05;

    frequencies.forEach((freq, i) => {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(freq, now);

      const startTime = now + i * (duration + gap);

      // Quick attack, smooth decay
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(0.25, startTime + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    });
  } catch (error) {
    console.warn('Failed to play open mic trigger sound:', error);
  }
}

/**
 * Plays a confirmation sound when a voice command (like "send it") is detected
 * Creates a quick double-beep to confirm the command was received
 */
export function playVoiceCommandSound(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Quick double-beep at the same pitch (confirmation sound)
    const frequency = 880; // A5 - higher pitch for distinctiveness
    const duration = 0.06;
    const gap = 0.08;
    const repetitions = 2;

    for (let i = 0; i < repetitions; i++) {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, now);

      const startTime = now + i * (duration + gap);

      // Quick envelope
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(0.2, startTime + 0.005);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    }
  } catch (error) {
    console.warn('Failed to play voice command sound:', error);
  }
}

// =============================================================================
// Sequence Notification Sounds (10 distinct beeps)
// =============================================================================

/** Sound names for the 10 notification beeps */
export const NOTIFICATION_SOUND_NAMES: Record<number, string> = {
  1: 'Chime',
  2: 'Ping',
  3: 'Bell',
  4: 'Chirp',
  5: 'Blip',
  6: 'Ding',
  7: 'Tone',
  8: 'Alert',
  9: 'Pop',
  10: 'Gong',
};

/** Helper to create oscillator with envelope */
function playTones(
  specs: Array<{
    freq: number;
    start: number;
    duration: number;
    gain: number;
    type: OscillatorType;
  }>
): void {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  for (const s of specs) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.connect(g);
    g.connect(ctx.destination);
    osc.type = s.type;
    osc.frequency.setValueAtTime(s.freq, now);
    const t = now + s.start;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(s.gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + s.duration);
    osc.start(t);
    osc.stop(t + s.duration);
  }
}

/** 1: Chime - gentle two-tone C5-E5 */
function playNotifySound1(): void {
  playTones([
    { freq: 523.25, start: 0, duration: 0.2, gain: 0.3, type: 'sine' },
    { freq: 659.25, start: 0.15, duration: 0.25, gain: 0.25, type: 'sine' },
  ]);
}

/** 2: Ping - single bright ping at A5 */
function playNotifySound2(): void {
  playTones([
    { freq: 880, start: 0, duration: 0.3, gain: 0.3, type: 'sine' },
  ]);
}

/** 3: Bell - resonant bell with overtone */
function playNotifySound3(): void {
  playTones([
    { freq: 660, start: 0, duration: 0.4, gain: 0.25, type: 'sine' },
    { freq: 1320, start: 0, duration: 0.2, gain: 0.1, type: 'sine' },
  ]);
}

/** 4: Chirp - quick ascending chirp */
function playNotifySound4(): void {
  playTones([
    { freq: 600, start: 0, duration: 0.08, gain: 0.25, type: 'sine' },
    { freq: 800, start: 0.06, duration: 0.08, gain: 0.25, type: 'sine' },
    { freq: 1000, start: 0.12, duration: 0.12, gain: 0.2, type: 'sine' },
  ]);
}

/** 5: Blip - soft square-wave blip */
function playNotifySound5(): void {
  playTones([
    { freq: 440, start: 0, duration: 0.12, gain: 0.15, type: 'square' },
  ]);
}

/** 6: Ding - classic doorbell ding */
function playNotifySound6(): void {
  playTones([
    { freq: 740, start: 0, duration: 0.5, gain: 0.25, type: 'sine' },
  ]);
}

/** 7: Tone - descending two-tone */
function playNotifySound7(): void {
  playTones([
    { freq: 784, start: 0, duration: 0.15, gain: 0.25, type: 'sine' },
    { freq: 587, start: 0.12, duration: 0.2, gain: 0.2, type: 'sine' },
  ]);
}

/** 8: Alert - triple beep attention-getter */
function playNotifySound8(): void {
  playTones([
    { freq: 932, start: 0, duration: 0.08, gain: 0.25, type: 'sine' },
    { freq: 932, start: 0.12, duration: 0.08, gain: 0.25, type: 'sine' },
    { freq: 932, start: 0.24, duration: 0.08, gain: 0.25, type: 'sine' },
  ]);
}

/** 9: Pop - soft bubble pop */
function playNotifySound9(): void {
  playTones([
    { freq: 350, start: 0, duration: 0.06, gain: 0.2, type: 'sine' },
    { freq: 700, start: 0.03, duration: 0.15, gain: 0.15, type: 'triangle' },
  ]);
}

/** 10: Gong - deep resonant gong */
function playNotifySound10(): void {
  playTones([
    { freq: 220, start: 0, duration: 0.6, gain: 0.3, type: 'sine' },
    { freq: 440, start: 0, duration: 0.3, gain: 0.12, type: 'sine' },
    { freq: 330, start: 0.05, duration: 0.5, gain: 0.08, type: 'triangle' },
  ]);
}

const NOTIFY_SOUND_FNS: Record<number, () => void> = {
  1: playNotifySound1,
  2: playNotifySound2,
  3: playNotifySound3,
  4: playNotifySound4,
  5: playNotifySound5,
  6: playNotifySound6,
  7: playNotifySound7,
  8: playNotifySound8,
  9: playNotifySound9,
  10: playNotifySound10,
};

/**
 * Play a sequence notification sound by number (1-10).
 * Defaults to sound 1 if the number is out of range.
 */
export function playNotificationSound(soundNumber?: number): void {
  try {
    const num = soundNumber && soundNumber >= 1 && soundNumber <= 10 ? soundNumber : 1;
    NOTIFY_SOUND_FNS[num]();
  } catch (error) {
    console.warn('Failed to play notification sound:', error);
  }
}

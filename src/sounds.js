// Notification sounds, generated with the Web Audio API (no sound files needed).
// Browsers only allow audio after the person has clicked or typed on the page,
// so the audio engine is started on the first interaction (see unlockAudio).
let ctx = null;

export function unlockAudio() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  if (!ctx) ctx = new AudioCtx();
  if (ctx.state === 'suspended') ctx.resume();
}

// One soft bell-like note: quick fade in, gentle fade out.
function tone(freq, start, duration, volume) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

// 'message': a bright two-note "ding-ding".
// 'activity' (new post, like, comment, follower): a single, softer "pop".
export function playSound(kind) {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  if (kind === 'message') {
    tone(880, now, 0.22, 0.2);
    tone(1318.5, now + 0.13, 0.32, 0.16);
  } else {
    tone(659.3, now, 0.28, 0.13);
    tone(987.8, now + 0.06, 0.24, 0.06);
  }
}

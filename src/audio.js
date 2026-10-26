// Recorded effects in public/audio, from Pixabay (Pixabay Content License: free for commercial use,
// no attribution) - trimmed, loudness-normalised and mono. Anything that has to sit on an exact
// frame (pin hits, reel clacks) stays synthesised below.
const SAMPLES = ['drop', 'payout', 'premium', 'jackpot', 'chest', 'rain'];

export class GameAudio {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.context = null;
    this.buffers = {};
    this.lastPlayed = {};
  }

  // Decoded once, on the first gesture that creates the context. Until a buffer arrives (or if it
  // never does) play() falls back to the synthesised version.
  loadSamples(context) {
    if (this.loading) return;
    this.loading = true;
    for (const name of SAMPLES) {
      fetch(`${import.meta.env.BASE_URL}audio/${name}.mp3`)
        .then((response) => response.arrayBuffer())
        .then((data) => context.decodeAudioData(data))
        .then((buffer) => { this.buffers[name] = buffer; })
        .catch(() => {});
    }
  }

  // An avalanche pays a batch every frame; one sample per 60 ms keeps it a shower, not a wall.
  play(name, volume = 1, rate = 1, delay = 0) {
    const context = this.ensureContext();
    const buffer = this.buffers[name];
    if (!context || !buffer) return false;
    const start = context.currentTime + delay;
    if (start - (this.lastPlayed[name] ?? -1) < 0.06) return true;
    this.lastPlayed[name] = start;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    gain.gain.value = volume;
    source.connect(gain).connect(context.destination);
    source.start(start);
    return true;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) this.ensureContext();
  }

  ensureContext() {
    if (!this.enabled) return null;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    this.context ??= new AudioContext();
    this.loadSamples(this.context);
    if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    return this.context;
  }

  tone(frequency, duration, type = 'sine', volume = 0.035, delay = 0) {
    const context = this.ensureContext();
    if (!context) return;
    const start = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  drop() {
    if (!this.play('drop', 0.35, 0.95 + Math.random() * 0.1)) this.tone(260, 0.12, 'triangle', 0.025);
  }
  // Pin board: a bright tick off a pin, a deeper thump off a bumper, both louder for harder hits.
  // The pitch wanders a little so a cascade of pins does not read as one note repeating.
  boardHit(kind, strength) {
    const wander = 1 + (Math.random() - 0.5) * 0.25;
    if (kind === 'bumper') this.tone(330 * wander, 0.14, 'square', 0.02 * strength);
    else this.tone(1400 * wander, 0.05, 'sine', 0.012 * strength);
  }
  payout(premium = false) {
    if (this.play(premium ? 'premium' : 'payout', 0.55)) return;
    this.tone(premium ? 720 : 540, 0.16, 'sine', 0.035);
    this.tone(premium ? 980 : 760, 0.18, 'sine', 0.025, 0.08);
  }
  jackpot() {
    if (this.play('jackpot', 0.7)) return;
    [523, 659, 784, 1046].forEach((frequency, index) => this.tone(frequency, 0.22, 'triangle', 0.03, index * 0.07));
  }
  error() { this.tone(150, 0.18, 'square', 0.018); }
  // A reel locking: a short clack, each reel a step higher so the three read as a run.
  reelStop(index) { this.tone(180 + index * 60, 0.06, 'square', 0.022); }
  // The last reel ticking past a face as it crawls in.
  reelTick() { this.tone(1100, 0.025, 'square', 0.01); }
  // A chest dropping into the machine: a low knock and a bright two-note call.
  chestDrop() {
    if (this.play('chest', 0.7)) return;
    this.tone(110, 0.12, 'triangle', 0.03);
    this.tone(659, 0.12, 'sine', 0.025, 0.1);
    this.tone(988, 0.18, 'sine', 0.025, 0.2);
  }
  // A money bag bursting over the board, under the jackpot call.
  coinRain() { this.play('rain', 0.6, 1, 0.35); }
  // The machine standing up: a latch clunk, then a rising power-on run under the racing lamps.
  powerOn() {
    this.tone(90, 0.09, 'square', 0.03);
    [392, 523, 659, 784].forEach((frequency, index) => this.tone(frequency, 0.16, 'triangle', 0.022, 0.12 + index * 0.08));
  }
}

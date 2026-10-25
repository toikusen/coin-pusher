export class GameAudio {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.context = null;
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

  drop() { this.tone(260, 0.12, 'triangle', 0.025); }
  // Pin board: a bright tick off a pin, a deeper thump off a bumper, both louder for harder hits.
  // The pitch wanders a little so a cascade of pins does not read as one note repeating.
  boardHit(kind, strength) {
    const wander = 1 + (Math.random() - 0.5) * 0.25;
    if (kind === 'bumper') this.tone(330 * wander, 0.14, 'square', 0.02 * strength);
    else this.tone(1400 * wander, 0.05, 'sine', 0.012 * strength);
  }
  payout(premium = false) {
    this.tone(premium ? 720 : 540, 0.16, 'sine', 0.035);
    this.tone(premium ? 980 : 760, 0.18, 'sine', 0.025, 0.08);
  }
  jackpot() {
    [523, 659, 784, 1046].forEach((frequency, index) => this.tone(frequency, 0.22, 'triangle', 0.03, index * 0.07));
  }
  error() { this.tone(150, 0.18, 'square', 0.018); }
  // The machine standing up: a latch clunk, then a rising power-on run under the racing lamps.
  powerOn() {
    this.tone(90, 0.09, 'square', 0.03);
    [392, 523, 659, 784].forEach((frequency, index) => this.tone(frequency, 0.16, 'triangle', 0.022, 0.12 + index * 0.08));
  }
}

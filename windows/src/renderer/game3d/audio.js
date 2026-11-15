// Game sound, synthesised with Web Audio (no sound files): wind rising with speed, freewheel ticking when
// coasting, chimes for pick-ups and medals, countdown beeps and a crowd cheer at the finish.

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.tickTimer = 0;
  }

  /** Must be called from a user gesture the first time (browsers start audio suspended). */
  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.enabled ? 0.6 : 0;
      this.master.connect(ctx.destination);
      // Wind: looping noise through a low-pass filter.
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < data.length; i++) {
        last = 0.97 * last + 0.03 * (Math.random() * 2 - 1);
        data[i] = last * 6;
      }
      this.noise = buf;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = 'lowpass';
      this.windFilter.frequency.value = 400;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      src.connect(this.windFilter).connect(this.windGain).connect(this.master);
      src.start();
    } catch {
      this.ctx = null;
    }
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.6 : 0;
  }

  /** Called every frame with the player's speed (m/s) and cadence. */
  update(dt, speed, cadence) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, speed / 16);
    this.windGain.gain.setTargetAtTime(0.02 + s * s * 0.3, t, 0.3);
    this.windFilter.frequency.setTargetAtTime(250 + s * 1400, t, 0.3);
    // Freewheel ticks while coasting.
    if (cadence < 5 && speed > 2) {
      this.tickTimer -= dt;
      if (this.tickTimer <= 0) {
        this.tickTimer = 0.9 / Math.max(2, speed);
        this.blip(3200, 0.012, 0.05, 'square');
      }
    }
  }

  blip(freq, dur, vol, type = 'sine', when = 0) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  chime() {
    this.blip(880, 0.25, 0.18, 'triangle');
    this.blip(1320, 0.35, 0.14, 'triangle', 0.09);
  }

  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => this.blip(f, 0.4, 0.16, 'triangle', i * 0.12));
  }

  whoosh() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(3000, t + 0.5);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.7);
  }

  beep(final = false) {
    this.blip(final ? 1046 : 660, final ? 0.6 : 0.18, 0.22, 'square');
  }

  cheer() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1200;
    f.Q.value = 0.6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 3.6);
  }

  stop() {
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}

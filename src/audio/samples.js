import * as Tone from 'tone';
import { sampleLife } from '../soul/evolve.js';

// Caches decoded buffers. Plays random fragments of a recorded voice,
// pitched to the current key, through the shared effect chain.

export class SampleBank {
  constructor() {
    this.buffers = new Map(); // id -> Tone.ToneAudioBuffer
    this.samples = [];        // full list from soul
    // diagnostics — how many trigger calls land vs. bail, and why
    this.stats = { attempted: 0, played: 0, noSamples: 0, noneLoaded: 0, noBuffer: 0 };
    this._lastStatsLog = performance.now();
  }

  logStats(now = performance.now()) {
    if (now - this._lastStatsLog < 15000) return;
    this._lastStatsLog = now;
    const loadedCount = [...this.buffers.values()].filter(b => b.loaded).length;
    // eslint-disable-next-line no-console
    console.log('[samples]', {
      pool: this.samples.length,
      loaded: loadedCount,
      attempts15s: this.stats.attempted,
      played15s: this.stats.played,
      skip_noSamples: this.stats.noSamples,
      skip_noneLoaded: this.stats.noneLoaded,
      skip_noBuffer: this.stats.noBuffer,
    });
    this.stats = { attempted: 0, played: 0, noSamples: 0, noneLoaded: 0, noBuffer: 0 };
  }

  update(samples) {
    this.samples = samples || [];
    // prefetch all samples — previously we only loaded the first 8, which meant
    // once the pool grew past 8, older voices could never be picked because
    // their buffers never became `loaded`.
    for (const s of this.samples) this._ensureLoaded(s);
    // prune buffers for samples no longer present
    const present = new Set(this.samples.map(s => s.id));
    for (const id of [...this.buffers.keys()]) {
      if (!present.has(id)) {
        const b = this.buffers.get(id);
        try { b.dispose(); } catch {}
        this.buffers.delete(id);
      }
    }
  }

  _ensureLoaded(s) {
    if (this.buffers.has(s.id)) return;
    const buf = new Tone.ToneAudioBuffer(s.url, () => {}, (err) => {
      console.warn('sample load failed', s.id, err);
      this.buffers.delete(s.id);
    });
    this.buffers.set(s.id, buf);
  }

  // pick a sample weighted by life. newer/higher-life plays more often.
  pickWeighted() {
    if (!this.samples.length) return null;
    const loaded = this.samples.filter(s => {
      const b = this.buffers.get(s.id);
      return b && b.loaded;
    });
    if (!loaded.length) return null;
    const now = Date.now();
    const lifeOf = (s) => Math.max(0.05, s.life ?? sampleLife(s, now));
    let total = 0;
    for (const s of loaded) total += lifeOf(s);
    let r = Math.random() * total;
    for (const s of loaded) {
      r -= lifeOf(s);
      if (r <= 0) return s;
    }
    return loaded[0];
  }

  /**
   * Trigger a chopped, pitched fragment.
   * @param {Tone.ToneAudioNode} dest  connect player here (effect chain input)
   * @param {number} semitones         pitch offset
   * @param {number} velocity          0..1
   */
  trigger(dest, semitones = 0, velocity = 0.7, when) {
    this.stats.attempted++;
    this.logStats();
    if (!this.samples.length) { this.stats.noSamples++; return; }
    const sample = this.pickWeighted();
    if (!sample) { this.stats.noneLoaded++; return; }
    const buffer = this.buffers.get(sample.id);
    if (!buffer || !buffer.loaded) { this.stats.noBuffer++; return; }
    const duration = buffer.duration;
    if (duration <= 0.05) return;
    this.stats.played++;

    // Three-bucket length distribution:
    //   15%  long    — 1.5s–4s capped to recording length
    //   50%  medium  — 400ms–1.8s, the 'slightly longer' feel
    //   35%  micro   — 60ms–300ms chopped stutter-like grains
    const r = Math.random();
    let fragLen;
    if (r < 0.15 && duration >= 1.6) {
      const longMax = Math.min(4.0, duration * 0.9);
      fragLen = 1.5 + Math.random() * Math.max(0, longMax - 1.5);
      velocity *= 0.85;   // soften long fragments a touch (was 0.7 — too quiet)
    } else if (r < 0.65) {
      const minLen = 0.4;
      const maxLen = Math.min(1.8, duration * 0.9);
      fragLen = minLen + Math.pow(Math.random(), 1.3) * (maxLen - minLen);
    } else {
      const minLen = 0.06;
      const maxLen = Math.min(0.3, duration * 0.9);
      fragLen = minLen + Math.pow(Math.random(), 1.5) * (maxLen - minLen);
    }
    // floor the effective velocity so no voice fragment ever lands
    // inaudible — minimum ~-6 dB pre-makeup so voices always sit up.
    const effectiveVelocity = Math.max(0.5, velocity);
    const start = Math.random() * Math.max(0.0001, duration - fragLen - 0.01);

    // scale fades to fragment length so micro stutters don't get swallowed
    const fadeIn  = Math.min(0.01, fragLen * 0.2);
    const fadeOut = Math.min(0.04, fragLen * 0.35);
    const player = new Tone.Player({
      url: buffer,
      playbackRate: Math.pow(2, semitones / 12),
      fadeIn,
      fadeOut,
    });
    // mono MediaRecorder output can collapse to one channel through some stereo
    // effects (pingpong / phaser / pitchshift). route each sample through a
    // Panner. most of the time the pan stays near center (±0.15); ~15% of
    // the time a sample is intentionally pushed out to one side (0.3 to 0.75
    // left or right) for stereo variety.
    const wide = Math.random() < 0.15;
    const panPos = wide
      ? (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.45)
      : -0.15 + Math.random() * 0.3;
    const pan = new Tone.Panner(panPos);
    // +5 dB makeup so voices sit on top of the bed instead of behind it
    const vol = new Tone.Volume(Tone.gainToDb(effectiveVelocity) + 5).connect(dest);
    player.connect(pan);
    pan.connect(vol);
    const t = when ?? Tone.now();
    try {
      player.start(t, start, fragLen);
    } catch (e) { /* race — buffer swapped out */ }
    player.onstop = () => { try { player.dispose(); pan.dispose(); vol.dispose(); } catch {} };
  }
}

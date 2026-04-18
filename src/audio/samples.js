import * as Tone from 'tone';
import { sampleLife } from '../soul/evolve.js';

// Caches decoded buffers. Plays random fragments of a recorded voice,
// pitched to the current key, through the shared effect chain.

export class SampleBank {
  constructor() {
    this.buffers = new Map(); // id -> Tone.ToneAudioBuffer
    this.samples = [];        // full list from soul
  }

  update(samples) {
    this.samples = samples || [];
    // prefetch fresh ones
    for (const s of this.samples.slice(0, 8)) this._ensureLoaded(s);
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
    const sample = this.pickWeighted();
    if (!sample) return;
    const buffer = this.buffers.get(sample.id);
    if (!buffer || !buffer.loaded) return;
    const duration = buffer.duration;
    if (duration <= 0.05) return;

    // Three-bucket length distribution:
    //   15%  long    — 1.5s–4s capped to recording length
    //   50%  medium  — 400ms–1.8s, the 'slightly longer' feel
    //   35%  micro   — 60ms–300ms chopped stutter-like grains
    const r = Math.random();
    let fragLen;
    if (r < 0.15 && duration >= 1.6) {
      const longMax = Math.min(4.0, duration * 0.9);
      fragLen = 1.5 + Math.random() * Math.max(0, longMax - 1.5);
      velocity *= 0.7;
    } else if (r < 0.65) {
      const minLen = 0.4;
      const maxLen = Math.min(1.8, duration * 0.9);
      fragLen = minLen + Math.pow(Math.random(), 1.3) * (maxLen - minLen);
    } else {
      const minLen = 0.06;
      const maxLen = Math.min(0.3, duration * 0.9);
      fragLen = minLen + Math.pow(Math.random(), 1.5) * (maxLen - minLen);
    }
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
    // +5 dB makeup so voices sit on top of the bed instead of behind it
    const vol = new Tone.Volume(Tone.gainToDb(Math.max(0.001, velocity)) + 5).connect(dest);
    player.connect(vol);
    const t = when ?? Tone.now();
    try {
      player.start(t, start, fragLen);
    } catch (e) { /* race — buffer swapped out */ }
    player.onstop = () => { try { player.dispose(); vol.dispose(); } catch {} };
  }
}

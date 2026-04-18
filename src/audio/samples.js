import * as Tone from 'tone';

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
    let total = 0;
    for (const s of loaded) total += Math.max(0.05, s.life ?? 1);
    let r = Math.random() * total;
    for (const s of loaded) {
      r -= Math.max(0.05, s.life ?? 1);
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

    // pick a random fragment — vary length with some bias toward short
    const minLen = 0.08;
    const maxLen = Math.min(1.2, duration * 0.9);
    const fragLen = minLen + Math.pow(Math.random(), 2) * (maxLen - minLen);
    const start = Math.random() * Math.max(0.0001, duration - fragLen - 0.01);

    const player = new Tone.Player({
      url: buffer,
      playbackRate: Math.pow(2, semitones / 12),
      fadeIn: 0.01,
      fadeOut: 0.04,
    });
    const vol = new Tone.Volume(Tone.gainToDb(Math.max(0.001, velocity))).connect(dest);
    player.connect(vol);
    const t = when ?? Tone.now();
    try {
      player.start(t, start, fragLen);
    } catch (e) { /* race — buffer swapped out */ }
    player.onstop = () => { try { player.dispose(); vol.dispose(); } catch {} };
  }
}

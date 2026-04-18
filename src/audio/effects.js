import * as Tone from 'tone';

// Build/dispose effect nodes from soul.effects config. Returns a chain
// starting from `input` and ending at `output`, with per-effect wet mix.
// Each call fully rebuilds the chain — effect drift is slow so this is fine.

export class EffectChain {
  constructor(destination) {
    this.destination = destination;
    this.input = new Tone.Gain(1);
    this.output = new Tone.Gain(1).connect(destination);
    this.nodes = [];
    this._wire([]);
  }

  setEffects(list = []) {
    this._dispose();
    this.nodes = list.map(cfg => this._build(cfg)).filter(Boolean);
    this._wire(this.nodes);
  }

  _wire(nodes) {
    try { this.input.disconnect(); } catch {}
    let tail = this.input;
    for (const n of nodes) {
      tail.connect(n.in);
      tail = n.out;
    }
    tail.connect(this.output);
  }

  _dispose() {
    for (const n of this.nodes) { try { n.dispose(); } catch {} }
    this.nodes = [];
  }

  dispose() { this._dispose(); this.input.dispose(); this.output.dispose(); }

  _build(cfg) {
    const wet = clamp(cfg.wet ?? 0.3, 0, 1);
    switch (cfg.name) {
      case 'reverb': {
        const n = new Tone.Reverb({ decay: cfg.decay ?? 4, preDelay: cfg.preDelay ?? 0.02, wet });
        return wrap(n, () => n.dispose());
      }
      case 'delay': {
        const n = new Tone.FeedbackDelay({ delayTime: cfg.time ?? '8n', feedback: cfg.feedback ?? 0.4, wet });
        return wrap(n, () => n.dispose());
      }
      case 'pingpong': {
        const n = new Tone.PingPongDelay({ delayTime: cfg.time ?? '8n', feedback: cfg.feedback ?? 0.35, wet });
        return wrap(n, () => n.dispose());
      }
      case 'chorus': {
        const n = new Tone.Chorus({ frequency: cfg.freq ?? 1.1, depth: cfg.depth ?? 0.6, wet }).start();
        return wrap(n, () => n.dispose());
      }
      case 'filter': {
        const filter = new Tone.Filter({ frequency: cfg.cutoff ?? 1200, Q: cfg.q ?? 1, type: 'lowpass' });
        const lfo = new Tone.LFO({ frequency: cfg.lfoRate ?? 0.2, min: Math.max(120, (cfg.cutoff ?? 1200) * (1 - (cfg.lfoDepth ?? 0.5))), max: Math.min(8000, (cfg.cutoff ?? 1200) * (1 + (cfg.lfoDepth ?? 0.5))) });
        lfo.connect(filter.frequency); lfo.start();
        return { in: filter, out: filter, dispose: () => { try { lfo.stop(); lfo.dispose(); } catch {} filter.dispose(); } };
      }
      case 'bitcrush': {
        const n = new Tone.BitCrusher({ bits: cfg.bits ?? 6, wet });
        return wrap(n, () => n.dispose());
      }
      case 'tremolo': {
        const n = new Tone.Tremolo({ frequency: cfg.freq ?? 4, depth: cfg.depth ?? 0.6, wet }).start();
        return wrap(n, () => n.dispose());
      }
      default: return null;
    }
  }
}

function wrap(node, dispose) { return { in: node, out: node, dispose }; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

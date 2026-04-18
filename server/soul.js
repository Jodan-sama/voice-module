import { EventEmitter } from 'node:events';

// ——— musical vocabulary ———
const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SCALES = {
  minor:      [0, 2, 3, 5, 7, 8, 10],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  phrygian:   [0, 1, 3, 5, 7, 8, 10],
  lydian:     [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  majpent:    [0, 2, 4, 7, 9],
  minpent:    [0, 3, 5, 7, 10],
  hirajoshi:  [0, 2, 3, 7, 8],
  whole:      [0, 2, 4, 6, 8, 10],
};
const SCALE_NAMES = Object.keys(SCALES);
const ARP_PATTERNS = ['up', 'down', 'updown', 'random', 'converge', 'alt'];
const EFFECT_NAMES = ['reverb', 'delay', 'chorus', 'filter', 'bitcrush', 'pingpong', 'tremolo'];

// ——— randomness ———
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const chance = (p) => Math.random() < p;

// maximum fragments of voice to retain; oldest/most-played get culled
const MAX_SAMPLES = 24;

export class Soul extends EventEmitter {
  constructor(saved) {
    super();
    const now = Date.now();
    const base = {
      key: pick(KEYS),
      scale: pick(SCALE_NAMES),
      tempoBpm: Math.round(rand(56, 92)),
      rootOctave: 3,
      arpPattern: pick(ARP_PATTERNS),
      arpSteps: randi(6, 12),
      arpGate: rand(0.35, 0.85),          // note length as fraction of step
      arpSubdivision: pick([4, 8, 8, 8, 16]), // steps per beat (feel)
      effects: this._spawnEffects(),
      backgroundRhythm: this._spawnRhythm(),
      phase: 'waking',                    // waking | awake | breathing | sleeping
      phaseUntil: now + randi(20, 45) * 1000,
      breathSeconds: rand(6, 10),         // one full breath cycle
      samples: [],
      sampleTriggerRate: rand(0.15, 0.45),// chance per arp step to trigger a voice fragment
      bornAt: now,
      version: 1,
    };
    this.state = saved ? { ...base, ...saved, bornAt: saved.bornAt || base.bornAt } : base;
    // ephemeral runtime
    this._tBreath = 0;
    this._tEvolve = Date.now();
  }

  // ——— effect/rhythm spawning ———
  _spawnEffects() {
    const n = randi(2, 4);
    const pool = [...EFFECT_NAMES];
    const chosen = [];
    for (let i = 0; i < n && pool.length; i++) {
      const idx = (Math.random() * pool.length) | 0;
      const name = pool.splice(idx, 1)[0];
      chosen.push(this._effectDefaults(name));
    }
    return chosen;
  }

  _effectDefaults(name) {
    switch (name) {
      case 'reverb':   return { name, wet: rand(0.2, 0.55), decay: rand(2.5, 8), preDelay: rand(0.01, 0.05) };
      case 'delay':    return { name, wet: rand(0.15, 0.4), time: pick(['8n', '8n.', '4n', '4n.', '16n']), feedback: rand(0.3, 0.6) };
      case 'pingpong': return { name, wet: rand(0.15, 0.4), time: pick(['8n', '8n.', '4n']), feedback: rand(0.25, 0.55) };
      case 'chorus':   return { name, wet: rand(0.2, 0.5), freq: rand(0.2, 2.2), depth: rand(0.3, 0.8) };
      case 'filter':   return { name, wet: 1.0, cutoff: rand(400, 3200), q: rand(0.4, 6), lfoRate: rand(0.04, 0.5), lfoDepth: rand(0.2, 0.9) };
      case 'bitcrush': return { name, wet: rand(0.1, 0.35), bits: randi(4, 8) };
      case 'tremolo':  return { name, wet: rand(0.25, 0.6), freq: rand(0.8, 6), depth: rand(0.3, 0.8) };
      default: return { name, wet: 0.25 };
    }
  }

  _spawnRhythm() {
    // a subtle low pulse pattern — 16 steps boolean-ish
    const steps = 16;
    const density = rand(0.1, 0.3);
    const pattern = Array.from({ length: steps }, () => (Math.random() < density ? 1 : 0));
    // reinforce downbeats lightly
    pattern[0] = 1;
    return {
      pattern,
      steps,
      gainDb: rand(-28, -18),
      timbre: pick(['sub', 'click', 'wood', 'air']),
      filterHz: rand(140, 900),
    };
  }

  // ——— lifecycle ———
  start() {
    if (this._started) return;
    this._started = true;
    // a slow tick drives evolution + breath persistence; fast pulse is broadcast from index.js
    this._tick = setInterval(() => this._step(), 500);
  }

  stop() {
    clearInterval(this._tick);
    this._started = false;
  }

  _step() {
    const now = Date.now();

    // phase transition
    if (now >= this.state.phaseUntil) {
      this._transitionPhase(now);
    }

    // random parameter drift, weighted by phase
    const awake = this.state.phase === 'awake' || this.state.phase === 'waking';
    if (awake && chance(0.012)) this._shiftEffect();
    if (awake && chance(0.008)) this._shiftArp();
    if (awake && chance(0.004)) this._shiftKey();
    if (chance(0.003)) this.state.backgroundRhythm = this._spawnRhythm();

    // sample aging — every tick each sample loses a small fraction of life
    this._ageSamples();
  }

  _transitionPhase(now) {
    const rotation = {
      waking:    'awake',
      awake:     chance(0.35) ? 'breathing' : 'sleeping',
      breathing: chance(0.5) ? 'sleeping' : 'awake',
      sleeping:  'waking',
    };
    const next = rotation[this.state.phase] || 'awake';
    const durationSec = ({
      waking:    randi(5, 12),
      awake:     randi(40, 180),
      breathing: randi(20, 60),
      sleeping:  randi(30, 180),
    })[next];
    this.state.phase = next;
    this.state.phaseUntil = now + durationSec * 1000;
    // each phase brings a little change in breath rate
    this.state.breathSeconds = ({
      waking:    rand(5, 8),
      awake:     rand(4, 7),
      breathing: rand(8, 14),
      sleeping:  rand(12, 22),
    })[next];
    this._emitChange({ phase: next, phaseUntil: this.state.phaseUntil, breathSeconds: this.state.breathSeconds });
  }

  _shiftEffect() {
    const fx = this.state.effects;
    if (!fx.length || chance(0.25)) {
      // drop/add
      if (fx.length >= 4 || (fx.length > 1 && chance(0.5))) {
        fx.splice((Math.random() * fx.length) | 0, 1);
      } else {
        const available = EFFECT_NAMES.filter(n => !fx.find(e => e.name === n));
        if (available.length) fx.push(this._effectDefaults(pick(available)));
      }
    } else {
      // tweak parameters of one effect
      const e = pick(fx);
      if ('wet' in e) e.wet = Math.max(0, Math.min(1, e.wet + rand(-0.15, 0.15)));
      if ('cutoff' in e) e.cutoff = Math.max(120, Math.min(8000, e.cutoff * rand(0.6, 1.6)));
      if ('feedback' in e) e.feedback = Math.max(0, Math.min(0.85, e.feedback + rand(-0.15, 0.15)));
      if ('depth' in e) e.depth = Math.max(0, Math.min(1, e.depth + rand(-0.2, 0.2)));
      if ('freq' in e) e.freq = Math.max(0.05, e.freq * rand(0.6, 1.6));
    }
    this._emitChange({ effects: this.state.effects });
  }

  _shiftArp() {
    const patch = {};
    if (chance(0.5)) { this.state.arpPattern = pick(ARP_PATTERNS); patch.arpPattern = this.state.arpPattern; }
    if (chance(0.5)) { this.state.arpSteps = Math.max(4, Math.min(16, this.state.arpSteps + randi(-2, 2))); patch.arpSteps = this.state.arpSteps; }
    if (chance(0.4)) { this.state.arpGate = Math.max(0.15, Math.min(1.1, this.state.arpGate + rand(-0.2, 0.2))); patch.arpGate = this.state.arpGate; }
    if (chance(0.3)) { this.state.arpSubdivision = pick([4, 8, 8, 8, 16]); patch.arpSubdivision = this.state.arpSubdivision; }
    if (chance(0.2)) { this.state.tempoBpm = Math.max(48, Math.min(110, this.state.tempoBpm + randi(-6, 6))); patch.tempoBpm = this.state.tempoBpm; }
    if (chance(0.3)) { this.state.sampleTriggerRate = Math.max(0.05, Math.min(0.8, this.state.sampleTriggerRate + rand(-0.1, 0.1))); patch.sampleTriggerRate = this.state.sampleTriggerRate; }
    this._emitChange(patch);
  }

  _shiftKey() {
    // modulate to a related key — up a 4th/5th, or parallel mode
    const idx = KEYS.indexOf(this.state.key);
    const shifts = [-5, -2, 2, 3, 5, 7];
    this.state.key = KEYS[(idx + pick(shifts) + 12) % 12];
    if (chance(0.4)) this.state.scale = pick(SCALE_NAMES);
    this._emitChange({ key: this.state.key, scale: this.state.scale });
  }

  // ——— samples (voice fragments) ———
  addSample(meta) {
    const entry = {
      id: meta.id,
      url: meta.url,
      mime: meta.mime,
      duration: meta.duration,
      createdAt: meta.createdAt,
      life: 1.0,           // 1 → fresh; 0 → ready to be forgotten
      plays: 0,
    };
    this.state.samples.unshift(entry);
    // cap: cull lowest-life when over
    while (this.state.samples.length > MAX_SAMPLES) {
      const weakest = this.state.samples.reduce((w, s, i) => (s.life < w.life ? { s, i, life: s.life } : w), { life: Infinity, i: -1 });
      if (weakest.i === -1) break;
      this.state.samples.splice(weakest.i, 1);
    }
    this._emitChange({ samples: this.state.samples });
    return entry;
  }

  _ageSamples() {
    if (!this.state.samples.length) return;
    let removed = false;
    for (const s of this.state.samples) {
      // slow decay; older = weaker. ~0.5%/tick at default rate so a fragment lives ~2-6 hours
      s.life = Math.max(0, s.life - rand(0.0002, 0.0012));
    }
    for (let i = this.state.samples.length - 1; i >= 0; i--) {
      if (this.state.samples[i].life <= 0.02) {
        this.state.samples.splice(i, 1);
        removed = true;
      }
    }
    // only emit occasionally so we don't spam — but always on structural changes
    if (removed || chance(0.05)) {
      this._emitChange({ samples: this.state.samples });
    }
  }

  // ——— fast pulse: broadcast cheaply many times per second ———
  pulse() {
    const now = Date.now();
    const phase = ((now - this.state.bornAt) / 1000) % this.state.breathSeconds;
    const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * phase) / this.state.breathSeconds);
    // amplitude envelope per phase
    const ampByPhase = { waking: 0.35, awake: 1.0, breathing: 0.25, sleeping: 0.05 };
    return {
      t: now,
      breath,
      amp: ampByPhase[this.state.phase] ?? 0.6,
      phase: this.state.phase,
    };
  }

  snapshot() {
    return { ...this.state };
  }

  _emitChange(patch) {
    this.emit('change', { ...patch, _t: Date.now() });
  }
}

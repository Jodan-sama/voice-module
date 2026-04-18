// Pure, client-side soul. The leader of the session pool runs `tickEvolution`
// periodically, mutates its local state, and persists patches upstream.
//
// Nothing here touches the DOM, network, or audio — that keeps it trivially
// portable to the eventual physical instrument runtime.

// ——— musical vocabulary ———
export const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = {
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
export const ARP_PATTERNS = ['up', 'down', 'updown', 'random', 'converge', 'alt'];
const EFFECT_NAMES = ['reverb', 'delay', 'chorus', 'filter', 'bitcrush', 'pingpong', 'tremolo'];

const rand  = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const pick  = (arr) => arr[(Math.random() * arr.length) | 0];
const chance = (p) => Math.random() < p;

// ——— factory ———
export function createInitialState(now = Date.now()) {
  return {
    key: pick(KEYS),
    scale: pick(SCALE_NAMES),
    tempoBpm: Math.round(rand(56, 92)),
    rootOctave: 3,
    arpPattern: pick(ARP_PATTERNS),
    arpSteps: randi(6, 12),
    arpGate: rand(0.35, 0.85),
    arpSubdivision: pick([4, 8, 8, 8, 16]),
    effects: spawnEffects(),
    backgroundRhythm: spawnRhythm(),
    phase: 'waking',
    phaseUntil: now + randi(10, 25) * 1000,
    breathSeconds: rand(6, 10),
    sampleTriggerRate: rand(0.15, 0.45),
    bornAt: now,
    version: 1,
  };
}

function spawnEffects() {
  const n = randi(2, 4);
  const pool = [...EFFECT_NAMES];
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    const idx = (Math.random() * pool.length) | 0;
    out.push(effectDefaults(pool.splice(idx, 1)[0]));
  }
  return out;
}

function effectDefaults(name) {
  switch (name) {
    case 'reverb':   return { name, wet: rand(0.2, 0.55), decay: rand(2.5, 8), preDelay: rand(0.01, 0.05) };
    case 'delay':    return { name, wet: rand(0.15, 0.4), time: pick(['8n','8n.','4n','4n.','16n']), feedback: rand(0.3, 0.6) };
    case 'pingpong': return { name, wet: rand(0.15, 0.4), time: pick(['8n','8n.','4n']), feedback: rand(0.25, 0.55) };
    case 'chorus':   return { name, wet: rand(0.2, 0.5), freq: rand(0.2, 2.2), depth: rand(0.3, 0.8) };
    case 'filter':   return { name, wet: 1.0, cutoff: rand(400, 3200), q: rand(0.4, 6), lfoRate: rand(0.04, 0.5), lfoDepth: rand(0.2, 0.9) };
    case 'bitcrush': return { name, wet: rand(0.1, 0.35), bits: randi(4, 8) };
    case 'tremolo':  return { name, wet: rand(0.25, 0.6), freq: rand(0.8, 6), depth: rand(0.3, 0.8) };
    default: return { name, wet: 0.25 };
  }
}

function spawnRhythm() {
  const steps = 16;
  const density = rand(0.1, 0.3);
  const pattern = Array.from({ length: steps }, () => (Math.random() < density ? 1 : 0));
  pattern[0] = 1;
  return {
    pattern,
    steps,
    gainDb: rand(-28, -18),
    timbre: pick(['sub', 'click', 'wood', 'air']),
    filterHz: rand(140, 900),
  };
}

// ——— evolution step. Returns true if `state` was mutated. ———
export function tickEvolution(state, now = Date.now()) {
  if (!state || !state.version) {
    Object.assign(state, createInitialState(now));
    return true;
  }
  let changed = false;

  // catch-up: advance phase as many times as needed if there was a long gap
  let guard = 32;
  while (now >= (state.phaseUntil ?? 0) && guard-- > 0) {
    transitionPhase(state, now);
    changed = true;
  }

  const awake = state.phase === 'awake' || state.phase === 'waking';
  if (awake && chance(0.012)) { shiftEffect(state); changed = true; }
  if (awake && chance(0.008)) { shiftArp(state);    changed = true; }
  if (awake && chance(0.004)) { shiftKey(state);    changed = true; }
  if (chance(0.003))          { state.backgroundRhythm = spawnRhythm(); changed = true; }

  return changed;
}

function transitionPhase(state, now) {
  const rotation = {
    waking:    'awake',
    awake:     chance(0.35) ? 'breathing' : 'sleeping',
    breathing: chance(0.5)  ? 'sleeping'  : 'awake',
    sleeping:  'waking',
  };
  const next = rotation[state.phase] || 'awake';
  const durationSec = ({
    waking:    randi(5, 12),
    awake:     randi(40, 180),
    breathing: randi(20, 60),
    sleeping:  randi(30, 180),
  })[next];
  state.phase = next;
  state.phaseUntil = now + durationSec * 1000;
  state.breathSeconds = ({
    waking:    rand(5, 8),
    awake:     rand(4, 7),
    breathing: rand(8, 14),
    sleeping:  rand(12, 22),
  })[next];
}

function shiftEffect(state) {
  const fx = state.effects || (state.effects = []);
  if (!fx.length || chance(0.25)) {
    if (fx.length >= 4 || (fx.length > 1 && chance(0.5))) {
      fx.splice((Math.random() * fx.length) | 0, 1);
    } else {
      const available = EFFECT_NAMES.filter(n => !fx.find(e => e.name === n));
      if (available.length) fx.push(effectDefaults(pick(available)));
    }
  } else {
    const e = pick(fx);
    if ('wet' in e)      e.wet      = clamp(e.wet      + rand(-0.15, 0.15), 0, 1);
    if ('cutoff' in e)   e.cutoff   = clamp(e.cutoff   * rand(0.6, 1.6),    120, 8000);
    if ('feedback' in e) e.feedback = clamp(e.feedback + rand(-0.15, 0.15), 0, 0.85);
    if ('depth' in e)    e.depth    = clamp(e.depth    + rand(-0.2, 0.2),   0, 1);
    if ('freq' in e)     e.freq     = Math.max(0.05, e.freq * rand(0.6, 1.6));
  }
}

function shiftArp(state) {
  if (chance(0.5)) state.arpPattern     = pick(ARP_PATTERNS);
  if (chance(0.5)) state.arpSteps       = clamp((state.arpSteps ?? 8) + randi(-2, 2), 4, 16);
  if (chance(0.4)) state.arpGate        = clamp((state.arpGate ?? 0.5) + rand(-0.2, 0.2), 0.15, 1.1);
  if (chance(0.3)) state.arpSubdivision = pick([4, 8, 8, 8, 16]);
  if (chance(0.2)) state.tempoBpm       = clamp((state.tempoBpm ?? 72) + randi(-6, 6), 48, 110);
  if (chance(0.3)) state.sampleTriggerRate = clamp((state.sampleTriggerRate ?? 0.25) + rand(-0.1, 0.1), 0.05, 0.8);
}

function shiftKey(state) {
  const idx = KEYS.indexOf(state.key);
  const shifts = [-5, -2, 2, 3, 5, 7];
  state.key = KEYS[((idx >= 0 ? idx : 0) + pick(shifts) + 12) % 12];
  if (chance(0.4)) state.scale = pick(SCALE_NAMES);
}

// ——— every-frame pulse ———
export function computePulse(state, now = Date.now()) {
  if (!state) return { t: now, breath: 0.5, amp: 0.3, phase: 'sleeping' };
  const bornAt = state.bornAt || now;
  const bs = state.breathSeconds || 8;
  const elapsed = ((now - bornAt) / 1000) % bs;
  const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * elapsed) / bs);
  const ampByPhase = { waking: 0.35, awake: 1.0, breathing: 0.25, sleeping: 0.05 };
  return {
    t: now,
    breath,
    amp: ampByPhase[state.phase] ?? 0.6,
    phase: state.phase ?? 'sleeping',
  };
}

// ——— sample life: derived from created_at, so we never persist it ———
export const SAMPLE_LIFESPAN_MS = 3 * 60 * 60 * 1000; // 3 hours
export function sampleLife(sample, now = Date.now()) {
  const age = now - new Date(sample.created_at).getTime();
  return Math.max(0, 1 - age / SAMPLE_LIFESPAN_MS);
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

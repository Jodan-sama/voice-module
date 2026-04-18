// Pure, client-side soul. The leader of the session pool runs `tickEvolution`
// periodically, mutates its local state, and persists patches upstream.
//
// Nothing here touches the DOM, network, or audio — that keeps it trivially
// portable to the eventual physical instrument runtime.

// ——— musical vocabulary ———
export const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = {
  major:      [0, 2, 4, 5, 7, 9, 11],
  majpent:    [0, 2, 4, 7, 9],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian:     [0, 2, 4, 6, 7, 9, 11],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  minor:      [0, 2, 3, 5, 7, 8, 10],
  minpent:    [0, 3, 5, 7, 10],
  phrygian:   [0, 1, 3, 5, 7, 8, 10],
  hirajoshi:  [0, 2, 3, 7, 8],
};
// weighted scale pool — major-ish scales appear many times, darker/exotic rarely
const SCALE_POOL = [
  'major', 'major', 'major', 'major',
  'majpent', 'majpent', 'majpent',
  'mixolydian', 'mixolydian', 'mixolydian',
  'lydian', 'lydian',
  'dorian', 'dorian',
  'minor', 'minor',
  'minpent',
  'phrygian',
  'hirajoshi',
];
export const ARP_PATTERNS = ['up', 'updown', 'down', 'alt'];
// weighted arp pool — 'up' and 'updown' dominate, feels like a song phrase
const ARP_POOL = [
  'up', 'up', 'up', 'up', 'up',
  'updown', 'updown', 'updown', 'updown',
  'down', 'down',
  'alt',
];
const EFFECT_NAMES = [
  'reverb', 'delay', 'chorus', 'filter', 'pingpong', 'tremolo',
  'phaser', 'autofilter', 'vibrato', 'pitchshift',
  'bitcrush',  // last — also weighted lower at pick time
];

// pleasing progressions in scale degrees — work across major/dorian/etc.
// (roots are 0-indexed scale degrees: 0=I, 1=ii, 2=iii, …)
// list is used as a weighted pool — duplicates = higher odds of being picked.
const PROGRESSIONS = [
  // pop "axis" family — play these a lot
  [0, 4, 5, 3],   // I – V  – vi – IV   (axis of awesome)
  [0, 4, 5, 3],
  [0, 5, 3, 4],   // I – vi – IV – V    (doo-wop)
  [0, 5, 3, 4],
  [0, 3, 4, 0],   // I – IV – V  – I
  [0, 3, 4, 0],
  [5, 3, 0, 4],   // vi – IV – I – V
  [0, 3, 5, 4],   // I – IV – vi – V
  // modal / anthem
  [0, 6, 3, 4],   // I – bVII – IV – V
  [0, 3, 0, 4],   // I – IV – I – V
  // quieter motion
  [0, 2, 5, 4],   // I – iii – vi – V
  [0, 0, 3, 4],   // tonic pedal then cadence
];

export const VOICE_NAMES = [
  'triangle', 'sine', 'square', 'pluck', 'bell', 'soft',
  'marimba', 'glass', 'organ', 'epiano', 'flute',
];

const rand  = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const pick  = (arr) => arr[(Math.random() * arr.length) | 0];
const chance = (p) => Math.random() < p;

// ——— factory ———
export function createInitialState(now = Date.now()) {
  return {
    key: pick(KEYS),
    scale: pick(SCALE_POOL),                   // weighted toward major/pentatonic
    tempoBpm: Math.round(rand(84, 118)),
    rootOctave: randi(2, 3),                   // 2–3 at birth; drifts 2–4 later
    arpPattern: pick(ARP_POOL),                // weighted toward up/updown
    arpSteps: randi(4, 8),                     // narrow — short phrases read as phrases
    arpGate: rand(0.35, 0.75),
    arpSubdivision: pick([8, 8, 16, 16, 16]),
    restProb: rand(0.12, 0.28),
    swing: chance(0.4) ? rand(0.2, 0.55) : 0,
    swingSubdivision: pick([8, 16]),
    burstProb: rand(0.0, 0.10),
    progression: pick(PROGRESSIONS).slice(),
    beatsPerChord: pick([8, 8, 16, 16]),       // longer holds — more room for phrase repetition
    progressionAnchorAt: now,
    effects: spawnEffects(),
    secondaryMelody: null,
    backgroundRhythm: spawnRhythm(),
    phase: 'waking',
    phaseUntil: now + randi(10, 25) * 1000,
    breathSeconds: rand(6, 10),
    sampleTriggerRate: rand(0.36, 0.74),
    voiceTarget: randomVoiceTarget(),
    bornAt: now,
    version: 4,
  };
}

function spawnEffects() {
  const n = randi(2, 4);
  // bitcrush is harsh — let it through only ~25% of the time so most incarnations are gentler
  const pool = EFFECT_NAMES.filter((nm) => nm !== 'bitcrush' || Math.random() < 0.25);
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    const idx = (Math.random() * pool.length) | 0;
    out.push(effectDefaults(pool.splice(idx, 1)[0]));
  }
  return out;
}

function effectDefaults(name) {
  switch (name) {
    case 'reverb':     return { name, wet: rand(0.2, 0.55), decay: rand(2.5, 8), preDelay: rand(0.01, 0.05) };
    case 'delay':      return { name, wet: rand(0.15, 0.4), time: pick(['8n','8n.','4n','4n.','16n']), feedback: rand(0.3, 0.6) };
    case 'pingpong':   return { name, wet: rand(0.15, 0.4), time: pick(['8n','8n.','4n']), feedback: rand(0.25, 0.55) };
    case 'chorus':     return { name, wet: rand(0.2, 0.5), freq: rand(0.2, 2.2), depth: rand(0.3, 0.8) };
    case 'filter':     return { name, wet: 1.0, cutoff: rand(400, 3200), q: rand(0.4, 3), lfoRate: rand(0.04, 0.5), lfoDepth: rand(0.2, 0.9) };
    case 'tremolo':    return { name, wet: rand(0.25, 0.6), freq: rand(0.8, 6), depth: rand(0.3, 0.8) };
    case 'phaser':     return { name, wet: rand(0.25, 0.55), freq: rand(0.1, 1.4), octaves: randi(2, 5), baseFreq: rand(180, 700) };
    case 'autofilter': return { name, wet: rand(0.3, 0.65), freq: rand(0.1, 2.5), depth: rand(0.4, 0.95), baseFreq: rand(150, 600), octaves: randi(2, 4) };
    case 'vibrato':    return { name, wet: rand(0.3, 0.6), freq: rand(2.5, 6.5), depth: rand(0.04, 0.18) };
    case 'pitchshift': return { name, wet: rand(0.12, 0.3), pitch: pick([-12, -7, -5, 5, 7, 12]), windowSize: 0.06 };
    // bitcrush is now gentle: small wet, higher bits — rarely abrasive
    case 'bitcrush':   return { name, wet: rand(0.05, 0.15), bits: randi(7, 10) };
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

function randomVoiceTarget() {
  // 2-3 voices active with weights, others 0. marimba is favored — it reads
  // as 'catchy' and grounds pop-style arp lines, so it lands in ~60% of blends.
  const n = randi(2, 3);
  const blend = Object.fromEntries(VOICE_NAMES.map(v => [v, 0]));
  const pool = [...VOICE_NAMES];
  let remaining = n;

  if (chance(0.6)) {
    blend.marimba = rand(0.6, 1.0);
    const idx = pool.indexOf('marimba');
    if (idx >= 0) pool.splice(idx, 1);
    remaining--;
  }
  for (let i = 0; i < remaining && pool.length; i++) {
    const idx = (Math.random() * pool.length) | 0;
    const v = pool.splice(idx, 1)[0];
    blend[v] = rand(0.45, 1.0);
  }
  return blend;
}

// ——— evolution step. Returns true if `state` was mutated. ———
export function tickEvolution(state, now = Date.now()) {
  if (!state || state.version !== 4) {
    // either brand new or older schema — regenerate, but keep bornAt if present
    const bornAt = state?.bornAt || now;
    Object.assign(state, createInitialState(now));
    state.bornAt = bornAt;
    return true;
  }
  let changed = false;

  // catch-up phase transitions if there was a long gap
  let guard = 32;
  while (now >= (state.phaseUntil ?? 0) && guard-- > 0) {
    transitionPhase(state, now);
    changed = true;
  }

  const awake = state.phase === 'awake' || state.phase === 'waking';

  if (awake && chance(0.025)) { shiftEffect(state);      changed = true; }
  if (awake && chance(0.010)) { shiftArp(state);         changed = true; }
  if (awake && chance(0.006)) { shiftVoices(state);      changed = true; }
  if (awake && chance(0.004)) { shiftProgression(state, now); changed = true; }
  if (awake && chance(0.003)) { shiftKey(state);         changed = true; }
  if (awake && chance(0.005)) { shiftFeel(state);        changed = true; }
  if (awake && chance(0.004)) { shiftSecondary(state);   changed = true; }
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
    awake:     randi(80, 360),
    breathing: randi(20, 60),
    // standard sleep 5–60s; 20% of the time a deeper sleep 30–90s.
    sleeping:  chance(0.2) ? randi(30, 90) : randi(5, 60),
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
      const available = EFFECT_NAMES
        .filter((n) => !fx.find((e) => e.name === n))
        .filter((n) => n !== 'bitcrush' || Math.random() < 0.25);
      if (available.length) fx.push(effectDefaults(pick(available)));
    }
  } else {
    const e = pick(fx);
    if ('wet' in e)      e.wet      = clamp(e.wet      + rand(-0.2, 0.2),  0, 1);
    if ('cutoff' in e)   e.cutoff   = clamp(e.cutoff   * rand(0.5, 1.8),   120, 8000);
    if ('feedback' in e) e.feedback = clamp(e.feedback + rand(-0.15, 0.15),0, 0.85);
    if ('depth' in e)    e.depth    = clamp(e.depth    + rand(-0.25, 0.25),0, 1);
    if ('freq' in e)     e.freq     = Math.max(0.05, e.freq * rand(0.5, 1.8));
  }
}

function shiftArp(state) {
  // less-frequent pattern change so phrases repeat more; use weighted pool
  if (chance(0.35)) state.arpPattern     = pick(ARP_POOL);
  // narrower steps range — song-length phrases feel catchier than 14-step runs
  if (chance(0.4))  state.arpSteps       = clamp((state.arpSteps ?? 6) + randi(-1, 1), 4, 8);
  if (chance(0.4))  state.arpGate        = clamp((state.arpGate ?? 0.5) + rand(-0.2, 0.2), 0.2, 1.0);
  if (chance(0.25)) state.arpSubdivision = pick([8, 8, 16, 16, 16]);
  if (chance(0.25)) state.restProb       = clamp((state.restProb ?? 0.2) + rand(-0.12, 0.12), 0.05, 0.45);
  if (chance(0.2))  state.tempoBpm       = clamp((state.tempoBpm ?? 96) + randi(-6, 6), 70, 128);
  if (chance(0.3))  state.sampleTriggerRate = clamp((state.sampleTriggerRate ?? 0.55) + rand(-0.2, 0.2), 0.36, 0.78);
}

function shiftVoices(state) {
  // subtly shift the blend target — engine crossfades actual gains toward it
  if (chance(0.5)) {
    state.voiceTarget = randomVoiceTarget();
  } else {
    // nudge current target instead of replacing it
    const t = { ...(state.voiceTarget || {}) };
    for (const v of VOICE_NAMES) {
      const cur = t[v] ?? 0;
      if (chance(0.35)) {
        const next = clamp(cur + rand(-0.35, 0.35), 0, 1);
        t[v] = next < 0.08 ? 0 : next;
      }
    }
    // guarantee at least one voice is audible
    const anyOn = VOICE_NAMES.some(v => (t[v] ?? 0) > 0.2);
    if (!anyOn) t[pick(VOICE_NAMES)] = rand(0.5, 1.0);
    state.voiceTarget = t;
  }
}

function shiftProgression(state, now) {
  if (chance(0.65)) state.progression = pick(PROGRESSIONS).slice();
  if (chance(0.3))  state.beatsPerChord = pick([4, 4, 8, 8, 16]);
  state.progressionAnchorAt = now;
}

function shiftKey(state) {
  const idx = KEYS.indexOf(state.key);
  const shifts = [-5, -2, 2, 3, 5, 7];
  state.key = KEYS[((idx >= 0 ? idx : 0) + pick(shifts) + 12) % 12];
  if (chance(0.4)) state.scale = pick(SCALE_POOL);
  // occasionally drift the root octave down a couple or up one — range 2..4
  if (chance(0.35)) {
    const step = pick([-2, -1, -1, -1, 1]);
    state.rootOctave = clamp((state.rootOctave ?? 3) + step, 2, 4);
  }
}

// feel: swing, burst probability, micro-timing variations on the arp grid
function shiftFeel(state) {
  const patch = {};
  if (chance(0.5)) {
    // toggle swing in/out, or nudge amount
    if ((state.swing ?? 0) > 0 && chance(0.35)) {
      state.swing = 0;  // straighten out
    } else {
      state.swing = rand(0.15, 0.55);
      state.swingSubdivision = pick([8, 16]);
    }
  }
  if (chance(0.5)) {
    // bursts: chance that any given step fires a quick double-speed sub-note
    state.burstProb = clamp((state.burstProb ?? 0.05) + rand(-0.05, 0.07), 0, 0.18);
  }
}

function shiftSecondary(state) {
  const sec = state.secondaryMelody;
  if (!sec) {
    // 35% chance we actually spawn one when this function fires
    if (chance(0.35)) state.secondaryMelody = spawnSecondary(state);
  } else {
    // 25% of the time we retire the secondary; otherwise tweak or replace it
    if (chance(0.25)) {
      state.secondaryMelody = null;
    } else if (chance(0.4)) {
      state.secondaryMelody = spawnSecondary(state);   // full replace, different voice/fx
    } else {
      const next = { ...sec };
      if (chance(0.4)) next.pattern      = pick(ARP_POOL);
      if (chance(0.4)) next.restProb     = clamp((next.restProb ?? 0.3) + rand(-0.1, 0.1), 0.05, 0.6);
      if (chance(0.3)) next.gate         = clamp((next.gate ?? 0.45) + rand(-0.15, 0.15), 0.2, 1.0);
      if (chance(0.3)) next.subdivision  = pick([8, 16]);
      if (chance(0.25)) next.octaveOffset = pick([-1, 0, 1, 1]);
      state.secondaryMelody = next;
    }
  }
}

function spawnSecondary(state) {
  // pick a voice that isn't already dominant in the primary blend, so the two
  // melodies have contrasting timbres
  const primary = state.voiceTarget || {};
  const dominant = VOICE_NAMES.filter(v => (primary[v] ?? 0) >= 0.4);
  const contrast = VOICE_NAMES.filter(v => !dominant.includes(v));
  const voice = pick(contrast.length ? contrast : VOICE_NAMES);
  return {
    pattern:      pick(ARP_POOL),
    steps:        randi(4, 8),
    subdivision:  pick([8, 16]),
    gate:         rand(0.3, 0.6),
    voice,
    octaveOffset: pick([-1, 0, 1, 1]),
    restProb:     rand(0.2, 0.45),
    // separate effect chain: 0-2 small effects, skewed gentle
    effects:      spawnSecondaryEffects(),
  };
}

function spawnSecondaryEffects() {
  // pool that skips the harsh bitcrush entirely and biases toward space/modulation
  const pool = ['reverb', 'delay', 'pingpong', 'chorus', 'phaser', 'autofilter', 'vibrato', 'pitchshift', 'tremolo'];
  const n = randi(0, 2);
  const out = [];
  const local = [...pool];
  for (let i = 0; i < n && local.length; i++) {
    const idx = (Math.random() * local.length) | 0;
    const name = local.splice(idx, 1)[0];
    const def = effectDefaults(name);
    // secondary effects are a touch wetter than primary so the melody sits in its own space
    if ('wet' in def) def.wet = clamp(def.wet * 1.15, 0, 1);
    out.push(def);
  }
  return out;
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

// ——— helpers used by the engine ———

// the currently-voiced chord's scale-degree root, from wall-clock
export function currentChordRoot(state, now = Date.now()) {
  const prog = state.progression || [0];
  if (prog.length <= 1) return prog[0] ?? 0;
  const anchor = state.progressionAnchorAt || state.bornAt || now;
  const beatsPerChord = state.beatsPerChord || 8;
  const chordMs = beatsPerChord * (60_000 / (state.tempoBpm || 96));
  const idx = Math.floor(((now - anchor) / chordMs)) % prog.length;
  return prog[((idx % prog.length) + prog.length) % prog.length] ?? 0;
}

// chord-tone aware MIDI note for a given arp step + chord root
// uses a triad-plus-octave voicing [root, 3rd, 5th, octave-root] — classic
// arpeggiator shape, pop-clean, no dissonant 7ths.
export function chordNoteMidi(state, chordRootDeg, step) {
  const scale = SCALES[state.scale] || SCALES.major;
  const chordPositions = [0, 2, 4, 7];  // root, 3rd, 5th, octave up
  const nPos = chordPositions.length;
  const octInArp = Math.floor(step / nPos);
  const posIdx = ((step % nPos) + nPos) % nPos;
  const scaleStep = chordRootDeg + chordPositions[posIdx];
  const scaleDeg = ((scaleStep % scale.length) + scale.length) % scale.length;
  const octFromWrap = Math.floor(scaleStep / scale.length);
  const keyIdx = Math.max(0, KEYS.indexOf(state.key));
  const rootMidi = 12 * ((state.rootOctave || 3) + 1) + keyIdx;
  return rootMidi + scale[scaleDeg] + 12 * (octInArp + octFromWrap);
}

// ——— sample life: derived from created_at + per-sample lifespan ———
// default is 1 day; upload rolls dice and occasionally mints a week / month / year / two-year fragment.
export const SAMPLE_LIFESPAN_MS = 24 * 60 * 60 * 1000; // 1 day
export function sampleLife(sample, now = Date.now()) {
  if (!sample?.created_at) return 1;
  const created = new Date(sample.created_at).getTime();
  if (!isFinite(created)) return 1;
  const rawSpan = Number(sample.lifespan_ms);
  const span = isFinite(rawSpan) && rawSpan > 0 ? rawSpan : SAMPLE_LIFESPAN_MS;
  const age = now - created;
  if (!isFinite(age) || age < 0) return 1;
  return Math.max(0, 1 - age / span);
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

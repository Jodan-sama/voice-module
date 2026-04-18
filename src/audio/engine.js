import * as Tone from 'tone';
import { EffectChain } from './effects.js';
import { SampleBank } from './samples.js';
import * as state from '../state.js';
import {
  VOICE_NAMES,
  currentChordRoot,
  chordNoteMidi,
  SCALES,
  KEYS,
} from '../soul/evolve.js';

// ——— arp pattern expansion ———
function expandArp(pattern, steps) {
  switch (pattern) {
    case 'up':       return Array.from({ length: steps }, (_, i) => i);
    case 'down':     return Array.from({ length: steps }, (_, i) => steps - 1 - i);
    case 'updown': {
      const up = Array.from({ length: steps }, (_, i) => i);
      const dn = up.slice(1, -1).reverse();
      return [...up, ...dn];
    }
    case 'random':   return Array.from({ length: steps * 2 }, () => (Math.random() * steps) | 0);
    case 'converge': {
      const out = [];
      let lo = 0, hi = steps - 1;
      while (lo <= hi) { out.push(lo++); if (lo <= hi) out.push(hi--); }
      return out;
    }
    case 'alt': {
      const even = [], odd = [];
      for (let i = 0; i < steps; i++) (i % 2 ? odd : even).push(i);
      return [...even, ...odd];
    }
    default: return Array.from({ length: steps }, (_, i) => i);
  }
}

// ——— voice factory: each returns a fresh PolySynth with a dedicated character ———
const VOICE_FACTORIES = {
  triangle: () => new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.02, decay: 0.25, sustain: 0.35, release: 1.1 },
    volume: -10,
  }),
  sine: () => new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.01, decay: 0.3, sustain: 0.55, release: 1.4 },
    volume: -7,
  }),
  square: () => new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'pulse', width: 0.32 },
    envelope: { attack: 0.005, decay: 0.2, sustain: 0.3, release: 0.6 },
    volume: -16,
  }),
  pluck: () => new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.002, decay: 0.5, sustain: 0.0, release: 0.5 },
    volume: -12,
  }),
  bell: () => new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 3.01,
    modulationIndex: 7,
    envelope: { attack: 0.001, decay: 1.2, sustain: 0.0, release: 1.4 },
    modulationEnvelope: { attack: 0.002, decay: 0.6, sustain: 0.0, release: 0.6 },
    volume: -14,
  }),
  soft: () => new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.6, decay: 0.3, sustain: 0.7, release: 2.8 },
    volume: -14,
  }),
};

const CROSSFADE_TAU = 4.5;   // seconds — how long a voice blend takes to settle
const MIN_AUDIBLE   = 0.02;  // gain below which we don't bother triggering a voice

export class Engine {
  constructor() {
    this.started = false;
    this.master = null;
    this.breathGain = null;
    this.effects = null;
    this.voices = {};        // name -> { synth, gain, target, current }
    this.padSynth = null;
    this.rhythmSynth = null;
    this.samples = new SampleBank();
    this.arpIdx = 0;
    this.arpOrder = [0];
    this.rhythmIdx = 0;
    this.arpLoop = null;
    this.rhythmLoop = null;
    this._lastBlendSync = 0;
  }

  async start() {
    if (this.started) return;
    await Tone.start();
    this.started = true;

    this.master = new Tone.Gain(0.85).toDestination();
    this.breathGain = new Tone.Gain(1).connect(this.master);
    this.effects = new EffectChain(this.breathGain);

    // voices — each fed into the shared effect chain through its own gain
    for (const name of VOICE_NAMES) {
      const synth = VOICE_FACTORIES[name]();
      const gain = new Tone.Gain(0);  // silent until target says otherwise
      synth.connect(gain);
      gain.connect(this.effects.input);
      this.voices[name] = { synth, gain, target: 0, current: 0 };
    }

    // background pad — slower harmonic bed, underlines each chord
    this.padSynth = new Tone.PolySynth(Tone.AMSynth, {
      harmonicity: 1.5,
      modulationIndex: 2,
      envelope: { attack: 2.5, decay: 1, sustain: 0.85, release: 4 },
      modulationEnvelope: { attack: 3, decay: 1, sustain: 0.8, release: 4 },
      volume: -22,
    }).connect(this.effects.input);

    // low sub/click rhythm
    this.rhythmSynth = new Tone.MembraneSynth({
      pitchDecay: 0.08,
      octaves: 4,
      envelope: { attack: 0.002, decay: 0.35, sustain: 0 },
      volume: -22,
    }).connect(this.master);

    // apply current soul state
    const snap = state.snapshot();
    if (snap) this.applyState(snap, true);
    this.samples.update(state.currentSamples());
    state.on('change', (patch) => this.applyState(patch, false));
    state.on('sample', (samples) => this.samples.update(samples));
    state.on('pulse', (p) => this._applyPulse(p));

    Tone.Transport.bpm.value = snap?.tempoBpm ?? 96;
    this._scheduleArp(snap?.arpSubdivision ?? 16);
    this._scheduleRhythm();
    this._schedulePad();

    Tone.Transport.start('+0.05');
  }

  _scheduleArp(sub) {
    if (this.arpLoop) { this.arpLoop.dispose(); this.arpLoop = null; }
    const interval = `${sub}n`;
    this.arpLoop = new Tone.Loop((time) => this._onArpTick(time), interval).start(0);
  }

  _scheduleRhythm() {
    if (this.rhythmLoop) { this.rhythmLoop.dispose(); this.rhythmLoop = null; }
    this.rhythmLoop = new Tone.Loop((time) => this._onRhythmTick(time), '16n').start(0);
  }

  _schedulePad() {
    const trigger = (time) => {
      const snap = state.snapshot();
      if (!snap) return;
      if (snap.phase === 'sleeping') return;
      const chordRoot = currentChordRoot(snap, Date.now());
      const scale = SCALES[snap.scale] || SCALES.minor;
      const rootMidi = 12 * ((snap.rootOctave || 3) + 1) + Math.max(0, KEYS.indexOf(snap.key));
      // triad from the current chord
      const chord = [0, 2, 4].map(p => {
        const step = chordRoot + p;
        const deg = ((step % scale.length) + scale.length) % scale.length;
        const oct = Math.floor(step / scale.length);
        const midi = rootMidi + scale[deg] + 12 * oct;
        return Tone.Frequency(midi, 'midi').toNote();
      });
      try { this.padSynth.triggerAttackRelease(chord, '2n', time, 0.22); } catch {}
    };
    const schedule = () => {
      const when = Tone.Transport.now() + (2 + Math.random() * 6);
      Tone.Transport.scheduleOnce((t) => { trigger(t); schedule(); }, when);
    };
    schedule();
  }

  // —————— per-arp-step ——————

  _onArpTick(time) {
    const s = state.snapshot();
    if (!s) return;

    // crossfade voice gains toward state.voiceTarget (smooth, every tick)
    this._driftVoiceBlend();

    if (s.phase === 'sleeping') {
      if (Math.random() < 0.03) this._triggerVoice(time, s, 0, 0.12, 0.25);
      return;
    }

    if (this.arpIdx >= this.arpOrder.length) {
      this.arpOrder = expandArp(s.arpPattern, s.arpSteps);
      this.arpIdx = 0;
    }
    const step = this.arpOrder[this.arpIdx++] ?? 0;

    // rest? give the arp space to breathe. more rests in 'breathing' phase.
    const restBias = s.phase === 'breathing' ? 0.35 : 0;
    const restProb = Math.min(0.6, (s.restProb ?? 0.18) + restBias);
    if (Math.random() < restProb) return;

    const chordRoot = currentChordRoot(s, Date.now());
    const octaveJitter = Math.random() < 0.12 ? (Math.random() < 0.5 ? -1 : 1) : 0;
    const sCopy = octaveJitter ? { ...s, rootOctave: (s.rootOctave || 3) + octaveJitter } : s;
    const midi = chordNoteMidi(sCopy, chordRoot, step);
    const phaseAmp = s.phase === 'breathing' ? 0.45 : s.phase === 'waking' ? 0.7 : 1.0;
    const stepBeat = this.arpIdx % 4 === 1; // light accent every 4 steps
    const vel = (stepBeat ? 0.48 : 0.32) + Math.random() * 0.28;
    const noteLen = (s.arpGate ?? 0.55) * (60 / (s.tempoBpm || 96)) * 0.5;

    this._triggerVoice(time, s, midi, vel * phaseAmp, noteLen);

    // maybe trigger a voice fragment, pitched to the current arp note
    if (this.samples.samples.length) {
      const rate = (s.sampleTriggerRate ?? 0.25) * phaseAmp;
      if (Math.random() < rate) {
        const semitones = midi - 60 + (Math.random() < 0.3 ? (Math.random() < 0.5 ? -12 : 12) : 0);
        this.samples.trigger(this.effects.input, semitones, 0.4 + Math.random() * 0.35, time);
      }
    }
  }

  _triggerVoice(time, state, midi, velocity, duration) {
    const note = Tone.Frequency(midi, 'midi').toNote();
    for (const v of VOICE_NAMES) {
      const voice = this.voices[v];
      if (!voice) continue;
      if (voice.current < MIN_AUDIBLE) continue;
      try { voice.synth.triggerAttackRelease(note, duration, time, velocity); } catch {}
    }
  }

  _driftVoiceBlend() {
    const s = state.snapshot();
    if (!s) return;
    const now = performance.now();
    const dt = this._lastBlendSync ? Math.min(0.5, (now - this._lastBlendSync) / 1000) : 0;
    this._lastBlendSync = now;
    if (!dt) return;

    const alpha = 1 - Math.exp(-dt / CROSSFADE_TAU);
    const target = s.voiceTarget || {};
    for (const name of VOICE_NAMES) {
      const v = this.voices[name];
      if (!v) continue;
      const t = target[name] ?? 0;
      v.target = t;
      v.current = v.current + (t - v.current) * alpha;
      v.gain.gain.rampTo(v.current, 0.08);
    }
  }

  _onRhythmTick(time) {
    const s = state.snapshot();
    if (!s?.backgroundRhythm) return;
    const pat = s.backgroundRhythm.pattern || [];
    const step = this.rhythmIdx % (pat.length || 16);
    this.rhythmIdx++;
    if (!pat[step]) return;
    const phaseAmp = s.phase === 'sleeping' ? 0.15 : s.phase === 'breathing' ? 0.5 : 1.0;
    if (Math.random() > phaseAmp) return;

    // pulse on the current chord's root rather than always the key's tonic —
    // keeps the low end in harmony with the progression
    const scale = SCALES[s.scale] || SCALES.minor;
    const chordRoot = currentChordRoot(s, Date.now());
    const deg = ((chordRoot % scale.length) + scale.length) % scale.length;
    const keyIdx = Math.max(0, KEYS.indexOf(s.key));
    const midi = 12 * 2 + keyIdx + scale[deg];  // low octave
    const note = Tone.Frequency(midi, 'midi').toNote();
    const vel = 0.15 + Math.random() * 0.15;
    try { this.rhythmSynth.triggerAttackRelease(note, '16n', time, vel * phaseAmp); } catch {}
  }

  applyState(patch, initial) {
    const now = state.snapshot() || {};
    if (patch.tempoBpm && now.tempoBpm) {
      Tone.Transport.bpm.rampTo(now.tempoBpm, 3);
    } else if (initial) {
      Tone.Transport.bpm.value = now.tempoBpm ?? 96;
    }
    if (initial || patch.arpPattern || patch.arpSteps) {
      this.arpOrder = expandArp(now.arpPattern, now.arpSteps);
      this.arpIdx = 0;
    }
    if (patch.arpSubdivision) this._scheduleArp(now.arpSubdivision);
    if (initial || patch.effects) this.effects.setEffects(now.effects || []);
    // voice target is applied continuously by _driftVoiceBlend — nothing to do here
  }

  _applyPulse(p) {
    const phaseAmp = p.amp ?? 0.6;
    const breathMod = 0.7 + 0.3 * (p.breath ?? 0.5);
    const target = Math.max(0.05, Math.min(1.0, phaseAmp * breathMod));
    if (!this.breathGain) return;
    this.breathGain.gain.rampTo(target, 0.12);
  }
}

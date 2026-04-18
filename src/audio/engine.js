import * as Tone from 'tone';
import { EffectChain } from './effects.js';
import { SampleBank } from './samples.js';
import * as state from '../state.js';

// scale intervals mirror server
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
const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiFor(key, scaleName, octave, step) {
  const scale = SCALES[scaleName] || SCALES.minor;
  const deg = ((step % scale.length) + scale.length) % scale.length;
  const octOffset = Math.floor(step / scale.length);
  const root = 12 * (octave + 1) + KEYS.indexOf(key); // MIDI: C-1 = 0
  return root + scale[deg] + 12 * octOffset;
}

function expandArp(pattern, steps) {
  const half = Math.max(2, Math.floor(steps / 2));
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
      // outside-in
      const out = [];
      let lo = 0, hi = steps - 1;
      while (lo <= hi) { out.push(lo++); if (lo <= hi) out.push(hi--); }
      return out;
    }
    case 'alt': {
      // alternate odd/even
      const even = [], odd = [];
      for (let i = 0; i < steps; i++) (i % 2 ? odd : even).push(i);
      return [...even, ...odd];
    }
    default: return Array.from({ length: steps }, (_, i) => i);
  }
}

export class Engine {
  constructor() {
    this.started = false;
    this.master = null;
    this.wet = null;
    this.effects = null;
    this.arpSynth = null;
    this.padSynth = null;
    this.rhythmSynth = null;
    this.samples = new SampleBank();
    this.arpIdx = 0;
    this.arpOrder = [0];
    this.rhythmIdx = 0;
    this.arpLoop = null;
    this.rhythmLoop = null;
    this.breathLFO = null;
    this._lastState = {};
    this._ampTarget = 0.6;
  }

  async start() {
    if (this.started) return;
    await Tone.start();
    this.started = true;

    // master / breathing bus
    this.master = new Tone.Gain(0.85).toDestination();
    // slight breathing tremolo on amplitude
    this.breathGain = new Tone.Gain(1).connect(this.master);

    // shared effect chain
    this.effects = new EffectChain(this.breathGain);

    // main voice — airy pad-ish synth
    this.arpSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.04, decay: 0.3, sustain: 0.4, release: 1.4 },
      volume: -10,
    }).connect(this.effects.input);

    // background pad that underlines the harmony softly
    this.padSynth = new Tone.PolySynth(Tone.AMSynth, {
      harmonicity: 1.5,
      modulationIndex: 2,
      envelope: { attack: 2.5, decay: 1, sustain: 0.9, release: 4 },
      modulationEnvelope: { attack: 3, decay: 1, sustain: 0.8, release: 4 },
      volume: -22,
    }).connect(this.effects.input);

    // low rhythm engine (no effects — lives under the bed)
    this.rhythmSynth = new Tone.MembraneSynth({
      pitchDecay: 0.08,
      octaves: 4,
      envelope: { attack: 0.002, decay: 0.35, sustain: 0 },
      volume: -24,
    }).connect(this.master);

    // apply current soul state
    const snap = state.snapshot();
    if (snap) this.applyState(snap, true);
    state.on('change', (patch) => this.applyState(patch, false));
    state.on('sample', (samples) => this.samples.update(samples));
    state.on('pulse', (p) => this._applyPulse(p));

    // transport & scheduling
    Tone.Transport.bpm.value = snap?.tempoBpm ?? 72;
    this._scheduleArp(snap?.arpSubdivision ?? 8);
    this._scheduleRhythm();

    // slow, triadic pad pulses — loose, decoupled from the arp grid
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
    // Every 1–3 bars, softly restate a triad from the scale
    const s = state.snapshot();
    if (!s) return;
    const trigger = (time) => {
      const snap = state.snapshot();
      if (!snap) return;
      if (snap.phase === 'sleeping') return; // pad only when awake-ish
      const scale = SCALES[snap.scale] || SCALES.minor;
      const rootMidi = midiFor(snap.key, snap.scale, snap.rootOctave, 0);
      const chord = [0, 2, 4].map(deg => Tone.Frequency(rootMidi + (scale[deg] ?? scale[0]), 'midi').toNote());
      try { this.padSynth.triggerAttackRelease(chord, '2n', time, 0.25); } catch {}
    };
    const schedule = () => {
      const when = Tone.Transport.now() + (2 + Math.random() * 8);
      Tone.Transport.scheduleOnce((t) => {
        trigger(t);
        schedule();
      }, when);
    };
    schedule();
  }

  _onArpTick(time) {
    const s = state.snapshot();
    if (!s) return;
    if (s.phase === 'sleeping') {
      // very sparse clicks
      if (Math.random() < 0.02) {
        const midi = midiFor(s.key, s.scale, s.rootOctave + 1, (Math.random() * s.arpSteps) | 0);
        const note = Tone.Frequency(midi, 'midi').toNote();
        try { this.arpSynth.triggerAttackRelease(note, 0.2, time, 0.15); } catch {}
      }
      return;
    }

    if (this.arpIdx >= this.arpOrder.length) {
      this.arpOrder = expandArp(s.arpPattern, s.arpSteps);
      this.arpIdx = 0;
    }
    const step = this.arpOrder[this.arpIdx++] ?? 0;

    const octaveJitter = Math.random() < 0.15 ? (Math.random() < 0.5 ? -1 : 1) : 0;
    const midi = midiFor(s.key, s.scale, s.rootOctave + octaveJitter, step);
    const note = Tone.Frequency(midi, 'midi').toNote();
    const gate = s.arpGate ?? 0.5;
    const vel = 0.35 + Math.random() * 0.35;
    const phaseAmp = s.phase === 'breathing' ? 0.4 : s.phase === 'waking' ? 0.6 : 1.0;
    try {
      this.arpSynth.triggerAttackRelease(note, gate * (60 / (s.tempoBpm || 72)) * 0.5, time, vel * phaseAmp);
    } catch {}

    // maybe trigger a voice fragment, pitched to the current arp note
    if (s.samples?.length) {
      const rate = (s.sampleTriggerRate ?? 0.25) * phaseAmp;
      if (Math.random() < rate) {
        // pitch: align sample's reference (~C4) to current step
        const semitones = midi - 60 + (Math.random() < 0.3 ? (Math.random() < 0.5 ? -12 : 12) : 0);
        this.samples.trigger(this.effects.input, semitones, 0.4 + Math.random() * 0.35, time);
      }
    }
  }

  _onRhythmTick(time) {
    const s = state.snapshot();
    if (!s?.backgroundRhythm) return;
    const pat = s.backgroundRhythm.pattern || [];
    const step = this.rhythmIdx % (pat.length || 16);
    this.rhythmIdx++;
    if (!pat[step]) return;

    // phase-gated: sleeping → very sparse; breathing → soft
    const phaseAmp = s.phase === 'sleeping' ? 0.15 : s.phase === 'breathing' ? 0.5 : 1.0;
    if (Math.random() > phaseAmp) return;

    const keyMidi = midiFor(s.key, s.scale, 1, 0); // low root
    const note = Tone.Frequency(keyMidi, 'midi').toNote();
    const vel = 0.15 + Math.random() * 0.15;
    try { this.rhythmSynth.triggerAttackRelease(note, '16n', time, vel * phaseAmp); } catch {}
  }

  applyState(patch, initial) {
    const now = state.snapshot() || {};
    // tempo
    if (patch.tempoBpm && now.tempoBpm) {
      Tone.Transport.bpm.rampTo(now.tempoBpm, 2);
    } else if (initial) {
      Tone.Transport.bpm.value = now.tempoBpm ?? 72;
    }
    // rebuild arp order when pattern/steps change
    if (initial || patch.arpPattern || patch.arpSteps) {
      this.arpOrder = expandArp(now.arpPattern, now.arpSteps);
      this.arpIdx = 0;
    }
    if (patch.arpSubdivision) this._scheduleArp(now.arpSubdivision);
    // effects
    if (initial || patch.effects) this.effects.setEffects(now.effects || []);
    // samples
    if (initial || patch.samples) this.samples.update(now.samples || []);
    // rhythm pattern changes — nothing to do, tick reads live state
  }

  _applyPulse(p) {
    // amplitude envelope = phase amp modulated by breath (0..1)
    const phaseAmp = p.amp ?? 0.6;
    const breathMod = 0.75 + 0.25 * (p.breath ?? 0.5); // 0.75..1.0
    const target = Math.max(0.05, Math.min(1.0, phaseAmp * breathMod));
    if (!this.breathGain) return;
    // gentle ramp — no zipper noise
    this.breathGain.gain.rampTo(target, 0.12);
  }
}

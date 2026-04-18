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
  // —— new patches ——
  marimba: () => new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 4.01,
    modulationIndex: 12,
    oscillator: { type: 'sine' },
    modulation: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.9, sustain: 0, release: 0.4 },
    modulationEnvelope: { attack: 0.002, decay: 0.18, sustain: 0, release: 0.2 },
    volume: -10,
  }),
  glass: () => new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 5.5,
    modulationIndex: 15,
    oscillator: { type: 'sine' },
    modulation: { type: 'triangle' },
    envelope: { attack: 0.002, decay: 2.2, sustain: 0.0, release: 2.4 },
    modulationEnvelope: { attack: 0.01, decay: 1.2, sustain: 0, release: 1.0 },
    volume: -18,
  }),
  organ: () => new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsine', count: 3, spread: 14 },
    envelope: { attack: 0.04, decay: 0.08, sustain: 0.85, release: 0.6 },
    volume: -16,
  }),
  epiano: () => new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 1,
    modulationIndex: 6,
    oscillator: { type: 'triangle' },
    modulation: { type: 'sine' },
    envelope: { attack: 0.001, decay: 1.6, sustain: 0.25, release: 1.4 },
    modulationEnvelope: { attack: 0.001, decay: 0.9, sustain: 0, release: 0.5 },
    volume: -9,
  }),
  flute: () => new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fmsine', modulationType: 'sine', modulationIndex: 1.2, harmonicity: 1 },
    envelope: { attack: 0.22, decay: 0.2, sustain: 0.75, release: 1.2 },
    volume: -12,
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
    this.tailBus = null;
    this.tailReverb = null;
    this.tailGain = null;
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
    this._lastEffectsSig = null;
    this._lastArpSig = null;
    this._lastArpSub = null;
    this._lastSwing = null;
    // secondary melody pieces — lazily built when state.secondaryMelody exists
    this.secondary = null;  // { synth, fx, gain, loop, voice, idx, order, lastSig }
  }

  async start() {
    if (this.started) return;
    await Tone.start();
    // give the scheduler more buffer so main-thread bumps don't glitch audio
    try { Tone.context.lookAhead = 0.2; } catch {}
    this.started = true;

    // master bus with a gentle "glue" compressor and a brickwall limiter.
    // the compressor is set very light (ratio 1.8, soft knee, low threshold)
    // so sustained material isn't audibly squashed; it only tames transients
    // that would otherwise produce clicks. the limiter is a safety net at
    // -0.8 dB so nothing ever clips the DAC.
    this.master = new Tone.Gain(0.85);
    this.glue = new Tone.Compressor({
      threshold: -18,
      ratio: 1.8,
      attack: 0.01,
      release: 0.18,
      knee: 18,
    });
    this.brickwall = new Tone.Limiter(-0.8);
    this.master.connect(this.glue);
    this.glue.connect(this.brickwall);
    this.brickwall.toDestination();

    this.breathGain = new Tone.Gain(1).connect(this.master);
    this.effects = new EffectChain(this.breathGain);

    // Persistent tail reverb. Taps post-effects but bypasses the breath
    // envelope, so the room keeps ringing through phase transitions and
    // mid-frame dropouts. Carries ~7s of decay.
    this.tailBus = new Tone.Gain(0.32);
    this.tailReverb = new Tone.Reverb({ decay: 7, preDelay: 0.05, wet: 1.0 });
    this.tailGain = new Tone.Gain(0.55).connect(this.master);
    this.tailBus.connect(this.tailReverb);
    this.tailReverb.connect(this.tailGain);
    // fire-and-forget IR generation — don't block engine start on a slow phone
    this.tailReverb.generate().catch(() => {});
    // send from post-effects into the tail — arrives already coloured
    this.effects.output.connect(this.tailBus);

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

    // burst: fire a second, double-speed sub-note mid-step for rhythmic variety
    if ((s.burstProb ?? 0) > 0 && Math.random() < s.burstProb) {
      const stepSec = (60 / (s.tempoBpm || 96)) * (4 / (s.arpSubdivision || 16));
      const burstTime = time + stepSec * 0.5;
      const nextMidi = chordNoteMidi(sCopy, chordRoot, step + 1);
      this._triggerVoice(burstTime, s, nextMidi, vel * phaseAmp * 0.85, noteLen * 0.5);
    }

    // maybe trigger a voice fragment, pitched to the current chord tone.
    // NOTE: we use a reference state with rootOctave fixed at 3 and no
    // per-note octave jitter, so vocals stay in their natural range even
    // when the melody drifts into lower octaves.
    if (this.samples.samples.length) {
      // floor the phase multiplier at 0.7 so voices don't thin out in
      // breathing/waking; 'sleeping' already returned above.
      const rate = (s.sampleTriggerRate ?? 0.25) * Math.max(0.7, phaseAmp);
      if (Math.random() < rate) {
        const vocalRef = { ...s, rootOctave: 3 };
        const vocalMidi = chordNoteMidi(vocalRef, chordRoot, step);
        const semitones = vocalMidi - 60 + (Math.random() < 0.3 ? (Math.random() < 0.5 ? -12 : 12) : 0);
        this.samples.trigger(this.effects.input, semitones, 0.65 + Math.random() * 0.35, time);
      }
    }
  }

  // ——— secondary melody: independent synth + FX + loop, aligned to the transport ———

  _syncSecondary(state) {
    const cfg = state?.secondaryMelody;
    if (!cfg) {
      if (this.secondary) this._teardownSecondary();
      return;
    }
    const sig = JSON.stringify({
      v: cfg.voice, sub: cfg.subdivision, fx: cfg.effects,
    });
    if (this.secondary && this.secondary.sig === sig) {
      // quick pattern/steps/gate/rest updates are consumed live; nothing to do
      return;
    }
    // rebuild (first time, voice swap, subdivision change, or effects change)
    this._teardownSecondary();
    const voiceName = VOICE_NAMES.includes(cfg.voice) ? cfg.voice : pick(VOICE_NAMES);
    const synth = VOICE_FACTORIES[voiceName]();
    const gain = new Tone.Gain(0.55);
    const fx = new EffectChain(gain);
    fx.setEffects(cfg.effects || []);
    synth.connect(fx.input);
    gain.connect(this.breathGain);           // rides the breath envelope like the rest
    gain.connect(this.tailBus);              // also feeds the persistent reverb tail
    const interval = `${cfg.subdivision || 16}n`;
    const loop = new Tone.Loop((time) => this._onSecondaryTick(time), interval).start(0);
    this.secondary = {
      sig, synth, fx, gain, loop,
      voice: voiceName,
      idx: 0,
      order: [],
      lastPatternSig: null,
    };
  }

  _teardownSecondary() {
    if (!this.secondary) return;
    try { this.secondary.loop.dispose(); } catch {}
    try { this.secondary.synth.dispose(); } catch {}
    try { this.secondary.fx.dispose(); } catch {}
    try { this.secondary.gain.dispose(); } catch {}
    this.secondary = null;
  }

  _onSecondaryTick(time) {
    const s = state.snapshot();
    const cfg = s?.secondaryMelody;
    const sec = this.secondary;
    if (!s || !cfg || !sec) return;
    if (s.phase === 'sleeping') return;

    // rebuild the pattern order if arp shape changed
    const patSig = `${cfg.pattern}:${cfg.steps}`;
    if (sec.lastPatternSig !== patSig) {
      sec.order = expandArp(cfg.pattern, cfg.steps);
      sec.idx = 0;
      sec.lastPatternSig = patSig;
    }
    if (sec.idx >= sec.order.length) sec.idx = 0;
    const step = sec.order[sec.idx++] ?? 0;

    const phaseAmp = s.phase === 'breathing' ? 0.4 : s.phase === 'waking' ? 0.65 : 0.95;
    const restBias = s.phase === 'breathing' ? 0.2 : 0;
    const restProb = Math.min(0.7, (cfg.restProb ?? 0.3) + restBias);
    if (Math.random() < restProb) return;

    const chordRoot = currentChordRoot(s, Date.now());
    const octaveOffset = cfg.octaveOffset ?? 0;
    const sCopy = { ...s, rootOctave: (s.rootOctave || 3) + octaveOffset };
    const midi = chordNoteMidi(sCopy, chordRoot, step);
    const note = Tone.Frequency(midi, 'midi').toNote();
    const noteLen = (cfg.gate ?? 0.45) * (60 / (s.tempoBpm || 96)) * 0.5;
    const vel = (0.28 + Math.random() * 0.22) * phaseAmp;
    try { sec.synth.triggerAttackRelease(note, noteLen, time, vel); } catch {}
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
    // first pass: snap voice gains to their target so the instrument is
    // immediately audible instead of fading in from silence over ~5s.
    if (!this._lastBlendSync) {
      this._lastBlendSync = now;
      const target = s.voiceTarget || {};
      for (const name of VOICE_NAMES) {
        const v = this.voices[name];
        if (!v) continue;
        const t = target[name] ?? 0;
        v.target = t;
        v.current = t;
        v.gain.gain.value = t;
      }
      return;
    }
    const dt = Math.min(0.5, (now - this._lastBlendSync) / 1000);
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

    // tempo — ramp, don't reset
    if (patch.tempoBpm && now.tempoBpm) {
      Tone.Transport.bpm.rampTo(now.tempoBpm, 3);
    } else if (initial) {
      Tone.Transport.bpm.value = now.tempoBpm ?? 96;
    }

    // swing is cheap to apply every time it changes
    const swingSig = `${now.swing ?? 0}:${now.swingSubdivision ?? 8}`;
    if (swingSig !== this._lastSwing) {
      Tone.Transport.swing = now.swing ?? 0;
      Tone.Transport.swingSubdivision = `${now.swingSubdivision || 8}n`;
      this._lastSwing = swingSig;
    }

    // arp pattern rebuild only when pattern or step count actually differs.
    // realtime patches contain every field, so a naive check causes
    // rebuilds on every tempo/effect/voice drift — that's the click source.
    const arpSig = `${now.arpPattern}:${now.arpSteps}`;
    if (arpSig !== this._lastArpSig) {
      this.arpOrder = expandArp(now.arpPattern, now.arpSteps);
      this.arpIdx = 0;
      this._lastArpSig = arpSig;
    }

    if (now.arpSubdivision && now.arpSubdivision !== this._lastArpSub) {
      this._scheduleArp(now.arpSubdivision);
      this._lastArpSub = now.arpSubdivision;
    }

    // effect chain rebuild only when the effect set structurally changes.
    // stringify is cheap for a list of ~3 small objects.
    const fxSig = JSON.stringify(now.effects || []);
    if (fxSig !== this._lastEffectsSig) {
      this.effects.setEffects(now.effects || []);
      this._lastEffectsSig = fxSig;
    }

    // secondary melody: create/destroy/swap as needed
    this._syncSecondary(now);
    // voice target is applied continuously by _driftVoiceBlend — nothing to do here
  }

  _applyPulse(p) {
    if (!this.breathGain) return;

    const now = performance.now();
    const dt = this._lastAmpT ? Math.min(0.5, (now - this._lastAmpT) / 1000) : 0;
    this._lastAmpT = now;

    // phase amplitude changes step-wise when the soul transitions phases.
    // smooth it asymmetrically — very slow fade going quiet, quicker return when waking.
    const targetPhase = p.amp ?? 0.6;
    // initialize loud regardless of current phase, so a listener arriving during
    // a 'sleeping' moment still gets immediate confirmation that audio is alive.
    if (this._smoothedAmp == null) this._smoothedAmp = Math.max(0.7, targetPhase);
    const goingDown = targetPhase < this._smoothedAmp;
    const tau = goingDown ? 35 : 2.5;  // seconds — slow exhale, quick inhale
    if (dt) {
      const alpha = 1 - Math.exp(-dt / tau);
      this._smoothedAmp += (targetPhase - this._smoothedAmp) * alpha;
    }

    const breathMod = 0.7 + 0.3 * (p.breath ?? 0.5);
    const target = Math.max(0.02, Math.min(1.0, this._smoothedAmp * breathMod));
    this.breathGain.gain.rampTo(target, 0.12);
  }
}

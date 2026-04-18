import * as Tone from 'tone';
import * as state from './state.js';
import { initScene } from './scene/scene.js';
import { Engine } from './audio/engine.js';
import { initRecord } from './ui/record.js';

const canvas = document.getElementById('stage');
const recordBtn = document.getElementById('record');
const hint = document.getElementById('hint');
const status = document.getElementById('status');

// connect to the living soul ASAP — visuals can render before audio starts
state.connect();

// 3D scene runs immediately
initScene(canvas);

// audio needs a user gesture. iOS Safari is strict: the AudioContext.resume()
// call has to happen synchronously inside a touch / click handler. We listen
// for several gesture types to maximize coverage and call Tone.start() before
// any await so the resume hits inside the gesture chain.
const audio = new Engine();
let audioStarting = false;

async function startAudio() {
  if (audioStarting || audio.started) return;
  audioStarting = true;
  try {
    // 1. resume the context — must be the first thing inside the gesture
    await Tone.start();
    if (Tone.context.state !== 'running') {
      // some iOS versions need an explicit second nudge
      await Tone.context.resume();
    }
    if (Tone.context.state !== 'running') {
      throw new Error(`audio blocked (context ${Tone.context.state})`);
    }
    // 2. now build the engine graph
    await audio.start();
    status.textContent = hint.textContent;
  } catch (e) {
    console.error('[audio] start failed', e, 'context state:', Tone.context?.state);
    status.textContent = 'tap again to listen';
    audioStarting = false;  // allow retry on next gesture
  }
}

// idempotent — register on every gesture type that might be the first one,
// at both window level and on the record button (so recording-first paths
// also unlock playback). capture-phase on the button so we run before the
// recorder's own click handler.
window.addEventListener('pointerdown', startAudio);
window.addEventListener('touchstart',  startAudio, { passive: true });
window.addEventListener('click',       startAudio);
window.addEventListener('keydown',     startAudio);
recordBtn.addEventListener('pointerdown', startAudio, { capture: true });
recordBtn.addEventListener('touchstart',  startAudio, { capture: true, passive: true });

// show phase in the status line
state.on('phase', (phase) => {
  const word = {
    waking: 'stirring',
    awake: 'playing',
    breathing: 'breathing',
    sleeping: 'dreaming',
  }[phase] || phase;
  status.textContent = word;
  setTimeout(() => { if (status.textContent === word) status.textContent = hint.textContent; }, 3500);
});

initRecord({ button: recordBtn, status });

// first-paint nudge
status.textContent = 'tap anywhere to listen';

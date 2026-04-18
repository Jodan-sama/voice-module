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

// audio needs a user gesture — start on first interaction with the page
const audio = new Engine();
let audioStarting = false;
async function startAudio() {
  if (audioStarting || audio.started) return;
  audioStarting = true;
  try { await audio.start(); status.textContent = hint.textContent; }
  catch (e) { console.error('audio start failed', e); audioStarting = false; }
}

// any first interaction wakes the audio
const wake = () => {
  startAudio();
  window.removeEventListener('pointerdown', wake);
  window.removeEventListener('keydown', wake);
};
window.addEventListener('pointerdown', wake);
window.addEventListener('keydown', wake);

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

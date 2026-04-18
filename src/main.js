import * as Tone from 'tone';
import * as state from './state.js';
import { initScene } from './scene/scene.js';
import { Engine } from './audio/engine.js';
import { initRecord } from './ui/record.js';

const canvas = document.getElementById('stage');
const recordBtn = document.getElementById('record');
const hint = document.getElementById('hint');
const status = document.getElementById('status');

state.connect();
initScene(canvas);

const audio = new Engine();
let audioReady = false;
let audioStarting = false;

// ——— iOS / mobile audio unlock ———
//
// Mobile browsers, especially iOS Safari, only honor AudioContext.resume()
// when it is called *synchronously* from a touch/click event. They also
// often need a silent buffer played through the destination before WebAudio
// will produce any sound. We do both inside the gesture handler before any
// await, then continue async to build the engine graph.

function rawCtx() {
  const c = Tone.getContext();
  return c?.rawContext || c?._context || c;
}

function syncUnlock() {
  const ctx = rawCtx();
  if (!ctx) return;
  // silent priming buffer FIRST — order matters on iOS; the buffer is what
  // actually opens the output node, resume() alone often isn't enough.
  try {
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch {}
  if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
    try { ctx.resume(); } catch {}
  }
}

async function startAudio() {
  if (audioReady) return;

  // sync unlock FIRST — must happen synchronously in the gesture
  syncUnlock();

  if (audioStarting) return;
  audioStarting = true;

  try {
    status.textContent = 'unlocking…';

    // Tone.start()'s underlying resume() can hang forever on some iOS
    // versions (Safari just never resolves the promise). Race it with a
    // short timeout — we'll then trust the raw context state instead.
    await Promise.race([
      Tone.start().catch(() => {}),
      new Promise((r) => setTimeout(r, 1500)),
    ]);

    // belt-and-suspenders: re-do the sync unlock, sometimes one pass isn't enough
    syncUnlock();
    await new Promise((r) => setTimeout(r, 200));

    if (Tone.context.state !== 'running') {
      throw new Error(`blocked (${Tone.context.state}) — check ringer switch & try again`);
    }

    status.textContent = 'starting…';
    await Promise.race([
      audio.start(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('engine timed out')), 8000)),
    ]);

    audioReady = true;
    status.textContent = hint.textContent;
  } catch (e) {
    console.error('[audio] start failed', e, 'context state:', Tone.context?.state);
    const msg = (e?.message || 'unknown').toLowerCase().slice(0, 100);
    status.textContent = msg;
    audioStarting = false;
    setTimeout(() => {
      if (!audioReady) status.textContent = 'tap again to listen';
    }, 4500);
  }
}

// register on every gesture path that might fire first. on iOS, touchstart
// and click are the reliable ones; pointerdown isn't always honored. each
// handler is idempotent, so multiple firings are fine.
window.addEventListener('touchstart', startAudio, { passive: true });
window.addEventListener('click', startAudio);
window.addEventListener('keydown', startAudio);
// also unlock when the record button is the first thing tapped, before its
// own click handler runs
recordBtn.addEventListener('touchstart', startAudio, { capture: true, passive: true });
recordBtn.addEventListener('click', startAudio, { capture: true });

// show phase in the status line
state.on('phase', (phase) => {
  if (!audioReady) return;
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

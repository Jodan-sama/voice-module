import * as Tone from 'tone';
import * as state from './state.js';
import { initScene } from './scene/scene.js';
import { Engine } from './audio/engine.js';
import { initRecord } from './ui/record.js';
import { migrateAllSamples } from './ui/migrate.js';

// DevTools-only: convert every non-WAV sample in the bucket to 22 kHz mono
// WAV in place. idempotent, safe to re-run. see src/ui/migrate.js for options.
// usage:
//   await __migrateSamples({ dryRun: true })  // just report, no writes
//   await __migrateSamples()                   // do it for real
window.__migrateSamples = migrateAllSamples;

const canvas = document.getElementById('stage');
const glowEl = document.getElementById('glow');
const recordBtn = document.getElementById('record');
const hint = document.getElementById('hint');
const status = document.getElementById('status');

state.connect();
initScene(canvas);

const audio = new Engine();

// ——— cloud load indicator ———
// yellow while any sample buffer is in flight, neon-green flash when the last
// one finishes, red flash on any failure. capped at 5s regardless. the glow
// rides on a fixed-position full-viewport div (#glow) with an inset box-shadow.

const GLOW_MAX_MS = 5000;
const GLOW_YELLOW = 'inset 0 0 140px 28px rgba(245, 210, 70, 0.42)';
const GLOW_GREEN  = 'inset 0 0 160px 32px rgba(60, 245, 140, 0.55)';
const GLOW_RED    = 'inset 0 0 170px 36px rgba(245, 80, 80, 0.55)';
let glowTimer = null;
let pendingLoads = 0;
let loadsStarted = 0;
let loadsSucceeded = 0;
let loadsFailed = 0;

function setGlow(boxShadow, holdMs) {
  if (glowTimer) clearTimeout(glowTimer);
  if (glowEl) glowEl.style.boxShadow = boxShadow;
  glowTimer = setTimeout(() => {
    if (glowEl) glowEl.style.boxShadow = '';
    glowTimer = null;
  }, Math.min(holdMs, GLOW_MAX_MS));
}

audio.samples.setLoadListener(({ phase }) => {
  if (phase === 'start') {
    pendingLoads++;
    loadsStarted++;
    setGlow(GLOW_YELLOW, GLOW_MAX_MS);
  } else if (phase === 'success') {
    pendingLoads = Math.max(0, pendingLoads - 1);
    loadsSucceeded++;
    if (pendingLoads === 0) setGlow(GLOW_GREEN, 1400);
  } else if (phase === 'fail') {
    pendingLoads = Math.max(0, pendingLoads - 1);
    loadsFailed++;
    setGlow(GLOW_RED, 3500);   // red takes priority over pending-yellow
  }
});

// report aggregate load health every 20s so the console has a running pulse
setInterval(() => {
  console.log('[cloud] sample-loads 20s window:', {
    started: loadsStarted,
    succeeded: loadsSucceeded,
    failed: loadsFailed,
    pending: pendingLoads,
    poolSize: state.currentSamples().length,
  });
  loadsStarted = 0; loadsSucceeded = 0; loadsFailed = 0;
}, 20000);
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

// Build a silent WAV blob at runtime and stick it on a hidden <audio> tag.
// On iOS, even when AudioContext.state === 'running', WebAudio output may
// not reach the speaker unless there is an active HTMLMediaElement playing
// on the page. This silent loop is the route-opener.
let silentEl = null;
function silentWavUrl() {
  const sr = 8000, samples = 4000;          // 0.5s of silence, 8kHz mono 8-bit
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  v.setUint32(0, 0x52494646, false);        // RIFF
  v.setUint32(4, 36 + samples, true);
  v.setUint32(8, 0x57415645, false);        // WAVE
  v.setUint32(12, 0x666d7420, false);       // fmt
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  v.setUint32(36, 0x64617461, false);       // data
  v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 0x80);  // 0x80 = silence for u8 PCM
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function ensureSilentEl() {
  if (silentEl) return silentEl;
  silentEl = document.createElement('audio');
  silentEl.src = silentWavUrl();
  silentEl.loop = true;
  silentEl.preload = 'auto';
  silentEl.setAttribute('playsinline', '');
  silentEl.style.display = 'none';
  document.body.appendChild(silentEl);
  return silentEl;
}

function setPlaybackSession() {
  // iOS 17+: explicitly declare we're doing media playback, not a call.
  // prevents the low-end-drops-out-after-recording bug by keeping the OS
  // from ever switching the session into 'play-and-record' mode.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
}

function syncUnlock() {
  setPlaybackSession();
  const ctx = rawCtx();
  if (!ctx) return;
  // 1. play silent <audio> on the page so iOS opens the speaker route
  try { ensureSilentEl().play().catch(() => {}); } catch {}
  // 2. play a 1-sample silent buffer through the AudioContext destination
  try {
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch {}
  // 3. resume the context
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

// show phase in the status line + do quiet-period housekeeping
let sleepCount = 0;
state.on('phase', (phase) => {
  if (audioReady) {
    const word = {
      waking: 'stirring',
      awake: 'playing',
      breathing: 'breathing',
      sleeping: 'dreaming',
    }[phase] || phase;
    status.textContent = word;
    setTimeout(() => { if (status.textContent === word) status.textContent = hint.textContent; }, 3500);
  }
  if (phase === 'sleeping') {
    sleepCount++;
    // on every sleep: ~75% chance to summon a cloud elder into the pool
    if (Math.random() < 0.75) {
      state.summonElderSample().catch(() => {});
    }
    // on every second sleep: rotate the whole pool during the quiet
    if (sleepCount % 2 === 0) {
      state.refreshSamplePool().catch(() => {});
    }
  }
});

initRecord({ button: recordBtn, status, hint });

// first-paint nudge
status.textContent = 'tap anywhere to listen';

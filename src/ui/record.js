import * as state from '../state.js';

const DURATION_SEC = 5;

// Records ~5 seconds of voice, uploads the blob to Supabase Storage,
// then inserts a row into `samples`. All other clients receive it over
// Realtime and start weaving it in.
export function initRecord({ button, status }) {
  let busy = false;

  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.classList.add('active');
    const originalHint = status.textContent;
    try {
      // Keep voice processing OFF on the mic request. Any of EC/NS/AGC enabled
      // flips iOS into 'voice call' audio-session mode, which AGCs the entire
      // output and glitches playback until the stream closes. It also strips
      // texture from the voice — bad for an artistic instrument.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      // iOS 17+: explicitly say we're still doing playback even while recording,
      // so the session never enters voice mode and low-end doesn't get filtered.
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}

      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

      const started = performance.now();
      rec.start();

      let remaining = DURATION_SEC;
      status.textContent = `listening · ${remaining}`;
      const interval = setInterval(() => {
        remaining -= 1;
        if (remaining > 0) status.textContent = `listening · ${remaining}`;
      }, 1000);

      await new Promise((resolve) => {
        setTimeout(() => { try { rec.stop(); } catch {} resolve(); }, DURATION_SEC * 1000);
      });
      clearInterval(interval);

      await new Promise((resolve) => rec.addEventListener('stop', resolve, { once: true }));
      for (const tr of stream.getTracks()) tr.stop();

      // after the mic closes, reassert playback session and nudge iOS routing
      // so the low-end filter doesn't linger in 'voice' mode.
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}

      const duration = (performance.now() - started) / 1000;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      status.textContent = 'weaving…';
      const sample = await state.uploadSample(blob, blob.type, duration);
      const label = sample?.label || 'woven in';
      const rare = label !== 'woven in';
      status.textContent = label;
      // long-lived fragments deserve to linger on screen a moment
      setTimeout(() => { status.textContent = originalHint; }, rare ? 6000 : 1800);
    } catch (err) {
      console.error('[record] failed', err);
      let msg;
      if (err?.name === 'NotAllowedError')       msg = 'mic denied';
      else if (err?.name === 'NotFoundError')    msg = 'no mic found';
      else if (err?.message) {
        // strip our own "upload:" / "insert:" prefix so the user sees the raw Supabase text
        msg = err.message.replace(/^(upload|insert):\s*/i, '').toLowerCase().slice(0, 140);
      } else {
        msg = 'couldn\'t record';
      }
      status.textContent = msg;
      setTimeout(() => { status.textContent = originalHint; }, 9000);
    } finally {
      button.classList.remove('active');
      busy = false;
    }
  });
}

function pickMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';
}

import * as state from '../state.js';

const DURATION_SEC = 5;

// Records ~5 seconds of voice, uploads raw blob to server.
// Server stores; soul broadcasts the new sample id; clients load and play.
export function initRecord({ button, status }) {
  let busy = false;

  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.classList.add('active');
    const originalHint = status.textContent;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });

      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

      const started = performance.now();
      rec.start();

      // countdown
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

      const duration = (performance.now() - started) / 1000;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      status.textContent = 'weaving…';
      await state.uploadSample(blob, blob.type, duration);
      status.textContent = 'woven in';
      setTimeout(() => { status.textContent = originalHint; }, 1800);
    } catch (err) {
      console.error(err);
      status.textContent = err.name === 'NotAllowedError' ? 'mic denied' : 'couldn\'t record';
      setTimeout(() => { status.textContent = originalHint; }, 2200);
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

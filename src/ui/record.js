import * as state from '../state.js';
import { audioBlobToWav } from '../audio/wav.js';

const DURATION_SEC = 5;
const MIN_DURATION_SEC = 0.2;  // refuse to upload anything shorter (empty mic, perm-denied, etc.)

// Records ~5 seconds of voice, re-encodes to WAV, and uploads to Supabase.
//
// Why the WAV detour: MediaRecorder produces WebM where the duration field
// in the EBML container is left as 'unknown' (0x01FFFFFFFFFFFFFF) because
// it doesn't know the final length at start. Most players — including
// Supabase's storage-UI preview — read that field and show 0:00. WAV's
// header carries an explicit sample count, so downstream tooling always
// reads the correct duration. Tone.js's decodeAudioData works either way,
// but the cloud preview is much more useful with WAV.
export function initRecord({ button, status, hint }) {
  let busy = false;
  // restoreText reads the hint element fresh each time so we always go back
  // to the genuine 'tap to leave a voice' string, never to whatever happens
  // to be in the status bar (which may itself be a stale label from a prior
  // recording or phase transition mid-revert).
  const restoreText = () => hint?.textContent ?? '';
  // setStatusWithRevert: write `text`, then revert after `holdMs` only if
  // the status hasn't been overwritten in the meantime. prevents leftover
  // timers from clobbering newer state.
  function setStatusWithRevert(text, holdMs) {
    status.textContent = text;
    setTimeout(() => {
      if (status.textContent === text) status.textContent = restoreText();
    }, holdMs);
  }

  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.classList.add('active');
    try {
      // Switch the iOS audio session into 'play-and-record' BEFORE asking for
      // the mic — the 'playback' default we set at startup rejects getUserMedia.
      // We'll switch back to 'playback' after the stream closes.
      try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}

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

      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

      const started = performance.now();
      // 500ms timeslice forces ondataavailable to fire periodically instead of
      // only on stop(), so browser quirks around stop() can't lose the final
      // chunk when the track is torn down.
      rec.start(500);

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

      const capturedBlob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      status.textContent = 'weaving…';

      // decode to PCM + re-encode as 22 kHz mono WAV so the bucket preview
      // and any other downstream tool sees a sane duration. if decode fails,
      // fall back to uploading the raw blob — Tone.js can still play it.
      let uploadBlob = capturedBlob;
      let uploadMime = capturedBlob.type || 'audio/webm';
      let decodedDuration = (performance.now() - started) / 1000;
      try {
        const wav = await audioBlobToWav(capturedBlob);
        if (wav.duration < MIN_DURATION_SEC) {
          throw new Error(`recording too short (${wav.duration.toFixed(2)}s)`);
        }
        uploadBlob = wav.blob;
        uploadMime = 'audio/wav';
        decodedDuration = wav.duration;
      } catch (err) {
        if (err?.message?.startsWith('recording too short')) throw err;  // propagate
        console.warn('[record] WAV re-encode failed, uploading raw container', err);
      }

      const sample = await state.uploadSample(uploadBlob, uploadMime, decodedDuration);
      const label = sample?.label || 'woven in';
      const rare = label !== 'woven in';
      // long-lived fragments deserve to linger on screen a moment
      setStatusWithRevert(label, rare ? 6000 : 1800);
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
      setStatusWithRevert(msg, 9000);
    } finally {
      // always revert the iOS session so the low-end filter never lingers,
      // whether recording succeeded, errored, or was cancelled mid-way
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
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

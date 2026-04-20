import * as state from '../state.js';

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
export function initRecord({ button, status }) {
  let busy = false;

  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.classList.add('active');
    const originalHint = status.textContent;
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

      // decode to PCM + re-encode as WAV so the bucket preview and any other
      // downstream tool sees a sane duration. if decode fails, fall back to
      // uploading the raw blob — Tone.js can still play it locally.
      let uploadBlob = capturedBlob;
      let uploadMime = capturedBlob.type || 'audio/webm';
      let decodedDuration = (performance.now() - started) / 1000;
      try {
        const wav = await webmToWav(capturedBlob);
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

// Decode an arbitrary mime blob via AudioContext and produce a 16-bit PCM
// WAV blob with correct headers. Preserves channel count and sample rate.
async function webmToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const decoder = new Ctx();
  let audioBuffer;
  try {
    audioBuffer = await decoder.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    // don't keep a second AudioContext alive past decode
    decoder.close?.();
  }
  const { sampleRate, numberOfChannels, length, duration } = audioBuffer;
  // interleave channels into one Float32Array
  const interleaved = new Float32Array(length * numberOfChannels);
  for (let c = 0; c < numberOfChannels; c++) {
    const chan = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) {
      interleaved[i * numberOfChannels + c] = chan[i];
    }
  }
  const wavBlob = pcmToWavBlob(interleaved, sampleRate, numberOfChannels);
  return { blob: wavBlob, duration };
}

function pcmToWavBlob(samples, sampleRate, numChannels = 1) {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataLength = samples.length * 2;   // 16-bit = 2 bytes per sample
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  view.setUint32(0, 0x52494646, false);     // 'RIFF'
  view.setUint32(4, 36 + dataLength, true); // file size - 8
  view.setUint32(8, 0x57415645, false);     // 'WAVE'
  view.setUint32(12, 0x666d7420, false);    // 'fmt '
  view.setUint32(16, 16, true);             // fmt chunk size
  view.setUint16(20, 1, true);              // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  view.setUint32(36, 0x64617461, false);    // 'data'
  view.setUint32(40, dataLength, true);     // data chunk size

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

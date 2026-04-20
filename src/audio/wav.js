// WAV encoding utilities — shared by the live recorder and the bucket migrator.
// Decoded + resampled + mono-mixed 16-bit PCM written as a standard RIFF WAV
// with an explicit sample count in the header, so Supabase's preview and any
// other player reads the correct duration.

export async function audioBlobToWav(blob, { targetRate = 22050, mono = true } = {}) {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const decoder = new Ctx();
  let audioBuffer;
  try {
    // AudioContext.decodeAudioData mutates its input on some implementations;
    // slice gives a detachable copy.
    audioBuffer = await decoder.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    decoder.close?.();
  }

  const needsResample = audioBuffer.sampleRate !== targetRate
    || (mono && audioBuffer.numberOfChannels !== 1);
  let out = audioBuffer;
  if (needsResample) {
    const outChannels = mono ? 1 : audioBuffer.numberOfChannels;
    const outLength  = Math.max(1, Math.ceil(audioBuffer.duration * targetRate));
    const offline = new OfflineAudioContext(outChannels, outLength, targetRate);
    const src = offline.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(offline.destination);
    src.start(0);
    out = await offline.startRendering();
  }

  const { sampleRate, numberOfChannels, length, duration } = out;
  const interleaved = new Float32Array(length * numberOfChannels);
  for (let c = 0; c < numberOfChannels; c++) {
    const chan = out.getChannelData(c);
    for (let i = 0; i < length; i++) {
      interleaved[i * numberOfChannels + c] = chan[i];
    }
  }
  const wavBlob = pcmToWavBlob(interleaved, sampleRate, numberOfChannels);
  return { blob: wavBlob, duration, sampleRate, channels: numberOfChannels };
}

export function pcmToWavBlob(samples, sampleRate, numChannels = 1) {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  view.setUint32(0, 0x52494646, false);     // 'RIFF'
  view.setUint32(4, 36 + dataLength, true);
  view.setUint32(8, 0x57415645, false);     // 'WAVE'
  view.setUint32(12, 0x666d7420, false);    // 'fmt '
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  view.setUint32(36, 0x64617461, false);    // 'data'
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

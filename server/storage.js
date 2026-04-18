import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EXT_FOR = {
  'audio/webm': 'webm',
  'audio/webm;codecs=opus': 'webm',
  'audio/ogg': 'ogg',
  'audio/ogg;codecs=opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

export class Storage {
  constructor({ dataDir, sampleDir }) {
    this.dataDir = dataDir;
    this.sampleDir = sampleDir;
    this.stateFile = path.join(dataDir, 'state.json');
    this._saveTimer = null;
  }

  async init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.sampleDir, { recursive: true });
  }

  loadState() {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  scheduleSave(state) {
    // debounce writes — evolution is noisy
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush(state);
    }, 750);
  }

  flush(state) {
    try {
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      console.error('state persist failed', err);
    }
  }

  async writeSample(buffer, mime) {
    const ext = EXT_FOR[mime?.toLowerCase?.()] || 'webm';
    const id = crypto.randomUUID();
    const filename = `${id}.${ext}`;
    const full = path.join(this.sampleDir, filename);
    await fs.promises.writeFile(full, buffer);
    return { id, url: `/samples/${filename}`, filename };
  }

  async deleteSample(filename) {
    if (!filename) return;
    const full = path.join(this.sampleDir, path.basename(filename));
    try {
      await fs.promises.unlink(full);
    } catch {}
  }
}

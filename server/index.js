import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { WebSocketServer } from 'ws';

import { Soul } from './soul.js';
import { Storage } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const SAMPLE_DIR = path.join(DATA_DIR, 'samples');
fs.mkdirSync(SAMPLE_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 3000);
const DIST_DIR = path.join(__dirname, '..', 'dist');

const storage = new Storage({ dataDir: DATA_DIR, sampleDir: SAMPLE_DIR });
await storage.init();

const soul = new Soul(storage.loadState());
soul.on('change', (patch) => {
  storage.scheduleSave(soul.snapshot());
  broadcast({ type: 'patch', patch });
});

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/state', (_req, res) => {
  res.json(soul.snapshot());
});

// Upload a recorded blob. Body is raw audio bytes (webm/opus or wav).
app.post('/api/sample', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty' });
    const mime = req.headers['content-type'] || 'audio/webm';
    const duration = Number(req.headers['x-duration'] || 5);
    const { id, url } = await storage.writeSample(req.body, mime);
    const sample = soul.addSample({ id, url, mime, duration, createdAt: Date.now() });
    res.json({ ok: true, sample });
  } catch (err) {
    console.error('sample upload failed', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.use('/samples', express.static(SAMPLE_DIR, {
  maxAge: '1y',
  immutable: true,
}));

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', state: soul.snapshot() }));
  ws.on('message', (raw) => {
    // clients are read-only for now; future collab features go here
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
    } catch {}
  });
});

// broadcast the cheap, fast-changing signals (breath phase, arp step) on a tick
setInterval(() => {
  broadcast({ type: 'pulse', pulse: soul.pulse() });
}, 120);

soul.start();

server.listen(PORT, () => {
  console.log(`[living] listening on :${PORT}`);
});

function shutdown() {
  console.log('\n[living] drifting off…');
  storage.flush(soul.snapshot());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

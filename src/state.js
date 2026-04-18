// Connects to the server, keeps a local mirror of the soul,
// and exposes `on('change'|'pulse'|'sample', cb)` for subscribers.

const listeners = { change: new Set(), pulse: new Set(), sample: new Set(), phase: new Set() };
let current = null;
let ws = null;
let reconnectDelay = 500;

export function on(ev, cb) {
  listeners[ev]?.add(cb);
  return () => listeners[ev]?.delete(cb);
}
function emit(ev, payload) {
  for (const cb of listeners[ev] || []) { try { cb(payload); } catch (e) { console.error(e); } }
}

export function snapshot() { return current; }

export async function connect() {
  // bootstrap over HTTP so we have state before WS handshakes
  try {
    const r = await fetch('/api/state');
    if (r.ok) {
      current = await r.json();
      emit('change', current);
    }
  } catch (e) { /* fine, WS will hello */ }
  openSocket();
}

function openSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.addEventListener('open', () => { reconnectDelay = 500; });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  });
  ws.addEventListener('close', () => {
    setTimeout(openSocket, Math.min(reconnectDelay *= 1.6, 8000));
  });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

function handle(msg) {
  if (msg.type === 'hello') {
    const prevPhase = current?.phase;
    current = msg.state;
    emit('change', current);
    if (current.phase !== prevPhase) emit('phase', current.phase);
  } else if (msg.type === 'patch') {
    if (!current) return;
    const prevPhase = current.phase;
    current = { ...current, ...msg.patch };
    emit('change', msg.patch);
    if (msg.patch.samples) emit('sample', current.samples);
    if (msg.patch.phase && msg.patch.phase !== prevPhase) emit('phase', msg.patch.phase);
  } else if (msg.type === 'pulse') {
    emit('pulse', msg.pulse);
  }
}

export async function uploadSample(blob, mime, duration) {
  const res = await fetch('/api/sample', {
    method: 'POST',
    headers: { 'Content-Type': mime, 'X-Duration': String(duration) },
    body: blob,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return res.json();
}

// State mirror + Supabase wiring.
//
// Design:
// - One `soul` row in Postgres, live-mirrored here via Realtime.
// - A `samples` table, also live-mirrored.
// - Breath/amplitude pulse is computed locally every RAF — no network.
// - Clients join a Realtime presence channel keyed by a random sessionId.
//   The member with the lexicographically smallest id is the "leader" and
//   is the only one running evolution + writing state. If they leave,
//   presence sync elects another within ~2s. When the site is empty,
//   the instrument sleeps. When someone returns, evolution catches up.

import { supabase, publicUrl } from './supa.js';
import { tickEvolution, computePulse, createInitialState, sampleLife, SAMPLE_LIFESPAN_MS } from './soul/evolve.js';

const PRESENCE_CHANNEL = 'living:presence';
const SOUL_CHANNEL     = 'living:soul';
const TICK_MS          = 500;
const PERSIST_MIN_MS   = 1200;   // soonest we'll write to DB after a change
const PERSIST_MAX_MS   = 15000;  // latest we'll sit on a change
const CULL_INTERVAL_MS = 60_000; // how often the leader prunes dead samples

const sessionId = crypto.randomUUID();

const listeners = { change: new Set(), pulse: new Set(), phase: new Set(), sample: new Set() };
function emit(ev, v) { for (const cb of listeners[ev] || []) { try { cb(v); } catch (e) { console.error(e); } } }
export function on(ev, cb) { listeners[ev]?.add(cb); return () => listeners[ev]?.delete(cb); }

let current = null;
let samples = [];
export function snapshot() { return current; }
export function currentSamples() { return samples; }

let isLeader = false;
let leaderCheck = null;
let pendingWrite = null;
let lastPersistAt = 0;
let dirtySince = 0;

// ——— bootstrap ———

export async function connect() {
  // 1. initial soul + samples
  const [{ data: soul, error: se }, { data: sams, error: saErr }] = await Promise.all([
    supabase.from('soul').select('state').eq('id', 1).single(),
    supabase.from('samples').select('*').order('created_at', { ascending: false }).limit(64),
  ]);
  if (se) console.warn('[living] soul fetch', se);
  if (saErr) console.warn('[living] samples fetch', saErr);

  current = normalizeState(soul?.state);
  samples = (sams || []).map(withUrl);
  emit('change', current);
  emit('sample', samples);

  // 2. subscribe to realtime changes
  supabase
    .channel(SOUL_CHANNEL)
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'soul', filter: 'id=eq.1' },
      (payload) => {
        const next = normalizeState(payload.new?.state);
        const prevPhase = current?.phase;
        current = next;
        emit('change', next);
        if (next.phase !== prevPhase) emit('phase', next.phase);
      })
    .subscribe();

  supabase
    .channel('living:samples')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'samples' },
      ({ new: row }) => {
        samples = [withUrl(row), ...samples].slice(0, 64);
        emit('sample', samples);
      })
    .on('postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'samples' },
      ({ old }) => {
        samples = samples.filter(s => s.id !== old.id);
        emit('sample', samples);
      })
    .subscribe();

  // 3. presence — elect a leader
  const presence = supabase.channel(PRESENCE_CHANNEL, { config: { presence: { key: sessionId } } });
  presence
    .on('presence', { event: 'sync' }, () => {
      const state = presence.presenceState();
      const ids = Object.keys(state).sort();
      const shouldLead = ids[0] === sessionId;
      if (shouldLead !== isLeader) {
        isLeader = shouldLead;
        if (isLeader) startLeading();
        else stopLeading();
      }
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await presence.track({ joinedAt: Date.now() });
      }
    });

  // 4. local pulse loop — every RAF is too often for subscribers, throttle to ~60ms
  let lastPulseT = 0;
  const pulseLoop = () => {
    const now = performance.now();
    if (now - lastPulseT > 60) {
      lastPulseT = now;
      emit('pulse', computePulse(current, Date.now()));
    }
    requestAnimationFrame(pulseLoop);
  };
  requestAnimationFrame(pulseLoop);
}

// ——— leader behavior ———

function startLeading() {
  // initialize the state if nobody has yet
  if (!current || !current.version) {
    current = createInitialState(Date.now());
    markDirty();
  }
  leaderCheck = setInterval(leaderTick, TICK_MS);
  // prune dead samples periodically
  leaderCull();
  cullTimer = setInterval(leaderCull, CULL_INTERVAL_MS);
}

function stopLeading() {
  if (leaderCheck) clearInterval(leaderCheck);
  if (cullTimer)   clearInterval(cullTimer);
  leaderCheck = null;
  cullTimer = null;
  if (pendingWrite) { clearTimeout(pendingWrite); pendingWrite = null; }
}

let cullTimer = null;

function leaderTick() {
  if (!isLeader || !current) return;
  const now = Date.now();
  const changed = tickEvolution(current, now);
  if (changed) {
    emit('change', current);
    markDirty();
    maybePersist();
  }
}

function markDirty() { if (!dirtySince) dirtySince = Date.now(); }

function maybePersist() {
  if (!dirtySince) return;
  const now = Date.now();
  const sinceDirty = now - dirtySince;
  const sinceLast  = now - lastPersistAt;
  // persist immediately if stale, else debounce
  if (sinceDirty >= PERSIST_MAX_MS || sinceLast >= PERSIST_MAX_MS) {
    persistNow();
    return;
  }
  if (pendingWrite) return;
  const wait = Math.max(PERSIST_MIN_MS - sinceLast, 200);
  pendingWrite = setTimeout(() => { pendingWrite = null; persistNow(); }, wait);
}

async function persistNow() {
  if (!isLeader || !current) return;
  dirtySince = 0;
  lastPersistAt = Date.now();
  const toWrite = { state: current, leader_id: sessionId, leader_seen: new Date().toISOString() };
  const { error } = await supabase.from('soul').update(toWrite).eq('id', 1);
  if (error) console.warn('[living] soul persist failed', error);
}

async function leaderCull() {
  if (!isLeader) return;
  // fetch all and filter client-side — each sample carries its own lifespan now
  const { data: all, error } = await supabase
    .from('samples')
    .select('id, path, created_at, lifespan_ms');
  if (error) return console.warn('[living] cull query failed', error);
  const now = Date.now();
  const dead = (all || []).filter((s) => {
    const age = now - new Date(s.created_at).getTime();
    const span = Number(s.lifespan_ms) || SAMPLE_LIFESPAN_MS;
    return age > span;
  });
  if (!dead.length) return;
  const ids = dead.map((d) => d.id);
  const paths = dead.map((d) => d.path).filter(Boolean);
  await supabase.from('samples').delete().in('id', ids);
  if (paths.length) await supabase.storage.from('fragments').remove(paths);
}

// ——— uploads ———

// preservation tiers — most fragments live a day, a rare few last a very long time
const HOUR = 3600_000;
const DAY  = 24 * HOUR;
const LIFESPAN_TIERS = [
  { threshold: 0.005, ms: 2 * 365 * DAY, label: 'kept for two years' },
  { threshold: 0.030, ms:     365 * DAY, label: 'kept for a year' },
  { threshold: 0.100, ms:      30 * DAY, label: 'kept for a month' },
  { threshold: 0.250, ms:       7 * DAY, label: 'kept for a week' },
];
function rollLifespan() {
  const r = Math.random();
  for (const t of LIFESPAN_TIERS) if (r < t.threshold) return { ms: t.ms, label: t.label };
  return { ms: SAMPLE_LIFESPAN_MS, label: 'woven in' };
}

export async function uploadSample(blob, mime, duration) {
  const id = crypto.randomUUID();
  // `audio/webm;codecs=opus` → `audio/webm` so it matches the bucket's allowed list
  const baseMime = String(mime || 'audio/webm').split(';')[0].trim().toLowerCase();
  const ext = extFor(baseMime);
  const path = `${id}.${ext}`;
  const { error: upErr } = await supabase.storage.from('fragments').upload(path, blob, {
    contentType: baseMime,
    cacheControl: '31536000',
    upsert: false,
  });
  if (upErr) {
    console.error('[living] storage upload failed', upErr);
    throw new Error(`upload: ${upErr.message || upErr.error || 'unknown'}`);
  }
  const { ms: lifespan_ms, label } = rollLifespan();
  const { data, error } = await supabase
    .from('samples')
    .insert({ path, mime: baseMime, duration, lifespan_ms })
    .select()
    .single();
  if (error) {
    console.error('[living] samples insert failed', error);
    throw new Error(`insert: ${error.message || 'unknown'}`);
  }
  return { ...data, label };
}

// ——— helpers ———

function normalizeState(state) {
  if (!state || typeof state !== 'object' || !state.version) {
    // fall back to a safe default; leader will overwrite on its first tick
    return createInitialState(Date.now());
  }
  return state;
}

function withUrl(row) {
  return { ...row, url: publicUrl(row.path) };
}

function extFor(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg'))  return 'ogg';
  if (m.includes('mp4'))  return 'mp4';
  if (m.includes('mpeg')) return 'mp3';
  if (m.includes('wav'))  return 'wav';
  return 'webm';
}

// legacy-compat shim so audio engine doesn't care where samples came from
export { currentSamples as getSamples };

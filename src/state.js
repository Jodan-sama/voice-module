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
const POOL_TARGET      = 48;     // target size for the local sample pool
const REALTIME_KEEP_P  = 0.8;    // probability a Realtime-arriving sample joins the pool

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

// ——— sample pool construction ———
//
// The pool is built by uniformly sampling non-elder recordings from the last
// 24h, then filling any deficit with random elders. This removes the implicit
// "newest samples dominate" bias and lets older/other-user voices surface
// equally. The pool is refreshed on every 2nd sleep phase (see main.js) and
// slowly rotates as Realtime INSERTs probabilistically replace random slots.

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Track local Blob URLs so we can revoke them when the sample is removed
// from the pool. Keeps memory bounded; only relevant for our own freshly-
// uploaded samples (other clients' samples come in via public URLs).
const localBlobUrls = new Map();

function dropLocalBlob(id) {
  const u = localBlobUrls.get(id);
  if (!u) return;
  try { URL.revokeObjectURL(u); } catch {}
  localBlobUrls.delete(id);
}

// Add a sample row to the local pool, deduplicating by id and keeping the
// pool size capped at POOL_TARGET by replacing a random existing slot once
// the cap is hit. If `localBlob` is provided, we play from a Blob URL
// instead of the public CDN URL — eliminates the brief window after upload
// where Supabase's edge cache hasn't propagated and the public URL would
// 404. Returns true if the pool changed.
function addToPool(row, localBlob = null) {
  if (!row) return false;
  if (samples.some((s) => s.id === row.id)) return false;
  let entry = withUrl(row);
  if (localBlob && typeof URL !== 'undefined' && URL.createObjectURL) {
    try {
      const blobUrl = URL.createObjectURL(localBlob);
      entry = { ...entry, url: blobUrl };
      localBlobUrls.set(row.id, blobUrl);
    } catch (e) { /* fall back to public URL */ }
  }
  if (samples.length >= POOL_TARGET) {
    const idx = (Math.random() * samples.length) | 0;
    const evicted = samples[idx];
    if (evicted) dropLocalBlob(evicted.id);
    samples = samples.map((s, i) => (i === idx ? entry : s));
  } else {
    samples = [entry, ...samples];
  }
  return true;
}

async function fetchSamplePool() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // 1. fresh non-elders from the last 24h — cast a wide net, shuffle locally
  const { data: fresh, error: fErr } = await supabase
    .from('samples')
    .select('*')
    .gte('created_at', cutoff)
    .lte('lifespan_ms', SAMPLE_LIFESPAN_MS)
    .limit(256);
  if (fErr) console.warn('[living] fresh pool fetch failed', fErr);

  const pool = shuffle([...(fresh || [])]).slice(0, POOL_TARGET);

  // 2. fill the deficit with random elders when fresh recordings are sparse
  if (pool.length < POOL_TARGET) {
    const deficit = POOL_TARGET - pool.length;
    const { data: elders, error: eErr } = await supabase
      .from('samples')
      .select('*')
      .gt('lifespan_ms', SAMPLE_LIFESPAN_MS)
      .order('created_at', { ascending: false })
      .limit(deficit * 3);
    if (eErr) console.warn('[living] elder fill fetch failed', eErr);
    const pickedElders = shuffle([...(elders || [])]).slice(0, deficit);
    pool.push(...pickedElders);
  }

  return pool.map(withUrl);
}

export async function refreshSamplePool() {
  try {
    const next = await fetchSamplePool();
    if (!next.length) return;  // don't wipe to empty on a transient failure
    // revoke any local Blob URLs whose samples didn't make it into the new pool
    const keepIds = new Set(next.map((s) => s.id));
    for (const [id] of localBlobUrls) {
      if (!keepIds.has(id)) dropLocalBlob(id);
    }
    samples = next;
    emit('sample', samples);
  } catch (err) {
    console.warn('[living] pool refresh failed', err);
  }
}

// ——— bootstrap ———

export async function connect() {
  // 1. initial soul + sample pool, in parallel
  const [{ data: soul, error: se }, pool] = await Promise.all([
    supabase.from('soul').select('state').eq('id', 1).single(),
    fetchSamplePool(),
  ]);
  if (se) console.warn('[living] soul fetch', se);

  current = normalizeState(soul?.state);
  samples = pool;
  emit('change', current);
  emit('sample', samples);

  // ——— one-time cloud status log, everything a human would want to see to
  // confirm the Supabase side is alive and we're getting real rows back ———
  const elders = samples.filter((s) => Number(s.lifespan_ms) > SAMPLE_LIFESPAN_MS);
  const fresh  = samples.filter((s) => Number(s.lifespan_ms) <= SAMPLE_LIFESPAN_MS);
  const byTier = samples.reduce((acc, s) => {
    const ms = Number(s.lifespan_ms);
    const label =
      ms >= 2 * 365 * 24 * 3600 * 1000 ? '2y' :
      ms >=     365 * 24 * 3600 * 1000 ? '1y' :
      ms >=      30 * 24 * 3600 * 1000 ? '1m' :
      ms >=       7 * 24 * 3600 * 1000 ? '1w' :
      ms >=            24 * 3600 * 1000 ? '1d' : '<1d';
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  console.log('[cloud] supabase connection check', {
    url: import.meta.env.VITE_SUPABASE_URL || '(missing VITE_SUPABASE_URL!)',
    soulRowPresent: !!soul,
    soulError: se?.message || null,
    poolSize: samples.length,
    freshCount: fresh.length,
    elderCount: elders.length,
    tierBreakdown: byTier,
    sampleUrlExample: samples[0]?.url || '(pool is empty)',
    oldestCreatedAt: samples.length ? samples.reduce((a, b) => new Date(a.created_at) < new Date(b.created_at) ? a : b).created_at : null,
    newestCreatedAt: samples.length ? samples.reduce((a, b) => new Date(a.created_at) > new Date(b.created_at) ? a : b).created_at : null,
  });
  if (samples[0]?.url) {
    // kick a HEAD request at the first sample's public URL — if the bucket
    // is misconfigured (not public, wrong policy, expired link), this 404s
    // or 403s and tells us why loads are failing.
    fetch(samples[0].url, { method: 'HEAD' })
      .then((r) => console.log('[cloud] sample URL reachability:', {
        status: r.status, ok: r.ok, contentType: r.headers.get('content-type'), contentLength: r.headers.get('content-length'),
      }))
      .catch((err) => console.warn('[cloud] sample URL HEAD failed:', err));
  }

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
        // the uploader already added their own sample locally in uploadSample();
        // addToPool dedups by id, so that case is a no-op here. remote inserts
        // only slide into the pool with REALTIME_KEEP_P probability so the
        // rotation isn't dominated by whatever was just recorded.
        if (Math.random() > REALTIME_KEEP_P) return;
        if (addToPool(row)) emit('sample', samples);
      })
    .on('postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'samples' },
      ({ old }) => {
        dropLocalBlob(old.id);
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

// When the soul enters 'sleeping' we may reach out to the cloud for an older
// elder fragment that isn't currently in the local pool. Adding it surfaces
// a voice we wouldn't otherwise hear and triggers the mint tint during the
// single breath of silence.
let _summoning = false;
export async function summonElderSample() {
  if (_summoning) return null;
  _summoning = true;
  try {
    const { data, error } = await supabase
      .from('samples')
      .select('*')
      .gt('lifespan_ms', SAMPLE_LIFESPAN_MS)     // only long-tier fragments qualify
      .order('created_at', { ascending: true })  // oldest first — mysterious ghosts
      .limit(24);
    if (error || !data?.length) return null;
    const currentIds = new Set(samples.map((s) => s.id));
    const unseen = data.filter((s) => !currentIds.has(s.id));
    if (!unseen.length) return null;
    const picked = unseen[Math.floor(Math.random() * unseen.length)];
    if (addToPool(picked)) emit('sample', samples);
    return picked;
  } catch (err) {
    console.warn('[living] summon elder failed', err);
    return null;
  } finally {
    _summoning = false;
  }
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
  // ensure the uploader always hears their own voice regardless of the
  // Realtime INSERT's 80% probability filter. pass the local blob so the
  // sample plays from a Blob URL — eliminates the CDN-propagation window
  // where the public URL would 404 right after upload. addToPool dedups
  // by id, so when the Realtime echo arrives it's a no-op.
  if (addToPool(data, blob)) emit('sample', samples);
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

// One-shot migration: copies every row from the SOURCE living-instrument
// project's `soul` + `samples` tables and every file from its `fragments`
// bucket into the DESTINATION INSTRUMENTS project's prefixed `li_*` tables
// and `li-fragments` bucket.
//
// Run with Node 18+ from the repo root:
//   npm i @supabase/supabase-js      # (already a project dep)
//   node migrate.mjs
//
// Idempotent. Reruns upsert rows and skip already-uploaded files.

import { createClient } from '@supabase/supabase-js';

// ---------- credentials (anon publishable keys; safe to commit) ----------

const SRC_URL = 'https://fhdyvzxoosydpiytnqgo.supabase.co';
const SRC_KEY = 'sb_publishable_Rr4fg0keYyphcsDgg1RGkg_i-zqSZFf';

const DST_URL = 'https://lueovxcoqrkjdjxfvwng.supabase.co';
const DST_KEY = 'sb_publishable__lKNH5ui_nFn57fiAx2VDg_0yShDBro';

const SRC_BUCKET = 'fragments';
const DST_BUCKET = 'li-fragments';

const SRC = createClient(SRC_URL, SRC_KEY);
const DST = createClient(DST_URL, DST_KEY);

// ---------- soul (single row) ----------

async function migrateSoul() {
  const { data, error } = await SRC.from('soul').select('*');
  if (error) throw new Error(`soul read: ${error.message}`);
  console.log(`[soul] source rows: ${data.length}`);
  let ok = 0;
  for (const row of data) {
    const { error: uErr } = await DST.from('li_soul').upsert(row);
    if (uErr) {
      console.error(`[soul] upsert failed id=${row.id}: ${uErr.message}`);
    } else {
      console.log(`[soul] upserted id=${row.id}`);
      ok++;
    }
  }
  console.log(`[soul] done, ${ok}/${data.length}`);
}

// ---------- samples (paginated, 1000-row chunks) ----------

async function migrateSamples() {
  let total = 0;
  let lastId = null;
  const PAGE = 1000;
  while (true) {
    let q = SRC.from('samples').select('*').order('id').limit(PAGE);
    if (lastId) q = q.gt('id', lastId);
    const { data, error } = await q;
    if (error) throw new Error(`samples read: ${error.message}`);
    if (!data.length) break;
    const { error: uErr } = await DST.from('li_samples').upsert(data);
    if (uErr) {
      console.error('[samples] upsert batch failed:', uErr.message);
      break;
    }
    total += data.length;
    lastId = data[data.length - 1].id;
    console.log(`[samples] inserted ${total} (cursor ${lastId})`);
    if (data.length < PAGE) break;
  }
  console.log(`[samples] done, total ${total}`);
}

// ---------- storage (recursive walk, parallel-safe sequential copy) ----------

async function listAllFiles(bucket, prefix = '') {
  const out = [];
  let offset = 0;
  const LIMIT = 1000;
  while (true) {
    const { data, error } = await SRC.storage.from(bucket).list(prefix, {
      limit: LIMIT,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(`storage list "${prefix}": ${error.message}`);
    if (!data || !data.length) break;
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // folders have no `id` and no `metadata`
      if (!entry.id && !entry.metadata) {
        const nested = await listAllFiles(bucket, path);
        out.push(...nested);
      } else {
        out.push({ path, size: entry.metadata?.size });
      }
    }
    if (data.length < LIMIT) break;
    offset += LIMIT;
  }
  return out;
}

async function migrateStorage() {
  console.log(`[storage] listing source bucket "${SRC_BUCKET}"…`);
  const files = await listAllFiles(SRC_BUCKET);
  console.log(`[storage] ${files.length} files to migrate`);
  let copied = 0, skipped = 0, failed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      const { data: blob, error: dErr } = await SRC.storage.from(SRC_BUCKET).download(f.path);
      if (dErr) {
        console.warn(`[storage] download fail ${f.path}: ${dErr.message}`);
        failed++;
        continue;
      }
      const contentType = blob.type || 'application/octet-stream';
      const { error: uErr } = await DST.storage.from(DST_BUCKET).upload(f.path, blob, {
        contentType,
        cacheControl: '31536000',
        upsert: false,
      });
      if (uErr) {
        const msg = uErr.message || '';
        if (/duplicate|already exists/i.test(msg) || String(uErr.statusCode) === '409') {
          skipped++;
        } else {
          console.warn(`[storage] upload fail ${f.path}: ${msg}`);
          failed++;
        }
      } else {
        copied++;
      }
    } catch (e) {
      console.warn(`[storage] error ${f.path}: ${e.message}`);
      failed++;
    }
    if ((i + 1) % 10 === 0 || i === files.length - 1) {
      console.log(`[storage] ${i + 1}/${files.length}: copied=${copied} skipped=${skipped} failed=${failed}`);
    }
  }
  console.log(`[storage] done: copied=${copied} skipped=${skipped} failed=${failed}`);
}

// ---------- run ----------

console.log('=== living-instrument migration ===');
console.log(`source: ${SRC_URL}`);
console.log(`dest:   ${DST_URL}`);
console.log('');

await migrateSoul();
console.log('');
await migrateSamples();
console.log('');
await migrateStorage();
console.log('');
console.log('=== done ===');

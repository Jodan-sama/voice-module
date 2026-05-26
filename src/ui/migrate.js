// One-shot migrator: converts every non-WAV sample in the bucket to 22 kHz mono
// WAV with a proper duration header, updates the DB row, and deletes the old
// file. Idempotent — rows already stored as audio/wav with a .wav path are
// skipped.
//
// Intended to be run manually from the browser DevTools console:
//
//   await __migrateSamples();                     // convert everything
//   await __migrateSamples({ dryRun: true });     // only report, no writes
//   await __migrateSamples({ concurrency: 3 });   // parallelism knob
//
// Safe to re-run. The live instrument keeps working while the migration is
// running; Realtime INSERT for newly uploaded WAVs updates every open tab.

import { supabase, BUCKET, SAMPLES_TABLE } from '../supa.js';
import { audioBlobToWav } from '../audio/wav.js';

export async function migrateAllSamples({
  concurrency = 2,
  dryRun = false,
  onProgress = null,
} = {}) {
  const started = performance.now();
  const { data: rows, error } = await supabase
    .from(SAMPLES_TABLE)
    .select('id, path, mime, duration, lifespan_ms, created_at')
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[migrate] list failed', error);
    throw error;
  }
  if (!rows?.length) {
    console.log('[migrate] bucket is empty — nothing to do');
    return { total: 0, converted: 0, skipped: 0, failed: 0 };
  }

  const stats = { total: rows.length, processed: 0, converted: 0, skipped: 0, failed: 0, failures: [] };
  console.log(`[migrate] ${rows.length} rows found, dryRun=${dryRun}, concurrency=${concurrency}`);

  const queue = rows.slice();
  async function worker(id) {
    while (queue.length) {
      const row = queue.shift();
      try {
        const skipReason = alreadyWav(row) ? 'already-wav' : null;
        if (skipReason) {
          stats.skipped++;
          log(`[migrate] (${progressLabel(stats)}) skip ${row.path} — ${skipReason}`);
        } else if (dryRun) {
          log(`[migrate] (${progressLabel(stats)}) would convert ${row.path} (${row.mime})`);
          stats.converted++;  // would-have-converted count, in dryRun
        } else {
          await migrateOne(row);
          stats.converted++;
          log(`[migrate] (${progressLabel(stats)}) converted ${row.path}`);
        }
      } catch (err) {
        stats.failed++;
        stats.failures.push({ id: row.id, path: row.path, error: String(err?.message || err) });
        console.warn(`[migrate] (${progressLabel(stats)}) FAILED ${row.path}:`, err);
      }
      stats.processed++;
      onProgress?.(stats);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  const elapsed = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`[migrate] done in ${elapsed}s`, {
    total: stats.total,
    converted: stats.converted,
    skipped: stats.skipped,
    failed: stats.failed,
  });
  if (stats.failed) console.log('[migrate] failures:', stats.failures);
  return stats;
}

function alreadyWav(row) {
  const mime = (row.mime || '').toLowerCase();
  const path = (row.path || '').toLowerCase();
  return mime === 'audio/wav' || mime === 'audio/x-wav' || path.endsWith('.wav');
}

function progressLabel(stats) {
  return `${stats.processed + 1}/${stats.total}`;
}

function log(msg) { console.log(msg); }

async function migrateOne(row) {
  // 1. download the original
  const { data: blob, error: dErr } = await supabase.storage.from(BUCKET).download(row.path);
  if (dErr) throw new Error(`download: ${dErr.message}`);
  if (!blob || !blob.size) throw new Error('empty blob');

  // 2. decode + resample + re-encode
  const wav = await audioBlobToWav(blob);
  if (!wav?.blob?.size) throw new Error('encode produced empty blob');

  // 3. upload new WAV
  const base = row.path.replace(/\.[^.]+$/, '');
  const newPath = `${base}.wav`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(newPath, wav.blob, {
    contentType: 'audio/wav',
    cacheControl: '31536000',
    upsert: true,
  });
  if (upErr) throw new Error(`upload: ${upErr.message}`);

  // 4. flip the DB row to the new path
  const { error: updErr } = await supabase.from(SAMPLES_TABLE).update({
    path: newPath,
    mime: 'audio/wav',
    duration: wav.duration,
  }).eq('id', row.id);
  if (updErr) {
    // try to clean up the orphaned upload
    try { await supabase.storage.from(BUCKET).remove([newPath]); } catch {}
    throw new Error(`db update: ${updErr.message}`);
  }

  // 5. delete the original (if paths differ)
  if (newPath !== row.path) {
    const { error: delErr } = await supabase.storage.from(BUCKET).remove([row.path]);
    if (delErr) console.warn(`[migrate] old file delete failed ${row.path}:`, delErr.message);
  }
}

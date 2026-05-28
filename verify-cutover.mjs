// Verify the cutover end-to-end from this environment:
//   1. fetch voices.konpakt.design and confirm the deployed bundle was
//      built against the destination's URL (env vars took effect).
//   2. query the destination's li_soul + li_samples tables with the anon
//      key (RLS + tables work).
//   3. HEAD-check the first sample's public URL (bucket is public and
//      objects are reachable).

import { createClient } from '@supabase/supabase-js';

const SITE = 'https://voices.konpakt.design';
const DST_URL = 'https://lueovxcoqrkjdjxfvwng.supabase.co';
const DST_KEY = 'sb_publishable__lKNH5ui_nFn57fiAx2VDg_0yShDBro';
const OLD_REF = 'fhdyvzxoosydpiytnqgo';
const NEW_REF = 'lueovxcoqrkjdjxfvwng';

console.log('=== cutover verify ===\n');

// ——— 1. live site ———
console.log(`[1] fetching ${SITE} …`);
const indexRes = await fetch(SITE, { redirect: 'follow' });
console.log(`    status: ${indexRes.status} ${indexRes.statusText}`);
if (!indexRes.ok) {
  console.error('    !! site itself returned non-2xx, aborting');
  process.exit(1);
}
const html = await indexRes.text();
// the env vars get baked into the JS bundle. find the bundle, fetch it,
// and look for either URL inside.
const bundleMatch = html.match(/src="(\/assets\/index-[^"]+\.js)"/);
if (!bundleMatch) {
  console.error('    !! could not find /assets/index-*.js in the page');
  process.exit(1);
}
const bundleUrl = SITE + bundleMatch[1];
console.log(`    bundle: ${bundleUrl}`);
const bundleRes = await fetch(bundleUrl);
const bundleJs = await bundleRes.text();
const hasNew = bundleJs.includes(NEW_REF);
const hasOld = bundleJs.includes(OLD_REF);
console.log(`    contains new ref (${NEW_REF}): ${hasNew ? 'YES ✓' : 'NO ✗'}`);
console.log(`    contains old ref (${OLD_REF}): ${hasOld ? 'YES ✗ (stale build!)' : 'NO ✓'}`);
const bundleHasLiTables = bundleJs.includes('li_soul') && bundleJs.includes('li_samples');
console.log(`    references li_soul + li_samples in bundle: ${bundleHasLiTables ? 'YES ✓' : 'NO ✗'}`);

// ——— 2. destination tables ———
console.log(`\n[2] connecting to destination ${DST_URL} …`);
const dst = createClient(DST_URL, DST_KEY);

const { data: soulRow, error: soulErr } = await dst.from('li_soul').select('*').eq('id', 1).single();
if (soulErr) {
  console.error(`    !! li_soul read failed: ${soulErr.message}`);
} else {
  console.log(`    li_soul row id=${soulRow.id}, state.version=${soulRow?.state?.version}, leader_id=${soulRow.leader_id ?? '(none)'}`);
}

const { data: sampleRows, error: sampErr, count: sampCount } = await dst
  .from('li_samples')
  .select('id, path, mime, duration, lifespan_ms, created_at', { count: 'exact' })
  .order('created_at', { ascending: false });
if (sampErr) {
  console.error(`    !! li_samples read failed: ${sampErr.message}`);
} else {
  console.log(`    li_samples count: ${sampCount}`);
  console.log(`    li_samples first 3:`);
  for (const r of (sampleRows || []).slice(0, 3)) {
    console.log(`      - ${r.path}  ${r.mime}  ${r.duration}s  lifespan=${r.lifespan_ms}ms`);
  }
}

// ——— 3. storage object reachability ———
if (sampleRows?.length) {
  const first = sampleRows[0];
  const { data: pubData } = dst.storage.from('li-fragments').getPublicUrl(first.path);
  const pubUrl = pubData.publicUrl;
  console.log(`\n[3] HEAD ${pubUrl}`);
  const head = await fetch(pubUrl, { method: 'HEAD' });
  console.log(`    status:           ${head.status} ${head.statusText}`);
  console.log(`    content-type:     ${head.headers.get('content-type')}`);
  console.log(`    content-length:   ${head.headers.get('content-length')}`);
  console.log(`    reachable:        ${head.ok ? 'YES ✓' : 'NO ✗'}`);
}

console.log('\n=== done ===');

# living instrument

A digital living instrument. It breathes, wakes, plays, dreams. Its soul lives in Supabase — one shared state that every open tab hears in real time.

## What it is

- an arpeggiator at its heart: the key, scale, tempo, pattern, gate, and effect chain all drift on their own timescales
- a subtle background pulse that lives under the arpeggio with its own rhythm
- wake / breathing / sleeping phases that modulate amplitude and sparseness
- voices: any listener can leave a 5-second fragment. it's uploaded to Supabase Storage, chopped client-side, pitched to the current note, and folded back into the weave. fragments fade over ~3 hours and are forgotten
- state lives in a single Postgres row; clients sync via Supabase Realtime
- a minimal 3D stage: a semi-transparent rectangular shell, a ferrofluid blob, a breathing membrane, interior lights

One of the open tabs drives evolution (cheap leader election over a Realtime presence channel). When no one is looking, the instrument sleeps. When someone arrives, it picks up where it left off based on wall-clock time.

## Run locally

```bash
cp .env.example .env.local
# paste your anon key into .env.local
npm install
npm run dev
```

Open http://localhost:5173. Tap anywhere to wake audio. Tap the round button to leave a 5s fragment.

## Deploy

### 1. Supabase (one time)

1. Open Supabase → **SQL Editor → New query**
2. Paste the whole contents of `supabase/migration.sql`
3. Click **Run**

This creates the `soul` row, the `samples` table, the `fragments` Storage bucket, and the RLS policies.

### 2. Vercel

1. Vercel → **Add New → Project → Import** the GitHub repo
2. Framework preset auto-fills to **Vite** — don't change it
3. Expand **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | your project URL, e.g. `https://xxxx.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | anon key from Supabase → Settings → API |

4. Click **Deploy**.

Every push to `main` auto-deploys. No server to run.

## Layout

- `supabase/migration.sql` — schema, RLS, Storage bucket. Paste-and-run.
- `src/supa.js` — Supabase client singleton and `publicUrl()` helper.
- `src/soul/evolve.js` — pure evolution functions (drift, phase transitions, breath pulse). No IO. Portable to a physical-instrument runtime later.
- `src/state.js` — local mirror, Realtime subscription, presence-based leader election, sample upload, and dead-sample culling.
- `src/audio/` — Tone.js arpeggiator, AM pad, low membrane rhythm, shared effect chain, pitched voice-fragment trigger.
- `src/scene/` — three.js stage, noise-displaced ferrofluid (GLSL).
- `src/ui/record.js` — MediaRecorder → Supabase Storage.

## Notes

- Collaborative by default: no login, anyone can write soul updates and upload fragments. Swap RLS policies for something stricter if you want.
- Variable sample lifespans: each recording rolls for a preservation tier — most live ~1 day, but 15% last a week, 7% a month, 2.5% a year, and about 0.5% get kept for two whole years. Long-tier rolls show their label on upload (`kept for a week`, etc.); the default tier just says `woven in`. The leader culls samples once their own lifespan is up (state + storage).
- Safe to open many tabs: presence elects one leader; the rest just listen.

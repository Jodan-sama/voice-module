# living instrument

A digital living instrument. It breathes, wakes, plays, dreams. Its state is a single shared soul — everyone who opens the page hears the same evolving moment.

## What it is

- an arpeggiator at its heart, but the key, scale, tempo, pattern, gate, and effect chain all drift on their own timescales
- a subtle background pulse that lives under the arpeggio with its own rhythm
- wake / breathing / sleeping phases that modulate amplitude and sparseness
- voices: any listener can leave a 5-second fragment. the instrument chops it, pitches it to the current note, and folds it back into the weave. fragments slowly lose life and are forgotten; a pool of ~24 is kept
- state persists to disk and is shared across all connected clients over WebSocket
- a minimal 3D stage: a semi-transparent rectangular shell, ferrofluid blob, a breathing membrane, interior lights

The server is the soul. Clients render and play — nothing authoritative lives in the browser. This separation is intentional: the same soul will drive a physical instrument later.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173. Tap anywhere to wake the audio (browsers require a gesture). Hold the record button (or tap) to leave a fragment.

For production:

```bash
npm run build
npm start   # serves dist/ and the API on :3000
```

State and samples live in `server/data/` (override with `DATA_DIR=…`). Delete it to start fresh.

## Deploy to Fly.io (via GitHub Actions)

The soul is a long-running, stateful process that must keep evolving whether anyone's watching or not, so this is a single always-on Machine with a persistent volume. GitHub Actions handles everything — you never need a local CLI.

One-time setup (all in a browser):

1. **Get a Fly token** — https://fly.io/user/personal_access_tokens → *Create access token* → copy it.
2. **Add it as a repo secret** — GitHub repo → *Settings → Secrets and variables → Actions → New repository secret*. Name: `FLY_API_TOKEN`. Value: the token from step 1.
3. **Run the workflow** — GitHub repo → *Actions* → *deploy* → *Run workflow*. It auto-runs on every push to `main` too.

The workflow (`.github/workflows/deploy.yml`) creates the Fly app and the `living_data` volume on the first run if they don't exist, then `fly deploy`s. Subsequent pushes just redeploy.

Config highlights in `fly.toml`:
- `auto_stop_machines = "off"` and `min_machines_running = 1` — the instrument never sleeps server-side
- `[[mounts]]` attaches `living_data` at `/data`; the server writes `state.json` and `samples/*` there via `DATA_DIR=/data`
- health check hits `/api/state`
- WebSocket on `/ws` works through Fly's proxy with no extra config

If you picked a different app name, update `app = "…"` at the top of `fly.toml`. If you picked a different region, change `primary_region` **and** the `--region` flag when creating the volume.

## Layout

- `server/` — Express + ws. `soul.js` evolves state on timers. `storage.js` persists.
- `src/audio/` — `engine.js` drives Tone.js; `effects.js` rebuilds the effect chain on drift; `samples.js` plays chopped, pitched voice fragments.
- `src/scene/` — `scene.js` sets up three.js; `ferrofluid.js` is the noise-displaced blob.
- `src/ui/record.js` — MediaRecorder → POST `/api/sample`.
- `src/state.js` — bootstraps from `/api/state`, receives `hello` / `patch` / `pulse` over `/ws`.

## Protocol

The server emits three message kinds over `/ws`:

- `hello`  — full soul snapshot on connect
- `patch`  — partial state updates as the soul drifts
- `pulse`  — ~8 Hz heartbeat: `{ breath, amp, phase }` for smooth visual/audio envelope

## Notes

- Never the same twice: patterns are regenerated, keys modulate, effects come and go, and sample decay is randomized.
- No controls beyond recording — the listener doesn't conduct; they contribute.

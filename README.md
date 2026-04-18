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

State and samples live in `server/data/`. Delete it to start fresh.

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

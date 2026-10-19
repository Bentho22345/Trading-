# Mound Lab

Pitching-mechanics analysis from phone video, running privately in your browser. Drop in videos of pitches, get a biomechanics breakdown with a confidence level on every number, and compare two pitches phase by phase to see what changed, why it matters and how to fix it.

> Mound Lab gives 2D video estimates for training and education. It is not a medical device and does not diagnose injuries.

## Run it

```bash
cd mound-lab
npm install        # also downloads the pose models and copies the MediaPipe WASM into public/
npm run dev        # http://localhost:5173
npm run build && npx vite preview   # production build with the offline service worker
```

The first screen loads a synthetic demo pitcher ("good day" vs "off day") so the comparison works before you film anything.

## Test it

```bash
npm test            # Vitest: synthetic-pitcher regression suite (events, metrics, comparison, sync, filters)
npm run e2e         # Playwright: drag-and-drop, frame stepping, event editing, demo compare (desktop + 390 px phone)
PERSON_CLIP=/path/to/video-of-a-person.mp4 npx playwright test -g "real pose model"   # optional real pose run
npm run ci          # typecheck + unit + build + e2e
```

Playwright uses the Chromium at `/opt/pw-browsers/chromium`. Override it with `PW_CHROMIUM=/path/to/chrome`.

## Where things are

- `PLAN.md` — architecture, the decisions made, and status per milestone (including what isn't built yet)
- `VALIDATION.md` — what has been measured, how, and what hasn't
- `src/core/` — the analysis engine (pure TypeScript, unit-tested)
- `src/core/catalog.ts` — every metric's definition, camera-view validity, reference range with source, change threshold and coaching text

## Deploy on Render

Use the standalone **`mound-lab`** branch: it has this app at the repository root with its own `render.yaml`, so its Blueprint never includes PULSE. In Render: **New → Blueprint**, choose this repository and the `mound-lab` branch. It builds a free static site. No environment secrets are needed: the optional AI coach uses a key each user enters in their own browser.

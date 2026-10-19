# Mound Lab — plan and status

Mound Lab lets a pitcher, coach or parent drag in phone videos of pitches, get a biomechanics breakdown, and compare two pitches phase by phase to see what changed and how to fix it. It runs privately in the browser.

## Decisions I made (and why)

| Question | Decision | Why |
|---|---|---|
| Where does the app live? | `mound-lab/` inside this repository | The repo already holds an unrelated app (PULSE). A self-contained subfolder keeps both intact and is easy to move to its own repo later. |
| Framework | Vite + React 19 + TypeScript (strict), static SPA, hash routing | The brief prefers Vite. Static hosting works offline and needs no server. No server rendering is needed because share links are opt-in cloud only (not built yet). The repo-level `AGENTS.md` note about Next.js applies to PULSE, not this app. |
| State and storage | Zustand for UI state. IndexedDB (Dexie) stores clips, video blobs, pose tracks, JPEG frame caches, athletes, sessions, workload, markers and assignments. | Everything stays local and survives reloads. Analyses are recomputed from the cached raw track, so algorithm upgrades re-run old clips automatically (`ANALYSIS_VERSION`). |
| Pose model | MediaPipe Pose Landmarker (full, plus lite for quick previews), VIDEO mode, in a classic Web Worker. GPU delegate with CPU fallback. Self-hosted `.task` and WASM files. | Apache-2.0. Gives 33 points including heel and toe (needed for foot strike) and world landmarks (used as the "3D estimate"). The `postinstall` script downloads the models and copies the WASM so nothing is hot-linked. RTMPose/MoveNet are not wired in yet (see Gaps). |
| ROI cropping and person lock | MediaPipe VIDEO mode already tracks a region of interest from frame to frame. The worker runs `numPoses: 3` and locks onto the pitcher by bounding-box IoU. The first pick is the largest, most central person, or the person the user taps ("Pick the pitcher…"). | Re-implementing a crop loop on top of MediaPipe's own tracker would duplicate it. Multi-pose plus IoU handles catchers and coaches in frame. |
| Frame extraction | WebCodecs `VideoDecoder` + mp4box.js demuxing (frame-accurate, exact timestamps, rotation-aware, streaming with keyframe-bounded sample extraction). Falls back to `<video>` seeking for WebM or when the codec is unsupported. | As the brief asks. Samples outside the trim are dropped as they stream in, so large files never sit in memory whole. |
| Playback | Analysed clips play from a per-frame JPEG cache (≤720 px) drawn on canvas, with an LRU of decoded bitmaps. | Frame-accurate, instant scrubbing and two-clip sync, without seeking two `<video>` elements on every tick. About 30 KB per frame. |
| Media time vs real time | `realTime = mediaTime / slowmo`. Capture fps comes from the container. After analysis, a sanity check flags likely slow-motion exports (FS→BR > 450 ms). | Slow-motion exports can't be detected reliably from metadata, so the user sets "Clip speed" and the app nudges them when the timing looks implausible. |
| Charts | Hand-written canvas line charts and angle-angle plots | Handles thousands of points, event lines, cursor and click-to-seek, with no dependency. |
| PDF report | Print-optimised report page and the browser's "Save as PDF" | Fully client-side, keeps vector text, no heavy PDF library. |
| Composite video export | `canvas.captureStream` + MediaRecorder over the synced players | Works in every modern browser. ffmpeg.wasm would add about 30 MB. |
| AI coach | Opt-in only. Uses the user's own Anthropic key (stored only in localStorage), the official `@anthropic-ai/sdk` with `dangerouslyAllowBrowser`, streaming, Stop, follow-up chat and youth mode. Default model Claude Opus 5.5 with server-side refusal fallback. Sends numbers, findings, notes and 6 annotated stills — never video. | The brief allows a user-provided key. It needs no server, so the app stays static. A server route can be added later behind the same component. |
| Two-camera 3D | Not built yet. Only the monocular world-landmark separation estimate (`sep3dMax`, Low tier) is computed. | Milestone 14. |

## Architecture

```
src/core/        pure TypeScript, unit-tested, no DOM
  types.ts       joints, PoseTrack, events, Analysis
  signal.ts      Butterworth filtfilt, gap fill, derivatives
  clean.ts       despike, swap correction, filtering, data-driven roles
  body.ts        scale (height px, ground line, rubber) → body-unit series (u forward, v up, in body heights)
  events.ts      FM, PKH, HS, FS, MER, BR, MIR, END (view-aware)
  catalog.ts     metric definitions, views/tiers, references+sources, thresholds, coaching text, causal graph
  metrics.ts     time series + every metric, gated by view, fps and joint confidence
  analyze.ts     pipeline + view classification + fast recompute after event edits
  compare.ts     deltas, noise-aware status, root/symptom ranking, verdict, setup check, group compare
  sync.ts        phase warp, real-time-at-event, DTW
  synthetic.ts   parametric pitcher (good day / off day) for tests and the demo
src/video/       mp4 demux + metadata, WebCodecs/seek frame extraction
src/pose/        worker (MediaPipe + person lock), main-thread pipeline (progress, cancel, JPEG cache)
src/db/          Dexie schema
src/state/       Zustand store (import, analysis queue, demo clips, settings)
src/data/        drills (42), glossary (56), Pitch Smart tables + checks + ACWR
src/ui/          App shell, drop overlay, screens, canvas player, timeline, charts, exports
tests/unit/      Vitest regression suite (synthetic pitcher)
tests/e2e/       Playwright (drag-and-drop, frame stepping, event editing, demo compare, real pose run)
```

## Milestones

| # | Milestone | Status |
|---|---|---|
| 1 | Scaffold, design system, light/dark, routing, IndexedDB, PWA shell, CI script | Done (`npm run ci`) |
| 2 | Drag-and-drop import (anywhere / A / B / multiple / paste / picker / camera), metadata, real fps, VFR, rotation, frame-accurate player, trim, library | Done. Mirror, crop and rotate overrides are not built yet. |
| 3 | Synthetic pitcher + analysis core + comparison engine with tests | Done: events within ±2 frames at 240/120/60 fps, comparison flags exactly the injected changes |
| 4 | Pose pipeline: worker, model caching, person lock, swap fix, filtering, progress/cancel, per-clip cache, skeleton | Done. Verified on a real person clip in headless Chromium (see VALIDATION.md). |
| 5 | Single-pitch breakdown: events + editing, key frames, metric panel with tiers and view gating, charts, sequence proxies, joint drag-correction | Done |
| 6 | Compare (hero): side-by-side + overlay (3 modes), 3 sync modes, shared timeline, difference arrows, readouts, verdict, ranked findings with cues/drills/"show me", causal chain, consistency, full table, setup warnings, group compare, presets | Done |
| 7 | Annotation & measurement tools, calibration, voice-over | Done except voice-over: line, angle, distance (real units from athlete height or a drawn reference such as the rubber), text, freehand; per-frame or persistent |
| 8 | Athletes, sessions, progress, fatigue view, baselines, group compare | Done (basic) |
| 9 | Drill library (42), assignments, arm-care builder | Done |
| 10 | AI coach | Done (user key, client-side) |
| 11 | Exports: PDF (print), composite video, CSV/JSON, backup/restore | Done |
| 12 | Workload & Pitch Smart, ACWR, Pulse CSV import, ball-data CSV import and velocity scatter | Done |
| 13 | Bullpen auto-split, auto-trim, live recording with framing checks | Done. No standalone clip-quality score yet. |
| 14 | Two-camera 3D mode | **Not started** |
| 15 | Coach/team features, cloud sync | Partial: on-device accounts with per-person libraries (v3); no cloud sync |
| 16 | Validation pass, a11y audit, performance tuning | Partial — see VALIDATION.md |

## Version 2 (pitcher identification, far cameras, velocity, better/worse)

| Upgrade | How it works | Tested by |
|---|---|---|
| **Never mistakes a runner (or batter, catcher, coach) for the pitcher** | Pass 1 scans the clip at ~30 fps and tracks *everyone* (`core/people.ts`). Each person is scored on the signature of a pitch: a still set position, ONE sustained knee lift on ONE leg, the fastest arm, and no sustained travel. Runners (fast for >40% of the clip, alternating legs) are labelled and ignored even when bigger or more central. Tracks broken by occlusion are re-joined, and glitchy frames (box-size jumps) are dropped before scoring. The user can switch person in one click (re-uses the scan). | `people.test.ts` (bigger central runner, big still bystander, tiny pitcher); real-model composite clip in VALIDATION.md |
| **Adapts to the pitcher's size (far / center-field cameras)** | Frames decode at up to 1920 px. When people are small, the scan searches a pyramid of zoom tiles (frame-height, ½ and ⅓ height). Measured: MediaPipe's detector needs the person to fill ≥ ~20% of what it sees. Pass 2 runs the pose model on a square crop that follows the pitcher, so it always sees them large. | `people.test.ts` tile-coverage tests; detector size experiment and far-camera clip in VALIDATION.md |
| **Pitch velocity (mph)** | `core/ballspeed.ts`: frame double-differencing isolates the ball after release, and RANSAC fits a constant-velocity straight path, which rejects the decelerating hand. Scale comes from athlete height (default 6′0″ with a wider range). Side view and ≥ 50 fps only; otherwise it says why instead of guessing. Includes a "mark the ball" fallback (two clicks). A radar reading always wins. | `ballspeed.test.ts` (±3% at 120/240 fps, lefty, no-ball, 30 fps); demo clips measured from rendered frames |
| **Says what's better and what's worse** | Each metric has a research direction (`better: up/down/target/none`). Each changed metric is judged better, worse or style, then rolled up into an overall verdict (velocity counts too). | `compare.test.ts` scorecard tests |
| **Five new features** | 1) Clip quality score with advice; 2) drawing & measuring tools with calibration; 3) strobe (multi-exposure) image and A-vs-B key-frame sheet PNG; 4) session consistency report (repeatability per metric, release-point scatter, automatic best pitch); 5) rotate fix and mirror view | unit + e2e |
| **Faster** | Analyses are queued one at a time and start automatically on drop (setting). The scan drops to half rate when only one person is in frame. The pose model sees a 448 px crop instead of the full frame. The AI coach code loads on demand. | — |

## Version 3 (behind views, two pose models, mark-the-pitcher, accounts)

| Upgrade | How it works | Tested by |
|---|---|---|
| **Finds pitchers filmed from behind (center-field cameras)** | MediaPipe's person detector keys on the face, so a pitcher with their back to the camera was often never found. The people scan now uses **MoveNet MultiPose** (TensorFlow.js), which finds every person in one pass from any side. It runs on the whole frame, the zoom tiles for small people, and a zoomed crop around each tracked person. MediaPipe still double-checks the first frames. | Real photos in VALIDATION.md: umpire from behind and a broadcast view (tiny pitcher on the mound). MediaPipe found 0 people in both; MoveNet found all of them. |
| **Two models in the tracking pass** | MediaPipe stays the main tracker (33 points and a 3D estimate). Any frame it misses is filled by **MoveNet Thunder** on the same crop. The scan also checks whether MediaPipe can see each person: if it misses the pitcher on most probe frames (from behind, tiny, blurred), or loses them on more than half of the last 24 frames, MoveNet leads. The 3D estimate is kept only when MediaPipe covered ≥ 90% of frames. | `scan.test.ts` (keypoint mapping, confidence scale); real behind-view clip in VALIDATION.md |
| **Mark the pitcher by hand** | "Mark the pitcher…" lets you drag a box around the pitcher (or tap them) on any frame. If the scan found someone there, that person is chosen without re-scanning. If not, the marked region is **followed**: each frame's pose moves the crop for the next. The choice is saved with the clip. | `scan.test.ts` (tap, box, follow); e2e |
| **Smarter choice between pitch-like people** | Small tie-breakers for the biggest and most central person (the pitcher in broadcast and behind views), on top of the pitch-signature score. Auto-trim keeps ≥ 1 s before the motion and ≥ 3 s in total, and leaves clips alone when motion is everywhere. | `people.test.ts` |
| **Faster** | The scan runs MoveNet once per frame instead of a MediaPipe landmark pass per person. In busy frames only the 4 most likely pitchers are zoomed every sample; the rest are zoomed every third sample. MoveNet runs on WebGL, or **WASM SIMD** when WebGL isn't available in a worker (measured 6.4 s → 0.2 s per frame vs plain JS here). | timings in VALIDATION.md |
| **Sign-in and per-person memory** | A sign-in screen with accounts stored on this device. Each person gets their own library (clips, athletes, sessions, analyses) and settings, and "keep me signed in" remembers them for 30 days. The sign-in screen lists everyone who has signed in on the device. Passwords are kept only as salted PBKDF2-SHA-256 hashes (210k iterations), with back-off after repeated failures. There is guest mode, and an option to move guest clips into a new account. Account settings cover rename, password change, sign out and delete. **No server, so accounts don't sync between devices** (that would need a backend). | `auth.spec.ts` e2e (create, remembered reload, per-person settings, wrong password, switch person, guest) |

## Known gaps and next steps
- Milestone 7 (annotation tools, calibration from known distances, perspective correction, voice-over).
- Milestone 14 (two-camera triangulation; it unlocks true pelvis/trunk rotation, separation and the kinematic sequence).
- A benchmark of MediaPipe vs MoveNet on real labelled pitching clips (both are now used; see Version 3).
- Cross-device accounts (needs a backend; accounts are on-device today).
- Real-clip validation: none of the event or angle accuracy numbers have been measured on real pitchers yet (see VALIDATION.md). Thresholds are literature-based defaults until then.
- A clip-quality score (blur, lighting, pitcher size, camera motion) as a single number.
- Mirror, rotate and crop overrides in the clip header.
- Bundle size: the main chunk is ~730 KB (React, Dexie, mp4box, the analysis core and the demo). The AI coach (Anthropic SDK) loads on demand.

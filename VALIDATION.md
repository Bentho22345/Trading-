# Validation

This file covers what has been measured, how it was measured, and what has not been validated yet. **Mound Lab has not yet been validated on real pitching video with ground truth.** Treat the confidence tiers as literature-based until that is done (see "Not yet validated").

## 1. Synthetic pitcher regression suite (`npm test`, `npm run validate`)

`src/core/synthetic.ts` generates a parametric side-view pitcher with known event times and known angles. It adds Gaussian position noise, dropped low-confidence frames with garbage positions, and left/right arm-label swaps. There are two variants: a **good day** and an **off day** (shorter stride, late arm at foot strike, front knee collapsing, upright trunk at release, glove flying open).

### Unit-test acceptance (default noise 0.15% of height, 4 dropouts, 3 swaps; 240/120/60 fps; RHP and LHP)
- PKH, FS, MER and BR are detected within **±2 frames**. FM is within ±45 ms, HS within ±30 ms, MIR within ±40 ms and END within ±350 ms.
- Roles are found from the motion: throwing arm, lead leg and direction are correct for both RHP and LHP.
- Injected angles are recovered: stride ±0.5% ht, front knee at FS/BR <4°, trunk tilt <3°, forearm angle <6°.
- **The comparison flags exactly the injected changes.** Stride, arm timing, knee block, trunk tilt at release and glove distance come back as changed/big. Eight unchanged metrics come back as steady. Stride, arm timing, knee block and glove are labelled root causes. Extension and front knee at release are labelled symptoms. A clip compared with itself gives no findings.
- Repeat pitches of the same delivery (different noise seeds) are not flagged once the athlete's own variability is used.
- Front-view geometry (arm slot, side bend, stride direction) is checked against a hand-built frame.

### Accuracy sweep (`npm run validate`: 20 pitches per frame rate, higher noise 0.3% of height)

| fps | FM mean / max (ms) | PKH | HS | FS | MER | BR | MIR | END | stride err (% ht) | front knee FS err (°) | trunk BR err (°) | forearm FS err (°) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 240 | 33.8 / 66.7 | 7.3 / 16.7 | 16.7 / 20.8 | 3.5 / 8.3 | 2.1 / 4.2 | 4.2 / 4.2 | 29.2 / 29.2 | 204.4 / 229.2 | 0.5 / 0.9 | 1.4 / 2.7 | 1.1 / 2.2 | 0.8 / 1.9 |
| 120 | 30.8 / 66.7 | 8.3 / 33.3 | 15.8 / 16.7 | 7.1 / 16.7 | 3.8 / 8.3 | 8.3 / 8.3 | 25.0 / 25.0 | 206.3 / 250.0 | 0.5 / 1.1 | 0.9 / 2.4 | 2.0 / 3.4 | 1.0 / 2.4 |
| 60 | 28.3 / 66.7 | 10.0 / 33.3 | 16.7 / 16.7 | 10.8 / 16.7 | 15.0 / 66.7 | 6.7 / 16.7 | 17.5 / 33.3 | 202.5 / 250.0 | 0.7 / 1.4 | 1.0 / 2.3 | 2.7 / 6.4 | 2.1 / 5.6 |
| 30 | 46.7 / 100.0 | 23.3 / 66.7 | 35.0 / 66.7 | 1.7 / 33.3 | 60.0 / 133.3 | 41.7 / 66.7 | 15.0 / 33.3 | 205.0 / 266.7 | 0.6 / 1.5 | 1.3 / 2.6 | 9.2 / 21.6 | 6.9 / 18.0 |

What this shows:
- Release lands exactly one frame off at every frame rate. That is a systematic offset of the peak-wrist-speed rule, which matches the prototype's note that release tends to come out 1–2 frames early. On real clips a ball/hand refinement should replace it.
- At 30 fps, release, layback and the arm angles degrade a lot (forearm angle error up to 18°). This is why arm metrics drop a confidence tier below 100 fps and two tiers below 50 fps, and why the app warns at 30 fps.
- END is defined differently from the generator's keyframe (hips nearly still vs end of the scripted motion), so it is consistently ~200 ms late. It isn't used by any metric.
- These are **upper bounds on accuracy**. Synthetic noise is much kinder than real pose-model error, which includes motion blur on the throwing hand, occlusion and depth ambiguity.

## 2. Real pose model run (`PERSON_CLIP=… npx playwright test -g "real pose model"`)

- Clip: MediaPipe's public test image `pose.jpg` (a person in a lunge) panned into a 2.5 s, 120 fps, 640×428 video and encoded as VP9 in MP4. This is not a pitch. It checks the plumbing, not the biomechanics.
- What it showed: mp4box demux and WebCodecs decode delivered all 300 frames, the worker loaded the self-hosted model and WASM (GPU delegate via WebGL), the person lock held, and the skeleton lined up with the body on the decoded frames. The app correctly warned that there was "no clear leg lift" and that "the throwing hand never moves fast", so it didn't present the numbers as a pitch.
- **Speed in this sandbox: 300 frames in ~215 s** (~1.4 frames/s). The sandbox is headless Chromium with software-rendered WebGL (SwiftShader) and no GPU. That says nothing about speed on a real laptop or phone, and the brief's 20–30 s targets have **not** been verified.
- Bugs found and fixed by this run: (1) MP4s with the index at the end of the file produced zero samples, so samples are now read by offset from the parsed sample table; (2) shared frame sources lost redraw notifications, so the main player stayed black.
- The headless Chromium build here cannot decode H.264. The app now detects that and tells the user how to export a compatible file.

## 3. End-to-end tests (`npm run e2e`, desktop 1440 px and phone 390 px)
- Dropping two MP4s anywhere fills A and B, with 120 and 60 fps read from the container.
- Dropping onto slot B replaces only B.
- Frame stepping (button and ← →) moves exactly one frame.
- Moving foot strike to the current frame updates the stride metric.
- The demo comparison renders its verdict, findings, compare screen and clip screen with no console errors.

## 4. Version 2: pitcher identification, far cameras, velocity

### Picking the pitcher out of a crowd
- **Unit tests (`people.test.ts`)** use synthetic scenes with real motion: the pitcher, a base runner (constant 3.2 body heights/s, alternating knee drive and arm swing), and a person standing still. The pitcher is chosen when the runner is **bigger (520 vs 300 px) and more central**, when a still bystander is **twice the pitcher's size**, and when the pitcher is **70 px tall in a 1080p frame**. Scores separate clearly: pitcher 10.6, still bystander 2.3, runner −3.1.
- **Real pose model, composite clip** (MediaPipe's public test person; a 1.4× copy sweeps across the frame at ~2 body heights/s and passes in front of the static person):
  - the runner was labelled "Runner (ignored)" and the static person tracked;
  - the occlusion split the static person into two tracks in the first version, so stitching was added; they are now one track.
  - Limitation: during a full occlusion by a near-identical person, the scan picked up some false "leg lift / fast arm" readings. It still chose the right person, but the reasons shown were wrong for those frames.

### Far / center-field cameras
- **Detector size experiment** (real model, real frame): the person is ~130 px tall in a 1920×1080 frame and cropped at different zooms. Found when the person filled ≥ 22% of the crop; missed at 12–16%. The tile pyramid (frame-height, ½ and ⅓ height tiles, half-overlapping) follows from this. A unit test checks that every person between 0.2 and 0.5 of a tile's side fits fully inside some tile.
- **Real pose model, far clip**: the person is 13% of a 1920×1080 frame. The first version (single full-frame detection) failed with "No person could be found". The tile pyramid finds them, and the full-rate pass tracks them in a following crop with the skeleton on the body. The player now zooms to small pitchers automatically.

### Velocity
- **Unit tests (`ballspeed.test.ts`)**: synthetic pixels with a textured background, sensor noise, a large decelerating "hand" blob and a ball. Recovered speeds are within 3% at 85 and 72 mph (240 fps) and 60 and 90 mph (120 fps), and for a lefty throwing the other way. With no ball it returns **no number** instead of guessing, and it refuses at 30 fps.
- **Demo clips (rendered frames, real tracker)**: the true speed drawn is 85 / 81 mph; measured 86 / 82 mph (about +1.2%). The bias comes from the height estimate (nose-to-ankle ÷ 0.89).
- **Not yet validated against a radar gun on real pitches.** The quoted ranges combine ±0.5 px centroid error, ±4% depth-plane error and ±2% (height entered) or ±6% (height assumed). Real-world error could be larger with motion blur, a bad camera angle, or a ball lost against a white background. The tool reports "couldn't see the ball" instead of guessing, and "Mark the ball" is the manual fallback.

### Better / worse verdict
- Unit tests: good day vs off day → "A is the better delivery", with all five injected faults listed as "B is worse". Reversed → "B is better". Identical clips → no winner. Style metrics are never called better or worse. Velocity enters the verdict.

## Not yet validated (needed before trusting the tiers)
1. **Event timing on real pitches.** This needs 20+ real clips per view at 120–240 fps, with FS/MER/BR labelled frame by frame by two raters. Report the mean/max error in frames and ms per event and per view.
2. **Angle accuracy on real pitches.** Compare against manual goniometer measurements on key frames by two raters (knee, trunk, elbow, forearm, arm slot, side bend).
3. **Repeatability.** Same pitcher, same setup, 10 fastballs: measure per-metric SD to tune the default "changed" thresholds (currently literature-based).
4. **3D/marker comparison.** OpenBiomechanics (CC BY-NC-SA, non-commercial dev use only) could be rendered to 2D views to test the side/front pipelines against marker truth.
5. **Performance** on a mid-range laptop (WebGPU/WebGL), a recent iPhone and an Android phone, against the 20 s / 45 s targets.
6. **View classification** on real side-open, side-closed, front and back clips.

Until (1)–(3) are done, the High/Medium/Low tiers follow the published single-camera validation (PITCHAI: pelvis/trunk ≈6°, knee ≈9°, throwing arm ≈12°, glove arm ≈14° RMSE) and the camera-plane validity rules, not Mound Lab's own measurements.

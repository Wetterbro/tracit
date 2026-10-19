# Tracit

Trace reference images onto paper or canvas with your phone camera. Tracit tracks your sheet in the live camera feed (markerless, from a photo of the sheet itself) and draws your reference images pinned to it in perspective, so they stay in place on the paper while the phone moves.

**Live app: https://wetterbro.github.io/tracit/**

Open it in Chrome on Android. It's a static site, so nothing is uploaded and all processing happens on your phone. You can install it from Chrome's menu (**Add to Home screen / Install app**), and once it has loaded one time it works offline.

---

## How to use it

1. **Set up the phone.** Mount or hold it above your paper so the sheet fills most of the view. A phone stand, a stack of books or a gooseneck holder all work. Even light without hard shadows helps tracking.
2. **Open Tracit** and allow camera access. The tracking engine (OpenCV.js, about 10 MB) downloads once on the first visit; the progress bar at the top shows the download.
3. **Capture canvas.** Point at the sheet and tap **Capture canvas**. That photo becomes the tracking target. If Tracit says it found few features, see the tips below and recapture.
4. **Add image.** Pick one or more reference images from your gallery.
5. **Place the references** on the captured photo:
   - one finger drags the image you touch,
   - two fingers pinch to scale and twist to rotate the selected image,
   - **Layers** → **Flip** mirrors horizontally, **Rotate 90°** and **Reset size** are there too.
6. **Trace.** Tap **Trace**. Tracit finds the sheet in the live camera image and overlays your references on it. The badge at the top left shows **Tracking** (green), **Weak tracking** (amber) or **Searching…** (red). If tracking is lost, the overlay holds its last position for a second and then fades out until the sheet is found again.
7. **Draw.** Watch the screen and trace the overlay with your pencil.

### Tools

| Tool | What it does |
|---|---|
| **Layers** | List of references (top item is drawn on top): show/hide, move up/down, delete, select. For the selected reference: opacity, **Color / Gray / Edges** display, edge threshold and edge colour, flip, rotate 90°, reset size. |
| **Grid** | Grid attached to the canvas (it moves in perspective with the paper). Set the cell count in **Settings**. |
| **Lock** | Locks placement so your hand touching the screen can't move anything. |
| **Freeze** | Pauses the camera image and the overlay so you can study them. Tap the view (or **Resume**) to continue. |
| **Place / Trace** | Switch between placing on the photo and live tracing. You can also move, scale and rotate references in Trace mode; the gestures are mapped through the live perspective. |
| **Camera switch** (top right) | Cycles through your phone's cameras if Tracit picked the wrong lens. The choice is remembered. |
| **⛶ / ⌄** (top right) | Fullscreen, and hide all controls (the ☰ button brings them back). |
| **Settings** | Grid cells, smoothing (steadier vs. more responsive), tracking resolution (480 px fast / 640 px precise), performance stats, flashlight (if your phone supports it), recapture canvas, clear session. |

The screen stays on while Tracit is open (Screen Wake Lock), and your session (canvas photo, references, positions and settings) is saved automatically on the phone and restored when you reopen the app.

## Tips for good tracking

- **Texture matters most.** Tracking follows visual features of the captured photo. A plain white sheet has almost none. Make a few light pencil marks, scribbles or small crosses spread over the sheet (especially near the edges), or put some textured objects such as tape, a ruler or a patterned cloth around the paper. Then recapture. Your drawing itself adds texture as you go.
- **Fill the view.** Capture with the paper filling most of the frame, from roughly the position you'll trace from.
- **Keep the background still.** The whole captured photo is the target, so anything visible around the paper (the desk) should not move relative to it.
- **Light evenly.** Avoid strong shadows from your hand or the phone and avoid glare on glossy paper. The flashlight (Settings) can help in dim rooms.
- **Recapture if needed.** After big changes (lots of drawing, moved lamp), **Settings → Recapture canvas**. References keep their positions on the sheet.
- **Steady mount.** Tracking handles movement, but a fixed mount gives the calmest overlay. Raise **Smoothing** if the overlay jitters and lower it if it lags behind.
- If the badge stays amber or red, Tracit shows a tip as a reminder of the above.

---

## How it works

```
camera (getUserMedia, rear, 1080p ideal)
   │  <video> shown full screen (native frame rate, never blocked)
   │
   ├─► createImageBitmap(video, resize to 480 px wide) ──► Web Worker
   │                                                     OpenCV.js (WASM)
   │                                                     ├─ ORB detect + match + RANSAC  (every 30 frames / when needed)
   │                                                     └─ LK optical flow + RANSAC    (all other frames)
   │                                         homography ◄┘
   ├─ One Euro filter on the 4 projected canvas corners → smoothed homography
   └─ WebGL2: each reference = quad with a 3×3 projective matrix
      (screen ← frame ← canvas ← reference), perspective-correct texturing,
      colour / gray / Sobel-edge shader, grid shader
```

- **Target:** the captured photo is downscaled to 640 px wide ("canvas space"). ORB keypoints and descriptors (up to 1200) are computed once.
- **Detection:** ORB (700 features) on the 480 px live frame, brute-force Hamming kNN, Lowe ratio test (0.8), `findHomography` with RANSAC (4 px). The result is sanity-checked: convex, not mirrored, in front of the camera, and of plausible size.
- **Tracking between detections:** the RANSAC inliers plus up to 120 Shi-Tomasi corners seeded inside the detected sheet (back-projected to canvas space) are followed with `calcOpticalFlowPyrLK` and a forward-backward consistency check (≤ 1 px). The homography is re-estimated from the surviving correspondences with RANSAC each frame.
- **Re-detection** runs every 30 frames while tracking is good, immediately when flow inliers fall below half of the initial set, and on loss. A successful detection replaces the flow pose, which removes accumulated drift.
- **Smoothing:** a One Euro filter (adaptive low-pass) on the four projected corners, rebuilt into a homography. Filters reset on re-acquisition so the overlay snaps rather than slides.
- **Lost handling:** the last pose is held for 1 s, then the overlay fades out over 0.7 s.

### Code layout

| File | Purpose |
|---|---|
| `index.html`, `css/app.css` | UI markup and styles (portrait bottom bar, landscape side bar, sheets). |
| `js/app.js` | App state, modes (camera / place / trace), gestures → transforms, layers UI, render loop, save/restore. |
| `js/tracker-core.js` | The tracking algorithm (OpenCV.js). Plain script so it runs both in the worker and in Node tests. |
| `js/tracker-worker.js` | Web Worker: downloads OpenCV.js with progress, runs the tracker on frames. |
| `js/tracker-client.js` | Main-thread side: frame pumping (one in flight), smoothing, status, fade. |
| `js/renderer.js` | WebGL2 renderer (projective quads, display-mode shader, grid/outline shader). |
| `js/math.js` | 3×3 matrix helpers, 4-point homography, One Euro filter. |
| `js/camera.js` | Camera start, friendly errors, torch, Screen Wake Lock. |
| `js/gestures.js` | Pointer-event drag / pinch / rotate / tap recognizer. |
| `js/storage.js` | IndexedDB session persistence. |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA: offline caching (app files + OpenCV.js) and install metadata. |

## Tests and measurements

```bash
npm install          # dev dependencies only: OpenCV.js (same build as the CDN) and Playwright
npm test             # math unit tests + tracker test on synthetic warped images
npm run test:e2e     # browser end-to-end test (headless Chromium, fake camera)
```

- `tests/math.test.mjs` checks the 4-point homography, the inverse, and the One Euro filter (jitter suppression and lag).
- `tests/tracker.test.cjs` renders a sketch-covered target, warps it into 90 simulated camera frames along a moving, tilting path with known ground-truth homographies (plus noise and blur), and runs the real tracker. Result: **every frame tracked "good", mean corner error 1.3 px, worst 3.2 px** at 480×360. It also checks that an unrelated image is reported as lost, and shows that a near-blank sheet yields only ~120 keypoints (the reason for the texture tip).
- `tests/e2e/run.cjs` runs the whole app in headless Chromium with a synthetic video as the fake camera: OpenCV loads in the worker, canvas capture, adding a reference, tracking locks to "good", freeze/resume, and session restore after reload.

Measured timings (tracker only):

| Environment | Optical-flow frame | Detection frame | Tracking rate |
|---|---|---|---|
| Node 22 on a desktop-class container CPU (480×360) | ~7.5 ms | ~55 ms | (not frame-limited) |
| Headless Chromium, end-to-end in the app (480 px) | 6–15 ms | 45–70 ms | ~29 fps (the camera's 30 fps) |

These numbers are from a cloud test machine, not a phone. WASM on a mid-range Android phone is typically 2–4× slower, which puts flow frames around 15–30 ms (≈30 fps). Detection frames take longer, but they're rare (every 30 frames) and the camera image never waits for them, so they show up as a brief pause in overlay updates, not as a stutter. Turn on **Settings → Show performance stats** to see the real numbers on your phone. If it's slow, keep the 480 px tracking resolution.

Things tuned for speed: processing at 480 px, a single frame in flight (no queue buildup), off-main-thread resize via `createImageBitmap`, a 15×15 LK window with 2 pyramid levels (about 3× cheaper than 21×21/3 with the same accuracy in the test), at most 160 tracked points, device-pixel ratio capped at 2 for the overlay, and edge/gray effects done in the shader instead of by reprocessing images.

---

## Decisions I made

You asked me to decide things myself, so here is what I chose and why.

1. **OpenCV.js build:** `@techstark/opencv-js@4.10.0-release.1` from jsDelivr. It's the official OpenCV 4.10 WASM build packaged on npm, so it's pinned, CORS-enabled (the service worker can cache it) and identical to the copy the tests use. Its single file (~10 MB) includes ORB, BFMatcher, `calcOpticalFlowPyrLK`, `findHomography` and `goodFeaturesToTrack`. Its ORB binding can't take the score-type constructor argument, so parameters are set with setters.
2. **Worker:** tracking runs in a classic Web Worker. OpenCV is fetched with `fetch()` so the loading bar shows real progress, then evaluated with `importScripts(blob:)`.
3. **Camera choice and resolution:** phones with several rear lenses often hand out an ultra-wide or tele lens for a plain "rear camera" request, so Tracit picks the lowest-numbered back camera (Chrome labels them `camera2 0, facing back`, …), which is the main lens, and offers a switch button for anything else. 1920×1080 "ideal" with continuous autofocus when supported. Higher resolutions don't improve tracking (frames are downscaled to 480 px anyway) and cost bandwidth and battery. The canvas snapshot is stored at full camera resolution so the photo looks sharp in Place mode.
4. **Canvas = the whole captured photo.** I didn't add a step to crop the paper out of the photo, because the area around the paper (desk texture) actually helps tracking, and it keeps the flow to one tap. The grid covers the whole photo for the same reason.
5. **Extra flow points:** besides ORB inliers, Shi-Tomasi corners are seeded inside the detected sheet. ORB inliers alone are often too few and too clustered on a sparse sheet, and LK tracks corners better than ORB keypoints.
6. **Forward-backward LK check** instead of trusting LK's error value. It costs a second LK pass but rejects drifting points reliably.
7. **Smoothing on corners, not matrix entries.** Filtering the four projected corners is geometrically meaningful (pixels on screen), and One Euro keeps fast motion responsive. A **Smoothing** slider maps onto the filter's cutoff.
8. **WebGL2 renderer** with a projective vertex transform (w = homography's third row) for perspective-correct warping of any number of layers at full display resolution. Canvas 2D can't do perspective warps.
9. **Edges = Sobel in a fragment shader** (not Canny). It updates in real time while you drag the threshold and costs nothing per frame. It samples a slightly blurred mip level of large images to ignore photo noise. Edge colour is selectable (black, red, blue, green, white).
10. **Grid** cells are square. The slider sets the number of cells along the canvas's longer side (2–24).
11. **Gestures:** one finger moves only the image you touched (so touching the paper area doesn't shift things by accident). Two fingers act on the selected image wherever you pinch, which makes small images easy to scale. In Trace mode, gestures are mapped through the inverse of the live homography.
12. **Freeze** pauses the `<video>` element (which freezes the last camera frame) and stops tracking, so image and overlay stay together. A short tap resumes, and drags still adjust references while frozen.
13. **Lost tracking:** hold for 1 s, then fade over 0.7 s, as you specified. Filters reset when the sheet is found again.
14. **Storage:** one IndexedDB record (snapshot and reference images as Blobs plus all settings), saved 0.6 s after any change. References are re-decoded on restore. Large references are downscaled to 2048 px for the GPU, and the original file is what gets saved.
15. **Offline:** the service worker precaches the app files and OpenCV.js. App files are served network-first, so updates show up on the next launch while online, and the cache is used offline. OpenCV is cache-first because its URL is versioned.
16. **PWA display:** `fullscreen` with any orientation. Portrait uses a bottom toolbar and bottom sheets. Landscape on phones uses a right-hand toolbar and side panels. All controls can be hidden.
17. **Hosting:** GitHub Pages straight from the `main` branch root (no build step). A `.nojekyll` file keeps Pages from running Jekyll.
18. **No frameworks, no build:** plain ES modules, so the deployed files are the source files.

## Privacy

Everything stays on your device: the camera stream, the photos and your session (in the browser's IndexedDB). The only network request is the one-time download of the app files and OpenCV.js.

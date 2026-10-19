/*
 * Tracker test with synthetic imagery (Node, no browser needed).
 *
 * Builds a textured "canvas" target, warps it into simulated camera frames
 * with known homographies (a smooth hand-held camera path), runs the real
 * tracker core on them, and checks the recovered pose against ground truth by
 * corner reprojection error. Also checks that a frame without the target is
 * reported as lost, and prints per-frame timings.
 *
 * Run: npm test   (needs `npm install` for the OpenCV.js dev dependency)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

globalThis.self = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../js/tracker-core.js'), 'utf8'));
const { TracitTracker } = globalThis;

function loadCv() {
  const cv = require('@techstark/opencv-js');
  // The Emscripten module is a "thenable": resolve a wrapper, not the module
  // itself, or the promise would try to adopt it forever.
  return new Promise(resolve => {
    if (cv.Mat) return resolve({ cv });
    cv.onRuntimeInitialized = () => resolve({ cv });
  });
}

// Deterministic PRNG so the test is reproducible.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/** A paper-like target: light background with sketchy strokes and a few marks. */
function makeTarget(cv, w, h, strokes) {
  const m = new cv.Mat(h, w, cv.CV_8UC4, new cv.Scalar(235, 232, 225, 255));
  for (let i = 0; i < strokes; i++) {
    const c = new cv.Scalar(40 + rnd() * 120, 40 + rnd() * 120, 40 + rnd() * 120, 255);
    const kind = rnd();
    const x = rnd() * w, y = rnd() * h;
    if (kind < 0.4) cv.line(m, new cv.Point(x, y), new cv.Point(x + (rnd() - 0.5) * 120, y + (rnd() - 0.5) * 120), c, 1 + Math.floor(rnd() * 3));
    else if (kind < 0.7) cv.circle(m, new cv.Point(x, y), 4 + rnd() * 30, c, 1 + Math.floor(rnd() * 2));
    else if (kind < 0.85) cv.rectangle(m, new cv.Point(x, y), new cv.Point(x + rnd() * 50, y + rnd() * 50), c, 2);
    else cv.putText(m, String.fromCharCode(65 + Math.floor(rnd() * 26)), new cv.Point(x, y), cv.FONT_HERSHEY_SIMPLEX, 0.6 + rnd(), c, 2);
  }
  return m;
}

/** Ground-truth homography for a camera looking at the target from a moving pose. */
function poseH(t, tw, th, fw, fh) {
  // Map the target into the frame: scale to ~70% of the frame, rotate a bit,
  // translate along a smooth path, add mild perspective (tilt).
  const s = 0.62 * fw / tw * (1 + 0.08 * Math.sin(t * 0.9));
  const a = 0.15 * Math.sin(t * 0.7);
  const cx = fw / 2 + 40 * Math.sin(t * 1.1), cy = fh / 2 + 25 * Math.cos(t * 0.8);
  const px = 0.00025 * Math.sin(t * 0.5), py = 0.0002 * Math.cos(t * 0.6);
  // T(c) * R * S * T(-target centre), then perspective row.
  const cos = Math.cos(a) * s, sin = Math.sin(a) * s;
  const A = [cos, -sin, cx - (cos * tw / 2 - sin * th / 2),
             sin, cos, cy - (sin * tw / 2 + cos * th / 2),
             0, 0, 1];
  // Perspective in target space: P = [1 0 0; 0 1 0; px py 1] around target centre.
  const P = mul(mul([1, 0, tw / 2, 0, 1, th / 2, 0, 0, 1], [1, 0, 0, 0, 1, 0, px, py, 1]), [1, 0, -tw / 2, 0, 1, -th / 2, 0, 0, 1]);
  return mul(A, P);
}

function mul(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return r;
}

function cornerError(Hest, Htrue, w, h) {
  let max = 0;
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const a = TracitTracker.project(Hest, x, y), b = TracitTracker.project(Htrue, x, y);
    max = Math.max(max, Math.hypot(a[0] - b[0], a[1] - b[1]));
  }
  return max;
}

/** Render a camera frame: background clutter + warped target + noise + blur. */
function renderFrame(cv, target, H, fw, fh) {
  const frame = new cv.Mat(fh, fw, cv.CV_8UC4, new cv.Scalar(90, 80, 70, 255));
  // Table texture outside the paper.
  for (let i = 0; i < 40; i++) {
    cv.line(frame, new cv.Point(rnd() * fw, rnd() * fh), new cv.Point(rnd() * fw, rnd() * fh), new cv.Scalar(60 + rnd() * 60, 60, 50, 255), 1);
  }
  const Hm = cv.matFromArray(3, 3, cv.CV_64F, H);
  cv.warpPerspective(target, frame, Hm, new cv.Size(fw, fh), cv.INTER_LINEAR, cv.BORDER_TRANSPARENT);
  Hm.delete();
  // Sensor noise (+-6 levels per channel).
  const d = frame.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 12;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  cv.GaussianBlur(frame, frame, new cv.Size(3, 3), 0.6);
  return { width: fw, height: fh, data: new Uint8ClampedArray(frame.data) , mat: frame };
}

(async () => {
  const { cv } = await loadCv();
  const TW = 640, TH = 480, FW = 480, FH = 360, FRAMES = 90;

  const target = makeTarget(cv, TW, TH, 160);
  const tracker = new TracitTracker(cv);
  const nk = tracker.setTarget({ width: TW, height: TH, data: target.data });
  console.log(`target keypoints: ${nk}`);
  assert(nk > 300, 'expected plenty of target keypoints');

  let worst = 0, sumErr = 0, good = 0;
  const times = { detect: [], flow: [] };
  for (let f = 0; f < FRAMES; f++) {
    const Ht = poseH(f / 30 * 2.0, TW, TH, FW, FH);
    const fr = renderFrame(cv, target, Ht, FW, FH);
    const r = tracker.process(fr); if (process.env.DEBUG) console.log(f, r.mode, r.status, r.inliers, r.ms.toFixed(1));
    fr.mat.delete();
    assert(r.H, `frame ${f}: tracking lost (${r.status})`);
    const e = cornerError(r.H, Ht, TW, TH);
    worst = Math.max(worst, e); sumErr += e;
    if (r.status === 'good') good++;
    times[r.mode === 'detect' ? 'detect' : 'flow'].push(r.ms);
  }
  const avg = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-';
  console.log(`frames: ${FRAMES}, good: ${good}, mean corner err: ${(sumErr / FRAMES).toFixed(2)}px, worst: ${worst.toFixed(2)}px`);
  console.log(`detect frames: ${times.detect.length} avg ${avg(times.detect)} ms | flow frames: ${times.flow.length} avg ${avg(times.flow)} ms (desktop Node, ${FW}x${FH})`);
  assert(worst < 5, `corner error too large: ${worst}`);
  assert(good >= FRAMES * 0.9, 'expected mostly good tracking');
  assert(times.flow.length > times.detect.length, 'optical flow should carry most frames');

  // A frame without the target must be reported as lost.
  tracker.reset();
  const other = makeTarget(cv, FW, FH, 160);
  const r = tracker.process({ width: FW, height: FH, data: other.data });
  console.log(`unrelated frame -> ${r.status} (${r.inliers} inliers)`);
  assert.strictEqual(r.status, 'lost');
  other.delete();

  // A sparse "almost blank sheet" target gives few keypoints (drives the UI tip).
  const blank = makeTarget(cv, TW, TH, 3);
  const t2 = new TracitTracker(cv);
  const nb = t2.setTarget({ width: TW, height: TH, data: blank.data });
  console.log(`near-blank sheet keypoints: ${nb}`);
  blank.delete(); t2.dispose();

  tracker.dispose();
  target.delete();
  console.log('tracker tests passed');
})().catch(e => { console.error(e); process.exit(1); });

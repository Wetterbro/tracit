/*
 * Tracit tracker core.
 *
 * Markerless planar tracking of a captured "canvas" photo in live camera frames,
 * using OpenCV.js:
 *
 *   1. Target: ORB keypoints + descriptors are computed once on the captured
 *      canvas photo (the "target", in canvas-space pixels).
 *   2. Detection: ORB on the live frame, brute-force Hamming kNN matching,
 *      Lowe ratio test, homography via RANSAC (target -> frame).
 *   3. Tracking: between detections, the inlier points (plus extra
 *      Shi-Tomasi corners seeded inside the detected quad and back-projected to
 *      the target) are followed with pyramidal Lucas-Kanade optical flow with a
 *      forward-backward consistency check, and the homography is re-estimated
 *      from the surviving correspondences with RANSAC.
 *   4. Re-detection every N frames, or as soon as flow quality drops.
 *
 * This file is a classic script (no ES module syntax) so it can be loaded with
 * importScripts() inside the Web Worker and with vm/eval in Node tests.
 * It exposes `TracitTracker` on the global object.
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    targetFeatures: 1200,   // ORB features on the (static) target image
    frameFeatures: 700,     // ORB features per live detection frame
    fastThreshold: 12,      // lower than OpenCV's 20 so paper-like images give more keypoints
    ratio: 0.8,             // Lowe ratio test
    ransacDetect: 4.0,      // px, RANSAC reprojection threshold for detection
    ransacFlow: 3.0,        // px, RANSAC threshold for flow-based re-estimation
    minDetectInliers: 12,   // below this a detection is rejected
    goodInliers: 25,        // >= this many inliers = "good"
    redetectEvery: 30,      // frames between forced re-detections (when tracking is good)
    flowMaxPoints: 160,     // cap on tracked points (speed)
    extraCorners: 120,      // Shi-Tomasi corners seeded per detection
    fbMaxError: 1.0,        // px, forward-backward optical-flow error limit
    lkWin: 15,              // LK window (px); 15x15 with 2 pyramid levels is ~3x cheaper than 21/3
    lkLevels: 2,
  };

  class TracitTracker {
    /**
     * @param {object} cv  Initialized OpenCV.js module.
     * @param {object} [opts] Overrides for DEFAULTS.
     */
    constructor(cv, opts) {
      this.cv = cv;
      this.o = Object.assign({}, DEFAULTS, opts || {});
      this.target = null;       // {w, h, kps: Float32Array(x,y,...), desc: cv.Mat, count}
      this.prevGray = null;     // cv.Mat of previous frame (for optical flow)
      this.pts = null;          // Float32Array of tracked frame points (x,y pairs)
      this.tpts = null;         // Float32Array of matching target points
      this.initialCount = 0;
      this.framesSinceDetect = 0;
      this.lastH = null;
      this._makeDetectors();
    }

    _makeDetectors() {
      const cv = this.cv;
      // The OpenCV.js binding can't take the ScoreType constructor argument,
      // so construct with the feature count and use setters for the rest.
      const make = n => {
        const orb = new cv.ORB(n);
        orb.setFastThreshold(this.o.fastThreshold);
        return orb;
      };
      this.orbTarget = make(this.o.targetFeatures);
      this.orbFrame = make(this.o.frameFeatures);
      this.matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
    }

    /** Convert RGBA pixels (ImageData-like) to a new grayscale Mat. */
    _gray(img) {
      const cv = this.cv;
      const rgba = new cv.Mat(img.height, img.width, cv.CV_8UC4);
      rgba.data.set(img.data);
      const gray = new cv.Mat();
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      rgba.delete();
      return gray;
    }

    /**
     * Set the tracking target (the captured canvas photo, already downscaled to
     * canvas-space size). Returns the number of keypoints found.
     */
    setTarget(img) {
      const cv = this.cv;
      this._disposeTarget();
      this.reset();
      const gray = this._gray(img);
      const kps = new cv.KeyPointVector();
      const desc = new cv.Mat();
      const noMask = new cv.Mat();
      this.orbTarget.detectAndCompute(gray, noMask, kps, desc);
      const n = kps.size();
      const pts = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const p = kps.get(i).pt;
        pts[i * 2] = p.x; pts[i * 2 + 1] = p.y;
      }
      kps.delete(); noMask.delete(); gray.delete();
      this.target = { w: img.width, h: img.height, kps: pts, desc, count: n };
      return n;
    }

    /** Forget the current pose so the next frame runs a full detection. */
    reset() {
      if (this.prevGray) { this.prevGray.delete(); this.prevGray = null; }
      this.pts = this.tpts = null;
      this.initialCount = 0;
      this.framesSinceDetect = 0;
      this.lastH = null;
    }

    /**
     * Process one live frame (RGBA ImageData-like at processing resolution).
     * @returns {{H: number[]|null, status: 'good'|'weak'|'lost', inliers: number, mode: string, ms: number}}
     */
    process(img) {
      const t0 = now();
      if (!this.target || this.target.count < 8) {
        return { H: null, status: 'lost', inliers: 0, mode: 'none', ms: now() - t0 };
      }
      const gray = this._gray(img);
      let res = null;
      let mode = 'flow';

      // 1. Cheap path: optical flow from the previous frame.
      if (this.prevGray && this.pts && this.pts.length >= 16) {
        res = this._flow(gray);
      }
      this.framesSinceDetect++;

      // 2. Full detection when flow failed, quality dropped, or it is time to refresh.
      const weakFlow = !res || res.inliers < Math.max(this.o.goodInliers, this.initialCount * 0.5);
      if (weakFlow || this.framesSinceDetect >= this.o.redetectEvery) {
        const det = this._detect(gray);
        // A successful detection is drift-free, so prefer it unless flow is
        // clearly better supported.
        if (det && (!res || det.inliers >= this.o.goodInliers || det.inliers >= res.inliers)) {
          res = det;
          mode = 'detect';
          this.initialCount = det.pts.length / 2;
          this.framesSinceDetect = 0;
        } else if (res) {
          // Detection failed (e.g. motion blur) but flow is fine: retry sooner.
          this.framesSinceDetect = Math.floor(this.o.redetectEvery / 2);
        }
      }

      if (this.prevGray) this.prevGray.delete();
      this.prevGray = gray;

      if (!res) {
        this.pts = this.tpts = null;
        this.lastH = null;
        return { H: null, status: 'lost', inliers: 0, mode, ms: now() - t0 };
      }
      this.pts = res.pts;
      this.tpts = res.tpts;
      this.lastH = res.H;
      const status = res.inliers >= this.o.goodInliers ? 'good' : 'weak';
      return { H: res.H, status, inliers: res.inliers, mode, ms: now() - t0 };
    }

    /** ORB detection + matching + RANSAC homography. */
    _detect(gray) {
      const cv = this.cv;
      const o = this.o;
      const kps = new cv.KeyPointVector();
      const desc = new cv.Mat();
      const noMask = new cv.Mat();
      this.orbFrame.detectAndCompute(gray, noMask, kps, desc);
      noMask.delete();
      if (kps.size() < 8 || desc.rows < 2) { kps.delete(); desc.delete(); return null; }

      const matches = new cv.DMatchVectorVector();
      this.matcher.knnMatch(desc, this.target.desc, matches, 2);
      const src = [], dst = [];
      const tk = this.target.kps;
      for (let i = 0; i < matches.size(); i++) {
        const m = matches.get(i);
        if (m.size() < 2) { m.delete(); continue; }
        const a = m.get(0), b = m.get(1);
        if (a.distance < o.ratio * b.distance) {
          const fp = kps.get(a.queryIdx).pt;
          src.push(tk[a.trainIdx * 2], tk[a.trainIdx * 2 + 1]);
          dst.push(fp.x, fp.y);
        }
        m.delete();
      }
      matches.delete(); kps.delete(); desc.delete();
      if (src.length / 2 < o.minDetectInliers) return null;

      const fit = this._homography(src, dst, o.ransacDetect);
      if (!fit || fit.inliers < o.minDetectInliers) return null;

      // Seed extra, LK-friendly corners inside the detected quad so flow
      // tracking has enough well-spread points even on sparse targets.
      const extra = this._seedCorners(gray, fit.H);
      const pts = concatF32(fit.dst, extra.dst);
      const tpts = concatF32(fit.src, extra.src);
      const capped = capPoints(pts, tpts, o.flowMaxPoints);
      return { H: fit.H, inliers: fit.inliers, pts: capped.pts, tpts: capped.tpts };
    }

    /** Pyramidal LK flow with forward-backward check, then RANSAC homography. */
    _flow(gray) {
      const cv = this.cv;
      const o = this.o;
      const n = this.pts.length / 2;
      const prev = cv.matFromArray(n, 1, cv.CV_32FC2, this.pts);
      const next = new cv.Mat();
      const back = new cv.Mat();
      const st1 = new cv.Mat(), st2 = new cv.Mat();
      const err1 = new cv.Mat(), err2 = new cv.Mat();
      const win = new cv.Size(o.lkWin, o.lkWin);
      const crit = new cv.TermCriteria(cv.TermCriteria_COUNT | cv.TermCriteria_EPS, 20, 0.03);
      cv.calcOpticalFlowPyrLK(this.prevGray, gray, prev, next, st1, err1, win, o.lkLevels, crit);
      cv.calcOpticalFlowPyrLK(gray, this.prevGray, next, back, st2, err2, win, o.lkLevels, crit);
      const pn = next.data32F, pb = back.data32F, p0 = prev.data32F;
      const s1 = st1.data, s2 = st2.data;
      const src = [], dst = [];
      const W = gray.cols, H = gray.rows;
      for (let i = 0; i < n; i++) {
        if (!s1[i] || !s2[i]) continue;
        const dx = pb[i * 2] - p0[i * 2], dy = pb[i * 2 + 1] - p0[i * 2 + 1];
        if (dx * dx + dy * dy > o.fbMaxError * o.fbMaxError) continue;
        const x = pn[i * 2], y = pn[i * 2 + 1];
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        src.push(this.tpts[i * 2], this.tpts[i * 2 + 1]);
        dst.push(x, y);
      }
      prev.delete(); next.delete(); back.delete();
      st1.delete(); st2.delete(); err1.delete(); err2.delete();
      if (src.length / 2 < 8) return null;
      const fit = this._homography(src, dst, o.ransacFlow);
      if (!fit || fit.inliers < 8) return null;
      return { H: fit.H, inliers: fit.inliers, pts: fit.dst, tpts: fit.src };
    }

    /**
     * RANSAC homography target->frame. Returns H (row-major 9 numbers) and the
     * inlier correspondences, or null if the result is degenerate.
     */
    _homography(src, dst, thresh) {
      const cv = this.cv;
      const n = src.length / 2;
      const s = cv.matFromArray(n, 1, cv.CV_32FC2, src);
      const d = cv.matFromArray(n, 1, cv.CV_32FC2, dst);
      const mask = new cv.Mat();
      const Hm = cv.findHomography(s, d, cv.RANSAC, thresh, mask);
      let out = null;
      if (Hm && !Hm.empty()) {
        const H = Array.from(Hm.data64F);
        if (plausible(H, this.target.w, this.target.h)) {
          const m = mask.data;
          const is = [], id = [];
          for (let i = 0; i < n; i++) {
            if (m[i]) { is.push(src[i * 2], src[i * 2 + 1]); id.push(dst[i * 2], dst[i * 2 + 1]); }
          }
          out = { H, inliers: is.length / 2, src: new Float32Array(is), dst: new Float32Array(id) };
        }
      }
      if (Hm) Hm.delete();
      s.delete(); d.delete(); mask.delete();
      return out;
    }

    /** Shi-Tomasi corners inside the projected target quad, back-projected to target space. */
    _seedCorners(gray, H) {
      const cv = this.cv;
      const empty = { src: new Float32Array(0), dst: new Float32Array(0) };
      if (this.o.extraCorners <= 0) return empty;
      const tw = this.target.w, th = this.target.h;
      const quad = [[0, 0], [tw, 0], [tw, th], [0, th]].map(p => project(H, p[0], p[1]));
      const mask = cv.Mat.zeros(gray.rows, gray.cols, cv.CV_8UC1);
      const poly = cv.matFromArray(4, 1, cv.CV_32SC2, [].concat(...quad.map(q => [Math.round(q[0]), Math.round(q[1])])));
      const polys = new cv.MatVector();
      polys.push_back(poly);
      cv.fillPoly(mask, polys, new cv.Scalar(255));
      const corners = new cv.Mat();
      cv.goodFeaturesToTrack(gray, corners, this.o.extraCorners, 0.01, 8, mask, 3, false, 0.04);
      const Hi = invert3(H);
      const src = [], dst = [];
      const c = corners.data32F;
      for (let i = 0; i < corners.rows; i++) {
        const x = c[i * 2], y = c[i * 2 + 1];
        const t = project(Hi, x, y);
        if (t[0] < 0 || t[1] < 0 || t[0] > tw || t[1] > th) continue;
        src.push(t[0], t[1]); dst.push(x, y);
      }
      mask.delete(); poly.delete(); polys.delete(); corners.delete();
      return { src: new Float32Array(src), dst: new Float32Array(dst) };
    }

    _disposeTarget() {
      if (this.target && this.target.desc) this.target.desc.delete();
      this.target = null;
    }

    dispose() {
      this.reset();
      this._disposeTarget();
      for (const k of ['orbTarget', 'orbFrame', 'matcher']) {
        if (this[k]) { this[k].delete(); this[k] = null; }
      }
    }
  }

  // ---- helpers -------------------------------------------------------------

  function now() {
    return (typeof performance !== 'undefined' ? performance : Date).now();
  }

  function project(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  function invert3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    const k = 1 / det;
    return [
      A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
      B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
      C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
    ];
  }

  /**
   * Reject degenerate homographies: the projected target must stay a convex,
   * non-mirrored quad in front of the camera, of sane size.
   */
  function plausible(H, w, h) {
    if (H.some(v => !isFinite(v))) return false;
    const corners = [[0, 0], [w, 0], [w, h], [0, h]];
    for (const [x, y] of corners) {
      if (H[6] * x + H[7] * y + H[8] <= 0) return false; // behind the camera
    }
    const q = corners.map(p => project(H, p[0], p[1]));
    let sign = 0, area = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < 1e-6) return false;
      const s = Math.sign(cross);
      if (sign === 0) sign = s; else if (s !== sign) return false; // not convex
      area += a[0] * b[1] - b[0] * a[1];
    }
    if (sign < 0) return false; // mirrored
    area = Math.abs(area) / 2;
    const ratio = area / (w * h);
    return ratio > 0.005 && ratio < 50;
  }

  function concatF32(a, b) {
    const out = new Float32Array(a.length + b.length);
    out.set(a); out.set(b, a.length);
    return out;
  }

  /** Keep at most `max` correspondences, evenly subsampled. */
  function capPoints(pts, tpts, max) {
    const n = pts.length / 2;
    if (n <= max) return { pts, tpts };
    const p = new Float32Array(max * 2), t = new Float32Array(max * 2);
    for (let i = 0; i < max; i++) {
      const j = Math.floor(i * n / max);
      p[i * 2] = pts[j * 2]; p[i * 2 + 1] = pts[j * 2 + 1];
      t[i * 2] = tpts[j * 2]; t[i * 2 + 1] = tpts[j * 2 + 1];
    }
    return { pts: p, tpts: t };
  }

  TracitTracker.DEFAULTS = DEFAULTS;
  TracitTracker.project = project;
  TracitTracker.plausible = plausible;
  root.TracitTracker = TracitTracker;
})(typeof self !== 'undefined' ? self : globalThis);

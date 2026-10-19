/*
 * Main-thread side of tracking: owns the worker, pumps downscaled camera
 * frames to it (one in flight at a time), smooths the returned homography and
 * manages the good / weak / lost state with a short hold-then-fade when lost.
 */
import { OneEuro, projectRect, rectToQuad } from './math.js';

export const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';

const HOLD_MS = 1000;  // keep the last pose this long after losing the target
const FADE_MS = 700;   // then fade the overlay out over this long

export class TrackerClient extends EventTarget {
  constructor() {
    super();
    this.worker = null;
    this.ready = false;
    this.busy = false;
    this.frameId = 0;
    this.procWidth = 480;           // processing width for live frames
    this.target = null;             // {w, h}
    this.H = null;                  // smoothed homography target -> proc frame
    this.frameSize = null;          // {width, height} of the proc frame H refers to
    this.status = 'lost';
    this.lastGoodAt = 0;
    this.filters = Array.from({ length: 8 }, () => new OneEuro());
    this.setSmoothing(0.5);
    this.stats = { fps: 0, ms: 0, inliers: 0, mode: '-', detectMs: 0, flowMs: 0 };
    this._fpsCount = 0; this._fpsT = performance.now();
    this._grab = null;              // fallback 2D canvas when OffscreenCanvas is missing
  }

  /** Start the worker and download OpenCV.js. Emits 'progress', resolves when ready. */
  init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = new Promise((resolve, reject) => {
      this.worker = new Worker('js/tracker-worker.js');
      this.worker.onmessage = (e) => this._onMessage(e.data, resolve, reject);
      this.worker.onerror = (e) => reject(new Error(e.message || 'Tracking worker failed to start'));
      this.worker.postMessage({ type: 'init', cvUrl: OPENCV_URL });
    });
    return this._initPromise;
  }

  _onMessage(m, resolve, reject) {
    switch (m.type) {
      case 'progress': this._emit('progress', m); break;
      case 'ready': this.ready = true; resolve(); break;
      case 'target':
        this._targetResolve && this._targetResolve(m.keypoints);
        break;
      case 'result': this._onResult(m); break;
      case 'error':
        if (!this.ready) { reject(new Error(m.message)); break; }
        console.warn('tracker error', m);
        this.busy = false;
        break;
    }
  }

  /**
   * Smoothing amount 0..1. Higher = steadier but laggier. Maps onto the One
   * Euro filter's minimum cutoff frequency.
   */
  setSmoothing(v) {
    this.smoothing = v;
    const minCutoff = 3.0 * Math.pow(0.08, v); // v=0 -> 3 Hz, v=1 -> 0.24 Hz
    for (const f of this.filters) { f.minCutoff = minCutoff; f.beta = 0.03; }
  }

  /** Send the canvas photo (RGBA ImageData in canvas space) as tracking target. */
  setTarget(imageData) {
    this.target = { w: imageData.width, h: imageData.height };
    this.H = null;
    this.status = 'lost';
    this._resetFilters();
    return new Promise((resolve) => {
      this._targetResolve = resolve;
      const copy = new Uint8ClampedArray(imageData.data);
      this.worker.postMessage({ type: 'target', width: imageData.width, height: imageData.height, buffer: copy.buffer }, [copy.buffer]);
    });
  }

  reset() {
    if (this.worker) this.worker.postMessage({ type: 'reset' });
    this.H = null;
    this.status = 'lost';
    this._resetFilters();
  }

  _resetFilters() { for (const f of this.filters) f.reset(); }

  /** Called every animation/video frame; sends a new frame if the worker is idle. */
  async pump(video) {
    if (!this.ready || !this.target || this.busy || !video.videoWidth) return;
    this.busy = true;
    const w = this.procWidth;
    const h = Math.round(w * video.videoHeight / video.videoWidth);
    const id = ++this.frameId;
    const t = performance.now();
    try {
      if (typeof OffscreenCanvas !== 'undefined') {
        // Resize happens off the main thread; the worker reads the pixels.
        const bitmap = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
        this.worker.postMessage({ type: 'frame', id, t, bitmap }, [bitmap]);
      } else {
        if (!this._grab) this._grab = document.createElement('canvas');
        const c = this._grab;
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(video, 0, 0, w, h);
        const data = g.getImageData(0, 0, w, h).data;
        this.worker.postMessage({ type: 'frame', id, t, width: w, height: h, buffer: data.buffer }, [data.buffer]);
      }
    } catch (err) {
      this.busy = false;
    }
  }

  _onResult(m) {
    this.busy = false;
    const now = performance.now();
    // Stats
    this._fpsCount++;
    if (now - this._fpsT > 1000) {
      this.stats.fps = this._fpsCount * 1000 / (now - this._fpsT);
      this._fpsCount = 0; this._fpsT = now;
    }
    this.stats.ms = m.ms;
    this.stats.latency = now - m.t;
    this.stats.inliers = m.inliers;
    this.stats.mode = m.mode;
    if (m.mode === 'detect') this.stats.detectMs = m.ms; else if (m.mode === 'flow') this.stats.flowMs = m.ms;

    const prev = this.status;
    if (m.H) {
      // Re-acquired after loss, or the frame size changed (rotation): restart filters
      // so the overlay snaps instead of sliding in from the stale pose.
      const sizeChanged = !this.frameSize || this.frameSize.width !== m.width || this.frameSize.height !== m.height;
      if (prev === 'lost' || sizeChanged) this._resetFilters();
      this.frameSize = { width: m.width, height: m.height };
      const q = projectRect(m.H, this.target.w, this.target.h);
      const ts = m.t / 1000;
      const sq = q.map((v, i) => this.filters[i].filter(v, ts));
      this.H = rectToQuad(this.target.w, this.target.h, sq) || m.H;
      this.status = m.status;
      this.lastGoodAt = now;
    } else {
      this.status = 'lost';
    }
    if (prev !== this.status) this._emit('status', { status: this.status });
  }

  /** Overlay opacity factor 0..1 according to the lost hold/fade timing. */
  visibility(now = performance.now()) {
    if (!this.H) return 0;
    if (this.status !== 'lost') return 1;
    const dt = now - this.lastGoodAt;
    if (dt < HOLD_MS) return 1;
    return Math.max(0, 1 - (dt - HOLD_MS) / FADE_MS);
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

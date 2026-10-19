/*
 * Tracking Web Worker (classic worker script).
 *
 * Loads OpenCV.js (with download progress), then runs TracitTracker on frames
 * posted by the main thread so the UI and the camera preview never block on
 * computer vision work.
 *
 * Messages in:
 *   {type:'init', cvUrl}
 *   {type:'target', width, height, buffer}            RGBA pixels of the canvas photo
 *   {type:'frame', id, t, bitmap, width, height}      ImageBitmap (drawn on an OffscreenCanvas)
 *   {type:'frame', id, t, buffer, width, height}      or raw RGBA pixels
 *   {type:'reset'}
 * Messages out:
 *   {type:'progress', loaded, total}, {type:'ready'}, {type:'error', message}
 *   {type:'target', keypoints}
 *   {type:'result', id, t, H, status, inliers, mode, ms, width, height}
 */
/* global TracitTracker */
'use strict';

importScripts('tracker-core.js');

let cv = null;
let tracker = null;
let canvas = null, ctx = null; // OffscreenCanvas used to read ImageBitmap pixels

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init': await init(msg.cvUrl); break;
      case 'target': {
        const img = { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buffer) };
        const keypoints = tracker.setTarget(img);
        self.postMessage({ type: 'target', keypoints });
        break;
      }
      case 'frame': {
        const img = readFrame(msg);
        const r = tracker.process(img);
        self.postMessage({ type: 'result', id: msg.id, t: msg.t, width: img.width, height: img.height, ...r });
        break;
      }
      case 'reset': if (tracker) tracker.reset(); break;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err), during: msg.type, id: msg.id });
  }
};

function readFrame(msg) {
  if (!msg.bitmap) {
    return { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buffer) };
  }
  const { bitmap } = msg;
  const w = bitmap.width, h = bitmap.height;
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, w, h);
}

/** Download OpenCV.js with progress reporting, evaluate it, wait for the WASM runtime. */
async function init(cvUrl) {
  const res = await fetch(cvUrl);
  if (!res.ok) throw new Error(`OpenCV.js download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 10400000; // ~10 MB when unknown
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0, lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (loaded - lastPost > 200000) {
      lastPost = loaded;
      self.postMessage({ type: 'progress', loaded, total });
    }
  }
  self.postMessage({ type: 'progress', loaded: total, total });
  const url = URL.createObjectURL(new Blob(chunks, { type: 'text/javascript' }));
  importScripts(url); // defines self.cv
  URL.revokeObjectURL(url);
  cv = (await waitForCv(self.cv)).mod;
  tracker = new TracitTracker(cv);
  self.postMessage({ type: 'ready' });
}

/**
 * The Emscripten module is "thenable", so never resolve a promise with it
 * directly (that would recurse forever): resolve a {mod} wrapper instead.
 */
function waitForCv(mod) {
  return new Promise((resolve, reject) => {
    if (!mod) return reject(new Error('OpenCV.js did not load'));
    const done = () => { clearInterval(timer); resolve({ mod }); };
    const timer = setInterval(() => { if (mod.Mat) done(); }, 50);
    if (mod.Mat) return done();
    mod.onRuntimeInitialized = done;
  });
}

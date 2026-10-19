/*
 * Tracit main module: app state, UI wiring, render loop.
 *
 * Coordinate systems
 *   canvas space  pixels of the captured canvas photo downscaled to CANVAS_W
 *                 wide. References are placed here; the tracker's homography
 *                 maps it to the live processing frame.
 *   ref local     pixels of a reference's texture (0..w, 0..h).
 *   frame         pixels of the downscaled live frame sent to the tracker.
 *   screen        CSS pixels of the stage.
 */
import * as M from './math.js';
import { Renderer } from './renderer.js';
import { Gestures } from './gestures.js';
import { TrackerClient } from './tracker-client.js';
import { startCamera, stopCamera, listCameras, pickMainRear, grabFrame, WakeLock, torchSupported, setTorch } from './camera.js';
import { loadSession, saveSession, clearSession, debounce } from './storage.js';

export const APP_VERSION = '3';
const CANVAS_W = 640;           // canvas-space width (= tracking target width)
const MAX_TEX = 2048;           // references are downscaled to fit this
const LOW_FEATURES = 250;       // fewer target keypoints than this -> show texture tip

const $ = (id) => document.getElementById(id);
const video = $('video');

// ---- State ------------------------------------------------------------------

const state = {
  mode: 'camera',               // 'camera' (no snapshot) | 'place' | 'trace'
  snapshot: null,               // {blob, tex, w, h} canvas photo; w,h = canvas-space size
  refs: [],                     // see newRef()
  selectedId: null,
  frozen: false,
  uiHidden: false,
  settings: { grid: false, gridCells: 8, locked: false, smoothing: 0.5, procWidth: 480, showStats: false },
  camera: null,                 // {stream, track}
  targetKeypoints: null,
};

let renderer;
const tracker = new TrackerClient();
const wakeLock = new WakeLock();
let nextId = 1;

// ---- Startup ----------------------------------------------------------------

async function main() {
  try {
    renderer = new Renderer($('gl'));
  } catch (err) {
    return showError('WebGL not available', err.message + ' Tracit needs WebGL2 (Chrome on Android supports it).', false);
  }
  bindUI();
  $('version').textContent = `Version ${APP_VERSION}`;
  onResize();
  window.addEventListener('resize', onResize);
  screen.orientation && screen.orientation.addEventListener && screen.orientation.addEventListener('change', onResize);

  registerServiceWorker();
  loadTracker();             // OpenCV download runs in parallel with the camera prompt
  await restore();
  await openCamera();
  setMode(state.snapshot ? (state.refs.length ? 'trace' : 'place') : 'camera');
  requestAnimationFrame(frame);
  pumpLoop();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  }
}

async function loadTracker() {
  $('loading').hidden = false;
  tracker.addEventListener('progress', (e) => {
    const { loaded, total } = e.detail;
    $('load-progress').value = Math.min(1, loaded / total);
    $('load-text').textContent = `${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`;
  });
  tracker.addEventListener('status', (e) => updateStatus(e.detail.status));
  tracker.procWidth = state.settings.procWidth;
  tracker.setSmoothing(state.settings.smoothing);
  try {
    await tracker.init();
    $('loading').hidden = true;
    if (state.snapshot) await sendTarget();
  } catch (err) {
    $('load-text').textContent = '';
    $('loading').firstElementChild.textContent = 'Could not load the tracking engine. Check your connection and reload. (' + err.message + ')';
  }
}

const CAMERA_KEY = 'tracit.cameraId';

async function openCamera() {
  let saved = null;
  try { saved = localStorage.getItem(CAMERA_KEY); } catch { /* storage blocked */ }
  try {
    state.camera = await startCamera(video, saved || undefined);
    $('torch-row').hidden = !torchSupported(state.camera.track);
    wakeLock.enable();
    return true;
  } catch (err) {
    showError('Camera unavailable', err.message, true);
    return false;
  }
}

/**
 * Cycle to the next camera: rear cameras first (main lens first), then the
 * rest. The choice is remembered on this device.
 */
async function switchCamera() {
  hint('Switching camera…');
  const cams = await listCameras();
  if (cams.length < 2) return hint(`Only ${cams.length} camera found`);
  const main = pickMainRear(cams);
  const isBack = c => /back|rear|environment/i.test(c.label);
  const ordered = [...cams].sort((a, b) => (b === main) - (a === main) || isBack(b) - isBack(a));
  const cur = state.camera ? state.camera.deviceId : null;
  const next = ordered[(ordered.findIndex(c => c.deviceId === cur) + 1) % ordered.length];
  stopCamera(video);
  try {
    state.camera = await startCamera(video, next.deviceId);
    try { localStorage.setItem(CAMERA_KEY, state.camera.deviceId); } catch { /* ignore */ }
    $('torch-row').hidden = !torchSupported(state.camera.track);
    tracker.reset();
    const idx = ordered.findIndex(c => c.deviceId === state.camera.deviceId) + 1;
    hint(`Camera ${idx} of ${ordered.length}: ${next.label || 'camera'}`);
  } catch (err) {
    showError('Camera unavailable', err.message, true);
  }
}

// ---- Session save / restore -------------------------------------------------

const scheduleSave = debounce(save, 600);

async function save() {
  if (!state.snapshot) return;
  try {
    await saveSession({
      v: 1,
      snapshot: state.snapshot.blob,
      canvasW: state.snapshot.w, canvasH: state.snapshot.h,
      refs: state.refs.map(r => ({
        id: r.id, name: r.name, blob: r.blob, x: r.x, y: r.y, scale: r.scale, rotation: r.rotation,
        flipX: r.flipX, opacity: r.opacity, mode: r.mode, threshold: r.threshold, edgeColor: r.edgeColor, visible: r.visible,
      })),
      selectedId: state.selectedId,
      settings: state.settings,
    });
  } catch (err) {
    console.warn('save failed', err);
    hint('Could not save the session (storage full?)');
  }
}

async function restore() {
  const s = await loadSession();
  if (!s || !s.snapshot) return;
  Object.assign(state.settings, s.settings || {});
  try {
    await setSnapshot(s.snapshot, false);
    for (const r of s.refs || []) {
      const ref = await newRef(r.blob, r.name);
      Object.assign(ref, r, { tex: ref.tex, w: ref.w, h: ref.h, thumb: ref.thumb, id: ref.id });
      state.refs.push(ref);
    }
    const sel = (s.refs || []).findIndex(r => r.id === s.selectedId);
    state.selectedId = sel >= 0 ? state.refs[sel].id : (state.refs[0] && state.refs[0].id) || null;
  } catch (err) {
    console.warn('restore failed', err);
  }
  tracker.procWidth = state.settings.procWidth;
  tracker.setSmoothing(state.settings.smoothing);
  syncUI();
}

// ---- Canvas snapshot ---------------------------------------------------------

async function captureCanvas() {
  if (!video.videoWidth) return hint('Camera is not ready yet');
  const full = grabFrame(video);
  const blob = await new Promise(r => full.toBlob(r, 'image/jpeg', 0.9));
  await setSnapshot(blob, true);
  // Keep references where they were relative to the paper.
  setMode('place');
  if (!state.refs.length) hint('Canvas captured. Now add a reference image.');
  scheduleSave();
}

/** Install a canvas photo: texture for place mode + downscaled tracking target. */
async function setSnapshot(blob, fresh) {
  const bmp = await createImageBitmap(blob);
  const w = CANVAS_W, h = Math.round(CANVAS_W * bmp.height / bmp.width);
  if (state.snapshot) renderer.deleteTexture(state.snapshot.tex);
  state.snapshot = { blob, tex: renderer.createTexture(bmp), w, h, bitmap: bmp };
  state.targetKeypoints = null;
  if (tracker.ready) await sendTarget();
  if (fresh) tracker.reset();
}

async function sendTarget() {
  const { bitmap, w, h } = state.snapshot;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, w, h);
  const n = await tracker.setTarget(g.getImageData(0, 0, w, h));
  state.targetKeypoints = n;
  if (n < LOW_FEATURES) {
    showTip(`Only ${n} trackable features found on your canvas. A plain white sheet is hard to track: add a few light pencil marks or scribbles (especially near the edges), or place some textured objects around the paper, then recapture.`);
  }
}

// ---- References -------------------------------------------------------------

/** Create a reference from an image Blob (texture, thumbnail, default placement). */
async function newRef(blob, name) {
  let bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const k = Math.min(1, MAX_TEX / Math.max(bmp.width, bmp.height));
  if (k < 1) {
    const small = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
    bmp.close();
    bmp = small;
  }
  const tex = renderer.createTexture(bmp);
  const cw = state.snapshot ? state.snapshot.w : CANVAS_W, ch = state.snapshot ? state.snapshot.h : CANVAS_W * 0.75;
  const scale = Math.min(cw * 0.7 / bmp.width, ch * 0.7 / bmp.height);
  const thumb = URL.createObjectURL(blob);
  const ref = {
    id: nextId++, name: name || 'Reference', blob, tex, w: bmp.width, h: bmp.height, thumb,
    x: cw / 2, y: ch / 2, scale, rotation: 0, flipX: false,
    opacity: 0.6, mode: 0, threshold: 0.35, edgeColor: [0, 0, 0], visible: true,
  };
  bmp.close();
  return ref;
}

async function addReferences(files) {
  if (!state.snapshot) {
    hint('Capture your canvas first, then add references.');
    return;
  }
  for (const f of files) {
    try {
      const ref = await newRef(f, f.name.replace(/\.[^.]+$/, ''));
      state.refs.push(ref);
      state.selectedId = ref.id;
    } catch (err) {
      hint(`Could not open ${f.name}`);
    }
  }
  if (state.mode === 'camera') setMode('place');
  syncUI();
  scheduleSave();
}

function refTransform(r) {
  return M.mulAll(
    M.translate(r.x, r.y), M.rotate(r.rotation), M.scale(r.scale * (r.flipX ? -1 : 1), r.scale), M.translate(-r.w / 2, -r.h / 2),
  );
}

function selectedRef() { return state.refs.find(r => r.id === state.selectedId) || null; }

function deleteRef(id) {
  const i = state.refs.findIndex(r => r.id === id);
  if (i < 0) return;
  const [r] = state.refs.splice(i, 1);
  renderer.deleteTexture(r.tex);
  URL.revokeObjectURL(r.thumb);
  if (state.selectedId === id) state.selectedId = state.refs.length ? state.refs[Math.min(i, state.refs.length - 1)].id : null;
  syncUI(); scheduleSave();
}

function moveRef(id, dir) {
  const i = state.refs.findIndex(r => r.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= state.refs.length) return;
  [state.refs[i], state.refs[j]] = [state.refs[j], state.refs[i]];
  syncUI(); scheduleSave();
}

// ---- Views ------------------------------------------------------------------

/** canvas space -> screen for the current mode, or null when nothing to draw. */
function viewMatrix() {
  if (!state.snapshot) return null;
  const sw = renderer.cssW, sh = renderer.cssH;
  if (state.mode === 'place') {
    // Fit the snapshot into the area not covered by the top bar and toolbar.
    const pad = 12, top = state.uiHidden ? 0 : 56;
    let availW = sw - pad * 2, availH = sh - pad * 2 - top;
    if (!state.uiHidden) {
      const tb = $('toolbar').getBoundingClientRect();
      if (tb.width > tb.height) availH -= tb.height; else availW -= tb.width;
    }
    const s = Math.min(availW / state.snapshot.w, availH / state.snapshot.h);
    const ox = pad + (availW - state.snapshot.w * s) / 2;
    const oy = top + pad + (availH - state.snapshot.h * s) / 2;
    return [s, 0, ox, 0, s, oy, 0, 0, 1];
  }
  if (state.mode === 'trace' && tracker.H && tracker.frameSize) {
    // Frame px -> screen px, matching the <video>'s object-fit: cover.
    const { width: fw, height: fh } = tracker.frameSize;
    const s = Math.max(sw / fw, sh / fh);
    const D = [s, 0, (sw - fw * s) / 2, 0, s, (sh - fh * s) / 2, 0, 0, 1];
    return M.mul(D, tracker.H);
  }
  return null;
}

function frame(now) {
  requestAnimationFrame(frame);
  const view = viewMatrix();
  let alpha = 1;
  if (state.mode === 'trace') alpha = state.frozen ? 1 : tracker.visibility(now);
  if (state.mode === 'camera' || !view) { renderer.draw(null); return; }
  const layers = state.refs.filter(r => r.visible).map(r => ({
    tex: r.tex, transform: refTransform(r), opacity: r.opacity, mode: r.mode, threshold: r.threshold, edgeColor: r.edgeColor,
  }));
  renderer.draw({
    view,
    alpha,
    background: state.mode === 'place' ? { tex: { ...state.snapshot.tex, w: state.snapshot.w, h: state.snapshot.h } } : null,
    layers,
    grid: state.settings.grid ? { cells: state.settings.gridCells, w: state.snapshot.w, h: state.snapshot.h } : null,
    outline: state.mode === 'place' && !state.settings.locked && selectedRef() ? (() => {
      const r = selectedRef();
      return { transform: refTransform(r), w: r.w, h: r.h };
    })() : null,
  });
  if (state.settings.showStats) updateStats();
}

/** Feed camera frames to the tracker (once per new video frame when supported). */
function pumpLoop() {
  const tick = () => {
    if (state.mode === 'trace' && !state.frozen && state.snapshot) tracker.pump(video);
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  };
  tick();
}

function onResize() {
  const r = $('stage').getBoundingClientRect();
  renderer.resize(r.width, r.height);
}

// ---- Modes ------------------------------------------------------------------

function setMode(mode) {
  if (mode !== 'camera' && !state.snapshot) mode = 'camera';
  state.mode = mode;
  if (state.frozen && mode !== 'trace') setFrozen(false);
  document.body.classList.toggle('place', mode === 'place');
  if (mode === 'trace') {
    tracker.reset();
    if (!tracker.ready) hint('Waiting for the tracking engine to load…');
  }
  updateStatus(mode === 'trace' ? tracker.status : null);
  syncUI();
}

function setFrozen(on) {
  state.frozen = on;
  if (on) video.pause(); else video.play().catch(() => {});
  if (!on) tracker.reset();
  $('frozen').hidden = !on;
  updateStatus(state.mode === 'trace' ? (on ? 'frozen' : tracker.status) : null);
  syncUI();
}

let weakSince = 0;
function updateStatus(s) {
  const el = $('status');
  if (state.mode === 'camera') { el.dataset.s = 'off'; el.textContent = 'Point at your canvas'; return; }
  if (state.mode === 'place') { el.dataset.s = 'off'; el.textContent = 'Placing'; return; }
  if (state.frozen) { el.dataset.s = 'frozen'; el.textContent = 'Frozen'; return; }
  const labels = { good: 'Tracking', weak: 'Weak tracking', lost: 'Searching…' };
  el.dataset.s = s;
  el.textContent = tracker.ready ? labels[s] || s : 'Loading…';
  // Texture tip when tracking stays poor for a while.
  if (s === 'good') weakSince = 0;
  else if (!weakSince) {
    weakSince = performance.now();
    setTimeout(() => {
      if (weakSince && state.mode === 'trace' && tracker.status !== 'good' && performance.now() - weakSince > 2900) {
        showTip('Tracking is weak. Make sure most of the paper is in view and well lit. A plain white sheet has few features: add a few light pencil marks or some texture, then recapture the canvas.');
      }
    }, 3000);
  }
}

function updateStats() {
  const s = tracker.stats;
  $('stats').textContent = `track ${s.fps.toFixed(0)} fps · ${s.ms.toFixed(0)} ms (${s.mode}) · det ${s.detectMs.toFixed(0)} / flow ${s.flowMs.toFixed(0)} ms · ${s.inliers} pts` +
    (state.targetKeypoints != null ? ` · target ${state.targetKeypoints} kp` : '');
}

// ---- Gestures ---------------------------------------------------------------

function screenToCanvas(p) {
  const v = viewMatrix();
  const inv = v && M.invert(v);
  return inv ? M.project(inv, p.x, p.y) : null;
}

function hitTest(p) {
  const c = screenToCanvas(p);
  if (!c) return null;
  for (let i = state.refs.length - 1; i >= 0; i--) {
    const r = state.refs[i];
    if (!r.visible) continue;
    const inv = M.invert(refTransform(r));
    const [u, v] = M.project(inv, c[0], c[1]);
    if (u >= 0 && v >= 0 && u <= r.w && v <= r.h) return r;
  }
  return null;
}

let dragging = null;
function bindGestures() {
  new Gestures($('touch'), {
    begin(p) {
      dragging = null;
      if (state.settings.locked || state.mode === 'camera') return;
      const hit = hitTest(p);
      if (hit) { state.selectedId = hit.id; syncLayerList(); }
      dragging = hit || selectedRef();
      dragging && (dragging._oneFingerOk = !!hit);
    },
    move(prev, cur) {
      if (!dragging || state.settings.locked) return;
      const r = dragging;
      const pc = prev.map(screenToCanvas), cc = cur.map(screenToCanvas);
      if (pc.some(x => !x) || cc.some(x => !x)) return;
      if (cur.length === 1) {
        // One finger only moves a reference that was touched directly.
        if (!r._oneFingerOk) return;
        r.x += cc[0][0] - pc[0][0];
        r.y += cc[0][1] - pc[0][1];
      } else {
        // Two fingers: scale + rotate + translate about the midpoint.
        const [a0, b0] = pc, [a1, b1] = cc;
        const d0 = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]), d1 = Math.hypot(b1[0] - a1[0], b1[1] - a1[1]);
        if (d0 < 1e-3) return;
        const s = d1 / d0;
        const rot = Math.atan2(b1[1] - a1[1], b1[0] - a1[0]) - Math.atan2(b0[1] - a0[1], b0[0] - a0[0]);
        const m0 = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2], m1 = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2];
        const dx = r.x - m0[0], dy = r.y - m0[1];
        const c = Math.cos(rot), sn = Math.sin(rot);
        r.x = m1[0] + s * (c * dx - sn * dy);
        r.y = m1[1] + s * (sn * dx + c * dy);
        r.scale *= s;
        r.rotation += rot;
        r._oneFingerOk = true;
      }
    },
    end() { if (dragging) scheduleSave(); dragging = null; },
    tap() { if (state.frozen) setFrozen(false); },
  });
}

// ---- UI wiring --------------------------------------------------------------

function bindUI() {
  bindGestures();
  $('btn-capture').onclick = captureCanvas;
  $('btn-add').onclick = () => $('file').click();
  $('file').onchange = (e) => { addReferences([...e.target.files]); e.target.value = ''; };
  $('btn-place').onclick = () => setMode('place');
  $('btn-trace').onclick = () => setMode('trace');
  $('btn-layers').onclick = () => toggleSheet('sheet-layers');
  $('btn-settings').onclick = () => toggleSheet('sheet-settings');
  $('btn-grid').onclick = () => { state.settings.grid = !state.settings.grid; syncUI(); scheduleSave(); };
  $('btn-lock').onclick = () => { state.settings.locked = !state.settings.locked; syncUI(); scheduleSave(); hint(state.settings.locked ? 'Placement locked' : 'Placement unlocked'); };
  $('btn-freeze').onclick = () => { if (state.mode !== 'trace') return hint('Freeze works in Trace mode'); setFrozen(!state.frozen); };
  $('btn-hide').onclick = () => setUIHidden(true);
  $('btn-show').onclick = () => setUIHidden(false);
  $('btn-full').onclick = toggleFullscreen;
  $('btn-cam').onclick = switchCamera;
  document.querySelectorAll('.sheet .close').forEach(b => (b.onclick = () => (b.closest('.sheet').hidden = true)));
  $('tip').querySelector('.close').onclick = () => ($('tip').hidden = true);
  $('error-close').onclick = () => ($('error').hidden = true);
  $('error-retry').onclick = async () => { $('error').hidden = true; await openCamera(); };

  // Layer properties
  $('p-opacity').oninput = (e) => editSel(r => (r.opacity = +e.target.value));
  $('p-threshold').oninput = (e) => editSel(r => (r.threshold = +e.target.value));
  $('p-mode').onclick = (e) => { const b = e.target.closest('button'); if (b) editSel(r => (r.mode = +b.dataset.mode)); };
  $('p-edgecolor').onclick = (e) => { const b = e.target.closest('button'); if (b) editSel(r => (r.edgeColor = b.dataset.c.split(',').map(Number))); };
  $('p-flip').onclick = () => editSel(r => (r.flipX = !r.flipX));
  $('p-rot').onclick = () => editSel(r => (r.rotation += Math.PI / 2));
  $('p-fit').onclick = () => editSel(r => {
    const s = state.snapshot;
    r.scale = Math.min(s.w * 0.7 / r.w, s.h * 0.7 / r.h); r.rotation = 0; r.x = s.w / 2; r.y = s.h / 2;
  });

  // Settings
  $('s-cells').oninput = (e) => { state.settings.gridCells = +e.target.value; state.settings.grid = true; syncUI(); scheduleSave(); };
  $('s-smooth').oninput = (e) => { state.settings.smoothing = +e.target.value; tracker.setSmoothing(state.settings.smoothing); syncUI(); scheduleSave(); };
  $('s-proc').onchange = (e) => { state.settings.procWidth = +e.target.value; tracker.procWidth = state.settings.procWidth; tracker.reset(); scheduleSave(); };
  $('s-stats').onchange = (e) => { state.settings.showStats = e.target.checked; syncUI(); scheduleSave(); };
  $('s-torch').onchange = async (e) => {
    try { await setTorch(state.camera.track, e.target.checked); } catch { hint('Flashlight not available'); e.target.checked = false; }
  };
  $('s-recapture').onclick = () => { $('sheet-settings').hidden = true; if (state.frozen) setFrozen(false); setMode('camera'); hint('Point at your canvas and tap “Capture canvas”'); };
  $('s-clear').onclick = async () => {
    if (!confirm('Clear the canvas snapshot and all references?')) return;
    await clearSession();
    location.reload();
  };
}

function editSel(fn) {
  const r = selectedRef();
  if (!r) return;
  fn(r);
  syncUI();
  scheduleSave();
}

function toggleSheet(id) {
  for (const s of document.querySelectorAll('.sheet')) s.hidden = s.id === id ? !s.hidden : true;
  syncUI();
}

function setUIHidden(on) {
  state.uiHidden = on;
  document.body.classList.toggle('ui-hidden', on);
  $('btn-show').hidden = !on;
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => hint('Fullscreen not available'));
}

/** Reflect state in all controls. */
function syncUI() {
  const has = !!state.snapshot;
  document.querySelectorAll('[data-needs="snapshot"]').forEach(b => (b.disabled = !has));
  $('btn-capture').classList.toggle('primary', state.mode === 'camera');
  $('btn-capture').querySelector('span').textContent = has ? 'Recapture' : 'Capture canvas';
  $('btn-capture').hidden = has && state.mode !== 'camera';
  $('btn-place').classList.toggle('on', state.mode === 'place');
  $('btn-trace').classList.toggle('on', state.mode === 'trace');
  $('btn-grid').classList.toggle('on', state.settings.grid);
  $('btn-lock').classList.toggle('on', state.settings.locked);
  $('btn-lock').querySelector('use').setAttribute('href', state.settings.locked ? '#i-lock' : '#i-unlock');
  $('btn-freeze').classList.toggle('on', state.frozen);
  $('btn-freeze').querySelector('use').setAttribute('href', state.frozen ? '#i-play' : '#i-pause');
  $('btn-freeze').querySelector('span').textContent = state.frozen ? 'Resume' : 'Freeze';
  $('btn-layers').classList.toggle('on', !$('sheet-layers').hidden);
  $('btn-settings').classList.toggle('on', !$('sheet-settings').hidden);
  $('stats').hidden = !state.settings.showStats;

  $('s-cells').value = state.settings.gridCells; $('o-cells').textContent = state.settings.gridCells;
  $('s-smooth').value = state.settings.smoothing; $('o-smooth').textContent = Math.round(state.settings.smoothing * 100) + '%';
  $('s-proc').value = String(state.settings.procWidth);
  $('s-stats').checked = state.settings.showStats;
  syncLayerList();
}

function syncLayerList() {
  const list = $('layer-list');
  list.textContent = '';
  $('layers-empty').hidden = state.refs.length > 0;
  // Top-most layer first.
  for (let i = state.refs.length - 1; i >= 0; i--) {
    const r = state.refs[i];
    const li = document.createElement('li');
    li.classList.toggle('sel', r.id === state.selectedId);
    li.innerHTML = `
      <button class="icon-btn vis" aria-label="${r.visible ? 'Hide' : 'Show'}"><svg><use href="#${r.visible ? 'i-eye' : 'i-eyeoff'}"/></svg></button>
      <img alt="">
      <span class="name"></span>
      <button class="icon-btn up" aria-label="Move up" ${i === state.refs.length - 1 ? 'disabled' : ''}><svg><use href="#i-up"/></svg></button>
      <button class="icon-btn down" aria-label="Move down" ${i === 0 ? 'disabled' : ''}><svg><use href="#i-down"/></svg></button>
      <button class="icon-btn del" aria-label="Delete"><svg><use href="#i-trash"/></svg></button>`;
    li.querySelector('img').src = r.thumb;
    li.querySelector('.name').textContent = r.name;
    li.onclick = (e) => {
      const b = e.target.closest('button');
      if (b && b.classList.contains('vis')) { r.visible = !r.visible; scheduleSave(); }
      else if (b && b.classList.contains('up')) return moveRef(r.id, +1);
      else if (b && b.classList.contains('down')) return moveRef(r.id, -1);
      else if (b && b.classList.contains('del')) { if (confirm(`Delete “${r.name}”?`)) deleteRef(r.id); return; }
      state.selectedId = r.id;
      syncUI();
    };
    list.appendChild(li);
  }
  const r = selectedRef();
  $('layer-props').hidden = !r;
  if (r) {
    $('p-opacity').value = r.opacity; $('o-opacity').textContent = Math.round(r.opacity * 100) + '%';
    $('p-threshold').value = r.threshold; $('o-threshold').textContent = r.threshold.toFixed(2);
    $('p-mode').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.mode === r.mode));
    $('edge-opts').hidden = r.mode !== 2;
    $('p-edgecolor').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.c === r.edgeColor.join(',')));
  }
}

// ---- Messages ---------------------------------------------------------------

let hintTimer;
function hint(text) {
  const el = $('hint');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => (el.hidden = true), 3200);
}

function showTip(text) {
  $('tip-text').textContent = text;
  $('tip').hidden = false;
}

function showError(title, text, canRetry) {
  $('error-title').textContent = title;
  $('error-text').textContent = text;
  $('error-retry').hidden = !canRetry;
  $('error').hidden = false;
}

// Expose a little state for debugging/automated tests.
window.tracit = { state, tracker };

main();

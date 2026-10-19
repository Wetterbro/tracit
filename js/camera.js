/*
 * Rear camera access, snapshot capture, torch and screen wake lock.
 */

/**
 * Start a camera. With a deviceId that exact camera is opened; otherwise the
 * rear camera is requested and then, on phones with several rear lenses, the
 * main one is chosen (see pickMainRear). Returns {stream, track, deviceId}.
 */
export async function startCamera(video, deviceId) {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw friendlyError({ name: 'InsecureContext' });
  }
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  const tries = deviceId
    ? [{ deviceId: { exact: deviceId }, ...size }, { facingMode: { ideal: 'environment' }, ...size }]
    : [{ facingMode: { exact: 'environment' }, ...size }, { facingMode: { ideal: 'environment' }, ...size }];
  let stream, lastErr;
  for (const constraints of tries) {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: constraints }); break; }
    catch (err) {
      lastErr = err;
      if (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError') break;
    }
  }
  if (!stream) throw friendlyError(lastErr);
  if (!deviceId) {
    // facingMode alone often lands on an ultra-wide or tele lens on multi-camera
    // phones. Device labels are available now that permission was granted.
    const main = pickMainRear(await listCameras());
    const current = stream.getVideoTracks()[0].getSettings().deviceId;
    if (main && main.deviceId !== current) {
      stream.getTracks().forEach(t => t.stop());
      return startCamera(video, main.deviceId);
    }
  }
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();
  await new Promise(r => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
  const track = stream.getVideoTracks()[0];
  // Continuous autofocus helps when the phone is mounted close to the paper.
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    }
  } catch { /* optional */ }
  return { stream, track, deviceId: track.getSettings().deviceId };
}

/** All video inputs (labels are filled in after camera permission is granted). */
export async function listCameras() {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  } catch { return []; }
}

/**
 * Choose the main rear camera. Chrome on Android labels cameras like
 * "camera2 0, facing back"; the lowest-numbered back camera is the main wide
 * lens, higher numbers are usually ultra-wide, tele or depth sensors.
 */
export function pickMainRear(cams) {
  const back = cams.filter(c => /back|rear|environment|r\u00fcck/i.test(c.label));
  if (!back.length) return null;
  const num = c => { const m = c.label.match(/camera2?\s*(\d+)/i); return m ? +m[1] : 99; };
  return back.slice().sort((a, b) => num(a) - num(b))[0];
}

export function stopCamera(video) {
  const s = video.srcObject;
  if (s) s.getTracks().forEach(t => t.stop());
  video.srcObject = null;
}

export function torchSupported(track) {
  try { return !!(track && track.getCapabilities && track.getCapabilities().torch); } catch { return false; }
}

export async function setTorch(track, on) {
  await track.applyConstraints({ advanced: [{ torch: on }] });
}

/** Grab the current video frame at full resolution into a new canvas. */
export function grabFrame(video) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return c;
}

/** Map getUserMedia errors to clear, actionable messages. */
export function friendlyError(err) {
  const name = err && err.name;
  const messages = {
    NotAllowedError: 'Camera permission was denied. Tap the icon left of the address bar → Permissions → Camera → Allow, then reload Tracit. (If you installed Tracit, long-press its icon → App info → Permissions.)',
    SecurityError: 'Camera access was blocked by the browser. Make sure you opened Tracit over https:// and that camera access is allowed for this site.',
    NotFoundError: 'No camera was found on this device.',
    OverconstrainedError: 'The rear camera could not be opened with the requested settings.',
    NotReadableError: 'The camera is in use by another app (or blocked by the system). Close other camera apps and reload.',
    AbortError: 'The camera could not be started. Please reload and try again.',
    InsecureContext: 'Camera access needs a secure (https://) connection. Open Tracit from its GitHub Pages https:// address.',
  };
  const e = new Error(messages[name] || `Could not start the camera: ${(err && err.message) || name || 'unknown error'}`);
  e.code = name;
  return e;
}

/** Keep the screen awake while tracing; re-acquired when the page becomes visible again. */
export class WakeLock {
  constructor() {
    this.sentinel = null;
    this.wanted = false;
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') this._acquire();
    });
  }
  get supported() { return 'wakeLock' in navigator; }
  async enable() { this.wanted = true; await this._acquire(); }
  async disable() {
    this.wanted = false;
    if (this.sentinel) { try { await this.sentinel.release(); } catch { /* ignore */ } }
    this.sentinel = null;
  }
  async _acquire() {
    if (!this.supported || (this.sentinel && !this.sentinel.released)) return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
    } catch { /* e.g. battery saver; not fatal */ }
  }
}

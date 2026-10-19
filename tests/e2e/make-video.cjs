/*
 * Generates a synthetic camera video (Y4M) for the browser end-to-end test:
 * a sketch-covered sheet of paper on a textured table, filmed by a slowly
 * moving, slightly tilting "hand-held" camera. Chrome plays it through its
 * fake camera device (--use-file-for-fake-video-capture).
 *
 * Usage: node tests/e2e/make-video.cjs out.y4m
 */
'use strict';
const fs = require('fs');
const cv0 = require('@techstark/opencv-js');

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function ready() {
  return new Promise(r => (cv0.Mat ? r({ cv: cv0 }) : (cv0.onRuntimeInitialized = () => r({ cv: cv0 }))));
}

(async () => {
  const { cv } = await ready();
  const out = process.argv[2] || 'fake-camera.y4m';
  const WW = 1200, WH = 900, FW = 640, FH = 480, N = 150;
  // World: wooden-ish table with grain lines, and a sheet with sketch strokes.
  const world = new cv.Mat(WH, WW, cv.CV_8UC4, new cv.Scalar(120, 85, 60, 255));
  for (let i = 0; i < 300; i++) {
    const y = rnd() * WH;
    cv.line(world, new cv.Point(0, y), new cv.Point(WW, y + (rnd() - 0.5) * 60), new cv.Scalar(90 + rnd() * 60, 60 + rnd() * 40, 40, 255), 1 + Math.floor(rnd() * 2));
  }
  const px0 = 250, py0 = 175, pw = 700, ph = 550;
  cv.rectangle(world, new cv.Point(px0, py0), new cv.Point(px0 + pw, py0 + ph), new cv.Scalar(240, 238, 232, 255), -1);
  for (let i = 0; i < 140; i++) {
    const x = px0 + 20 + rnd() * (pw - 40), y = py0 + 20 + rnd() * (ph - 40);
    const c = new cv.Scalar(60 + rnd() * 80, 60 + rnd() * 80, 60 + rnd() * 80, 255);
    const k = rnd();
    if (k < 0.5) cv.line(world, new cv.Point(x, y), new cv.Point(x + (rnd() - 0.5) * 90, y + (rnd() - 0.5) * 90), c, 2);
    else if (k < 0.8) cv.circle(world, new cv.Point(x, y), 5 + rnd() * 25, c, 2);
    else cv.putText(world, String.fromCharCode(65 + Math.floor(rnd() * 26)), new cv.Point(x, y), cv.FONT_HERSHEY_SIMPLEX, 1, c, 2);
  }

  const fd = fs.openSync(out, 'w');
  fs.writeSync(fd, `YUV4MPEG2 W${FW} H${FH} F30:1 Ip A1:1 C420jpeg\n`);
  const frame = new cv.Mat();
  const yuv = new cv.Mat();
  for (let f = 0; f < N; f++) {
    // Camera path: loop-closed (sin/cos of 2*pi*f/N) so the looping video has no jump.
    const t = 2 * Math.PI * f / N;
    const s = 0.62 + 0.04 * Math.sin(t);
    const a = 0.08 * Math.sin(t);
    const cx = WW / 2 + 60 * Math.sin(t), cy = WH / 2 + 40 * Math.cos(t);
    const c = Math.cos(a) * s, sn = Math.sin(a) * s;
    // world -> frame: rotate/scale about the camera centre + slight perspective.
    const A = [c, -sn, FW / 2 - (c * cx - sn * cy), sn, c, FH / 2 - (sn * cx + c * cy), 0.00008 * Math.sin(t), 0.00006 * Math.cos(t), 1];
    const H = cv.matFromArray(3, 3, cv.CV_64F, A);
    cv.warpPerspective(world, frame, H, new cv.Size(FW, FH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(30, 30, 30, 255));
    H.delete();
    cv.cvtColor(frame, yuv, cv.COLOR_RGBA2YUV_I420);
    fs.writeSync(fd, 'FRAME\n');
    fs.writeSync(fd, Buffer.from(yuv.data));
  }
  fs.closeSync(fd);
  console.log(`wrote ${out}: ${N} frames ${FW}x${FH}`);
  process.exit(0);
})();

/* Unit tests for js/math.js (homography helpers and One Euro filter). Run: npm test */
import assert from 'node:assert';
import * as M from '../js/math.js';

const close = (a, b, eps = 1e-6) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);

// A known homography (rotation + scale + translation + perspective).
const Htrue = M.normalize(M.mulAll(
  M.translate(240, 180), M.rotate(0.3), M.scale(0.7),
  [1, 0, 0, 0, 1, 0, 0.0004, -0.0002, 1], M.translate(-320, -240),
));

// homographyFrom4 recovers it exactly from its corner correspondences.
const quad = M.projectRect(Htrue, 640, 480);
const H4 = M.rectToQuad(640, 480, quad);
for (let i = 0; i < 9; i++) close(H4[i], Htrue[i], 1e-6);

// Invert is an inverse.
const I = M.mul(Htrue, M.invert(Htrue));
for (let i = 0; i < 9; i++) close(I[i] / I[8], M.IDENTITY[i], 1e-9);

// Projection round trip.
const [u, v] = M.project(Htrue, 100, 50);
const [x, y] = M.project(M.invert(Htrue), u, v);
close(x, 100, 1e-6); close(y, 50, 1e-6);

// One Euro: removes jitter on a still signal, follows a moving one.
const f = new M.OneEuro(1.0, 0.02);
let out = 0, maxDev = 0;
for (let i = 0; i < 300; i++) {
  out = f.filter(100 + (i % 2 ? 1 : -1), i / 30);
  if (i > 30) maxDev = Math.max(maxDev, Math.abs(out - 100));
}
assert(maxDev < 0.3, `jitter not suppressed: ${maxDev}`);
f.reset();
for (let i = 0; i < 60; i++) out = f.filter(i * 10, i / 30); // 300 px/s ramp
assert(Math.abs(out - 590) < 30, `lag too large: ${out}`);

console.log('math tests passed');

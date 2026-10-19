/*
 * Small 2D projective math helpers.
 * Matrices are row-major arrays of 9 numbers: [a b c; d e f; g h i].
 */

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

/** Multiply any number of matrices left to right: mulAll(A, B, C) = A*B*C. */
export function mulAll(...ms) {
  return ms.reduce((acc, m) => mul(acc, m));
}

export function invert(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
}

export function project(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function translate(tx, ty) { return [1, 0, tx, 0, 1, ty, 0, 0, 1]; }
export function scale(sx, sy = sx) { return [sx, 0, 0, 0, sy, 0, 0, 0, 1]; }
export function rotate(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Normalize so that H[8] == 1 (keeps w positive for points in front). */
export function normalize(H) {
  const k = H[8];
  return H.map(v => v / k);
}

/**
 * Homography mapping 4 source points to 4 destination points
 * (exact solve of the 8x8 DLT system with Gaussian elimination).
 * @param {number[][]} src [[x,y] x4]
 * @param {number[][]} dst [[x,y] x4]
 */
export function homographyFrom4(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Solve A x = b (n x n) with partial pivoting. Returns null if singular. */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Corners of a w x h rectangle projected by H, flattened [x0,y0,...,x3,y3]. */
export function projectRect(H, w, h) {
  return [[0, 0], [w, 0], [w, h], [0, h]].flatMap(([x, y]) => project(H, x, y));
}

/** Inverse of projectRect: homography from the w x h rectangle to 4 corners. */
export function rectToQuad(w, h, q) {
  return homographyFrom4(
    [[0, 0], [w, 0], [w, h], [0, h]],
    [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]],
  );
}

/**
 * One Euro filter (Casiez et al. 2012): a low-pass filter whose cutoff rises
 * with speed, so slow jitter is removed while fast motion stays responsive.
 */
export class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  /** @param {number} x value  @param {number} t time in seconds */
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

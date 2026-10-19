/*
 * WebGL2 overlay renderer.
 *
 * Every drawable is a textured quad whose corners are mapped by a full 3x3
 * projective matrix (local pixels -> clip space). The matrix's third row
 * becomes gl_Position.w, so texture interpolation is perspective-correct and
 * a reference warped by the tracking homography looks painted on the paper.
 *
 * Per-reference display modes are done in the fragment shader so the edge
 * threshold can be changed in real time:
 *   0 = colour, 1 = grayscale, 2 = edges (Sobel magnitude on a mip level, thresholded).
 */
import { mulAll } from './math.js';

const VS = `#version 300 es
in vec2 aPos;            // 0..1 unit quad
uniform mat3 uM;         // local px -> clip (projective)
uniform vec2 uSize;      // quad size in local px
out vec2 vUV;
out vec2 vLocal;
void main() {
  vec2 local = aPos * uSize;
  vec3 p = uM * vec3(local, 1.0);
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUV = aPos;
  vLocal = local;
}`;

const FS_IMAGE = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uOpacity;
uniform int uMode;
uniform float uThresh;
uniform vec2 uTexel;
uniform float uLod;
uniform vec3 uEdgeColor;
out vec4 outColor;
float lum(vec2 uv) {
  vec4 c = textureLod(uTex, uv, uLod);
  return dot(c.rgb, vec3(0.299, 0.587, 0.114)) * c.a + (1.0 - c.a); // transparent = white
}
void main() {
  vec4 c = texture(uTex, vUV);
  if (uMode == 1) {
    float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    c.rgb = vec3(l);
  } else if (uMode == 2) {
    vec2 d = uTexel;
    float tl = lum(vUV + vec2(-d.x, -d.y)), t = lum(vUV + vec2(0.0, -d.y)), tr = lum(vUV + vec2(d.x, -d.y));
    float l  = lum(vUV + vec2(-d.x, 0.0)),                                 r  = lum(vUV + vec2(d.x, 0.0));
    float bl = lum(vUV + vec2(-d.x, d.y)),  b = lum(vUV + vec2(0.0, d.y)),  br = lum(vUV + vec2(d.x, d.y));
    float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
    float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
    float mag = length(vec2(gx, gy));
    float a = smoothstep(uThresh, uThresh + 0.06, mag);
    c = vec4(uEdgeColor, a);
  }
  float a = c.a * uOpacity;
  outColor = vec4(c.rgb * a, a); // premultiplied
}`;

const FS_GRID = `#version 300 es
precision highp float;
in vec2 vLocal;
uniform vec2 uSize;
uniform float uCell;
uniform vec4 uColor;
out vec4 outColor;
void main() {
  vec2 g = vLocal / uCell;
  vec2 fw = max(fwidth(g), vec2(1e-6));
  vec2 f = abs(fract(g - 0.5) - 0.5) / fw;
  float line = 1.0 - min(min(f.x, f.y) / 1.2, 1.0);
  vec2 bw = max(fwidth(vLocal), vec2(1e-6));
  vec2 b = min(vLocal, uSize - vLocal) / bw;
  float border = 1.0 - min(min(b.x, b.y) / 2.0, 1.0);
  float a = max(line, border) * uColor.a;
  outColor = vec4(uColor.rgb * a, a);
}`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available on this device/browser.');
    this.gl = gl;
    this.imgProg = this._program(VS, FS_IMAGE);
    this.gridProg = this._program(VS, FS_GRID);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    for (const p of [this.imgProg, this.gridProg]) {
      const loc = gl.getAttribLocation(p.prog, 'aPos');
      if (loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0); }
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.cssW = 1; this.cssH = 1;
  }

  _program(vs, fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(prog, i).name;
      u[name] = gl.getUniformLocation(prog, name);
    }
    return { prog, u };
  }

  /** Match the drawing buffer to the element's CSS size (DPR capped for speed). */
  resize(cssW, cssH, dpr = Math.min(window.devicePixelRatio || 1, 2)) {
    this.cssW = cssW; this.cssH = cssH;
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  /** Upload an image (ImageBitmap / canvas / img) as a mipmapped texture. */
  createTexture(source) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, w: source.width, h: source.height };
  }

  deleteTexture(t) { if (t) this.gl.deleteTexture(t.tex); }

  /** CSS px -> clip space. */
  clipMatrix() {
    return [2 / this.cssW, 0, -1, 0, -2 / this.cssH, 1, 0, 0, 1];
  }

  /**
   * Draw one frame.
   * @param {object} scene
   *   view:       canvas space -> CSS px (projective, row-major)
   *   background: optional {tex} drawn at canvas-space origin (the snapshot in place mode)
   *   layers:     [{tex, transform (local px -> canvas space), opacity, mode, threshold, edgeColor}]
   *   grid:       optional {cells, w, h}  lines attached to the canvas
 *   outline:    optional {transform, w, h}  selection frame
   *   alpha:      global overlay opacity (used for the lost-tracking fade)
   */
  draw(scene) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!scene || !scene.view) return;
    gl.bindVertexArray(this.vao);
    const base = mulAll(this.clipMatrix(), scene.view);
    const alpha = scene.alpha == null ? 1 : scene.alpha;
    if (alpha <= 0) return;

    if (scene.background) {
      this._drawImage(base, scene.background.tex, { opacity: 1, mode: 0 });
    }
    for (const L of scene.layers || []) {
      this._drawImage(mulAll(base, L.transform), L.tex, {
        opacity: L.opacity * alpha, mode: L.mode, threshold: L.threshold, edgeColor: L.edgeColor,
      });
    }
    if (scene.grid) {
      const g = scene.grid;
      this._drawLines(base, g.w, g.h, Math.max(g.w, g.h) / g.cells, g.color || [0.2, 0.9, 1.0, 0.8], alpha);
    }
    if (scene.outline) {
      // Selection frame: the grid shader with a single cell draws just the border.
      const o = scene.outline;
      this._drawLines(mulAll(base, o.transform), o.w, o.h, Math.max(o.w, o.h) * 2, [1, 0.8, 0.2, 0.9], 1);
    }
  }

  _drawLines(M, w, h, cell, c, alpha) {
    const gl = this.gl;
    const p = this.gridProg;
    gl.useProgram(p.prog);
    gl.uniformMatrix3fv(p.u.uM, false, colMajor(M));
    gl.uniform2f(p.u.uSize, w, h);
    gl.uniform1f(p.u.uCell, cell);
    gl.uniform4f(p.u.uColor, c[0], c[1], c[2], c[3] * alpha);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _drawImage(M, t, o) {
    const gl = this.gl;
    const p = this.imgProg;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniformMatrix3fv(p.u.uM, false, colMajor(M));
    gl.uniform2f(p.u.uSize, t.w, t.h);
    gl.uniform1f(p.u.uOpacity, o.opacity);
    gl.uniform1i(p.u.uMode, o.mode || 0);
    gl.uniform1f(p.u.uThresh, o.threshold == null ? 0.3 : o.threshold);
    // Edge detection samples a slightly blurred mip level of large images to
    // suppress photo noise; offsets match that level's texel size.
    const lod = Math.max(0, Math.floor(Math.log2(Math.max(t.w, t.h) / 1024)));
    gl.uniform1f(p.u.uLod, lod);
    gl.uniform2f(p.u.uTexel, Math.pow(2, lod) / t.w, Math.pow(2, lod) / t.h);
    const ec = o.edgeColor || [0, 0, 0];
    gl.uniform3f(p.u.uEdgeColor, ec[0], ec[1], ec[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

function colMajor(m) {
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

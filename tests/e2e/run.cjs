/*
 * Browser end-to-end test (headless Chromium + fake camera).
 *
 *   node tests/e2e/make-video.cjs tests/out/fake-camera.y4m
 *   node tests/e2e/run.cjs
 *
 * Serves the app on localhost (a secure context, so camera + SW work), feeds
 * the synthetic video as the camera, captures the canvas, adds a reference,
 * switches to Trace and checks that tracking locks on. OpenCV.js is served
 * from node_modules instead of the CDN so the test runs offline.
 * Screenshots go to tests/out/.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'tests/out');
const VIDEO = path.join(OUT, 'fake-camera.y4m');
const CV_LOCAL = path.join(ROOT, 'node_modules/@techstark/opencv-js/dist/opencv.js');
const CV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function serve() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

(async () => {
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}/`;
  const browser = await chromium.launch({
    executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${VIDEO}`,
      '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 1, hasTouch: true, serviceWorkers: 'block' });
  await ctx.route(CV_URL, route => route.fulfill({ path: CV_LOCAL, contentType: 'text/javascript' }));
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  page.on('worker', w => w.on('console', m => logs.push(`[worker] ${m.text()}`)));

  let ok = true;
  const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) ok = false; };

  await page.goto(base);
  await page.waitForFunction(() => window.tracit && document.getElementById('video').videoWidth > 0, null, { timeout: 20000 });
  check(true, 'camera stream started');
  await page.waitForFunction(() => window.tracit.tracker.ready, null, { timeout: 60000 });
  check(true, 'OpenCV.js loaded in the worker');

  await page.click('#btn-capture');
  await page.waitForFunction(() => window.tracit.state.snapshot && window.tracit.state.targetKeypoints != null, null, { timeout: 20000 });
  const kp = await page.evaluate(() => window.tracit.state.targetKeypoints);
  check(kp > 250, `canvas captured, ${kp} target keypoints`);

  await page.setInputFiles('#file', path.join(ROOT, 'icons/icon-512.png'));
  await page.waitForFunction(() => window.tracit.state.refs.length === 1, null, { timeout: 10000 });
  check(true, 'reference added');
  await page.screenshot({ path: path.join(OUT, 'place.png') });

  await page.click('#btn-trace');
  await page.evaluate(() => { const s = window.tracit.state.settings; s.showStats = true; s.grid = true; });
  await page.waitForTimeout(6000);
  const r = await page.evaluate(() => {
    const t = window.tracit.tracker;
    return { status: t.status, H: t.H, stats: t.stats, frame: t.frameSize };
  });
  console.log('tracker:', JSON.stringify({ status: r.status, stats: r.stats }));
  check(r.status === 'good', `tracking status is "${r.status}"`);
  check(r.stats.fps > 5, `tracker throughput ${r.stats.fps.toFixed(1)} fps (headless, software GL)`);
  await page.screenshot({ path: path.join(OUT, 'trace.png') });
  await page.click('#btn-layers');
  await page.click('#p-mode button[data-mode="2"]');
  await page.screenshot({ path: path.join(OUT, 'layers-edges.png') });
  await page.click('#btn-layers');
  await page.setViewportSize({ width: 860, height: 412 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'trace-landscape.png') });

  // Camera switch button responds (the fake device is a single camera)
  await page.click('#btn-cam');
  await page.waitForTimeout(500);
  const camHint = await page.evaluate(() => !document.getElementById('hint').hidden && document.getElementById('hint').textContent);
  check(!!camHint, `camera button responds: "${camHint}"`);

  // Freeze / resume
  await page.click('#btn-freeze');
  check(await page.evaluate(() => document.getElementById('video').paused), 'freeze pauses the camera image');
  await page.tap('#touch');
  check(await page.evaluate(() => !window.tracit.state.frozen), 'tap resumes');

  // Session persists across reload
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForFunction(() => window.tracit && window.tracit.state.snapshot && window.tracit.state.refs.length === 1, null, { timeout: 20000 });
  check(true, 'session restored from IndexedDB after reload');

  const errors = logs.filter(l => l.startsWith('[pageerror]') || l.startsWith('[error]'));
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  fs.writeFileSync(path.join(OUT, 'console.log'), logs.join('\n'));
  await browser.close();
  srv.close();
  console.log(ok ? 'e2e passed' : 'e2e FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

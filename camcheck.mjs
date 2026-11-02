/* Game Day - does the Cougar Cam find people across a room?

   Builds a pretend living room - three people, each about 40% of the
   picture's height, which is how big somebody on a couch 3-4 m from a
   laptop camera looks - feeds it to Chromium as its camera, and asks
   cam.js where the people are and how it would frame each one.

   Needs ffmpeg and Pillow, and downloads MediaPipe's sample photo of a
   person the first time (kept in tests/.cache/, not in git).
   Run from the repo root: node camcheck.mjs */
import {createRequire} from 'module';
import {spawn, execFileSync} from 'child_process';
import fs from 'fs';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if(!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.mkdirSync('tests/.cache', {recursive: true});
const person = 'tests/.cache/pose.jpg', frame = 'tests/.cache/room.png', y4m = 'tests/.cache/room.y4m';
if(!fs.existsSync(person)) execFileSync('curl', ['-sSL', '-o', person, 'https://storage.googleapis.com/mediapipe-assets/pose.jpg']);
const XS = [0.12, 0.42, 0.72];
execFileSync('python3', ['-c', `
from PIL import Image
bg = Image.new('RGB', (1920, 1080), (58, 52, 48))
p = Image.open('${person}'); p = p.resize((int(p.width * 430 / p.height), 430))
for x in [${XS.join(',')}]:
    bg.paste(p, (int(x * 1920), 520))
bg.save('${frame}')`]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', frame, '-t', '2', '-r', '15', '-pix_fmt', 'yuv420p', y4m]);

const PORT = 9000 + Math.floor(Math.random() * 900);
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {cwd: 'web', stdio: 'ignore'});
await sleep(800);
const browser = await chromium.launch({args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + y4m]});
try {
  const pg = await browser.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('http://127.0.0.1:' + PORT + '/play.html');     // any page of ours; cam.js is imported below
  const res = await pg.evaluate(async () => {
    const {createCam} = await import('./cam.js');
    const cam = createCam({cpu: true});
    await cam.start();
    for(let i = 0; i < 60 && cam.status.detector !== 'on'; i++) await new Promise(r => setTimeout(r, 500));
    let ps = [];
    for(let i = 0; i < 20 && ps.length < 3; i++){ await new Promise(r => setTimeout(r, 800)); ps = cam.people(); }
    const W = cam.video.videoWidth, H = cam.video.videoHeight;
    const out = {status: cam.status, W, H, people: ps, frames: ps.map(p => cam.frameOf(p))};
    cam.stop();
    return out;
  });
  console.log('  camera ' + res.W + 'x' + res.H + ', people finder ' + res.status.detector);
  const ps = res.people.slice().sort((a, b) => a.x - b.x);
  ok(ps.length === 3, 'found ' + ps.length + ' of 3 people' + ps.map(p => ' (' + p.x.toFixed(2) + ', score ' + p.s.toFixed(2) + ')').join(''));
  // each pasted photo is 430 px tall and so 645 px (0.34 of the picture) wide
  ok(ps.every((p, i) => p.x + p.w / 2 > XS[i] && p.x + p.w / 2 < XS[i] + 0.34), 'each found where they sit');
  // each zoom frame contains its person's head and is about a third of the picture wide
  const fr = res.frames;
  ok(fr.every(f => f.w / res.W > 0.15 && f.w / res.W < 0.6 && Math.abs(f.w / f.h - 16 / 9) < 0.05), 'zooms are 16:9, ' + fr.map(f => Math.round(100 * f.w / res.W) + '%').join(' / ') + ' of the width');
  ok(res.people.every((p, i) => { const f = res.frames[i], hx = (p.x + p.w / 2) * res.W, hy = (p.y + p.h * 0.1) * res.H; return hx > f.x && hx < f.x + f.w && hy > f.y && hy < f.y + f.h; }), 'every zoom has the head in it');
  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
} catch(e){ ok(false, 'threw: ' + e.message); }
await browser.close(); server.kill();
console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);

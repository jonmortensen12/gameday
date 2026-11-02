/* Game Day - the jumbotron and three phones in Chromium, over ?local=1.

   A finished game (tests/fixtures/byu-utah-2025.json, served in place of
   ESPN) replays at 60x. Three phones join from the room code; they call
   plays, vote on drives, tap KICK, answer trivia and flag a review, by
   clicking the real buttons. The jumbotron runs with Chromium's fake
   camera and microphone, so the camera, the people finder (MediaPipe, on
   the CPU here) and the reaction recorder all start for real.

   Checks: the room opens, phones join and get their views, calls come back
   as results, a trivia round runs on both screens, a review opens and
   settles, the game reaches its final screen with awards, a reaction clip
   is recorded and saved, and no page throws. Run from the repo root:
   node netcheck.mjs */
import {createRequire} from 'module';
import {spawn} from 'child_process';
import fs from 'fs';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if(!c) fails++; };
const tap = (p, sel) => p.click(sel, {timeout: 1500}).catch(() => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 8000 + Math.floor(Math.random() * 1000);
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {cwd: 'web', stdio: 'ignore'});
await sleep(800);
const base = 'http://127.0.0.1:' + PORT + '/';
const fixture = fs.readFileSync('tests/fixtures/byu-utah-2025.json', 'utf8');

const browser = await chromium.launch({args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']});
const ctx = await browser.newContext({permissions: ['camera', 'microphone']});
await ctx.route('https://site.api.espn.com/**', r => {
  if(/summary\?event=401756924/.test(r.request().url())) return r.fulfill({status: 200, contentType: 'application/json', body: fixture, headers: {'access-control-allow-origin': '*'}});
  return r.fulfill({status: 200, contentType: 'application/json', body: '{"events":[]}', headers: {'access-control-allow-origin': '*'}});
});
const errors = [];
const watch = (p, who) => {
  p.on('pageerror', e => errors.push(who + ': ' + e.message));
  p.on('console', m => { if(m.type() === 'error' && !/favicon|404|Failed to load resource/.test(m.text())) errors.push(who + ' console: ' + m.text()); });
};

try {
  console.log('jumbotron');
  const tv = await ctx.newPage();
  watch(tv, 'tv');
  await tv.setViewportSize({width: 1600, height: 900});
  await tv.goto(base + 'index.html?local=1&replay=401756924&team=252&speed=60&preroll=60&fresh=1');
  // start by hand, as a person would (the camera needs the click)
  await tv.click('#startBtn');
  await tv.waitForFunction(() => window.GD && GD.host.room.code, null, {timeout: 15000});
  const code = await tv.evaluate(() => GD.host.room.code);
  ok(/^[A-Z0-9]{4}$/.test(code), 'room open: ' + code);
  await tv.waitForFunction(() => GD.cam && GD.cam.status.camera === 'on', null, {timeout: 15000}).catch(() => {});
  ok(await tv.evaluate(() => GD.cam.status.camera === 'on'), 'fake camera on');

  console.log('phones');
  const phones = [];
  for(const [name, kidMode] of [['Grandpa', false], ['Ava', true], ['Jon', false]]){
    const p = await ctx.newPage();
    watch(p, name);
    await p.setViewportSize({width: 390, height: 844});
    await p.goto(base + 'play.html?local=1#' + code);
    await p.fill('#nameIn', name);
    if(kidMode) await p.click('#kid');
    await p.click('#joinBtn');
    phones.push({p, name});
  }
  for(const {p, name} of phones) await p.waitForSelector('#mainScr:not(.hide)', {timeout: 15000}).then(() => ok(true, name + ' joined'), () => ok(false, name + ' joined'));
  await tv.waitForFunction(() => GD.host.roomInfo().people.filter(p => p.on).length === 3, null, {timeout: 10000}).catch(() => {});
  ok(await tv.evaluate(() => GD.host.roomInfo().people.filter(p => p.on).length) === 3, 'the jumbotron sees three phones');

  // play along until the final whistle
  let sawTrivia = false, sawTvOnPhone = false, flagged = false, sawReview = false, answered = 0, calls = 0;
  const t0 = Date.now();
  while(Date.now() - t0 < 330000){
    const v = await tv.evaluate(() => { const v = GD.host.S; return {phase: v.phase, tv: !!(v.tv && v.tv.state !== 'done'), rv: v.rv && v.rv.state, n: Object.keys(v.done).length}; });
    if(v.tv) sawTrivia = true;
    if(v.rv) sawReview = true;
    for(const {p} of phones){
      const vis = await p.evaluate(() => ({tv: !document.getElementById('tvScr').classList.contains('hide'),
        kick: !document.getElementById('kickCard').classList.contains('hide'), drive: !document.getElementById('driveCard').classList.contains('hide'),
        rv: !document.getElementById('rvCard').classList.contains('hide'), rvBtns: document.querySelectorAll('#rvBtns button').length}));
      if(vis.tv){
        sawTvOnPhone = true;
        const n = await p.$$eval('#tvA button:not(.mine)', b => b.length);
        if(n === 4){ await tap(p, '#tvA button >> nth=' + Math.floor(Math.random() * 4)); answered++; }
        continue;
      }
      if(vis.kick && Math.random() < 0.3) await tap(p, '#kickBtn');
      if(vis.rv && vis.rvBtns) await tap(p, '#rvBtns button >> nth=' + (Math.random() < 0.5 ? 0 : 1));
      if(vis.drive && Math.random() < 0.2) await tap(p, '#driveBtns button >> nth=' + Math.floor(Math.random() * 4));
      if(Math.random() < 0.5){ await tap(p, Math.random() < 0.5 ? '#runBtn' : '#passBtn'); calls++; }
    }
    if(!flagged && v.n > 60){ flagged = true; await phones[2].p.click('#flagBtn'); await phones[2].p.click('#flagBtn'); }
    if(v.phase === 'final') break;
    await sleep(400);
  }
  const S = await tv.evaluate(() => { const S = GD.host.S; return {phase: S.phase, players: Object.values(S.players).map(p => ({n: p.name, s: p.score, calls: p.calls, tv: p.tvRight})), rounds: S.tvN, rv: S.rv && S.rv.state}; });
  console.log('  ' + S.players.map(p => p.n + ' ' + p.s + ' pts, ' + p.calls + ' calls settled').join(' · ') + ' · ' + S.rounds + ' trivia rounds');
  ok(S.phase === 'final', 'reached the final whistle');
  ok(S.players.every(p => p.calls > 10), 'every phone\'s calls were settled');
  ok(S.players.some(p => p.s > 0), 'points were scored');
  ok(sawTrivia && sawTvOnPhone && answered > 0, 'trivia ran on the jumbotron and the phones (' + answered + ' answers)');
  ok(sawReview, 'a review was flagged from a phone');
  const tickets = await phones[0].p.evaluate(() => document.querySelectorAll('#tickets .tk').length);
  ok(tickets >= 2, 'a phone shows its results (' + tickets + ')');
  await tv.waitForFunction(() => document.getElementById('endOver').classList.contains('on') || document.getElementById('camWrap').classList.contains('on'), null, {timeout: 20000}).catch(() => {});
  const aw = await tv.evaluate(() => document.querySelectorAll('#awards div').length);
  ok(aw >= 3, 'the final screen has awards (' + aw + ')');

  console.log('camera');
  const st = await tv.evaluate(() => GD.cam.status);
  ok(st.detector === 'on', 'people finder loaded (' + st.detector + (st.error ? ': ' + st.error : '') + ')');
  ok(st.recording === 'on', 'reaction recorders running');
  // pretend the room went off: a clip of the 8+ s before and 5 s after
  await sleep(17000);
  await tv.keyboard.press('r');
  await sleep(7000);
  const clips = await tv.evaluate(async () => (await (await import('./cam.js')).listClips()).map(c => ({size: c.blob.size, pre: c.pre})));
  ok(clips.length >= 1 && clips[0].size > 20000, 'a reaction clip was saved: ' + (clips[0] ? Math.round(clips[0].size / 1024) + ' KB, ' + clips[0].pre.toFixed(1) + ' s before the shout' : 'none'));
  ok(clips.length && clips[0].pre >= 7.9, 'it starts at least 8 s before the shout');
} catch(e){
  ok(false, 'threw: ' + e.message);
} finally {
  ok(!errors.length, 'no page errors' + (errors.length ? ':\n    ' + [...new Set(errors)].slice(0, 8).join('\n    ') : ''));
  await browser.close();
  server.kill();
}
console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);

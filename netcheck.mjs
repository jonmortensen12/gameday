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
  let keyTested = false, rejoinTested = false, pushes = 0, locks = 0, huddle = 0, skipped = null, kickCalls = 0;
  let sawTrivia = false, sawTvOnPhone = false, flagged = false, sawReview = false, answered = 0, calls = 0;
  const t0 = Date.now();
  while(Date.now() - t0 < 560000){   // the huddles hold the replay, so this takes a while
    const v = await tv.evaluate(() => { const v = GD.host.S; return {phase: v.phase, tv: !!(v.tv && v.tv.state !== 'done'), rv: v.rv && v.rv.state, n: Object.keys(v.done).length}; });
    if(v.tv) sawTrivia = true;
    if(v.rv) sawReview = true;
    for(const {p} of phones){
      const vis = await p.evaluate(() => ({tv: !document.getElementById('tvScr').classList.contains('hide'),
        kick: !document.getElementById('kickCard').classList.contains('hide'),
        drive: !document.getElementById('driveCard').classList.contains('hide') && !document.getElementById('driveCard').classList.contains('locked'),
        play: !document.getElementById('snap').classList.contains('hide') && !document.getElementById('snap').classList.contains('locked'),
        askPlay: !document.getElementById('askPlay').disabled, askDrive: !document.getElementById('askDrive').disabled,
        lockPlay: !document.getElementById('lockPlay').classList.contains('hide'), lockDrive: !document.getElementById('lockDrive').classList.contains('hide'),
        rv: !document.getElementById('rvCard').classList.contains('hide'), rvBtns: document.querySelectorAll('#rvBtns button').length}));
      if(vis.tv){
        sawTvOnPhone = true;
        // once, somebody has had enough trivia: ⏭, twice
        if(skipped === null && p === phones[2].p && !huddle){
          // at 60x a round is over in a second: hold the game still while the thumb moves
          const n = await tv.evaluate(() => { GD.host.source.pause(); return GD.host.S.tv && GD.host.S.tv.state !== 'done' ? GD.host.S.tv.n : null; });
          if(n == null){ await tv.evaluate(() => GD.host.source.resume()); continue; }
          await tap(p, '#tvSkip'); await tap(p, '#tvSkip');
          await sleep(800);
          skipped = await tv.evaluate(n => { const r = GD.host.S.tv; GD.host.source.resume(); return !!(r && r.n === n && r.state === 'done' && r.skipped); }, n);
          continue;
        }
        const n = await p.$$eval('#tvA button:not(.mine)', b => b.length);
        if(n === 4){ await tap(p, '#tvA button >> nth=' + Math.floor(Math.random() * 4)); answered++; }
        continue;
      }
      if(vis.kick && Math.random() < 0.3) await tap(p, '#kickBtn');
      if(vis.rv && vis.rvBtns) await tap(p, '#rvBtns button >> nth=' + (Math.random() < 0.5 ? 0 : 1));
      if(vis.drive && Math.random() < 0.4) await tap(p, '#driveQs button >> nth=' + Math.floor(Math.random() * 18));
      if(Math.random() < 0.05) await tap(p, '#syncBtn');
      if(vis.play && Math.random() < 0.8){
        const r = Math.random();
        if(r < 0.2){ await tap(p, '#modeRow button[data-m=punt]'); await tap(p, '#kickGrid button >> nth=' + Math.floor(Math.random() * 8)); kickCalls++; }
        else if(r < 0.3){ await tap(p, '#modeRow button[data-m=fg]'); await tap(p, '#kickGrid button >> nth=' + Math.floor(Math.random() * 4)); kickCalls++; }
        else {
          await tap(p, '#modeRow button[data-m=rp]');
          await tap(p, Math.random() < 0.5 ? '#runBtn' : '#passBtn');
          if(Math.random() < 0.2) await tap(p, '#toBtn');
          calls++;
        }
      }
      /* Jon asks the room. At 60x a snap goes by every half second, faster
         than anyone could answer, so the replay holds still for a moment
         while the room answers - the huddle - and then Jon locks (as if at
         the snap) or lets the window run. */
      if(p === phones[2].p){
        if(!huddle && vis.askPlay && Math.random() < 0.4){ await tap(p, '#askPlay'); pushes++; huddle = 3; await tv.evaluate(() => GD.host.source.pause()); }
        else if(!huddle && vis.askDrive && Math.random() < 0.15){ await tap(p, '#askDrive'); pushes++; huddle = 3; await tv.evaluate(() => GD.host.source.pause()); }
      }
    }
    // drives only, switched on from the jumbotron's keyboard, and back
    // the jumbotron can ask too: A calls for a play, and every phone shows it
    if(!keyTested && v.n > 20 && !v.tv){
      const open = await tv.evaluate(() => GD.host.S.pp.some(q => !q.target && !q.void));
      if(!open){
        keyTested = true;
        await tv.evaluate(() => GD.host.source.pause());     // at 60x the play would be over before anyone looked
        await tv.keyboard.press('a');
        await sleep(1200);
        const shown = await phones[0].p.evaluate(() => !document.getElementById('snap').classList.contains('hide') && /the TV called/.test(document.getElementById('snapH').textContent));
        ok(shown, 'A on the jumbotron calls for a play, and the phones show it');
        await tv.evaluate(() => GD.host.source.resume());
      }
    }
    // people wander off: a reload, and a phone that comes back as a stranger
    if(!rejoinTested && v.n > 50 && !v.tv && !v.rv){
      rejoinTested = true;
      const before = await tv.evaluate(() => Object.fromEntries(Object.values(GD.host.S.players).map(p => [p.name, p.score])));
      await phones[1].p.reload();
      await phones[1].p.waitForSelector('#mainScr:not(.hide)', {timeout: 15000}).catch(() => {});
      ok(await phones[1].p.evaluate(() => !document.getElementById('mainScr').classList.contains('hide')), 'a reloaded phone is straight back in, no typing');
      // a brand-new page has a brand-new device id (here sessionStorage; at
      // the party: another browser, private mode, cleared data)
      await phones[2].p.close();
      await sleep(1500);
      const again = await ctx.newPage();
      watch(again, 'Jon again');
      await again.setViewportSize({width: 390, height: 844});
      await again.goto(base + 'play.html?local=1#' + code);
      await again.fill('#nameIn', 'Jon');
      await again.click('#joinBtn');
      await again.waitForSelector('#back:not(.hide)', {timeout: 15000}).catch(() => {});
      const backT = await again.evaluate(() => document.getElementById('backT').textContent);
      phones[2].p = again;
      await sleep(800);
      const after = await tv.evaluate(() => Object.fromEntries(Object.values(GD.host.S.players).map(p => [p.name, p.score])));
      ok(/Welcome back, Jon/.test(backT) && Object.keys(after).length === 3, 'Jon on a "new phone" gets his score back: "' + backT + '"');
      ok(after.Ava >= before.Ava && after.Jon >= before.Jon, 'no score lost (Ava ' + before.Ava + ' -> ' + after.Ava + ', Jon ' + before.Jon + ' -> ' + after.Jon + ')');
    }
    // the huddle is over: Jon locks (as if at the snap) or lets it run, and play goes on
    if(huddle && --huddle === 0){
      const j = phones[2].p;
      if(Math.random() < 0.6){
        const l = await j.evaluate(() => ({p: !document.getElementById('lockPlay').classList.contains('hide'), d: !document.getElementById('lockDrive').classList.contains('hide')}));
        if(l.p){ await tap(j, '#lockPlay'); locks++; }
        if(l.d){ await tap(j, '#lockDrive'); locks++; }
      }
      await tv.evaluate(() => GD.host.source.resume());
    }
    if(!flagged && v.n > 60 && !v.tv && !huddle){ flagged = true; await tap(phones[2].p, '#flagBtn'); await tap(phones[2].p, '#flagBtn'); }
    if(v.phase === 'final') break;
    await sleep(400);
  }
  const S = await tv.evaluate(() => { const S = GD.host.S; return {phase: S.phase, players: Object.values(S.players).map(p => ({n: p.name, s: p.score, calls: p.calls, tv: p.tvRight})), rounds: S.tvN, rv: S.rv && S.rv.state}; });
  console.log('  ' + S.players.map(p => p.n + ' ' + p.s + ' pts, ' + p.calls + ' calls settled').join(' · ') + ' · ' + S.rounds + ' trivia rounds');
  ok(S.phase === 'final', 'reached the final whistle');
  const PU = await tv.evaluate(() => ({pp: GD.host.S.pp.length, dvs: GD.host.S.dvs.filter(d => d.push).length, picks: GD.host.S.dvs.reduce((a, d) => a + Object.keys(d.picks).length, 0)}));
  ok(pushes > 5 && locks > 0, 'a phone asked the room ' + pushes + ' times and locked ' + locks);
  ok(S.players.every(p => p.calls > 3), 'every phone\'s answers to called plays were settled');
  ok(PU.dvs > 3 && PU.picks > 0, 'drive guesses settled: ' + PU.dvs + ' drives asked about, ' + PU.picks + ' sets of guesses');
  ok(S.players.some(p => p.s > 0), 'points were scored');
  ok(sawTrivia && sawTvOnPhone && answered > 0, 'trivia ran on the jumbotron and the phones (' + answered + ' answers)');
  ok(sawReview, 'a review was flagged from a phone');
  ok(keyTested && rejoinTested, 'the jumbotron-key and rejoin checks ran');
  ok(skipped === true, '⏭ on a phone ends the trivia for everyone');
  const K = await tv.evaluate(() => Object.values(GD.host.S.players).map(p => (p.kicks || [0, 0])[1] + (p.toTried || 0)));
  ok(kickCalls > 0 && K.some(n => n > 0), 'field goal, punt and 💥 calls were made (' + kickCalls + ') and settled (' + K.join(', ') + ')');
  const tickets = await phones[0].p.evaluate(() => document.querySelectorAll('#tickets .tk').length);
  ok(tickets >= 2, 'a phone shows its results (' + tickets + ')');
  const sit = await phones[0].p.evaluate(() => document.getElementById('sitT').textContent);
  ok(/^Q\d /.test(sit), 'the phone shows where the game is: "' + sit + '"');
  await phones[2].p.click('#tabs button >> nth=1');
  await sleep(1500);
  const hist = await phones[2].p.evaluate(() => ({rec: document.querySelectorAll('#rec div').length, items: document.querySelectorAll('#hist .hd').length,
    drives: [...document.querySelectorAll('#hist .hd table')].length}));
  ok(hist.rec === 11 && hist.items >= 5, 'My guesses: the record and ' + hist.items + ' settled guesses (' + hist.drives + ' drives)');
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

  // J: the jumbotron's moments off - a plain scoreboard, camera and microphone off - and back on
  await tv.keyboard.press('j');
  await sleep(800);
  const off = await tv.evaluate(() => ({plain: document.body.classList.contains('plain'), cam: !!GD.cam, chip: document.getElementById('showChip').textContent,
    overs: [...document.querySelectorAll('.over, #camWrap')].every(e => getComputedStyle(e).display === 'none')}));
  ok(off.plain && !off.cam && off.overs && /off/.test(off.chip), 'J turns the jumbotron moments off: nothing full-screen, camera stopped (' + off.chip + ')');
  await tv.keyboard.press('j');
  await tv.waitForFunction(() => GD.cam && GD.cam.status.camera === 'on', null, {timeout: 15000}).catch(() => {});
  ok(await tv.evaluate(() => !document.body.classList.contains('plain') && !!GD.cam && GD.cam.status.camera === 'on'), 'and J again turns them back on, camera and all');

  console.log('the jumbotron reloads mid-game');
  {
    const tv2 = await ctx.newPage();
    watch(tv2, 'tv2');
    await tv2.goto(base + 'index.html?local=1&event=401756924&team=252&nocam=1&go=1&fresh=1');
    await tv2.waitForFunction(() => window.GD && GD.host.room.code, null, {timeout: 15000});
    const code2 = await tv2.evaluate(() => GD.host.room.code);
    const ph = await ctx.newPage();
    watch(ph, 'Uncle');
    await ph.goto(base + 'play.html?local=1#' + code2);
    await ph.fill('#nameIn', 'Uncle');
    await ph.click('#joinBtn');
    await ph.waitForSelector('#mainScr:not(.hide)', {timeout: 15000});
    await tv2.evaluate(() => { Object.values(GD.host.S.players)[0].score = 77; });
    await sleep(5000);                                  // saved every 4 s
    await tv2.goto(base + 'index.html?local=1&event=401756924&team=252&nocam=1&go=1');   // a reload, minus fresh=1: carry on
    await tv2.waitForFunction(() => window.GD && GD.host.room.code, null, {timeout: 60000}).catch(() => {});
    const code3 = await tv2.evaluate(() => window.GD && GD.host.room.code);
    ok(code3 === code2, 'same room code after the reload (' + code2 + ' -> ' + code3 + ')');
    // the phone notices the old room went silent (8 s) and joins the new one
    await tv2.waitForFunction(() => GD.host.roomInfo().people.some(p => p.on && p.n === 'Uncle'), null, {timeout: 30000}).catch(() => {});
    await sleep(1000);
    const shown = await ph.evaluate(() => document.getElementById('meS').textContent);
    ok(shown === '77' && await tv2.evaluate(() => GD.host.roomInfo().people.some(p => p.on && p.n === 'Uncle')), 'the phone reconnected by itself and still shows its 77 points (' + shown + ')');
    await tv2.close(); await ph.close();
  }
} catch(e){
  ok(false, 'threw: ' + e.message);
} finally {
  ok(!errors.length, 'no page errors' + (errors.length ? ':\n    ' + [...new Set(errors)].slice(0, 8).join('\n    ') : ''));
  await browser.close();
  server.kill();
}
console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);

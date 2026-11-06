/* Game Day - the game, headless, through real games.

   Plays recorded ESPN feeds (tests/fixtures/) through game.js the way the
   jumbotron would see them live: each play reaching the feed 25-55 s after
   it happened, polled every 3 s, the TV running D behind real time.
   Pretend people play along. Nothing is guessed unless somebody pushes:

     caller   - pushes "call the next play" before every other play, and
                locks everybody's guesses at the snap two times in three
                (the rest run out their 30 s)
     boss     - pushes "new drive" just after half the changes of
                possession, and locks at the drive's first snap half the
                time; the feed pushes the rest
     oracle   - answers every pushed play right, 8 s before the snap
     cheater  - answers every pushed play right, 2 s AFTER the snap (must
                never count)
     coin     - answers pushed plays at random
     kicker   - on every pushed punt, field goal and 4th-down snap, calls
                exactly what happens (the return distance, the miss, going
                for it)
     gambler  - calls every pushed run or pass right and always adds
                💥 turnover (+100 only when the ball is lost)
     driver   - answers every pushed drive right, everything about it
     latecomer- answers a pushed drive 3 s after it has started on the TV
                (must never count)
     tapper   - taps KICK at every kickoff
     snapper  - (sync: 'snaps') no KICK and no locks; taps ⏱ at a third of
                the snaps instead
     flagger  - flags every review and votes the right ruling
     kid      - in kids' mode, answers trivia at random

   Run from the repo root: node gamecheck.mjs */
import fs from 'fs';
import {normalize, replaySource} from './web/feed.js';
import * as G from './web/game.js';

let fails = 0;
function ok(c, msg){ console.log((c ? '  ok   ' : '  FAIL ') + msg); if(!c) fails++; }
const scrim = p => (p.kind === 'run' || p.kind === 'pass' || p.kind === 'special') && !p.badWall;

async function run(file, team, Dtrue, label, opts = {}){
  console.log('\n' + label + ' (' + file + '), TV ' + Dtrue / 1000 + ' s behind');
  const N = normalize(JSON.parse(fs.readFileSync('tests/fixtures/' + file)));
  let cur = 0;
  const src = replaySource('cfb', 'x', {summary: N, clock: () => cur, preroll: 180});
  await src.ready;
  let SS = G.create({team, seed: 7});
  ['caller', 'boss', 'oracle', 'cheater', 'coin', 'kicker', 'gambler', 'driver', 'latecomer', 'tapper', 'snapper', 'flagger', 'kid']
    .forEach(id => G.join(SS, id, id, id === 'kid'));
  const tvOf = p => p.wall + Dtrue;
  const jitter = () => (Math.random() - 0.5) * 1600;
  const locks = !opts.noLocks;
  const events = [];
  const at = (t, f) => events.push({t, f});

  // plays: the caller pushes before every other run or pass, at least 2 s
  // after the snap before it and 10+ s before its own
  const sc = N.plays.filter(scrim);
  let pushed = 0;
  // what a kick call should have been, for the kicker
  const kickTruth = p => p.kind === 'special' ? (p.kick && (p.kick.fg ? 'fg:' + p.kick.fg :
    p.kick.punt === 'ret' ? 'punt:ret' + (p.kick.ret < 5 ? 0 : p.kick.ret < 15 ? 5 : 15) : 'punt:' + p.kick.punt)) : p.down === 4 ? 'punt:fake' : null;
  let kicks = 0, lostPushed = 0;
  sc.forEach((p, k) => {
    const kickish = p.kind === 'special' || p.down === 4;
    if(k === 0 || (k % 2 && !kickish) || (p.kind !== 'run' && p.kind !== 'pass' && !(p.kind === 'special' && p.kick))) return;
    const snap = tvOf(p), t = Math.max(tvOf(sc[k - 1]) + 2000, snap - 22000);
    if(snap - t < 10000) return;
    pushed++;
    at(t, () => G.push(SS, 'play', 'caller', src.now()));
    if(p.kind === 'run' || p.kind === 'pass'){
      at(snap - 8000, () => G.call(SS, 'oracle', src.now(), p.kind, p.yards >= 15));
      at(snap - 7000, () => G.call(SS, 'gambler', src.now(), p.kind, false, true));
      if(p.lost) lostPushed++;
    }
    const kt = kickTruth(p);
    if(kt){ kicks++; at(snap - 6000, () => G.call(SS, 'kicker', src.now(), kt)); }
    at(snap - 12000 + 1000, () => G.call(SS, 'coin', src.now(), Math.random() < 0.5 ? 'run' : 'pass', false));
    at(snap + 2000, () => G.call(SS, 'cheater', src.now(), p.kind, false));
    if(locks && pushed % 3) at(snap + Math.abs(jitter()) * 0.6, () => G.lock(SS, 'caller', src.now(), 'play'));
  });

  // drives: when each starts on the TV, when the one before it ended, and the answers
  const real = N.drives.map(d => {
    const first = N.plays.find(p => p.drive === d.id && scrim(p));
    const last = N.plays.filter(p => p.drive === d.id && !p.badWall).pop();
    return first && {d, start: tvOf(first), end: last ? tvOf(last) : tvOf(first)};
  }).filter(Boolean);
  const answers = d => Object.fromEntries(Object.keys(G.DRIVE_Q).map(f => [f, f === 'res' ? d.result : G.DRIVE_Q[f].of(d.stats)]));
  real.forEach((r, i) => {
    if(i === 0 || i % 2) return;                 // the feed pushes the others
    const t = real[i - 1].end + 5000;
    if(r.start - t < 15000) return;
    at(t, () => G.push(SS, 'drive', 'boss', src.now()));
    if(locks && i % 4 === 0) at(r.start + Math.abs(jitter()) * 0.6, () => G.lock(SS, 'boss', src.now(), 'drive'));
  });
  if(opts.sync !== 'snaps') N.plays.filter(p => p.kind === 'kickoff' && !p.badWall).forEach(p => at(tvOf(p) + jitter() / 2, () => G.kick(SS, 'tapper', src.now())));
  else sc.forEach((p, k) => { if(k % 3 === 1) at(tvOf(p) + jitter() / 2, () => G.snap(SS, 'snapper', src.now())); });
  const reviews = N.plays.map((p, i) => ({p, i})).filter(x => x.p.review && x.p.review !== 'pending').map(x => ({at: N.plays[x.i - 1] || x.p, v: x.p.review}));
  reviews.forEach(r => {
    at(tvOf(r.at) + 15000, () => G.flag(SS, 'flagger', src.now()));
    at(tvOf(r.at) + 25000, () => G.reviewVote(SS, 'flagger', src.now(), r.v));
    if(opts.room) at(tvOf(r.at) + 70000, () => G.refSaid(SS, 'coin', src.now(), opts.room === 'wrong' ? (r.v === 'stands' ? 'overturned' : 'stands') : r.v));
  });
  events.sort((a, b) => a.t - b.t);

  const end = N.plays[N.plays.length - 1].wall + 180000;
  let nextPoll = 0, ei = 0, rounds = 0, halfRound = false, lastRound = 0, maxPhone = 0, maxJumbo = 0, reloads = 0;
  const answered = {}, dpushes = {};
  for(;;){
    const now = src.now();
    if(now > end) break;
    while(ei < events.length && events[ei].t <= now) events[ei++].f();
    if(now >= nextPoll){ G.feed(SS, await src.poll(), now); nextPoll = now + 3000; }
    G.tick(SS, now);
    // a drive push is open: the driver answers for the drive it will turn out
    // to be (the first to start after it); the latecomer waits until that
    // drive has started
    const q = SS.dp.filter(x => G.isOpen(x, now)).pop();
    if(q){
      dpushes[q.n] = q.by;
      const target = real.find(r => r.start > q.at);
      if(target && target.d.result && target.d.result !== 'void'){
        if(!answered['d' + q.n] && target.start - now > 3000){
          answered['d' + q.n] = 1;
          Object.entries(answers(target.d)).forEach(([f, v]) => v != null && G.drivePick(SS, 'driver', now, f, v));
        }
        if(!answered['l' + q.n] && now > target.start + 3000){ answered['l' + q.n] = 1; G.drivePick(SS, 'latecomer', now, 'res', target.d.result); }
      }
    }
    const r = SS.tv;
    if(r && r.state === 'ask'){
      if(r.n !== lastRound){ lastRound = r.n; rounds++; if(r.kind === 'half') halfRound = true; }
      if(!r.ans.oracle && now - r.qAt > 3000) G.answer(SS, 'oracle', now, r.n, r.qs.adult[r.i].c);
      if(!r.ans.kid && now - r.qAt > 6000) G.answer(SS, 'kid', now, r.n, Math.floor(Math.random() * 4));
    }
    if(Math.floor(now / 1000) % 15 === 0){
      maxPhone = Math.max(maxPhone, JSON.stringify(G.phoneView(SS, 'oracle', now)).length);
      maxJumbo = Math.max(maxJumbo, JSON.stringify(G.jumboView(SS, now)).length);
    }
    if(!reloads && SS.phase === 'half'){ SS = G.load(G.save(SS)); reloads++; }
    cur += 1000;
  }
  const P = SS.players;
  const acc = id => P[id].calls ? P[id].right / P[id].calls : 0;
  const pp = SS.pp, made = Object.keys(dpushes).length;
  const playPushes = SS.pN;   // all pushes, both kinds
  console.log('  ' + sc.length + ' snaps, ' + pushed + ' plays the caller tried to push, ' + N.drives.length + ' drives, ' + reviews.length + ' reviews');
  ok(Math.abs(SS.D - Dtrue) < 1500, 'D measured from ' + (opts.sync === 'snaps' ? '⏱ taps alone' : 'KICK and lock taps') + ': ' + (SS.D / 1000).toFixed(1) + ' s (true ' + Dtrue / 1000 + ')');
  ok(P.oracle.calls >= pushed * 0.6, 'pushed plays settle: the oracle\'s answer counted on ' + P.oracle.calls + ' of ' + pushed + ' (a push waits while the last unlocked one waits for ESPN)');
  ok(acc('oracle') > 0.97, 'each push is matched to the right play: oracle ' + Math.round(100 * acc('oracle')) + '% right');
  const kk = P.kicker.kicks || [0, 0];
  ok(kk[1] >= kicks * 0.6 && kk[0] === kk[1], 'punts, field goals and 4th downs settle: kicker right on ' + kk[0] + ' of ' + kk[1] + ' (' + kicks + ' pushed)');
  ok((P.gambler.tos || 0) <= lostPushed && P.gambler.toTried > 10 && (lostPushed === 0 || P.gambler.tos > 0), '💥 pays only when the ball is lost: ' + (P.gambler.tos || 0) + ' of ' + P.gambler.toTried + ' (' + lostPushed + ' lost on pushed plays)');
  ok(P.cheater.calls === 0, 'an answer after the snap never counts: cheater ' + P.cheater.calls + ' counted');
  ok(P.coin.calls > 10 && acc('coin') > 0.25 && acc('coin') < 0.75, 'a coin is a coin: ' + Math.round(100 * acc('coin')) + '% of ' + P.coin.calls);
  const dst = P.driver.dstat || {};
  const fieldsOk = Object.keys(G.DRIVE_Q).every(f => dst[f] && dst[f][0] === dst[f][1]);
  ok(P.driver.drives >= made * 0.6 && fieldsOk, 'pushed drives settle right: driver ' + Object.entries(dst).map(([f, x]) => f + ' ' + x[0] + '/' + x[1]).join(', ') + ' (' + made + ' drive pushes)');
  const auto = Object.values(dpushes).filter(b => b === '_auto').length, boss = made - auto;
  // over a stream the feed is ahead of the TV and pushes the drive the moment
  // the TV shows the ball change hands - before anybody's thumb
  ok(auto > 3 && made >= (N.drives.length - 2) * 0.8, 'nearly every drive was asked about: ' + made + ' of ' + N.drives.length + ', ' + boss + ' pushed by hand, ' + auto + ' by the feed');
  ok(!(P.latecomer.dstat && P.latecomer.dstat.res && P.latecomer.dstat.res[1]), 'an answer after the drive started never counts: latecomer ' + JSON.stringify((P.latecomer.dstat || {}).res || [0, 0]));
  if(locks){
    const lk = SS.lockLog.filter(x => x.kind === 'play').map(x => Math.abs(x.s - Dtrue));
    lk.sort((a, b) => a - b);
    ok(lk.length > 5 && lk[lk.length >> 1] < 2500, 'lock taps line up with ESPN\'s snaps: ' + lk.length + ' locks, median miss ' + (lk[lk.length >> 1] / 1000).toFixed(1) + ' s');
  }
  ok(rounds >= 4 && halfRound, 'trivia rounds in breaks: ' + rounds + ', and at halftime');
  if(reviews.length){
    ok(P.flagger.reviews === reviews.length, 'reviews settled' + (opts.room ? ' (room said ' + (opts.room === 'wrong' ? 'the WRONG ruling, the feed corrected it)' : 'the ruling first)') : ' from the feed') + ': ' + P.flagger.reviews + ' of ' + reviews.length);
  }
  ok(SS.phase === 'final' && reloads === 1, 'the game ends (' + SS.phase + '), having survived a reload at halftime');
  ok(maxPhone < 14000 && maxJumbo < 9000, 'messages stay small: phone ' + maxPhone + ' B, jumbotron ' + maxJumbo + ' B');
  const aw = G.awards(SS);
  ok(aw.length >= 4, 'awards: ' + aw.map(a => a.t + ' ' + a.n).join(', '));
}

// classifying: every play of every fixture is something
{
  console.log('feed.js');
  for(const f of fs.readdirSync('tests/fixtures').filter(f => f.endsWith('.json'))){
    const N = normalize(JSON.parse(fs.readFileSync('tests/fixtures/' + f)));
    const calls = N.plays.filter(p => p.kind === 'run' || p.kind === 'pass').length;
    ok(calls > 100 && N.drives.every(d => d.result), f + ': ' + N.plays.length + ' plays, ' + calls + ' to call, every drive has an ending');
  }
}

// kicks: what ESPN's words say happened
{
  console.log('\nkicks');
  const {kickOf} = await import('./web/feed.js');
  const t = (type, text, y, want) => { const k = kickOf(type, text, y); const got = k ? (k.fg ? 'fg:' + k.fg : 'punt:' + k.punt + (k.punt === 'ret' ? k.ret : '')) : null;
    ok(got === want, type + ' "' + text.slice(0, 60) + '" -> ' + got); };
  t('Punt', 'T.Way punts 54 yards to PHI 27, Center-T.Ott, fair catch by C.DeJean.', 0, 'punt:fair');
  t('Punt', 'B.Mann punts 42 yards to WAS 23, Center-R.Underwood. L.McCaffrey to 50 for 27 yards (R.Underwood).', 27, 'punt:ret27');
  t('Punt Return', '(07:36) #99 J.DuPont punt 47 yards to the Utah30 #8 M.Carvalho return 9 yards to the Utah39', 9, 'punt:ret9');
  t('Punt', 'B.Mann punts 56 yards to end zone, Center-R.Underwood, Touchback.PENALTY on WAS-T.Owens, Illegal Block Above the Waist', 0, 'punt:none');
  t('Punt', 'Sam Vander Haar punt for 34 yds , Mana Carvalho muffs the punt, recovered by BYU', 0, 'punt:muffed');
  t('Blocked Punt', 'J.Smith punt blocked by K.Jones', 0, 'punt:blocked');
  t('Field Goal Missed', 'J.Elliott 41 yard field goal is No Good, Hit Left Upright', 0, 'fg:miss');
  t('Field Goal Good', 'D. Curtis 27 yd FG GOOD', 0, 'fg:good');
  t('Blocked Field Goal', 'K. Konrardy 48 yd FG BLOCKED', 0, 'fg:blocked');
}

// trivia can be ended early - by a grown-up, or by asking the room about the game
{
  console.log('\ntrivia, cut short');
  const S = G.create({team: '252'});
  G.join(S, 'mom', 'Mom'); G.join(S, 'kid', 'Kid', true);
  G.ad(S, 'mom', 1e6);
  G.endTrivia(S, 'kid', 1e6 + 2000);
  ok(S.tv && S.tv.state !== 'done', 'a kid cannot end it');
  G.endTrivia(S, 'mom', 1e6 + 3000);
  ok(S.tv.state === 'done' && S.tv.skipped === 'Mom', 'a grown-up can');
  G.ad(S, 'mom', 1e6 + 70000);
  ok(S.tv.state !== 'done', '📺 starts another');
  G.push(S, 'play', 'mom', 1e6 + 72000);
  ok(S.tv.state === 'done' && S.pp.length === 1, 'calling for a play ends it and opens the play');
}

// who is who: a phone that lost its saved id gets its score back by name
{
  console.log('\nrejoining');
  const S = G.create({team: '252'});
  G.join(S, 'devA', 'Grandpa'); S.players.devA.score = 120;
  let r = G.resolve(S, 'devA', 'Grandpa');
  ok(r.id === 'devA' && !r.back, 'the same phone is the same player');
  r = G.resolve(S, 'devB', ' grandpa ');
  ok(r.id === 'devA' && r.back, 'a new phone with the same name gets the score back');
  ok(G.resolve(S, 'devB', 'anything').id === 'devA', 'and keeps it after');
  G.join(S, 'devC', 'Mom');
  r = G.resolve(S, 'devD', 'Mom', id => id === 'devC');
  ok(r.id === 'devD', 'but not the score of somebody connected right now');
  const p = G.fresh(S, 'devB', 'Grandpa');
  ok(p.id === 'devB' && p.name === 'Grandpa 2' && S.players.devA.score === 120, '"not me" starts fresh as ' + p.name + ', the real Grandpa keeps 120');
  const S2 = G.load(G.save(S));
  ok(S2.players.devA.score === 120 && G.resolve(S2, 'devB', 'Grandpa 2').id === 'devB', 'all of it survives the jumbotron reloading');
}

await run('byu-utah-2025.json', '252', 8000, 'BYU 24, Utah 21 (2025), over an antenna');
await run('byu-utah-2025.json', '252', 45000, 'The same game on a streaming app');
await run('utah-isu-2026.json', '254', 5000, 'Utah at Iowa State (2026): five reviews');
await run('utah-isu-2026.json', '254', 5000, 'The same, the room calling the rulings - wrongly', {room: 'wrong'});
await run('nfl-phi-wsh-2026.json', '21', 30000, 'NFL: Eagles at Commanders (2026), streamed');
await run('byu-utah-2025.json', '252', 40000, 'No KICK taps and no locks: synced from ⏱ alone, streamed', {sync: 'snaps', noLocks: true});

console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);

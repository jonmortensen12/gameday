/* Game Day - the game, headless, through real games.

   Plays recorded ESPN feeds (tests/fixtures/) through game.js the way the
   jumbotron would see them live: each play reaching the feed 25-55 s after
   it happened, polled every 3 s, the TV running D behind real time.
   Pretend people play along:

     oracle   - calls every play right, 8 s before the snap on the TV
     cheater  - calls every play right, 2 s AFTER the snap on the TV
                (must land on the next play instead, so do no better than
                guessing)
     coin     - calls at random
     tapper   - taps KICK at every kickoff, the moment the TV shows it
     driver   - votes the right ending for every drive as the question opens
     flagger  - flags every review and votes the right ruling
     kid      - in kids' mode, answers trivia at random

   and the check asks: did the right calls score, the late ones not, D come
   out where the TV really is, every drive question settle, trivia run in
   the breaks, reviews settle from the feed, and the state survive a
   reload. Run from the repo root: node gamecheck.mjs */
import fs from 'fs';
import {normalize, replaySource} from './web/feed.js';
import * as G from './web/game.js';

let fails = 0;
function ok(c, msg){ console.log((c ? '  ok   ' : '  FAIL ') + msg); if(!c) fails++; }

async function run(file, team, Dtrue, label){
  console.log('\n' + label + ' (' + file + '), TV ' + Dtrue / 1000 + ' s behind');
  const raw = JSON.parse(fs.readFileSync('tests/fixtures/' + file));
  const N = normalize(raw);
  let cur = 0;
  const src = replaySource('cfb', 'x', {summary: N, clock: () => cur, preroll: 180});
  await src.ready;
  let SS = G.create({team, seed: 7});
  const S0 = SS;
  const ids = ['oracle', 'cheater', 'coin', 'tapper', 'driver', 'flagger', 'kid'];
  ids.forEach(id => G.join(SS, id, id, id === 'kid'));
  const tvOf = p => p.wall + Dtrue;
  // a play with a wrong wallclock in the feed is never scored (feed.js), and
  // when it really happened is unknown, so nobody here calls it
  const calls = N.plays.filter(p => (p.kind === 'run' || p.kind === 'pass') && !p.badWall);
  const kicks = N.plays.filter(p => p.kind === 'kickoff' && !p.badWall);
  // the play each review is about: the one before the play that reports it
  const reviews = N.plays.map((p, i) => ({p, i})).filter(x => x.p.review && x.p.review !== 'pending')
    .map(x => ({at: N.plays[x.i - 1] || x.p, v: x.p.review}));
  const events = [];
  calls.forEach(p => {
    events.push({t: tvOf(p) - 8000, f: () => G.call(SS, 'oracle', src.now(), p.kind, p.yards >= 15)});
    events.push({t: tvOf(p) + 2000, f: () => G.call(SS, 'cheater', src.now(), p.kind, false)});
    events.push({t: tvOf(p) - 10000, f: () => G.call(SS, 'coin', src.now(), Math.random() < 0.5 ? 'run' : 'pass', false)});
  });
  kicks.forEach(p => events.push({t: tvOf(p) + (Math.random() - 0.5) * 800, f: () => G.kick(SS, 'tapper', src.now())}));
  reviews.forEach(r => {
    events.push({t: tvOf(r.at) + 15000, f: () => G.flag(SS, 'flagger', src.now())});
    events.push({t: tvOf(r.at) + 25000, f: () => G.reviewVote(SS, 'flagger', src.now(), r.v)});
  });
  events.sort((a, b) => a.t - b.t);

  const end = N.plays[N.plays.length - 1].wall + 180000;
  let nextPoll = 0, ei = 0, rounds = 0, halfRound = false, lastRound = 0, maxPhone = 0, maxJumbo = 0;
  const driveSeen = {};
  let reloads = 0;
  for(;;){
    const now = src.now();
    if(now > end) break;
    while(ei < events.length && events[ei].t <= now) events[ei++].f();
    if(now >= nextPoll){ G.feed(SS, await src.poll(), now); nextPoll = now + 3000; }
    G.tick(SS, now);
    // the driver votes the real ending of whatever drive the question is about
    const q = SS.dq;
    if(q && !q.votes.driver && !driveSeen[q.n]){
      driveSeen[q.n] = 1;
      const idx = q.after ? N.drives.findIndex(d => d.id === q.after) : -1;
      const d = N.drives[idx + 1];
      if(d && d.result && d.result !== 'void') G.driveVote(SS, 'driver', now, d.result);
    }
    // trivia: the oracle reads the answer, the kid guesses
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
    // halfway through, the jumbotron is reloaded: the game must carry on
    if(!reloads && SS.phase === 'half'){ SS = G.load(G.save(SS)); reloads++; }
    cur += 1000;
  }
  const P = SS.players;
  const acc = id => P[id].calls ? P[id].right / P[id].calls : 0;
  const runs = calls.filter(p => p.kind === 'run').length;
  console.log('  ' + calls.length + ' plays to call (' + runs + ' runs), ' + kicks.length + ' kickoffs, ' + N.drives.length + ' drives, ' + reviews.length + ' reviews');
  ok(Math.abs(SS.D - Dtrue) < 1500, 'D measured from kickoff taps: ' + (SS.D / 1000).toFixed(1) + ' s (true ' + Dtrue / 1000 + ')');
  ok(P.oracle.calls >= calls.length * 0.9, 'every play got the oracle\'s call settled: ' + P.oracle.calls + ' of ' + calls.length);
  ok(acc('oracle') > 0.97, 'calls made before the snap score: oracle ' + Math.round(100 * acc('oracle')) + '%');
  ok(acc('cheater') < 0.75, 'calls made after the snap do not: cheater ' + Math.round(100 * acc('cheater')) + '% (guessing is ~' + Math.round(100 * Math.max(runs, calls.length - runs) / calls.length) + '%)');
  ok(acc('coin') > 0.3 && acc('coin') < 0.7, 'a coin is a coin: ' + Math.round(100 * acc('coin')) + '%');
  ok(P.oracle.score > P.cheater.score && P.cheater.score > 0, 'oracle ' + P.oracle.score + ' > cheater ' + P.cheater.score + ' > 0');
  const settled = SS.dqPast.length ? null : 0;
  const dr = P.driver.drives, counted = N.drives.filter(d => d.result && d.result !== 'void').length;
  ok(dr >= counted * 0.8, 'drive questions settle: driver right on ' + dr + ' of ' + counted + ' drives');
  ok(rounds >= 4, 'trivia rounds in breaks: ' + rounds);
  ok(halfRound, 'a halftime round');
  if(reviews.length){
    ok(P.flagger.reviews === reviews.length, 'reviews settled from the feed: ' + P.flagger.reviews + ' of ' + reviews.length);
  }
  ok(P.oracle.tvRight > 0 && P.kid.score > 0, 'trivia scores: oracle ' + P.oracle.tvRight + ' right, kid ' + P.kid.score + ' pts');
  ok(SS.phase === 'final', 'the game ends: ' + SS.phase);
  ok(reloads === 1, 'survived a reload at halftime');
  ok(maxPhone < 6000 && maxJumbo < 9000, 'messages stay small: phone ' + maxPhone + ' B, jumbotron ' + maxJumbo + ' B');
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

await run('byu-utah-2025.json', '252', 8000, 'BYU 24, Utah 21 (2025), over an antenna');
await run('byu-utah-2025.json', '252', 45000, 'The same game on a streaming app');
await run('utah-isu-2026.json', '254', 5000, 'Utah at Iowa State (2026): three reviews');

console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);

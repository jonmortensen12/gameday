/* Game Day - the game, and nothing but the game.

   Pure: no DOM, no network, no clock of its own. The host feeds it the
   ESPN feed (feed.js, normalized), what the phones did, and the time, and
   asks it what each screen should show. gamecheck.mjs runs a whole real
   game through it headless.

   TIME. Everything is in the feed's terms: `wall`, the real time a play
   happened. A phone's tap is stamped by the host when it arrives (the
   phones' own clocks are never trusted). What the room SEES is the TV,
   which runs D behind the wall clock - an antenna a few seconds, a
   streaming app up to a minute. So a play "happened on the TV" at
   wall + D. D starts at a guess and is measured at kickoffs: people tap
   KICK the moment the ball is kicked on the TV, and when the kickoff turns
   up in the feed (~40 s later) D = tap - wallclock.

   CALLING PLAYS. The feed is about one play behind the TV, so it can never
   open or close a call. Instead every call is timestamped, and when a play
   arrives the call that counts is each person's last one made before that
   play's snap appeared on the TV. Anything after the snap waits for the
   next play: no cheating possible, no referee needed.

   DRIVES. One question is always open: how does the NEXT drive end? It
   locks at that drive's first snap and the next one opens straight away.
   Being about the next drive rather than this one is what makes the feed's
   delay not matter.

   REVIEWS. The feed only says what the ruling was, on the play after. So
   the room starts a review (any phone's flag), votes for 45 seconds, and
   the feed settles it; if the feed never does, the room is asked.

   BREAKS. Trivia starts when the feed shows a stoppage that means
   commercials (after a score's kickoff, a timeout, the end of a quarter,
   halftime) and stops when play is back. A phone can start one too. */

import {BANK, liveQuestions} from './trivia.js';

export const PROTO = 1;
const SEC = 1000;
export const T = {
  margin: 1.5 * SEC,          // a call this close to the snap is too late
  dGuess: 6 * SEC,            // D before anybody has tapped a kickoff
  reviewVote: 45 * SEC,
  reviewAsk: 4 * 60 * SEC,    // nothing from the feed this long after a flag: ask the room
  qTime: 15 * SEC, qReveal: 5 * SEC,
  roundCool: 3 * 60 * SEC,    // between trivia rounds
  adCool: 60 * SEC,           // the 📺 button
  breakQs: 3, halfQs: 10,
  bigYards: 15,
  ticketsKept: 4,
};
export const PTS = {call: 10, minority: 10, big: 20, drive: 25, review: 40, flag: 5, trivia: 15, speed: 5};
const DRIVE_OPTS = ['td', 'fg', 'punt', 'turnover'];
export const DRIVE_LABEL = {td: 'Touchdown', fg: 'Field goal', punt: 'Punt', turnover: 'Turnover', void: 'No result'};

function rng(s){ return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function median(a){ const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; }
function clean(n){ return String(n || '').replace(/[^\p{L}\p{N} '\-]/gu, '').trim().slice(0, 14); }

export function create(cfg = {}){
  return {
    proto: PROTO,
    team: String(cfg.team || '252'), league: cfg.league || 'cfb', event: String(cfg.event || ''),
    seed: (cfg.seed >>> 0) || 1,
    D: T.dGuess, dTaps: [],                 // TV delay and the kickoff measurements behind it
    players: {}, order: 0,
    done: {},                               // play id -> processed
    queue: [], queued: {},                  // in the feed, not on the TV yet
    last: 0,                                // TV time of the newest processed play
    teams: {}, status: {state: 'pre', period: 0}, phase: 'pre',
    drives: [],                             // [{id, team}] in feed order
    dq: null, dqN: 0, dqPast: [],           // the drive question
    rv: null, rvN: 0, rvKnown: {},          // the review
    tv: null, tvN: 0, tvUsed: [], tvLast: -1e15, adLast: -1e15,   // trivia
    kick: {open: true, why: 'start', taps: []},
    roc: [],                                // the room's last calls, right or wrong
    log: [],                                // what the jumbotron announces
    clips: [],                              // reaction clips (just their labels; the video stays in the browser)
    lastPlay: null,
  };
}

/* ---------- people ---------- */
export function join(S, id, name, kid){
  let p = S.players[id];
  if(!p) p = S.players[id] = {id, n: 0, score: 0, streak: 0, best: 0, right: 0, calls: 0,
    picks: [], tickets: [], j: ++S.order, tvRight: 0, drives: 0, reviews: 0, bigs: 0};
  p.name = clean(name) || p.name || 'Cougar';
  p.kid = !!kid;
  return p;
}
function pts(S, p, n, why){ p.score += n; return n; }
function ticket(p, t){ p.tickets.push(t); if(p.tickets.length > 12) p.tickets.splice(0, p.tickets.length - 12); }

/* ---------- what phones do ---------- */
export function call(S, id, now, v, big){
  const p = S.players[id];
  if(!p || (v !== 'run' && v !== 'pass')) return;
  p.picks.push({t: now, v, big: !!big});
  if(p.picks.length > 20) p.picks.shift();
  p.lastCall = {t: now, v, big: !!big};
}

export function driveVote(S, id, now, v){
  const p = S.players[id], q = S.dq;
  if(!p || !q || q.locked || DRIVE_OPTS.indexOf(v) < 0) return;
  q.votes[id] = {v, t: now};
}

export function flag(S, id, now){
  const p = S.players[id];
  if(!p) return;
  if(S.rv && S.rv.state !== 'done') return;
  if(S.rv && now - S.rv.at < 60 * SEC) return;     // the same review, flagged twice
  S.rv = {n: ++S.rvN, by: id, at: now, state: 'vote', votes: {}, result: null,
    known: Object.assign({}, S.rvKnown)};
  S.log.push({k: 'review', at: now, by: p.name});
}
export function reviewVote(S, id, now, v){
  const r = S.rv;
  if(!r || r.state !== 'vote' || !S.players[id] || (v !== 'stands' && v !== 'overturned')) return;
  r.votes[id] = {v, t: now};
}
export function refSaid(S, id, now, v){
  const r = S.rv;
  if(!r || r.state !== 'ask') return;
  if(v === 'none'){ r.state = 'done'; r.result = 'none'; r.doneAt = now; return; }
  if(v === 'stands' || v === 'overturned') settleReview(S, v, now, 'room');
}

export function kick(S, id, now){
  if(!S.players[id] || !S.kick.open) return;
  if(S.kick.taps.some(k => k.id === id && now - k.t < 20 * SEC)) return;
  S.kick.taps.push({id, t: now});
}

export function ad(S, id, now){
  if(now - S.adLast < T.adCool) return;
  S.adLast = now;
  startRound(S, now, 'break', null, 'phone');
}

export function answer(S, id, now, n, i){
  const r = S.tv, p = S.players[id];
  if(!r || !p || r.n !== n || r.state !== 'ask') return;
  const k = p.kid ? 'kid' : 'adult';
  const Q = r.qs[k][r.i];
  if(!Q || r.ans[id] || i < 0 || i > 3) return;
  r.ans[id] = {i, t: now, k};
}

/* ---------- trivia rounds ---------- */
function pickQs(S, n, kid, live){
  const R = rng(S.seed + S.tvN * 977 + (kid ? 13 : 0));
  const pool = BANK.filter(q => !!q.kid === !!kid && S.tvUsed.indexOf(q.id) < 0);
  const out = [];
  if(!kid && live) live.filter(q => S.tvUsed.indexOf(q.id) < 0).slice(0, n > 3 ? 2 : 1).forEach(q => out.push(q));
  while(out.length < n && pool.length) out.push(pool.splice(Math.floor(R() * pool.length), 1)[0]);
  if(out.length < n){   // the bank has run dry: start it over
    const again = BANK.filter(q => !!q.kid === !!kid && out.indexOf(q) < 0);
    while(out.length < n && again.length) out.push(again.splice(Math.floor(R() * again.length), 1)[0]);
  }
  out.forEach(q => S.tvUsed.push(q.id));
  // shuffle the answers, remembering where the right one went
  return out.map(q => {
    const order = [0, 1, 2, 3].sort(() => R() - 0.5);
    return {id: q.id, q: q.q, a: order.map(o => q.a[o]), c: order.indexOf(0), note: q.note || ''};
  });
}

function startRound(S, now, kind, N, why){
  if(S.tv && S.tv.state !== 'done') return false;
  if(kind !== 'half' && now - S.tvLast < T.roundCool && why !== 'phone') return false;
  if(S.phase === 'final' && kind !== 'final') return false;
  const n = kind === 'half' || kind === 'final' ? T.halfQs : T.breakQs;
  const live = liveQuestions(N, S.team, S.seed + S.tvN);
  S.tv = {n: ++S.tvN, kind, why, at: now, i: 0, state: 'ask', qAt: now, ans: {}, past: [], ending: false,
    qs: {adult: pickQs(S, n, false, live), kid: pickQs(S, n, true, null)}};
  S.tvLast = now;
  S.log.push({k: 'trivia', at: now, kind});
  return true;
}

function stepRound(S, now){
  const r = S.tv;
  if(!r || r.state === 'done') return;
  if(r.state === 'ask'){
    const everyone = Object.values(S.players).filter(p => p.on !== false);
    const all = everyone.length && everyone.every(p => r.ans[p.id]);
    if(now - r.qAt >= T.qTime || (all && now - r.qAt > 3 * SEC)){
      // score it
      const res = {i: r.i, right: {adult: r.qs.adult[r.i].c, kid: r.qs.kid[r.i] ? r.qs.kid[r.i].c : -1}, who: {}};
      Object.entries(r.ans).forEach(([id, a]) => {
        const p = S.players[id];
        if(!p) return;
        const Q = r.qs[a.k][r.i];
        if(Q && a.i === Q.c){
          const quick = Math.max(0, 1 - (a.t - r.qAt) / T.qTime);
          const got = pts(S, p, PTS.trivia + Math.round(PTS.speed * quick));
          p.tvRight++;
          res.who[id] = got;
        } else res.who[id] = 0;
      });
      r.past.push(res);
      r.state = 'reveal'; r.revealAt = now;
    }
  } else if(r.state === 'reveal' && now - r.revealAt >= T.qReveal){
    if(r.ending || r.i + 1 >= r.qs.adult.length){ r.state = 'done'; r.doneAt = now; return; }
    r.i++; r.ans = {}; r.qAt = now; r.state = 'ask';
  }
}

/* ---------- reviews ---------- */
function settleReview(S, v, now, how){
  const r = S.rv;
  if(!r || r.state === 'done') return;
  r.state = 'done'; r.result = v; r.how = how; r.doneAt = now;
  const by = S.players[r.by];
  if(by) pts(S, by, PTS.flag);
  Object.entries(r.votes).forEach(([id, x]) => {
    const p = S.players[id];
    if(!p) return;
    if(x.v === v){ pts(S, p, PTS.review); p.reviews++; }
  });
  S.log.push({k: 'ruling', at: now, v});
}
function stepReview(S, now){
  const r = S.rv;
  if(!r || r.state === 'done') return;
  if(r.state === 'vote' && now - r.at >= T.reviewVote) r.state = 'wait';
  if(r.state === 'wait' && now - r.at >= T.reviewAsk) r.state = 'ask';
}

/* ---------- the feed ---------- */
function tvTime(S, p){ return p.wall + S.D; }

function rocPush(S, ok){ S.roc.push(ok ? 1 : 0); if(S.roc.length > 40) S.roc.shift(); }

/* A play to call came in: settle everybody's call for it. */
function settleCall(S, P, now){
  const snap = tvTime(S, P) - T.margin;
  const used = {};
  Object.values(S.players).forEach(p => {
    const mine = p.picks.filter(c => c.t <= snap);
    if(!mine.length) return;
    p.picks = p.picks.filter(c => c.t > snap);
    used[p.id] = mine[mine.length - 1];
  });
  const ids = Object.keys(used);
  if(!ids.length) return;
  const isCall = P.kind === 'run' || P.kind === 'pass';
  const share = {run: 0, pass: 0};
  ids.forEach(id => { share[used[id].v]++; });
  const big = isCall && P.yards >= T.bigYards;
  const line = playLine(S, P);
  const tally = {run: share.run, pass: share.pass, kind: P.kind, line, right: 0, at: now, id: P.id};
  ids.forEach(id => {
    const p = S.players[id], c = used[id];
    const t = {play: P.id, v: c.v, big: c.big, line, at: now, pts: 0};
    if(!isCall){ t.res = 'none'; ticket(p, t); return; }
    p.calls++;
    const ok = c.v === P.kind;
    rocPush(S, ok);
    if(ok){
      p.right++; p.streak++; p.best = Math.max(p.best, p.streak);
      const mult = p.streak >= 5 ? 2 : p.streak >= 3 ? 1.5 : 1;
      let n = PTS.call;
      if(share[c.v] / ids.length <= 0.34 && ids.length >= 3){ n += PTS.minority; t.few = share[c.v]; }
      t.pts += pts(S, p, Math.round(n * mult));
      t.mult = mult;
      tally.right++;
    } else p.streak = 0;
    if(c.big){
      if(big){ t.pts += pts(S, p, PTS.big); t.bigHit = 1; p.bigs++; }
      else { p.streak = 0; t.bigMiss = 1; }
    }
    t.res = ok ? 'right' : 'wrong';
    t.streak = p.streak;
    ticket(p, t);
  });
  S.lastCall = tally;
}

export function playLine(S, P){
  const t = S.teams[P.off];
  let s = P.text.replace(/^\([^)]*\)\s*/, '').replace(/\s+/g, ' ');
  s = s.replace(/^(No Huddle-)?(Shotgun|Pistol|Under Center)\s*/i, '').replace(/#\d+\s*/g, '');
  s = s.split(/\. The previous play|\(Original Play|, clock \d/)[0];
  if(s.length > 90) s = s.slice(0, 88).replace(/\s+\S*$/, '') + '...';
  return (t ? t.abbr + ': ' : '') + s;
}

/* The drive question: open on the drive after `after` (a drive id, or null
   for the first one of the game). */
function openDrive(S, after, now){
  const idx = after ? S.drives.findIndex(d => d.id === after) : -1;
  const prev = idx >= 0 ? S.drives[idx] : null;
  const other = prev ? Object.keys(S.teams).find(k => k !== prev.team) : null;
  S.dq = {n: ++S.dqN, after, target: null, team: other, at: now, votes: {}, locked: false, lockAt: null};
}
function driveFor(S, q){
  if(q.target) return S.drives.find(d => d.id === q.target);
  const idx = q.after ? S.drives.findIndex(d => d.id === q.after) : -1;
  if(q.after && idx < 0) return null;
  return S.drives[idx + 1] || null;
}
function stepDrive(S, N, now){
  const q = S.dq;
  if(!q){ if(S.phase !== 'final') openDrive(S, null, now); return; }
  const d = driveFor(S, q);
  if(!d) return;
  q.target = d.id; q.team = d.team;
  if(!q.locked){
    // locks at the drive's first real snap (its kickoff does not count)
    const first = N.plays.find(p => p.drive === d.id && (p.kind === 'run' || p.kind === 'pass' || p.kind === 'special'));
    if(!first || tvTime(S, first) > now) return;     // not on the TV yet
    q.locked = true; q.lockAt = tvTime(S, first) - T.margin;
    Object.keys(q.votes).forEach(id => { if(q.votes[id].t > q.lockAt) q.votes[id].late = true; });
    S.dqPast.push(q);
    if(S.dqPast.length > 6) S.dqPast.shift();
    openDrive(S, d.id, now);
  }
}
function settleDrives(S, N, now){
  S.dqPast.forEach(q => {
    if(q.result) return;
    const d = N.drives.find(x => x.id === q.target);
    if(!d || !d.result) return;
    q.result = d.result; q.doneAt = now;
    const team = S.teams[d.team];
    q.line = (team ? team.name + ' drive: ' : 'Drive: ') + (d.raw || DRIVE_LABEL[d.result]);
    if(d.result === 'void') return;
    Object.entries(q.votes).forEach(([id, x]) => {
      const p = S.players[id];
      if(!p || x.late) return;
      if(x.v === q.result){ pts(S, p, PTS.drive); p.drives++; ticket(p, {drive: q.n, v: x.v, res: 'right', pts: PTS.drive, line: q.line, at: now}); }
      else ticket(p, {drive: q.n, v: x.v, res: 'wrong', pts: 0, line: q.line, at: now});
    });
    S.log.push({k: 'drive', at: now, line: q.line, result: q.result});
  });
}

/* A kickoff is in the feed and the prompt was open: wait for the taps
   (over a streaming app the feed can be ahead of the TV, so they may not
   have happened yet), then measure from all of them three seconds after
   the first. */
function stepKick(S, now){
  const k = S.kick, P = k.pending;
  if(!P) return;
  const taps = k.taps.filter(x => x.t >= P.wall - 20 * SEC && x.t <= P.until);
  if(taps.length ? now - taps[0].t >= 3 * SEC : now > P.until) measureKick(S, P, now);
}
function measureKick(S, P, now){
  const k = S.kick;
  const lo = P.wall - 20 * SEC, hi = P.until;
  const taps = k.taps.filter(x => x.t >= lo && x.t <= hi);
  k.pending = null;
  if(taps.length){
    const firsts = {};
    taps.forEach(x => { if(!(x.id in firsts)) firsts[x.id] = x.t; });
    const sample = median(Object.values(firsts)) - P.wall;
    S.dTaps.push(sample);
    if(S.dTaps.length > 5) S.dTaps.shift();
    S.D = median(S.dTaps);
    S.log.push({k: 'synced', at: now, d: S.D, n: Object.keys(firsts).length});
  }
  k.taps = k.taps.filter(x => x.t > hi);
  k.open = false;
}

/* Everything new in a feed snapshot. */
export function feed(S, N, now){
  if(!N) return;
  S.teams = N.teams;
  S.status = N.status;
  S.drives = N.drives.map(d => ({id: d.id, team: d.team}));
  // New plays wait until the TV has shown them: over a streaming app the
  // feed can be AHEAD of the TV, and a call cannot be settled before the
  // room has seen the snap.
  N.plays.forEach(p => { if(!S.done[p.id] && !S.queued[p.id]){ S.queued[p.id] = 1; S.queue.push(p); } });
  let n = 0;
  while(n < S.queue.length && tvTime(S, S.queue[n]) <= now) n++;
  const fresh = S.queue.splice(0, n);
  if(fresh.length && S.phase === 'pre') S.phase = 'live';
  let breakWhy = null, half = false;
  fresh.forEach(P => {
    S.done[P.id] = 1; delete S.queued[P.id];
    S.last = Math.max(S.last, tvTime(S, P));
    if(P.kind === 'kickoff' && !P.badWall){
      if(S.kick.open || S.kick.taps.length) S.kick.pending = {wall: P.wall, until: P.wall + 120 * SEC};
      if(S.afterScore){ breakWhy = 'score'; S.afterScore = false; }
    }
    // a kickoff does not use up anybody's call: calls made during the
    // commercial are for the first snap after it
    if(P.kind === 'run' || P.kind === 'pass' || P.kind === 'special' || P.kind === 'kickoff'){
      if(P.kind !== 'kickoff' && !P.badWall) settleCall(S, P, now);
      S.lastPlay = {line: playLine(S, P), kind: P.kind, at: now, team: P.off};
      // play is back on while a round runs: finish the question and stop
      if(S.tv && S.tv.state !== 'done' && P.kind !== 'kickoff' && tvTime(S, P) > S.tv.at) S.tv.ending = true;
    }
    if(P.scoring){
      // who scored: the side whose score went up
      const prevH = S.scoreH || 0, prevA = S.scoreA || 0;
      const side = P.home > prevH ? N.homeId : P.away > prevA ? N.awayId : P.off;
      const pointsUp = Math.max(P.home - prevH, P.away - prevA);
      S.log.push({k: 'score', at: now, team: side, ours: side === S.team, td: pointsUp >= 6 || P.td, line: playLine(S, P),
        h: P.home, a: P.away});
      S.afterScore = true;
      S.kick.open = true; S.kick.why = 'score';
    }
    if(P.scoring || P.home || P.away){ S.scoreH = Math.max(S.scoreH || 0, P.home); S.scoreA = Math.max(S.scoreA || 0, P.away); }
    if(P.kind === 'timeout' && !/official/i.test(P.type) && !breakWhy) breakWhy = 'timeout';
    if(P.kind === 'timeout' && /official/i.test(P.type)) breakWhy = 'tv';
    if(P.kind === 'period'){ if(P.period === 2){ half = true; } else if(P.period === 1 || P.period === 3) breakWhy = 'quarter'; }
    if(P.kind === 'half') half = true;
    if(P.kind === 'final'){ S.phase = 'final'; }
  });
  if(half && S.phase !== 'final'){
    S.phase = 'half';
    S.kick.open = true; S.kick.why = 'half';
    startRound(S, now, 'half', N, 'half');
  } else if(S.phase === 'half' && fresh.some(p => p.period >= 3 && p.kind !== 'period')) S.phase = 'live';
  if(breakWhy && S.phase === 'live') startRound(S, now, 'break', N, breakWhy);
  if(N.status && N.status.state === 'post' && S.phase !== 'final'){ S.phase = 'final'; }
  if(S.phase === 'final' && !S.finalAt){ S.finalAt = now; S.log.push({k: 'final', at: now}); if(S.dq && !S.dq.locked) S.dq = null; }

  // reviews the feed has settled
  const reviewed = N.plays.filter(p => p.review && p.review !== 'pending');
  if(S.rv && S.rv.state !== 'done'){
    const hit = reviewed.find(p => !S.rv.known[p.id] && p.wall >= S.rv.at - S.D - 5 * 60 * SEC);
    if(hit) settleReview(S, hit.review, now, 'feed');
  }
  reviewed.forEach(p => { S.rvKnown[p.id] = 1; });

  for(let i = 0; i < 8; i++){            // several drives can arrive at once
    const was = S.dqN;
    if(S.phase === 'final' && !S.dq) break;
    stepDrive(S, N, now);
    if(S.dqN === was) break;
  }
  settleDrives(S, N, now);
  if(S.log.length > 60) S.log.splice(0, S.log.length - 60);
}

/* The clock moving with nothing new from the feed. */
export function tick(S, now){
  stepKick(S, now);
  stepRound(S, now);
  stepReview(S, now);
}

/* ---------- what the screens show ---------- */
export function rocMeter(S){ return S.roc.length ? Math.round(100 * S.roc.reduce((a, b) => a + b, 0) / S.roc.length) : 0; }

export function board(S){
  return Object.values(S.players).sort((a, b) => (b.score - a.score) || (a.j - b.j))
    .map((p, i) => ({id: p.id, n: p.name, s: p.score, st: p.streak, kid: p.kid ? 1 : 0, on: p.on === false ? 0 : 1, rank: i + 1}));
}

/* The room's calls for the next snap, as they stand: everybody's newest
   call made since the last play shown on the TV. */
export function split(S, now){
  const since = Math.max(S.last, now - 60 * SEC);
  const s = {run: 0, pass: 0, big: 0};
  Object.values(S.players).forEach(p => {
    const c = p.picks.filter(x => x.t > since).pop();
    if(c){ s[c.v]++; if(c.big) s.big++; }
  });
  return s;
}

function tvView(S, now, p){
  const r = S.tv;
  if(!r || r.state === 'done') return null;
  const k = p && p.kid ? 'kid' : 'adult';
  const Q = r.qs[k][r.i] || r.qs.adult[r.i];
  const v = {n: r.n, kind: r.kind, i: r.i, of: r.qs.adult.length, state: r.state, q: Q.q, a: Q.a,
    left: Math.max(0, Math.ceil((T.qTime - (now - r.qAt)) / 1000))};
  if(r.state === 'reveal'){ v.c = Q.c; v.note = Q.note; }
  if(p){
    const mine = r.ans[p.id];
    v.mine = mine ? mine.i : -1;
    if(r.state === 'reveal'){ const res = r.past[r.past.length - 1]; v.got = res && res.who[p.id] != null ? res.who[p.id] : null; }
  } else {
    v.answered = Object.keys(r.ans).length;
    if(r.state === 'reveal'){
      const res = r.past[r.past.length - 1];
      v.who = Object.entries(res.who).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => (S.players[id] || {}).name);
      v.kidQ = r.qs.kid[r.i] ? {q: r.qs.kid[r.i].q, a: r.qs.kid[r.i].a[r.qs.kid[r.i].c]} : null;
    } else v.kidQ = r.qs.kid[r.i] ? {q: r.qs.kid[r.i].q} : null;
  }
  return v;
}

function teamName(S, id){ const t = S.teams[id]; return t ? t.name : ''; }

function driveView(S, p){
  const q = S.dq;
  if(!q || q.locked) return null;
  const v = {n: q.n, team: teamName(S, q.team), ours: q.team === S.team, first: !q.after};
  if(p){ const m = q.votes[p.id]; v.mine = m ? m.v : null; }
  else { v.tally = {}; DRIVE_OPTS.forEach(o => { v.tally[o] = Object.values(q.votes).filter(x => x.v === o).length; }); }
  return v;
}

function reviewView(S, now, p){
  const r = S.rv;
  if(!r) return null;
  if(r.state === 'done' && now - r.doneAt > 25 * SEC) return null;
  const v = {n: r.n, state: r.state, by: (S.players[r.by] || {}).name || '',
    left: Math.max(0, Math.ceil((T.reviewVote - (now - r.at)) / 1000)), result: r.result};
  if(p){ const m = r.votes[p.id]; v.mine = m ? m.v : null; if(r.state === 'done') v.right = m ? m.v === r.result : null; }
  else { v.stands = Object.values(r.votes).filter(x => x.v === 'stands').length; v.over = Object.values(r.votes).filter(x => x.v === 'overturned').length;
    if(r.state === 'done') v.who = Object.entries(r.votes).filter(([, x]) => x.v === r.result).map(([id]) => (S.players[id] || {}).name); }
  return v;
}

function scoreView(S){
  const ids = Object.keys(S.teams);
  if(!ids.length) return null;
  const ours = S.teams[S.team] ? S.team : ids[0];
  const them = ids.find(k => k !== ours);
  const a = S.teams[ours], b = S.teams[them] || {};
  return {us: {n: a.name, abbr: a.abbr, s: a.score, c: a.color, alt: a.alt}, them: {n: b.name, abbr: b.abbr, s: b.score, c: b.color, alt: b.alt},
    detail: S.status.detail || '', state: S.status.state};
}

export function phoneView(S, id, now){
  const p = S.players[id];
  if(!p) return null;
  const b = board(S);
  const me = b.find(x => x.id === id);
  const pend = p.picks.filter(c => c.t > S.last - 0).slice(-1)[0];
  return {
    t: 'st', phase: S.phase, kid: p.kid ? 1 : 0,
    me: {n: p.name, s: p.score, st: p.streak, best: p.best, rank: me ? me.rank : 0, of: b.length, right: p.right, calls: p.calls},
    pend: pend ? {v: pend.v, big: pend.big, t: pend.t} : null,
    tickets: p.tickets.slice(-T.ticketsKept).map(t => ({v: t.v, res: t.res, pts: t.pts, line: t.line, at: t.at, big: t.big, bigHit: t.bigHit, few: t.few, drive: t.drive, streak: t.streak})),
    drive: driveView(S, p), review: reviewView(S, now, p), tv: tvView(S, now, p),
    kick: S.kick.open ? {why: S.kick.why, tapped: S.kick.taps.some(k => k.id === id && now - k.t < 120 * SEC)} : null,
    score: scoreView(S), roc: rocMeter(S),
    top: b.slice(0, 3).map(x => ({n: x.n, s: x.s})),
  };
}

export function jumboView(S, now){
  return {
    phase: S.phase, score: scoreView(S), roc: rocMeter(S), rocN: S.roc.length,
    board: board(S).slice(0, 10), players: Object.keys(S.players).length,
    split: split(S, now), lastCall: S.lastCall || null, lastPlay: S.lastPlay,
    drive: driveView(S, null), review: reviewView(S, now, null), tv: tvView(S, now, null),
    kick: S.kick.open ? {why: S.kick.why, taps: S.kick.taps.length} : null,
    log: S.log.slice(-8), D: S.D, synced: S.dTaps.length,
    team: S.team,
  };
}

/* The end-of-game awards, for the final screen. */
export function awards(S){
  const ps = Object.values(S.players);
  if(!ps.length) return [];
  const top = (f, min) => ps.filter(p => f(p) >= (min || 1)).sort((a, b) => f(b) - f(a))[0];
  const out = [];
  const mvp = top(p => p.score); if(mvp) out.push({t: 'MVP', n: mvp.name, v: mvp.score + ' pts'});
  const st = top(p => p.best, 3); if(st) out.push({t: 'Hot hand', n: st.name, v: st.best + ' calls in a row'});
  const acc = ps.filter(p => p.calls >= 10).sort((a, b) => b.right / b.calls - a.right / a.calls)[0];
  if(acc) out.push({t: 'Play caller', n: acc.name, v: Math.round(100 * acc.right / acc.calls) + '% right'});
  const tv = top(p => p.tvRight, 2); if(tv) out.push({t: 'Trivia champ', n: tv.name, v: tv.tvRight + ' right'});
  const dr = top(p => p.drives, 2); if(dr) out.push({t: 'Drive whisperer', n: dr.name, v: dr.drives + ' drives called'});
  const rv = top(p => p.reviews); if(rv) out.push({t: 'Replay official', n: rv.name, v: rv.reviews + ' review' + (rv.reviews > 1 ? 's' : '') + ' right'});
  const bg = top(p => p.bigs); if(bg) out.push({t: 'Big-play hunter', n: bg.name, v: bg.bigs + ' big plays called'});
  const kid = ps.filter(p => p.kid).sort((a, b) => b.score - a.score)[0];
  if(kid && kid !== mvp) out.push({t: 'Junior Cougar', n: kid.name, v: kid.score + ' pts'});
  return out;
}

export function save(S){ return JSON.stringify(S); }
export function load(json){
  const S = JSON.parse(json);
  if(!S || S.proto !== PROTO) return null;
  return S;
}

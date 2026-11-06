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

   PUSHES. Nothing is guessed until somebody in the room asks: "📣 Call
   the next play" or "🏈 New drive". Everybody gets 30 s (a play) or 120 s
   (a drive) to guess, and the person who pushed can lock everybody's
   guesses early - meant to be tapped at the snap. If nobody pushes a new
   drive, the feed does when it reports a change of possession, unless the
   next drive has already started on the TV.

   Which play or drive a push was about is worked out when the feed
   catches up: the first snap on the TV after the push (after the lock,
   when the lock was tapped). ESPN stamps each play within about 2 s of its
   snap (505 pairs of plays checked, 2026-11), so a lock tap at the snap
   and the play it locked are never confused with the next play, 15+ s
   later. A guess made after the snap never counts: after the lock tap if
   there was one (allowing 3 s for a slow thumb), otherwise after the snap
   by the feed's clock. The lock tap is also a sync tap.

   SYNC. Any tap of ⏱ at a snap, or KICK at a kickoff, is matched against
   the feed's play times; taps from different snaps agree on one delay and
   the wrong matches do not (plays are 20-60 s apart, irregularly).

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
  playWindow: 30 * SEC,       // to guess a pushed play
  driveWindow: 120 * SEC,     // to guess a pushed drive
  lockSlack: 3 * SEC,         // a lock tapped this long after the feed's snap still counts as at the snap
  stale: 10 * 60 * SEC,       // a push nothing ever matched is dropped
};
export const PTS = {call: 10, minority: 10, big: 20, drive: 25, bucket: 15, dflag: 10, review: 40, flag: 5, trivia: 15, speed: 5};
const DRIVE_OPTS = ['td', 'fg', 'punt', 'turnover'];
export const DRIVE_LABEL = {td: 'Touchdown', fg: 'Field goal', punt: 'Punt', turnover: 'Turnover', void: 'No result'};
/* What else to guess about a drive, in buckets that each come up about a
   quarter of the time (465 real drives, 2025-26: plays 3/5/8, yards
   7/27/66, time 1:19/2:14/3:59 at the quartiles; a flag on 43%). */
export const DRIVE_Q = {
  res: {label: 'How it ends', opts: DRIVE_OPTS, names: DRIVE_LABEL, pts: PTS.drive},
  plays: {label: 'Plays', opts: ['p1', 'p4', 'p6', 'p9'], names: {p1: '1-3', p4: '4-5', p6: '6-8', p9: '9+'}, pts: PTS.bucket,
    of: st => st.plays <= 3 ? 'p1' : st.plays <= 5 ? 'p4' : st.plays <= 8 ? 'p6' : 'p9'},
  yards: {label: 'Yards', opts: ['y0', 'y10', 'y30', 'y60'], names: {y0: 'Under 10', y10: '10-29', y30: '30-59', y60: '60+'}, pts: PTS.bucket,
    of: st => st.yards < 10 ? 'y0' : st.yards < 30 ? 'y10' : st.yards < 60 ? 'y30' : 'y60'},
  time: {label: 'Time', opts: ['t0', 't90', 't150', 't240'], names: {t0: 'Under 1:30', t90: '1:30-2:30', t150: '2:30-4:00', t240: '4:00+'}, pts: PTS.bucket,
    of: st => st.secs == null ? null : st.secs < 90 ? 't0' : st.secs < 150 ? 't90' : st.secs < 240 ? 't150' : 't240'},
  flag: {label: 'A flag?', opts: ['yes', 'no'], names: {yes: '🚩 Yes', no: 'No'}, pts: PTS.dflag, of: st => st.flag ? 'yes' : 'no'},
};
const FIELDS = Object.keys(DRIVE_Q);

function rng(s){ return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function median(a){ const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; }
function clean(n){ return String(n || '').replace(/[^\p{L}\p{N} '\-]/gu, '').trim().slice(0, 14); }

export function create(cfg = {}){
  return {
    proto: PROTO,
    team: String(cfg.team || '252'), league: cfg.league || 'cfb', event: String(cfg.event || ''),
    seed: (cfg.seed >>> 0) || 1,
    speed: cfg.speed > 0 ? cfg.speed : 1,   // a rehearsal's replay speed: answer windows stay in real seconds
    D: T.dGuess, dTaps: [],                 // TV delay and the kickoff measurements behind it
    players: {}, order: 0,
    done: {},                               // play id -> processed
    queue: [], queued: {},                  // in the feed, not on the TV yet
    last: 0,                                // TV time of the newest processed play
    teams: {}, status: {state: 'pre', period: 0}, phase: 'pre',
    drives: [],                             // [{id, team}] in feed order
    dvs: [], dvN: 0, cur: null,             // drives started on the TV, with everybody's guesses; the one going now
    sync: {taps: [], used: 0},              // ⏱ and KICK taps, for the TV delay
    rv: null, rvN: 0, rvKnown: {},          // the review
    tv: null, tvN: 0, tvUsed: [], tvLast: -1e15, adLast: -1e15,   // trivia
    kick: {open: true, why: 'start', taps: []},
    roc: [],                                // the room's last calls, right or wrong
    log: [],                                // what the jumbotron announces
    clips: [],                              // reaction clips (just their labels; the video stays in the browser)
    lastPlay: null,
    pp: [], dp: [], pN: 0,                  // pushed plays and drives, newest last
    lockLog: [],                            // lock tap minus the feed's snap time, for checking the timing after a game
    alias: {},                              // device id -> player id, for phones that lost their saved id
  };
}

/* ---------- people ---------- */
/* Which player a phone is. Normally its device id (kept in the phone's
   localStorage). A phone that lost it - a different browser, private
   mode, cleared data - comes back with a new id but the same name: if a
   player with that name is not connected right now, it is them, score and
   all. 'fresh' (the phone's "not me") undoes that. */
const key = n => clean(n).toLowerCase();
export function resolve(S, dev, name, online){
  if(S.players[dev]) return {id: dev, back: false};
  if(S.alias[dev] && S.players[S.alias[dev]]) return {id: S.alias[dev], back: false};
  const k = key(name);
  const same = k && Object.values(S.players).find(p => key(p.name) === k && !(online && online(p.id)));
  if(same){ S.alias[dev] = same.id; return {id: same.id, back: true}; }
  return {id: dev, back: false};
}
export function fresh(S, dev, name, kid){
  delete S.alias[dev];
  let n = clean(name) || 'Cougar', i = 2;
  const taken = x => Object.values(S.players).some(p => p.id !== dev && key(p.name) === key(x));
  while(taken(n)) n = clean(name).slice(0, 11) + ' ' + i++;
  return join(S, dev, n, kid);
}
export function join(S, id, name, kid){
  let p = S.players[id];
  if(!p) p = S.players[id] = {id, n: 0, score: 0, streak: 0, best: 0, right: 0, calls: 0,
    tickets: [], j: ++S.order, tvRight: 0, drives: 0, reviews: 0, bigs: 0};
  p.name = clean(name) || p.name || 'Cougar';
  p.kid = !!kid;
  return p;
}
function pts(S, p, n, why){ p.score += n; return n; }
function ticket(p, t){ p.tickets.push(t); if(p.tickets.length > 40) p.tickets.splice(0, p.tickets.length - 40); }

/* ---------- what phones do ---------- */
/* ---------- pushes ---------- */
function who(S, id){ return id === '_auto' ? 'ESPN' : id === '_tv' ? 'the TV' : (S.players[id] || {}).name || ''; }
const listOf = (S, kind) => kind === 'play' ? S.pp : S.dp;
/* One of each kind at a time: a push is in the way until the feed has
   matched it to its play or drive - or until its lock was tapped, which
   marks its snap, so the next push is plainly about the next one. */
const pending = list => list.find(q => !q.target && !q.void && !q.tapLock);
export function isOpen(q, now){ return !!q && !q.target && !q.void && q.lockAt == null && now < q.until; }
export function canPush(S, kind, id){
  const p = S.players[id];
  if(id !== '_auto' && id !== '_tv' && (!p || p.kid)) return false;
  return S.phase !== 'final' && !pending(listOf(S, kind));
}
export function push(S, kind, id, now){
  if((kind !== 'play' && kind !== 'drive') || !canPush(S, kind, id)) return null;
  const q = {n: ++S.pN, kind, by: id, at: now, until: now + (kind === 'play' ? T.playWindow : T.driveWindow) * (S.speed || 1),
    lockAt: null, tapLock: false, votes: {}, target: null};
  const list = listOf(S, kind);
  list.push(q);
  if(list.length > 8) list.shift();
  S.log.push({k: 'push', at: now, kind, by: who(S, id)});
  return q;
}
/* "Lock everyone's guesses": only whoever pushed (or the jumbotron). */
export function lock(S, id, now, kind){
  const q = listOf(S, kind).filter(x => isOpen(x, now)).pop();
  if(!q || (q.by !== id && id !== '_tv')) return;
  q.lockAt = now; q.tapLock = true;
  syncTap(S, id, now, 'snap', true);
}
export function call(S, id, now, v, big){
  const p = S.players[id], q = S.pp.filter(x => isOpen(x, now)).pop();
  if(!p || !q || (v !== 'run' && v !== 'pass')) return;
  q.votes[id] = {v, big: !!big, t: now};
}
/* A guess about the pushed drive: one question at a time. */
export function drivePick(S, id, now, f, v){
  const p = S.players[id], d = DRIVE_Q[f], q = S.dp.filter(x => isOpen(x, now)).pop();
  if(!p || !d || !q || d.opts.indexOf(v) < 0) return;
  (q.votes[id] = q.votes[id] || {})[f] = {v, t: now};
}
export const driveVote = (S, id, now, v) => drivePick(S, id, now, 'res', v);

export function flag(S, id, now){
  const p = S.players[id] || (id === '_tv' ? {name: 'the TV'} : null);
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
/* The ruling, from the room: as soon as voting has closed, anybody can say
   what the referee announced (the feed takes a minute or two to say it,
   and after four minutes the phones ask outright). If the feed later says
   otherwise, the feed wins and the points move (see feed()). */
export function refSaid(S, id, now, v){
  const r = S.rv;
  if(!r || (r.state !== 'ask' && r.state !== 'wait')) return;
  if(v === 'none'){ r.state = 'done'; r.result = 'none'; r.doneAt = now; return; }
  if(v === 'stands' || v === 'overturned') settleReview(S, v, now, 'room');
}

/* KICK at a kickoff, ⏱ at any snap: when the TV showed the ball being
   put in play. */
export function kick(S, id, now){ syncTap(S, id, now, 'kick'); }
export function snap(S, id, now){ syncTap(S, id, now, 'snap'); }
function syncTap(S, id, now, k, fromLock){
  if(!S.players[id] && id !== '_tv') return;        // '_tv': the space bar on the jumbotron
  const mine = S.sync.taps.filter(x => x.id === id);
  if(mine.length && now - mine[mine.length - 1].t < 8 * SEC && !fromLock) return;
  // the first KICK of a kickoff: a drive is about to start - ask the room about it
  if(k === 'kick' && !pending(S.dp) && S.phase !== 'final') push(S, 'drive', '_auto', now);
  S.sync.taps.push({id, t: now, k});
  if(k === 'kick'){ S.kick.taps.push({id, t: now}); if(S.kick.taps.length > 40) S.kick.taps.shift(); }
  if(S.sync.taps.length > 80) S.sync.taps.splice(0, S.sync.taps.length - 80);
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
        p.tvTried = (p.tvTried || 0) + 1;
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
  award(S, r, v, 1);
  S.log.push({k: 'ruling', at: now, v});
}
function award(S, r, v, sign){
  if(sign > 0 && !r.counted){ r.counted = true; Object.keys(r.votes).forEach(id => { const p = S.players[id]; if(p) p.rvTried = (p.rvTried || 0) + 1; }); }
  Object.entries(r.votes).forEach(([id, x]) => {
    const p = S.players[id];
    if(!p || x.v !== v) return;
    p.score += sign * PTS.review; p.reviews += sign;
  });
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

/* A pushed play came in: settle everybody's call for it. */
function settleCall(S, P, now, used, q){
  const ids = Object.keys(used);
  const isCall = P.kind === 'run' || P.kind === 'pass';
  const share = {run: 0, pass: 0};
  ids.forEach(id => { share[used[id].v]++; });
  const big = isCall && P.yards >= T.bigYards;
  const line = playLine(S, P);
  const tally = {run: share.run, pass: share.pass, kind: P.kind, line, right: 0, at: now, id: P.id, by: q ? who(S, q.by) : '', sit: P.sit};
  S.lastCall = tally;                     // the jumbotron shows the answer even if nobody guessed
  ids.forEach(id => {
    const p = S.players[id], c = used[id];
    const t = {play: P.id, v: c.v, big: c.big, line, at: now, pts: 0, sit: (P.sit ? P.sit + ' · ' : '') + 'Q' + P.period, kind: P.kind};
    if(!isCall){ t.res = 'none'; ticket(p, t); return; }
    p.calls++;
    const ok = c.v === P.kind;
    if(c.big) p.bigTried = (p.bigTried || 0) + 1;
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

/* The KICK prompt: open before the game, after a score and at halftime.
   It closes 10 s after the first tap, or once a kickoff is in the feed and
   2.5 minutes old - by then even a slow stream has shown it. */
function openKick(S, why, now){ S.kick = {open: true, why, since: now - 60 * SEC, taps: S.kick.taps || []}; }
function stepKick(S, N, now){
  const k = S.kick;
  if(!k.open) return;
  const tap = k.taps.find(x => x.t >= (k.since || -Infinity));
  const ko = N && N.plays.find(p => p.kind === 'kickoff' && !p.badWall && p.wall >= (k.since || -Infinity) - S.D);
  if((tap && now - tap.t > 10 * SEC) || (ko && now > ko.wall + 150 * SEC)) k.open = false;
}

/* ---------- drives ---------- */
/* A pushed play: the first snap on the TV after the push (after its lock,
   if the lock was tapped) is the one it was about. */
function matchPlay(S, P, now){
  const snap = tvTime(S, P);
  const q = S.pp.find(x => !x.target && !x.void && snap > x.at && !(x.tapLock && snap < x.lockAt - 8 * SEC));
  if(!q) return;
  if(P.badWall){ q.void = true; q.why = 'no time from ESPN for that play'; return; }
  q.target = P.id; q.doneAt = now;
  const cutoff = q.tapLock ? Math.min(q.lockAt, snap + T.lockSlack) : Math.min(q.until, snap - T.margin);
  const used = {};
  q.late = 0;
  Object.entries(q.votes).forEach(([id, x]) => { if(x.t <= cutoff) used[id] = x; else q.late++; });
  if(q.tapLock) logLock(S, q.lockAt - P.wall, 'play', now);
  settleCall(S, P, now, used, q);
}
/* A drive's first snap reached the TV: the drive push it answers, if any. */
function startDrive(S, P, now){
  const snap = tvTime(S, P);
  const dv = {n: ++S.dvN, id: P.drive, team: P.off, at: now, picks: {}, result: null};
  const q = S.dp.find(x => !x.target && !x.void && snap > x.at && !(x.tapLock && snap < x.lockAt - 8 * SEC));
  if(q){
    q.target = P.drive; q.doneAt = now; dv.push = q.n;
    const cutoff = q.tapLock ? Math.min(q.lockAt, snap + T.lockSlack) : Math.min(q.until, snap - T.margin);
    Object.entries(q.votes).forEach(([id, fs]) => {
      const mine = {};
      FIELDS.forEach(f => { if(fs[f] && fs[f].t <= cutoff) mine[f] = fs[f].v; });
      if(Object.keys(mine).length) dv.picks[id] = mine;
    });
    if(q.tapLock) logLock(S, q.lockAt - P.wall, 'drive', now);
  }
  S.dvs.push(dv);
  if(S.dvs.length > 10) S.dvs.shift();
  S.cur = dv;
}
function logLock(S, s, kind, now){
  S.lockLog.push({at: now, s: Math.round(s), D: Math.round(S.D), kind});
  if(S.lockLog.length > 60) S.lockLog.shift();
}
/* The feed reports a change of possession and nobody has pushed a drive:
   push one - unless the next drive has already started on the TV, when it
   would be too late to guess. */
function autoDrive(S, P, N, now){
  if(pending(S.dp) || S.phase === 'final') return;
  const i = N.plays.indexOf(P);
  const started = N.plays.slice(i + 1).some(x => x.drive !== P.drive && (x.kind === 'run' || x.kind === 'pass') && tvTime(S, x) <= now);
  if(!started) push(S, 'drive', '_auto', now);
}
function settleDrives(S, N, now){
  S.dvs.forEach(dv => {
    if(dv.result) return;
    const d = N.drives.find(x => x.id === dv.id);
    if(!d || !d.result) return;
    dv.result = d.result; dv.stats = d.stats; dv.doneAt = now;
    const team = S.teams[d.team];
    dv.line = (team ? team.name + ' drive: ' : 'Drive: ') + (d.raw || DRIVE_LABEL[d.result]) +
      ' · ' + d.stats.plays + ' plays, ' + d.stats.yards + ' yds' + (d.stats.secs != null ? ', ' + clock(d.stats.secs) : '');
    // what each question's answer was (the drive cut off by the half or the game counts for nothing)
    dv.ans = {};
    if(d.result !== 'void') FIELDS.forEach(f => { dv.ans[f] = f === 'res' ? d.result : DRIVE_Q[f].of(d.stats); });
    Object.entries(dv.picks).forEach(([id, mine]) => {
      const p = S.players[id];
      if(!p) return;
      const t = {drive: dv.n, line: dv.line, at: now, pts: 0, got: {}, mine, ans: dv.ans, res: 'none'};
      let right = 0, tried = 0;
      FIELDS.forEach(f => {
        if(!(f in mine) || dv.ans[f] == null) return;
        tried++;
        const ok = mine[f] === dv.ans[f];
        t.got[f] = ok ? 1 : 0;
        p.dstat = p.dstat || {};
        const st = p.dstat[f] = p.dstat[f] || [0, 0];
        st[1]++;
        if(ok){ st[0]++; right++; t.pts += pts(S, p, DRIVE_Q[f].pts); if(f === 'res') p.drives++; }
      });
      if(tried) t.res = right ? (right === tried ? 'right' : 'some') : 'wrong';
      t.right = right; t.tried = tried;
      ticket(p, t);
    });
    S.log.push({k: 'drive', at: now, line: dv.line, result: dv.result});
  });
}
const clock = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

/* ---------- the TV delay, from the taps ----------
   Each tap could be any of the plays that happened in the 2.5 minutes
   before it (a TV is never more than that behind), so it offers a set of
   possible delays. Taps on different snaps share only the true one: the
   gaps between plays are irregular. A KICK tap can only be a kickoff, so it
   settles the delay on its own; one ⏱ tap is enough to fine-tune a delay
   already known. Taps within 4 s of each other are one moment (several
   people tapping the same snap). A ⏱ tap is used once its play must be in
   the feed (90 s), a KICK tap as soon as its kickoff is. */
function measure(S, N, now){
  const sy = S.sync;
  const recent = sy.taps.filter(x => now - x.t < 20 * 60 * SEC);
  if(!recent.length) return;
  const moments = [];
  recent.slice().sort((a, b) => a.t - b.t).forEach(x => {
    const m = moments[moments.length - 1];
    if(m && x.t - m.last < 4 * SEC && m.k === x.k){ m.ts.push(x.t); m.last = x.t; }
    else moments.push({k: x.k, ts: [x.t], last: x.t});
  });
  const plays = N.plays.filter(p => !p.badWall && (p.kind === 'run' || p.kind === 'pass' || p.kind === 'special' || p.kind === 'kickoff'));
  const usable = [];
  moments.forEach(m => {
    m.t = median(m.ts);
    m.offs = plays.filter(p => (m.k !== 'kick' || p.kind === 'kickoff') && m.t - p.wall >= -5 * SEC && m.t - p.wall <= 150 * SEC).map(p => m.t - p.wall);
    if(!m.offs.length) return;
    if(m.k === 'kick' || now - m.t >= 90 * SEC) usable.push(m);
  });
  if(!usable.length) return;
  const key = usable.map(m => m.t + ':' + m.offs.length).join('|');
  if(key === sy.key) return;              // nothing new to learn
  sy.key = key;
  const known = S.dTaps.length > 0;
  let best = null;
  usable.forEach(m => m.offs.forEach(c => {
    let w = 0;
    const hits = [];
    usable.forEach(o => {
      const near = o.offs.filter(x => Math.abs(x - c) <= 2.5 * SEC).sort((a, b) => Math.abs(a - c) - Math.abs(b - c))[0];
      if(near != null){ w += o.k === 'kick' ? 3 : 1; hits.push(near); }
    });
    const closer = !best || w > best.w || (w === best.w && Math.abs(c - S.D) < Math.abs(best.c - S.D));
    if(closer) best = {c, w, hits};
  }));
  if(!best) return;
  const ok = best.w >= 2 || (known && Math.abs(best.c - S.D) <= 10 * SEC);
  if(!ok) return;
  const D = median(best.hits);
  const was = S.D;
  S.D = D;
  S.dTaps = best.hits.slice(-8);
  if(Math.abs(D - was) > 1500 || !known) S.log.push({k: 'synced', at: now, d: D, n: best.hits.length});
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
      if(S.afterScore){ breakWhy = 'score'; S.afterScore = false; }
    }
    // a new drive's first snap: the pushed drive it answers
    if((P.kind === 'run' || P.kind === 'pass' || P.kind === 'special') && !P.badWall && (!S.cur || S.cur.id !== P.drive)
      && !S.dvs.some(d => d.id === P.drive) && S.phase !== 'final') startDrive(S, P, now);
    // a pushed play
    if(P.kind === 'run' || P.kind === 'pass' || P.kind === 'special') matchPlay(S, P, now);
    // the ball changes hands: time to ask about the next drive
    if(P.scoring || P.turnover || P.kind === 'half' || (P.kind === 'special' && !/extra point|two-point|2pt|conversion/i.test(P.type + ' ' + P.text) && !/no play/i.test(P.text)))
      autoDrive(S, P, N, now);
    // where things stand after this play, for the screens
    if(P.kind !== 'timeout' && P.kind !== 'void' || !S.sit) S.sit = {
      period: P.period, clock: P.clock, at: tvTime(S, P),
      team: P.nx ? P.nx.team : P.to, text: P.scoring ? 'Kickoff next' : P.nx ? P.nx.text : '',
      after: P.kind === 'kickoff' ? 'Kickoff' : P.kind};
    // a kickoff does not use up anybody's call: calls made during the
    // commercial are for the first snap after it
    if(P.kind === 'run' || P.kind === 'pass' || P.kind === 'special' || P.kind === 'kickoff'){
      S.lastPlay = {line: playLine(S, P), kind: P.kind, at: now, team: P.off, sit: P.sit, q: P.period, clock: P.clock};
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
      openKick(S, 'score', now);
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
    openKick(S, 'half', now);
    startRound(S, now, 'half', N, 'half');
  } else if(S.phase === 'half' && fresh.some(p => p.period >= 3 && p.kind !== 'period')) S.phase = 'live';
  if(breakWhy && S.phase === 'live') startRound(S, now, 'break', N, breakWhy);
  if(N.status && N.status.state === 'post' && S.phase !== 'final'){ S.phase = 'final'; }
  if(S.phase === 'final' && !S.finalAt){ S.finalAt = now; S.log.push({k: 'final', at: now}); S.pp.concat(S.dp).forEach(q => { if(!q.target) q.void = true; }); }
  measure(S, N, now);
  stepKick(S, N, now);

  // reviews the feed has settled
  const reviewed = N.plays.filter(p => p.review && p.review !== 'pending');
  const R = S.rv;
  if(R && (R.state !== 'done' || (R.how === 'room' && now - R.doneAt < 12 * 60 * SEC))){
    const hit = reviewed.find(p => !R.known[p.id] && p.wall >= R.at - S.D - 5 * 60 * SEC);
    if(hit && R.state !== 'done') settleReview(S, hit.review, now, 'feed');
    else if(hit){
      R.how = 'feed';
      if(hit.review !== R.result){       // the room heard it wrong: the feed wins
        award(S, R, R.result, -1); award(S, R, hit.review, 1);
        R.result = hit.review; R.fixed = true;
        S.log.push({k: 'ruling', at: now, v: hit.review, fixed: true});
      }
    }
  }
  reviewed.forEach(p => { S.rvKnown[p.id] = 1; });

  settleDrives(S, N, now);
  // the drive going now, as far as the feed has got
  if(S.cur){ const d = N.drives.find(x => x.id === S.cur.id); if(d) S.cur.live = d.stats; }
  if(S.log.length > 60) S.log.splice(0, S.log.length - 60);
}

/* The clock moving with nothing new from the feed. */
export function tick(S, now){
  // a push nothing ever matched (the feed never sent its play) goes away
  S.pp.concat(S.dp).forEach(q => { if(!q.target && !q.void && now - q.at > T.stale){ q.void = true; q.why = 'never matched'; } });
  stepRound(S, now);
  stepReview(S, now);
}

/* ---------- what the screens show ---------- */
export function rocMeter(S){ return S.roc.length ? Math.round(100 * S.roc.reduce((a, b) => a + b, 0) / S.roc.length) : 0; }

export function board(S){
  return Object.values(S.players).sort((a, b) => (b.score - a.score) || (a.j - b.j))
    .map((p, i) => ({id: p.id, n: p.name, s: p.score, st: p.streak, kid: p.kid ? 1 : 0, on: p.on === false ? 0 : 1, rank: i + 1}));
}

/* The push to show: the newest one not matched yet (open, or locked and
   waiting for ESPN). */
function pushView(S, kind, now, p){
  const q = listOf(S, kind).filter(x => !x.target && !x.void).pop();
  if(!q) return null;
  const open = isOpen(q, now);
  const v = {n: q.n, by: who(S, q.by), auto: q.by === '_auto', open, left: open ? Math.ceil((q.until - now) / 1000 / (S.speed || 1)) : 0,
    locked: !open, tapLock: q.tapLock};
  if(p){
    v.mineBy = q.by === p.id;
    const m = q.votes[p.id];
    v.mine = !m ? null : kind === 'play' ? {v: m.v, big: m.big} : Object.fromEntries(Object.entries(m).map(([f, x]) => [f, x.v]));
  } else {
    v.n = Object.keys(q.votes).length;
    v.tally = {};
    Object.values(q.votes).forEach(m => {
      if(kind === 'play'){ v.tally[m.v] = (v.tally[m.v] || 0) + 1; if(m.big) v.tally.big = (v.tally.big || 0) + 1; }
      else Object.entries(m).forEach(([f, x]) => { v.tally[f] = v.tally[f] || {}; v.tally[f][x.v] = (v.tally[f][x.v] || 0) + 1; });
    });
  }
  return v;
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

/* Where the game stands, as of the newest play the TV has shown that the
   feed knows about. "Fresh" when that play was on the TV less than 25 s
   ago - nothing newer can have happened yet; otherwise the feed is
   catching up and the TV may be a play or two further on. */
function sitView(S, now){
  const x = S.sit;
  if(!x) return null;
  const t = S.teams[x.team];
  const text = x.after === 'period' ? 'End of quarter' : x.after === 'half' ? 'Halftime' : x.after === 'final' ? 'Final' : x.text;
  return {q: x.period, clock: x.clock, team: t ? t.abbr : '', teamName: t ? t.name : '', text, fresh: now - x.at < 25 * SEC,
    ago: Math.round((now - x.at) / 1000)};
}

/* The drive going now on the TV (as far as the feed has got), with what
   was guessed about it. */
function driveView(S, p, now){
  const c = S.cur;
  if(!c || c.result || S.phase === 'final') return null;
  const v = {team: teamName(S, c.team), ours: c.team === S.team, live: c.live || null, pushed: !!c.push};
  if(p) v.mine = c.picks[p.id] || null;
  else { v.tally = {}; Object.values(c.picks).forEach(m => { if(m.res) v.tally[m.res] = (v.tally[m.res] || 0) + 1; }); v.n = Object.keys(c.picks).length; }
  return v;
}

function reviewView(S, now, p){
  const r = S.rv;
  if(!r) return null;
  if(r.state === 'done' && now - r.doneAt > 25 * SEC) return null;
  const v = {n: r.n, state: r.state, by: (S.players[r.by] || {}).name || '',
    left: Math.max(0, Math.ceil((T.reviewVote - (now - r.at)) / 1000)), result: r.result, how: r.how || '', fixed: !!r.fixed};
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
  const ds = p.dstat || {};
  return {
    t: 'st', phase: S.phase, kid: p.kid ? 1 : 0,
    play: pushView(S, 'play', now, p), dpush: pushView(S, 'drive', now, p),
    can: {play: canPush(S, 'play', id), drive: canPush(S, 'drive', id)},
    me: {n: p.name, s: p.score, st: p.streak, best: p.best, rank: me ? me.rank : 0, of: b.length, right: p.right, calls: p.calls},
    // every guess settled, newest last: calls and drives
    tickets: p.tickets.slice(-30).map(t => t.drive ? {drive: t.drive, res: t.res, pts: t.pts, line: t.line, at: t.at, mine: t.mine, ans: t.ans, got: t.got} :
      {v: t.v, res: t.res, pts: t.pts, line: t.line, at: t.at, big: t.big, bigHit: t.bigHit, few: t.few, streak: t.streak, sit: t.sit, kind: t.kind}),
    rec: {calls: [p.right, p.calls], big: [p.bigs, p.bigTried || 0], rv: [p.reviews, p.rvTried || 0], tv: [p.tvRight, p.tvTried || 0],
      drive: Object.fromEntries(FIELDS.map(f => [f, ds[f] || [0, 0]]))},
    sit: sitView(S, now),
    drive: driveView(S, p, now), review: reviewView(S, now, p), tv: tvView(S, now, p),
    kick: S.kick.open ? {why: S.kick.why, tapped: S.kick.taps.some(k => k.id === id && now - k.t < 120 * SEC)} : null,
    synced: S.dTaps.length > 0, snapTapped: S.sync.taps.some(k => k.id === id && now - k.t < 8 * SEC),
    score: scoreView(S), roc: rocMeter(S),
    top: b.slice(0, 3).map(x => ({n: x.n, s: x.s})),
  };
}

export function jumboView(S, now){
  return {
    phase: S.phase, score: scoreView(S), roc: rocMeter(S), rocN: S.roc.length,
    board: board(S).slice(0, 10), players: Object.keys(S.players).length,
    play: pushView(S, 'play', now, null), dpush: pushView(S, 'drive', now, null),
    lastCall: S.lastCall || null, lastPlay: S.lastPlay,
    sit: sitView(S, now),
    drive: driveView(S, null, now), review: reviewView(S, now, null), tv: tvView(S, now, null),
    lastDrive: (S.dvs.filter(d => d.result).pop() || {}).line || '',
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
  if(!S.alias) S.alias = {};
  if(!S.dvs){ S.dvs = []; S.dvN = 0; S.cur = null; }
  if(!S.pp){ S.pp = []; S.dp = []; S.pN = 0; S.lockLog = []; }
  if(!S.sync) S.sync = {taps: [], used: 0};
  return S;
}

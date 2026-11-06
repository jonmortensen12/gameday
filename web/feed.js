/* Game Day - the ESPN feed.

   ESPN's public summary for one game: every play, the drives, the score,
   the stat leaders. A browser can read it directly (it sends
   access-control-allow-origin: *), so the jumbotron polls it itself, every
   three seconds, with no server of ours in between.

   What it is NOT is fast. Measured on Sunday Night Football (2026-11-01),
   a play reached the feed 24-56 seconds after it happened. Each play does
   carry `wallclock`, the real time it happened, and everything here keys on
   that: the game never needs the feed to be quick, only to say when.

   normalize(summary) turns ESPN's shape into the small one the game uses.
   slice(N, cut) is that game as the feed would have shown it at an earlier
   moment - what the replay source and the headless check are built on.

   Plays, normalized:
     {id, seq, drive, type, text, period, clock, wall (ms), off (team id),
      to (team id with the ball after), kind, yards, td, scoring, turnover,
      review: null | 'stands' | 'overturned' | 'pending', home, away}
   kind: 'run' | 'pass' - something to call
         'kickoff' | 'special' (punt, field goal) - the ball moved, no call
         'void' - nothing happened (penalty before the snap, kneel, spike)
         'timeout' | 'period' | 'half' | 'final' - stoppages */

export const LEAGUES = {cfb: 'college-football', nfl: 'nfl'};

export function summaryUrl(league, event){
  return 'https://site.api.espn.com/apis/site/v2/sports/football/' +
    (LEAGUES[league] || league) + '/summary?event=' + encodeURIComponent(event);
}
export function scoreboardUrl(league, date){
  return 'https://site.api.espn.com/apis/site/v2/sports/football/' + (LEAGUES[league] || league) +
    '/scoreboard?limit=300' + (league === 'cfb' ? '&groups=80' : '') + (date ? '&dates=' + date : '');
}

const RUN_WORDS = / rush | rushes | scrambles | up the middle| left end| right end| left tackle| right tackle| left guard| right guard/;

export function classify(type, text){
  const T = String(type || '').toLowerCase(), x = ' ' + String(text || '').toLowerCase() + ' ';
  if(/end of game|end of regulation/.test(T)) return 'final';
  if(/end of half/.test(T)) return 'half';
  if(/end period|two-minute/.test(T)) return 'period';
  if(/timeout/.test(T)) return 'timeout';
  if(/kickoff/.test(T)) return 'kickoff';
  if(/punt|field goal|extra point|two-point|2pt|safety|onside/.test(T)) return 'special';
  if(/kneel| spike|spiked/.test(x)) return 'void';
  if(T === 'penalty' && /no play/.test(x)) return 'void';       // whatever happened does not count
  if(/pass|sack|interception/.test(T)) return 'pass';
  if(/rush/.test(T)) return 'run';
  // fumbles and the rest: what the text says the offense tried
  if(/ pass |sacked| sack /.test(x)) return 'pass';
  if(RUN_WORDS.test(x)) return 'run';
  if(/kickoff/.test(x)) return 'kickoff';
  if(/ punt |field goal/.test(x)) return 'special';
  return 'void';
}

/* Reviews show up in the text, usually on the play AFTER the one reviewed:
   'The previous play is under automatic review - "Fumble". CALL OVERTURNED.'
   (college), 'The Replay Official reviewed ... and the play was REVERSED.'
   (NFL), 'Utah is challenging the ruling on the field ...'. */
export function reviewOf(text){
  const x = String(text || '');
  if(!/review|challeng/i.test(x)) return null;
  if(/overturn|reversed/i.test(x)) return 'overturned';
  if(/upheld|\bstands\b|confirmed/i.test(x)) return 'stands';
  return 'pending';
}

const RESULT = {TD: 'td', FG: 'fg', PUNT: 'punt', 'BLOCKED PUNT': 'turnover', DOWNS: 'turnover',
  INT: 'turnover', FUMBLE: 'turnover', 'MISSED FG': 'turnover', 'INT TD': 'turnover',
  'FUMBLE RETURN TD': 'turnover', 'FUMBLE TD': 'turnover', 'PUNT TD': 'turnover', SF: 'turnover', SAFETY: 'turnover',
  'BLOCKED FG': 'turnover', 'BLOCKED FG, DOWNS': 'turnover', 'END OF HALF': 'void', 'END OF GAME': 'void',
  'END OF 4TH QUARTER': 'void', 'END OF REGULATION': 'void'};
export function driveResult(r, display){
  const k = String(r || '').toUpperCase();
  if(RESULT[k]) return RESULT[k];
  const d = String(display || '').toLowerCase();
  if(!k && !d) return null;
  if(/end of/.test(d)) return 'void';
  if(/touchdown/.test(d) && !/return|interception|fumble/.test(d)) return 'td';
  if(/field goal/.test(d) && !/miss|block/.test(d)) return 'fg';
  if(/punt/.test(d) && !/block|return/.test(d)) return 'punt';
  return 'turnover';
}

export function markBadWalls(plays){
  const n = plays.length, w = plays.map(p => p.wall), best = new Array(n).fill(0), from = new Array(n).fill(-1);
  const SLACK = 5000;
  for(let j = 0; j < n; j++){
    if(!(w[j] > 1e12)) continue;
    best[j] = 1;
    for(let i = Math.max(0, j - 60); i < j; i++)
      if(best[i] && w[j] >= w[i] - SLACK && best[i] + 1 > best[j]){ best[j] = best[i] + 1; from[j] = i; }
  }
  let k = -1;
  for(let j = 0; j < n; j++) if(best[j] && (k < 0 || best[j] >= best[k])) k = j;
  const good = new Set();
  while(k >= 0){ good.add(k); k = from[k]; }
  let last = 0;
  plays.forEach((p, i) => {
    p.rawWall = p.wall;
    if(good.has(i)){ last = Math.max(last, p.wall); p.wall = last; }
    else { p.badWall = true; p.wall = last; }
  });
}

function ms(s){ const t = Date.parse(s); return isFinite(t) ? t : 0; }

export function normalize(d){
  const comp = (d.header && d.header.competitions && d.header.competitions[0]) || {};
  const teams = {};
  (comp.competitors || []).forEach(c => {
    const t = c.team || {};
    teams[c.id] = {id: String(c.id), abbr: t.abbreviation || '', name: t.location || t.shortDisplayName || t.displayName || t.name || '',
      nick: t.name || '', color: '#' + (t.color || '444444'), alt: '#' + (t.alternateColor || 'ffffff'),
      score: +c.score || 0, side: c.homeAway, logo: (t.logos && t.logos[0] && t.logos[0].href) || ''};
  });
  const st = (comp.status && comp.status.type) || {};
  const status = {state: st.state || 'pre', detail: st.shortDetail || st.detail || '',
    period: (comp.status && comp.status.period) || 0, clock: (comp.status && comp.status.displayClock) || '',
    start: ms(comp.date)};
  const homeId = Object.keys(teams).find(k => teams[k].side === 'home');
  const awayId = Object.keys(teams).find(k => teams[k].side === 'away');

  const drives = [], plays = [];
  const ds = d.drives || {};
  const list = (ds.previous || []).slice();
  if(ds.current && !list.some(x => x.id === ds.current.id)) list.push(Object.assign({current: true}, ds.current));
  list.forEach((x, di) => {
    const te = x.timeElapsed && x.timeElapsed.displayValue;
    const dr = {id: String(x.id), team: x.team ? String(x.team.id) : '', i: di,
      result: x.current ? null : driveResult(x.result, x.displayResult), raw: x.displayResult || x.result || '', plays: [],
      // ESPN's own count for the drive: offensive plays, net yards, time of possession
      stats: {plays: +x.offensivePlays || 0, yards: +x.yards || 0,
        secs: te && /^\d+:\d\d$/.test(te) ? +te.split(':')[0] * 60 + +te.split(':')[1] : null,
        flag: (x.plays || []).some(p => /penalty/i.test(p.text || '') || /penalty/i.test((p.type && p.type.text) || ''))}};
    drives.push(dr);
    (x.plays || []).forEach(p => {
      const type = (p.type && p.type.text) || '';
      const kind = classify(type, p.text);
      const s = p.start || {}, e = p.end || {};
      const off = (s.team && String(s.team.id)) || dr.team;
      plays.push({id: String(p.id), seq: +p.sequenceNumber || 0, drive: dr.id, type, text: p.text || '',
        period: (p.period && p.period.number) || 0, clock: (p.clock && p.clock.displayValue) || '',
        wall: ms(p.wallclock), off, to: (e.team && String(e.team.id)) || off, kind,
        down: s.down || 0, dist: s.distance || 0, spot: s.possessionText || '',
        sit: s.downDistanceText || '',                 // "3rd & 2 at BAL 43": the situation this play was snapped in
        nx: e.down ? {down: e.down, dist: e.distance || 0, spot: e.possessionText || '', text: e.downDistanceText || '', team: e.team ? String(e.team.id) : ''} : null,
        yards: +p.statYardage || 0, td: /touchdown/i.test(type) || /touchdown/i.test(p.text || ''),
        scoring: !!p.scoringPlay, turnover: !!p.isTurnover || /turnover on downs/i.test(p.text || ''),
        review: reviewOf(p.text), home: +p.homeScore || 0, away: +p.awayScore || 0});
      dr.plays.push(String(p.id));
    });
  });
  // Feed order, not wallclock order. A few plays carry a wrong wallclock:
  // BYU-Utah 2025 has a timeout stamped half an hour early, Utah at Iowa
  // State 2026 a pass stamped an hour and a half late and several with
  // none at all. The longest run of plays whose clocks move forward is
  // trusted; the rest are marked bad and given the time of the play before
  // them, so they can neither settle anybody's call nor reorder the game.
  markBadWalls(plays);

  let leaders = null;
  if(Array.isArray(d.leaders)) leaders = d.leaders.map(t => ({team: t.team ? String(t.team.id) : '',
    cats: (t.leaders || []).filter(c => c.leaders && c.leaders.length).map(c => ({name: c.name,
      who: c.leaders[0].athlete && c.leaders[0].athlete.displayName, line: c.leaders[0].displayValue}))}));
  let roster = null;
  if(d.boxscore && Array.isArray(d.boxscore.players)) roster = d.boxscore.players.map(t => ({team: String(t.team.id),
    names: [...new Set((t.statistics || []).flatMap(c => (c.athletes || []).map(a => a.athlete && a.athlete.displayName)).filter(Boolean))]}));

  return {teams, homeId, awayId, status, drives, plays, leaders, roster};
}

/* The game as the feed showed it when only plays up to `cut` were in.
   Leaders and box score are the final ones, so the replay drops them
   rather than give away the ending. */
export function slice(N, cut){
  const plays = N.plays.filter(p => p.wall <= cut);
  const have = new Set(plays.map(p => p.drive));
  const last = plays[plays.length - 1];
  const all = plays.length === N.plays.length;
  const drives = N.drives.filter(d => have.has(d.id)).map((d, i, arr) => {
    const done = i < arr.length - 1 || all;
    const mine = plays.filter(p => p.drive === d.id);
    // a drive still going shows what has happened so far, as the live feed would
    const stats = done ? d.stats : {plays: mine.filter(p => p.kind === 'run' || p.kind === 'pass').length,
      yards: mine.filter(p => p.kind === 'run' || p.kind === 'pass').reduce((a, p) => a + p.yards, 0), secs: null,
      flag: mine.some(p => /penalty/i.test(p.text) || /penalty/i.test(p.type))};
    return Object.assign({}, d, {plays: mine.map(p => p.id), result: done ? d.result : null, stats});
  });
  const teams = JSON.parse(JSON.stringify(N.teams));
  if(N.homeId && teams[N.homeId]) teams[N.homeId].score = last ? last.home : 0;
  if(N.awayId && teams[N.awayId]) teams[N.awayId].score = last ? last.away : 0;
  const status = Object.assign({}, N.status, {state: !last ? 'pre' : all ? 'post' : 'in',
    period: last ? last.period : 0, clock: last ? last.clock : '', detail: last ? 'Q' + last.period + ' ' + last.clock : ''});
  return {teams, homeId: N.homeId, awayId: N.awayId, status, drives, plays, leaders: null, roster: N.roster};
}

/* ---------- sources: where the jumbotron gets the game from ----------
   Both have now() - the time in the feed's own terms (real time for a live
   game) - and poll(), which resolves to a normalized snapshot or null. */

export function liveSource(league, event, fetcher){
  const url = summaryUrl(league, event);
  const f = fetcher || (u => fetch(u, {cache: 'no-store'}).then(r => { if(!r.ok) throw new Error('feed ' + r.status); return r.json(); }));
  return {
    kind: 'live', league, event,
    now: () => Date.now(),
    poll: () => f(url).then(normalize),
  };
}

/* A finished game played back as if live: each play turns up `lag` seconds
   after it happened (25-55 s, varied per play the way the real feed
   varies), in order. The clock can run fast (tests) or be paused (a
   rehearsal in front of a recorded game). */
export function replaySource(league, event, opts = {}){
  const speed = opts.speed || 1;
  const lagLo = opts.lag != null ? opts.lag : 25, lagHi = opts.lagHi != null ? opts.lagHi : (opts.lag != null ? opts.lag : 55);
  const realNow = opts.clock || (() => Date.now());
  let N = null, t0 = 0, v0 = 0, paused = false, pausedAt = 0, reveal = null;
  const ready = (opts.summary ? Promise.resolve(opts.summary) : liveSource(league, event, opts.fetcher).poll().then(x => x))
    .then(raw => {
      N = raw.plays ? raw : normalize(raw);
      const first = N.plays.find(p => p.wall) || {wall: realNow()};
      v0 = first.wall - (opts.preroll != null ? opts.preroll : 90) * 1000;
      t0 = realNow();
      // when each play reaches the feed, in order
      let prev = 0;
      reveal = N.plays.map(p => {
        const h = [...p.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 1000 / 1000;
        prev = Math.max(prev, p.wall + (lagLo + (lagHi - lagLo) * h) * 1000);
        return prev;
      });
    });
  const now = () => v0 + ((paused ? pausedAt : realNow()) - t0) * speed;
  return {
    kind: 'replay', league, event, ready,
    now,
    poll: () => ready.then(() => {
      const v = now();
      let n = 0;
      while(n < reveal.length && reveal[n] <= v) n++;
      const cut = n ? N.plays[n - 1].wall : -Infinity;
      return slice(N, cut);
    }),
    pause(){ if(!paused){ pausedAt = realNow(); paused = true; } },
    resume(){ if(paused){ t0 += realNow() - pausedAt; paused = false; } },
    get paused(){ return paused; },
    skip(sec){ t0 -= sec * 1000 / speed; },
    get full(){ return N; },
    revealAt: i => reveal[i],
  };
}

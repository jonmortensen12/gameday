/* Game Day - the host: the jumbotron laptop runs the room.

   The shape is Night Watch's (web/host.js there): the big screen opens a
   PeerJS room with a four-letter code, phones join from a QR code, and a
   phone that comes back with the same device id gets its own score back.
   What is different is that nothing here moves at 60 Hz. The game changes
   when the feed brings a play (every 3 s) or a phone taps, so the host
   ticks four times a second and only sends a phone its view when the view
   has changed.

   The game is saved to this laptop every few seconds, room code included,
   so reloading the jumbotron mid-game - or the laptop going to sleep at
   halftime - carries on where it was, with the same code the phones know. */
import * as G from './game.js';

const AWAY_MS = 8000, TICK_MS = 250, POLL_MS = 3000, SAVE_MS = 4000;

export function createHost(opts){
  const cfg = opts.cfg, src = opts.source;
  const key = 'gday_game_' + cfg.league + '_' + cfg.event + (src.kind === 'replay' ? '_replay' : '');
  let S = null, code = null;
  if(!opts.fresh){
    try {
      const kept = JSON.parse(localStorage.getItem(key) || 'null');
      if(kept && kept.S){ S = G.load(kept.S); code = kept.code || null; }
    } catch(e){ S = null; }
  }
  if(!S || src.kind === 'replay') S = G.create(cfg);
  if(src.kind === 'replay') code = null;
  Object.values(S.players).forEach(p => { p.on = false; });

  const people = {};           // dev id -> {id, conn, seen, last (json sent)}
  const room = {code: null, status: 'Opening the room...'};
  let handle = null, dead = false, feedOk = null, feedErr = '', lastFeed = 0, N = null, polling = false;
  let takenTries = 0;

  function open(){
    room.status = 'Opening the room...';
    handle = window.GDNet.host({
      open: c => { room.code = c; code = c; room.status = ''; persist(); info(); },
      conn: c => wire(c),
      error: msg => {
        // the code we had before a reload can stay held at the broker for a
        // minute; keep asking for it, then give up and take a new one
        if(msg === 'taken' && code && takenTries++ < 36){ room.status = 'Getting the room back...'; info(); setTimeout(open, 5000); return; }
        if(msg === 'taken'){ code = null; setTimeout(open, 100); return; }
        room.status = msg + ' Retrying...'; room.code = null; info();
        setTimeout(() => { if(!room.code && !dead) open(); }, 4000);
      }
    }, code || undefined);
  }

  function send(p, m){ if(p && p.conn){ try { p.conn.send(m); } catch(e){} } }

  function wire(c){
    let id = null;
    c.on('data', d => {
      if(!d || typeof d !== 'object') return;
      const now = src.now();
      if(d.t === 'hello' || d.t === 'fresh'){
        const dev = String(d.dev || c.peer).slice(0, 40);
        // which player this is: their device id, or - a phone that lost
        // its saved id - the player of the same name who is not here now
        let who = {id: dev, back: false};
        if(d.t === 'fresh'){ if(id && id !== dev && people[id] && people[id].conn === c) people[id].conn = null; G.fresh(S, dev, d.name, d.kid); }
        // somebody heard from in the last 4 s is here, and keeps their name
        else who = G.resolve(S, dev, d.name, pid => !!(people[pid] && people[pid].conn && people[pid].conn !== c && performance.now() - people[pid].seen < 4000));
        id = who.id;
        const old = people[id];
        if(old && old.conn && old.conn !== c){ try { old.conn.close(); } catch(e){} }
        const p = old || {id};
        p.conn = c; p.seen = performance.now(); p.last = '';
        people[id] = p;
        // the phone's own player can change its name; one picked up by name keeps it
        const pl = G.join(S, id, id === dev && d.t === 'hello' ? d.name : S.players[id].name, d.kid);
        pl.on = true;
        send(p, {t: 'host', proto: G.PROTO, code: room.code, back: who.back ? {n: pl.name, s: pl.score} : null, name: pl.name});
        push(p, now, true);
        info();
        return;
      }
      const p = id && people[id];
      if(!p || p.conn !== c) return;
      if(d.t === 'bye'){ p.conn = null; if(S.players[id]) S.players[id].on = false; info(); return; }   // the page closed
      p.seen = performance.now();
      const pl = S.players[id];
      if(pl && !pl.on){ pl.on = true; info(); }
      fromPhone(id, d, now);
      push(p, now, false);
    });
    c.on('close', () => {
      const p = id && people[id];
      if(p && p.conn === c){ p.conn = null; if(S.players[id]) S.players[id].on = false; info(); }
    });
  }

  function fromPhone(id, d, now){
    switch(d.t){
      case 'call': G.call(S, id, now, d.v, d.big); break;
      case 'drive': G.driveVote(S, id, now, d.v); break;
      case 'flag': G.flag(S, id, now); break;
      case 'rvote': G.reviewVote(S, id, now, d.v); break;
      case 'ref': G.refSaid(S, id, now, d.v); break;
      case 'kick': G.kick(S, id, now); break;
      case 'ad': G.ad(S, id, now); break;
      case 'ans': G.answer(S, id, now, d.n | 0, d.i | 0); break;
      case 'kid': if(S.players[id]) S.players[id].kid = !!d.v; break;
      case 'ping': break;
    }
    if(opts.onAction) opts.onAction(id, d, now);
  }

  function push(p, now, force){
    if(!p.conn) return;
    const v = G.phoneView(S, p.id, now);
    if(!v) return;
    v.feed = feedOk === false ? 'down' : '';
    const j = JSON.stringify(v);
    if(!force && j === p.last && performance.now() - (p.sent || 0) < 3000) return;
    p.last = j; p.sent = performance.now();
    send(p, v);
  }

  function info(){ if(opts.onRoom) opts.onRoom(roomInfo()); }
  function roomInfo(){
    return {code: room.code, status: room.status, feed: feedOk, feedErr, lastFeed, source: src.kind,
      people: Object.values(S.players).map(p => ({id: p.id, n: p.name, on: p.on ? 1 : 0, kid: p.kid ? 1 : 0}))};
  }

  function poll(){
    if(polling || dead) return;
    polling = true;
    src.poll().then(n => {
      polling = false;
      if(!n) return;
      N = n;
      const was = feedOk;
      feedOk = true; feedErr = ''; lastFeed = Date.now();
      G.feed(S, N, src.now());
      if(was !== true) info();
      if(opts.onFeed) opts.onFeed(N);
    }, e => {
      polling = false;
      const was = feedOk;
      feedOk = false; feedErr = String(e && e.message || e);
      if(was !== false) info();
    });
  }

  function persist(){
    if(src.kind === 'replay') return;
    try { localStorage.setItem(key, JSON.stringify({S: G.save(S), code, at: Date.now()})); } catch(e){}
  }

  function tick(){
    const now = src.now();
    // the feed changes nothing until it is polled, but the queue of plays
    // the TV has not shown yet empties with time alone
    if(N) G.feed(S, N, now);
    G.tick(S, now);
    const t = performance.now();
    Object.values(people).forEach(p => {
      if(p.conn && t - p.seen > AWAY_MS){ if(S.players[p.id] && S.players[p.id].on){ S.players[p.id].on = false; info(); } }
      push(p, now, false);
    });
    if(opts.onView) opts.onView(G.jumboView(S, now), S, now);
  }

  open();
  poll();
  const timers = [setInterval(tick, TICK_MS), setInterval(poll, POLL_MS), setInterval(persist, SAVE_MS)];
  addEventListener('pagehide', persist);

  return {
    get S(){ return S; }, get N(){ return N; }, room, source: src, roomInfo,
    now: () => src.now(),
    /* the jumbotron's own keys */
    setMode(m){ G.setMode(S, m, src.now()); persist(); },
    flag(){ G.flag(S, '_tv', src.now()); },
    nudgeD(ms){ S.D += ms; S.dTaps = S.dTaps.map(x => x + ms); },
    trivia(){ G.ad(S, '_', src.now()); },
    reset(){ S = G.create(cfg); persist(); info(); },
    act(id, d){ fromPhone(id, d, src.now()); },      // tests
    destroy(){ dead = true; timers.forEach(clearInterval); persist(); if(handle) handle.destroy(); },
  };
}

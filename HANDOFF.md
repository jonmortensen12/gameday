# Game Day — handoff

A second screen for watching a real football game at a party: guests call
plays on their phones, trivia fills the commercial breaks, a jumbotron
beside the TV keeps score, puts people on the "Cougar Cam" and replays the
room's reactions. Built for BYU at Utah, Saturday 2026-11-07, 10:00 MT on
ABC. The room is all BYU fans; the team is a setting, so any game works.

## Pieces

| File | What it is |
|---|---|
| `web/index.html` | The jumbotron. Setup screen (pick a game, or rehearse a finished one), then the board. Hosts the room. |
| `web/play.html` | The phone. Joins from the QR code, no install. |
| `web/feed.js` | ESPN's public feed → plays, drives, score. `normalize`, `slice`, `liveSource`, `replaySource`. |
| `web/game.js` | Everything that decides anything. Pure: no DOM, no network, no clock. |
| `web/trivia.js` | The question bank (adults and kids) and questions built from the live box score. |
| `web/host.js` | The room: PeerJS (via `net.js`), phone messages, polling, saving to localStorage. |
| `web/cam.js` | Camera, people finder (MediaPipe, vendored in `web/lib/mediapipe/`), noise, reaction recorder, clips in IndexedDB. |
| `web/net.js`, `web/qr.js`, `worker.js` | Copied from Night Watch (prefix `gameday-`). `/relay` is Cloudflare TURN if `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` are set on this Worker; it works without. |

## The feed, and why everything is timestamped

`https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=ID`
— no key, CORS open, `cache-control: max-age=2`. The jumbotron polls it
every 3 s. BYU at Utah is event **401856849**.

It is **slow**: a play reaches it 24–56 s after it happens (measured on SNF,
2026-11-01; `tools/lag.py` measures any live game). That is about one play
behind the TV, so the feed can never open or close a call. Instead:

- Every play carries `wallclock`, when it really happened. The TV shows it
  at `wall + D`. **D** is measured: phones get a KICK button at the opening
  kickoff, after scores and at halftime; when the kickoff turns up in the
  feed, D = median tap − its wallclock. Before any tap D is a 6 s guess
  (antenna). `[` / `]` on the jumbotron nudge it.
- Every phone action is stamped by the host when it arrives (never the
  phone's clock). A call counts for a play if it was made before
  `wall + D − 1.5 s`; the newest such call wins; later ones wait for the
  next play. So a call made after seeing the snap simply lands on the next
  play — `gamecheck` has a "cheater" proving it scores no better than a coin.
- Plays wait in a queue until `wall + D` has passed, because over a
  streaming app the feed can be **ahead** of the TV.
- Some plays have **wrong wallclocks** (an hour late, half an hour early,
  missing). `markBadWalls` keeps the longest run of forward-moving clocks;
  the rest are `badWall`, never settle a call and never measure D.
- Kickoffs never use up a call (calls made in the break are for the first
  snap after it). Punts and field goals do, as "no call". Pre-snap penalties
  (NO PLAY), kneels and spikes are ignored.

## The games

- **Call the snap** — RUN / PASS, optional 🔥 big play (15+ yards). 10 pts,
  +10 if a third or fewer of the room (3+ people) called it, ×1.5 at a
  3-streak, ×2 at 5. Big play +20, or a missed big play breaks the streak.
- **Next drive** — one question always open: how does the *next* drive end
  (TD / FG / punt / turnover, where missed FG and downs are turnovers)? It
  locks at that drive's first snap and the next opens. Being about the next
  drive is what makes the feed's delay not matter. Settled from ESPN's drive
  `result`. 25 pts.
- **Reviews** — any phone's 🚩 (tap twice) opens a 45 s STANDS / OVERTURNED
  vote. The feed reports the ruling in the next play's text ("CALL UPHELD",
  "CALL OVERTURNED", NFL "REVERSED"); `reviewOf` reads it. Nothing after
  4 minutes: the phones ask "what did the ref say?" 40 pts, flagger +5.
  About two reviews a game.
- **Trivia** — 3 questions × 15 s when the feed shows a break: the kickoff
  after a score (commercials follow it — see the 4-minute gaps in any
  game's wallclocks), a timeout, end of Q1/Q3; 10 at halftime. At least
  3 minutes between rounds unless a phone presses 📺. A round stops after
  the current question once a play is snapped. Kids get their own bank on
  the same clock. 15 pts + up to 5 for speed.
- **ROC meter** — the room's accuracy over its last 40 calls.

## The jumbotron

Dim and still while the game is on (`body.quiet`); full brightness for
trivia, reviews, a BYU score (7 s, silent), the Cougar Cam and the final
awards. **It makes no sound at all.**

- **Cougar Cam** after each trivia round, after a BYU score, and every
  minute or so before the game and at halftime: finds people
  (efficientdet_lite0, people only, ~1.5 Hz), picks one not shown lately,
  zooms the camera picture onto their head and shoulders with a caption.
- **Reactions**: when the room's noise jumps 14 dB over its own median for
  half a second, the clip from 8–16 s before to 5 s after is kept (rotating
  MediaRecorders: a new one every 8 s, each lives 26 s). Labelled with the
  play that was on the TV just before. Played once, muted, at the next
  break; the 8 loudest loop at halftime (`V` plays them any time). Clips stay
  on the laptop (IndexedDB, 40 kept); `S` downloads them.
- Keys: `F` full screen, `H` help, `C` cam, `R` fake a shout, `T` trivia,
  `V` reel, `[` `]` delay, `P` / `→` pause / skip a rehearsal.
- The game saves every 4 s with its room code; a reload (or the laptop
  sleeping) carries on, and phones reconnect by themselves.

## Phone protocol

phone → host: `hello {dev, name, kid}`, `call {v: run|pass, big}`,
`drive {v}`, `flag`, `rvote {v}`, `ref {v: stands|overturned|none}`,
`kick`, `ad`, `ans {n, i}`, `ping` (every 2.5 s; 8 s silent = away).
host → phone: `host`, then `st` (the whole view for that phone, sent when it
changes) — see `phoneView` in `game.js`.

## Testing

- `node gamecheck.mjs` — three recorded games (`tests/fixtures/`) through
  `game.js` with simulated people, at antenna and streaming delays.
- `node netcheck.mjs` — real pages in Chromium, ESPN served from a fixture,
  fake camera and mic.
- `node camcheck.mjs` — people finding on a built living-room picture.
- **Rehearse**: setup → "rehearse with a finished game" plays a real feed
  back as if live (25–55 s lag per play). With the game's replay video:
  start both, tap KICK at the kickoff.
- **A live game**: setup lists today's games (📡 = broadcast network, on an
  antenna). Nothing college or NFL is on an antenna between 2026-11-02 and
  BYU's kickoff, so a pre-game live test means a streamed game (ESPN app) —
  the KICK taps calibrate for the streaming delay the same way.

## Not built / ideas

- Clips to phones (now only on the laptop; `S` saves them).
- More trivia: ~40 adult questions and the game can use 60+; the bank
  starts over when it runs dry. Add to `BANK` in `trivia.js`.
- Team timeouts start trivia though not every one is a commercial; if that
  is too much, drop `'timeout'` as a break in `feed()` in `game.js`.
- Scoreboard shared with other party games (GAMEDAY.md's party-hub idea).

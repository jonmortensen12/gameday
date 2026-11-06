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
  at `wall + D`. **D** is measured from taps (`measure()` in `game.js`):
  KICK (prompted before the game, after scores, at halftime) and ⏱ (any
  snap, any time, on every phone; Space on the jumbotron). Each tap could
  be any play from the 2.5 minutes before it, so it offers a set of
  possible delays; taps on different snaps (4 s apart or more) share only
  the true one, because plays are irregularly spaced. A KICK tap can only
  match a kickoff, so it settles D alone; a single ⏱ tap only fine-tunes a
  D already known (within 10 s). ⏱ taps are used once 90 s old (their play
  must be in the feed by then). Before any tap D is a 6 s guess.
  `[` / `]` on the jumbotron nudge it. Measured 2026-11-05 on Thursday
  Night Football: the feed ran 22-53 s behind real time (median 42).
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
- **Next drive** — five questions about the next drive: how it ends (TD /
  FG / punt / turnover, where missed FG and downs are turnovers, 25 pts),
  plays (1-3 / 4-5 / 6-8 / 9+), yards (<10 / 10-29 / 30-59 / 60+), time of
  possession (<1:30 / 1:30-2:30 / 2:30-4:00 / 4:00+) (15 pts each) and a
  penalty flag yes/no (10). The buckets are the quartiles of 465 real
  drives, so each comes up about a quarter of the time. Guesses are
  timestamped like calls: each counts for the first drive whose first
  snap (not its kickoff) reaches the TV after it was made, so the moment a
  drive starts new guesses go to the one after. Settled from ESPN's drive
  summary (`result`, `offensivePlays`, `yards`, `timeElapsed`, any play
  with "penalty"). A drive cut off by the half or the game counts for
  nothing.
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

**Two modes**, switched on the setup screen, with `M` or the mode button on
the board, at any time: *every play* (all of the above) and *drives only*
(no RUN/PASS; the drive question is the game; reviews and trivia carry on).
Switching drops calls not yet settled; nothing already scored changes.

**Reviews, by hand**: 🚩 on any phone (tap twice) or `X` / the 🚩 button on
the jumbotron opens one. Once the 45 s vote closes, any phone (or `1` / `2`
on the jumbotron) can say the ruling the moment the referee announces it.
The feed still checks: if its ruling turns up within 12 minutes and
differs, the points move to the right voters and the board says "corrected
by the feed".

## What the screens show

- **The situation** (phones and jumbotron): quarter, clock, who has the
  ball, down and distance at the spot, after the newest play the TV has
  shown. "NOW" when that play was on the TV under 25 s ago; otherwise
  "ESPN CATCHING UP" (the TV may be a play or two ahead).
- Every settled call carries its play's situation ("3rd & 2 at BAL 43 ·
  Q2") and what it was.
- Phones: **This drive** (the one going now: plays, yards and flags so far
  against your guesses) and **Next drive** (the five questions).
- Phones, **My guesses** tab: the record (plays, big plays, each drive
  question, reviews, trivia) and the last 30 settled guesses, drives as a
  you / actual table.

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

## Coming back (people use their phones for other things)

- Scores live on the jumbotron, saved every 4 s with the room code. A
  phone holds nothing that matters.
- A phone that has joined before goes straight back in when the page is
  reopened, reloaded, found in history or the QR scanned again: no typing.
- A phone that hears nothing for 8 s reconnects (the TV sends at least
  every 3 s), and again on returning to the tab, `pageshow`, `online`,
  `focus`. A banner shows after 1.5 s without the room; tapping it retries.
- A phone that lost its saved id (another browser, private mode, cleared
  data) and types the same name gets that player's score back, if that
  player has not been heard from for 4 s. It is told "Welcome back, Jon!
  You have 135 points" with a "Not me - start fresh" button (which makes
  "Jon 2").
- The jumbotron reloading keeps the code (it asks the broker for it again
  for up to 3 minutes); phones rejoin by themselves.

## Phone protocol

phone → host: `hello {dev, name, kid}`, `call {v: run|pass, big}`,
`dpick {f: res|plays|yards|time|flag, v}`, `snap` (⏱), `flag`, `rvote {v}`, `ref {v: stands|overturned|none}`,
`kick`, `ad`, `ans {n, i}`, `fresh {dev, name, kid}` ("not me"), `bye`
(the page closed), `ping` (every 2.5 s; 8 s silent = away).
host → phone: `host {code, name, back: {n, s} | null}`, then `st` (the whole view for that phone, sent when it
changes) — see `phoneView` in `game.js`.

## Testing

- `node gamecheck.mjs` — four recorded games (`tests/fixtures/`, one NFL)
  through `game.js` with simulated people, at antenna and streaming delays;
  drives-only, a switch at halftime, the room giving wrong rulings that the
  feed corrects, and rejoining by name.
- `node netcheck.mjs` — real pages in Chromium, ESPN served from a fixture,
  fake camera and mic; the mode switch, a phone reloading, a phone coming
  back as a stranger, the jumbotron reloading.
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

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

Nothing is guessed until somebody asks (a **push**). Since 2026-11-06 this
replaced the always-open RUN/PASS card, the always-open next-drive card and
the drives-only mode.

- **📣 Call the next play** (any grown-up's phone, or `A` on the
  jumbotron): everybody gets **30 s**. The card has three tabs, and opens
  on the likely one (4th down on their own side: Punt; past midfield:
  Field goal). Every button shows its points - the rarer, the more
  (`CALLS` in `game.js`, from 19 recorded games, 3,347 plays):
  - **Run / Pass** 10 (+10 if a third or fewer of 3+ people called it,
    ×1.5 at a 3-streak, ×2 at 5). Add-ons, which cost the streak when
    they miss: 🔥 big play 15+ yds +20; 💥 turnover +100 (the ball lost on
    1.2% of runs and passes; interceptions and lost fumbles, not downs).
  - **Field goal**: good 10 (80%), missed 40 (18%), blocked 150 (2%).
  - **Punt**: fair catch 15 (33%), no return 15 (35%: out of bounds,
    downed, touchback), returned under 5 yds 30 (15%), 5-14 50 (8%), 15+
    50 (9%), muffed 150 (<1%), blocked 150.
  - **Go for it / fake** 60, on either kick tab: right when the play is a
    run or pass on 4th down. ESPN never says "fake" and cannot tell one
    from going for it (teams went for it on 26% of 4th downs, 13% on their
    own side), so it is priced as going for it. A kick called on 1st-3rd
    down that turns out a run or pass scores nothing either way.
  - Kick outcomes come from `kickOf()` in `feed.js`: ESPN's words (fair
    catch, muff, blocked, downed, out of bounds, touchback, "Field Goal
    Good/Missed", "Blocked ...") and, for returns, the punt's statYardage,
    which is the return yardage. ("Illegal Block" penalties are not blocked
    kicks.)
- **🏈 New drive** (any phone, `D` on the jumbotron, or **the feed** when it
  reports the ball changing hands - a score, punt, turnover, missed field
  goal, downs, halftime - or at the first KICK tap - unless the next drive
  has already started on the TV): everybody gets **120 s** for five
  questions about the next drive: how it ends (TD / FG / punt / turnover,
  where missed FG and downs are turnovers; punt 20, TD 25, turnover 35, FG
  80, from how 380 real drives ended: 38% / 30% / 23% / 9.5%), plays (1-3 / 4-5 / 6-8
  / 9+), yards (<10 / 10-29 / 30-59 / 60+), time of possession (<1:30 /
  1:30-2:30 / 2:30-4:00 / 4:00+) (15 pts each) and a penalty flag yes/no
  (10). The buckets are the quartiles of 465 real drives. Settled from
  ESPN's drive summary. A drive cut off by the half or the game counts for
  nothing.
- **🔒 Lock everyone's guesses**: only whoever pushed (or Space on the
  jumbotron for its own pushes) - meant for the snap. Locks for everybody
  at once, in real time, and is also a ⏱ sync tap.
- **Which play or drive a push was about** is worked out when the feed
  catches up: the first snap on the TV after the push (after its lock, if
  the lock was tapped, allowing 8 s for a lock tapped just before the
  snap). A guess made after the snap never counts: after the lock tap (3 s
  slack for a slow thumb), otherwise after `wall + D - 1.5 s`.
- **One of each kind at a time**: a push blocks the next of its kind until
  the feed has matched it - or until its lock was tapped, which marks its
  snap. A push nothing matches within 10 minutes is dropped.
- **ESPN stamps each play within ~2 s of its snap.** Checked on 505 pairs
  of plays with the clock running: where the two plays differ in length,
  the snap explains the gaps (typical miss 2.5 s), the end of the play does
  not (4.0 s). `S.lockLog` keeps every lock tap minus the feed's snap time,
  to check this against a real room.
- **Reviews**: 🚩 on any phone (tap twice) or `X` on the jumbotron; 45 s
  vote; any phone (or `1` / `2`) can give the ruling once voting closes;
  the feed checks it within 12 minutes and moves the points if the room
  heard it wrong. 40 pts, flagger +5.
- **Trivia** — 3 questions × 15 s when the feed shows a break: the kickoff
  after a score, a timeout, end of Q1/Q3; 10 at halftime. At least
  3 minutes between rounds unless a phone presses 📺. Kids get their own
  bank on the same clock. 15 pts + up to 5 for speed. **Ending it early**:
  ⏭ on any grown-up's phone (tap twice), `E` on the jumbotron, or calling
  for a play or a drive - all go straight back to the game.
- **ROC meter** — the room's accuracy over its last 40 calls.
- In a sped-up rehearsal the answer windows stay 30 s and 120 s of real
  time (`S.speed`).

## What the screens show

- **The situation** (phones and jumbotron): quarter, clock, who has the
  ball, down and distance at the spot, after the newest play the TV has
  shown. "NOW" when that play was on the TV under 25 s ago; otherwise
  "ESPN CATCHING UP" (the TV may be a play or two ahead).
- Every settled call carries its play's situation ("3rd & 2 at BAL 43 ·
  Q2") and what it was.
- Phones: the two push buttons, the open play and drive questions with
  their countdowns (and the lock button for whoever pushed), **This drive**
  (the one going now: plays, yards and flags so far against your guesses)
  and the latest results. A push buzzes every phone.
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
`push {kind: play|drive}`, `lock {kind}`, `call {v: run|pass|fg:...|punt:..., big, to}`
(answer the called play), `skip` (end trivia), `dpick {f: res|plays|yards|time|flag, v}` (answer the
drive push), `snap` (⏱), `flag`, `rvote {v}`, `ref {v: stands|overturned|none}`,
`kick`, `ad`, `ans {n, i}`, `fresh {dev, name, kid}` ("not me"), `bye`
(the page closed), `ping` (every 2.5 s; 8 s silent = away).
host → phone: `host {code, name, back: {n, s} | null}`, then `st` (the whole view for that phone, sent when it
changes) — see `phoneView` in `game.js`.

## Testing

- `node gamecheck.mjs` — four recorded games (`tests/fixtures/`, one NFL)
  through `game.js` with simulated people, at antenna and streaming delays:
  pushes by hand and by the feed, locks at the snap with ~1 s of thumb,
  answers before the snap (count, matched to the right play every time)
  and after it (never count), syncing from ⏱ alone, the room giving wrong
  rulings that the feed corrects, and rejoining by name.
- `node netcheck.mjs` — real pages in Chromium, ESPN served from a fixture
  at 60x (held still for each push's "huddle", or nobody could answer in
  time), fake camera and mic; a phone pushing and locking, `A` on the
  jumbotron, a phone reloading, a phone coming back as a stranger, the
  jumbotron reloading.
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

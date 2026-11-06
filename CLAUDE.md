# Game Day

## Git workflow

Solo project, no collaborators — work directly on `main`. Commit and push
straight to `main`, no feature branches or PRs needed. Cloudflare Workers
deploys from `main` on every push, so anything on another branch is not
live, and a change has to work before it is committed.

## Start here

Read `HANDOFF.md` before making any non-trivial change — how the feed's
delay is handled, the phone protocol, the tuning numbers and what is not
built yet. The party plan this came from is `GAMEDAY.md` in
jonmortensen12/Night-Watch.

## The game lives in `web/`

`web/` is the only directory Cloudflare uploads. The check scripts, the
fixtures, the tools and the notes beside it stay in the repo and off the
internet. Run the checks from the repo root.

## Before shipping

```
node gamecheck.mjs   # the game, headless, through four real recorded games: pushed plays and drives, locks, reviews, trivia, the TV delay
node netcheck.mjs    # the jumbotron and three phones in Chromium over ?local=1, a replayed game at 60x, the fake camera (several minutes)
node camcheck.mjs    # the Cougar Cam finds three people across a pretend living room (needs ffmpeg + Pillow)
python3 tools/lag.py cfb EVENT 600   # how far behind the ESPN feed is during a live game
```

`web/game.js` decides everything and draws nothing; `web/feed.js` turns
ESPN's feed into plays. Change either and `gamecheck` says whether calls
made before the snap still score and calls made after it still do not.

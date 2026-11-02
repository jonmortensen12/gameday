"""Game Day - how far behind is the ESPN feed, right now?

Polls a live game's summary every 3 s and prints, for each new play, how
many seconds after it happened (its wallclock) it reached the feed. Run it
during any live game before relying on the feed:

    python3 tools/lag.py cfb 401866453 600     # league, event id, seconds
    python3 tools/lag.py nfl 401873036 600 --save tests/fixtures/new.json

Event ids are in the jumbotron's game list, or on ESPN's game page URL
(.../game/_/gameId/401856849/...). --save keeps the final summary as a
fixture for gamecheck.mjs. Measured 2026-11-01 on Sunday Night Football:
24-56 s.
"""
import json, sys, time, urllib.request
from datetime import datetime, timezone

LEAGUES = {'cfb': 'college-football', 'nfl': 'nfl'}
league, event, secs = sys.argv[1], sys.argv[2], int(sys.argv[3])
save = sys.argv[sys.argv.index('--save') + 1] if '--save' in sys.argv else None
url = 'https://site.api.espn.com/apis/site/v2/sports/football/%s/summary?event=%s' % (LEAGUES.get(league, league), event)
seen, first, lags, raw = set(), True, [], None
end = time.time() + secs
while time.time() < end:
    try:
        raw = json.load(urllib.request.urlopen(url + '&_=%d' % time.time(), timeout=10))
        now = datetime.now(timezone.utc)
        ds = raw.get('drives', {})
        plays = [p for d in ds.get('previous', []) for p in d.get('plays', [])]
        if 'current' in ds: plays += ds['current'].get('plays', [])
        for p in plays:
            if p['id'] in seen: continue
            seen.add(p['id'])
            if first or not p.get('wallclock'): continue
            w = datetime.fromisoformat(p['wallclock'].replace('Z', '+00:00'))
            lag = (now - w).total_seconds()
            lags.append(lag)
            print('%s  %5.1f s  %-18s %s' % (now.strftime('%H:%M:%S'), lag, p['type']['text'][:18], p['text'][:80]), flush=True)
        first = False
    except Exception as e:
        print('error', e, flush=True)
    time.sleep(3)
if lags:
    s = sorted(lags)
    print('\n%d plays: median %.0f s, fastest %.0f s, slowest %.0f s' % (len(s), s[len(s) // 2], s[0], s[-1]))
if save and raw:
    json.dump(raw, open(save, 'w'))
    print('saved', save)

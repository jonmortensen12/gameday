/* Game Day - the Worker. Copied from Night Watch (from Mission Control).

   Everything in web/ is served straight from the assets; only the paths
   listed in wrangler.jsonc's run_worker_first reach this code. Today that
   is just /relay.

   /relay: Cloudflare TURN, the last of the routes a phone and the TV try.
   WebRTC prefers the same wifi, then straight across the internet, and
   only uses a relay when neither works - a guest network, a router that
   keeps devices apart, a phone on mobile data. Ported from Family
   Beatdown's relayPass.

   Two SECRETS, from the Cloudflare dashboard's TURN key: TURN_KEY_ID and
   TURN_KEY_API_TOKEN (Workers -> gameday -> Settings -> Variables
   and Secrets). Without them /relay answers {iceServers: null} and the game
   connects exactly as it would with no relay at all.

   A pass lasts RELAY_TTL and the page keeps it, so a game night costs a
   device one request here. The Worker reuses a pass it was just given for
   an hour rather than asking Cloudflare once per phone. No CORS header:
   another site's page cannot read a pass. */
const RELAY_TTL = 12 * 3600;                 // seconds
const RELAY_API = 'https://rtc.live.cloudflare.com/v1/turn/keys/';
let relayKept = null;                        // {id, body, until}

function relayKeys(env) {
  const id = (env.TURN_KEY_ID || '').trim();
  const token = (env.TURN_KEY_API_TOKEN || '').trim();
  return id && token ? { id, token } : null;
}

async function relayPass(env) {
  const keys = relayKeys(env);
  if (!keys) return { iceServers: null, why: 'not-set-up' };
  if (relayKept && relayKept.id === keys.id && Date.now() < relayKept.until) return relayKept.body;
  let res;
  try {
    res = await fetch(RELAY_API + encodeURIComponent(keys.id) + '/credentials/generate-ice-servers', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + keys.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: RELAY_TTL }),
    });
  } catch (e) {
    return { iceServers: null, why: 'cloudflare-unreachable' };
  }
  if (!res.ok) return { iceServers: null, why: 'cloudflare-' + res.status };
  let j;
  try { j = await res.json(); } catch (e) { return { iceServers: null, why: 'cloudflare-bad-answer' }; }
  // port 53 is in Cloudflare's list and browsers refuse it: it would only ever time out
  const ice = [].concat((j && j.iceServers) || []).map(s => Object.assign({}, s, {
    urls: [].concat(s.urls || []).filter(u => !/:53(\?|$)/.test(u)),
  })).filter(s => s.urls.length);
  if (!ice.length) return { iceServers: null, why: 'cloudflare-empty' };
  const now = Date.now();
  const body = { iceServers: ice, exp: now + RELAY_TTL * 1000 };
  relayKept = { id: keys.id, body, until: now + 3600 * 1000 };
  return body;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/relay' ) {
      return new Response(JSON.stringify(await relayPass(env)), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};

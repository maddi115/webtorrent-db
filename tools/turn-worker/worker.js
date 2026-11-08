// worker.js - A tiny Cloudflare Worker that hands out short-lived TURN logins.
// The secret TURN key stays here. The public site only ever sees logins that expire.
// Secrets: TURN_KEY_ID, TURN_KEY_API_TOKEN. Setting: ALLOWED_ORIGINS (comma separated).
const TTL_SECONDS = 24 * 60 * 60;
const REUSE_MS = 60 * 60 * 1000;
let saved = null;

function corsHeaders(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
    return allowed.includes(origin)
        ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET', Vary: 'Origin' }
        : null;
}

// One set of logins is shared for an hour, so a busy site makes few requests
async function getIceServers(env) {
    if (saved && Date.now() - saved.at < REUSE_MS) return saved.body;

    const answer = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ttl: TTL_SECONDS })
        }
    );
    if (!answer.ok) throw new Error(`Cloudflare answered ${answer.status}`);

    saved = { at: Date.now(), body: await answer.text() };
    return saved.body;
}

export default {
    async fetch(request, env) {
        const cors = corsHeaders(request, env);
        if (!cors) return new Response('Not allowed', { status: 403 });
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (request.method !== 'GET') return new Response('Not found', { status: 404, headers: cors });

        try {
            return new Response(await getIceServers(env), {
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }
            });
        } catch {
            return new Response('TURN is unavailable', { status: 502, headers: cors });
        }
    }
};

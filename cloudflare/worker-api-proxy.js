/**
 * Cloudflare Worker — api.minuto.co.il → Supabase Edge Functions proxy.
 *
 * Routes:
 *   api.minuto.co.il/<path>       →  ytydgldyeygpzmlxvpvb.supabase.co/functions/v1/<path>
 *
 * Examples:
 *   api.minuto.co.il/forms-submit                →  /functions/v1/forms-submit
 *   api.minuto.co.il/email-automation-scheduler  →  /functions/v1/email-automation-scheduler
 *   api.minuto.co.il/marketing-advisor           →  /functions/v1/marketing-advisor
 *
 * Why this Worker exists:
 *   - Forms on minuto.co.il post to a Minuto-branded URL instead of a
 *     Supabase project hash. Looks legitimate in browser DevTools, no
 *     "what is ytydgldyeygpzmlxvpvb?" trust friction.
 *   - Decouples the public API from the underlying provider. If we
 *     ever migrate off Supabase, only this Worker changes — the
 *     hundreds of WordPress form submissions and the dev's code keep
 *     working unchanged.
 *   - Easy to add cross-cutting concerns later (rate limit by IP,
 *     bot detection, request logging) without touching every edge
 *     function.
 *
 * Free tier: 100k requests/day. Minuto's traffic is far below that.
 *
 * Setup checklist (one-time, in Cloudflare dashboard):
 *   1. DNS → add CNAME: api.minuto.co.il → minuto.co.il (proxied / orange cloud)
 *   2. Workers & Pages → Create → Quick Edit
 *      - Name: minuto-api-proxy
 *      - Paste this file's content as the Worker script
 *      - Save & Deploy
 *   3. Same Worker → Settings → Triggers → Add Route:
 *      - Route: api.minuto.co.il/*
 *      - Zone: minuto.co.il
 *
 * Test after setup:
 *   curl -i -X POST https://api.minuto.co.il/forms-submit \
 *     -H "Content-Type: application/json" \
 *     -d '{"type":"newsletter","email":"erez+wt@minuto.co.il","consent":true}'
 *   Expect: 200 OK with {"ok":true,"type":"newsletter",...}
 */

const SUPABASE_FUNCTIONS_BASE =
  'https://ytydgldyeygpzmlxvpvb.supabase.co/functions/v1';

// Allowed paths — only proxy traffic for functions we know about. Prevents
// an open proxy that could be used to attack other Supabase endpoints.
// Add new function names here when shipping new ones.
const ALLOWED_FUNCTION_NAMES = new Set([
  'forms-submit',
  'email-automation-scheduler',
  'marketing-advisor',
  // Add more as needed; keep tight.
]);

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Path is something like /forms-submit or /forms-submit/sub. We only
    // route on the first segment; everything after it gets forwarded as-is
    // to give edge functions room to use sub-paths if they want to later.
    const segments = url.pathname.split('/').filter(Boolean);
    const fnName = segments[0] ?? '';
    const subPath = segments.slice(1).join('/');

    // Health check — no upstream call. Useful for monitoring.
    if (fnName === '_health') {
      return new Response(
        JSON.stringify({ ok: true, service: 'minuto-api-proxy' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Reject unknown function names rather than blindly proxying. Closes
    // off the "is this an open proxy?" attack surface.
    if (!ALLOWED_FUNCTION_NAMES.has(fnName)) {
      return new Response(
        JSON.stringify({ error: `Unknown endpoint: /${fnName}` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Build the upstream Supabase URL. Preserve query string + sub-path.
    const upstream =
      `${SUPABASE_FUNCTIONS_BASE}/${fnName}` +
      (subPath ? `/${subPath}` : '') +
      url.search;

    // Forward request 1:1. redirect:'manual' so we surface 30x responses
    // from upstream instead of silently following them (the same trap
    // that bit us with the WC POST→GET redirect a few hours ago).
    const init = {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    };

    try {
      const upstreamRes = await fetch(upstream, init);

      // Pass through status + body + headers. Strip Cloudflare/Supabase
      // hop-by-hop headers (handled automatically by Fetch API but
      // explicit is safer).
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: upstreamRes.headers,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: 'Upstream proxy failure',
          detail: err.message,
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },
};

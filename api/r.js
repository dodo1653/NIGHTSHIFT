// Same-origin proxy to the relay (Vercel edge). Reads are cached for a few seconds at the CDN, so the relay (a free
// Cloudflare Durable Object, shared request budget) sees a handful of requests however many people are watching.
// Hiring, uploads and launches go to the relay directly.
export const config = { runtime: 'edge' }
const RELAY = 'https://nightshift-relay.vetted-relay.workers.dev/v1/'
const TTL = { floor: 2, agent: 2, board: 4, vamp: 2, modes: 300, coin: 4 }
export default async function handler(req) {
  const u = new URL(req.url), path = u.searchParams.get('path')
  if (!TTL[path]) return new Response('{"error":"unknown"}', { status: 404, headers: { 'content-type': 'application/json' } })
  u.searchParams.delete('path')
  const r = await fetch(RELAY + path + '?' + u.searchParams.toString(), { cache: 'no-store' })
  return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': `public, s-maxage=${TTL[path]}, stale-while-revalidate=${TTL[path] * 3}` } })
}

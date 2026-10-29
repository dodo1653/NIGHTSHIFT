// Same-origin proxy to the relay (Vercel edge). Reads are cached a few seconds at the CDN so the relay's request
// budget holds however many people are watching; uploads, sends and launch notices pass straight through. Hiring
// goes to the relay directly (it limits hires per connection, so it needs the visitor's own address): `where` tells
// the page where the relay is.
import { RELAY_BASE } from './_relay.js'
export const config = { runtime: 'edge' }
const TTL = { floor: 2, agent: 2, board: 4, vamp: 2, modes: 300, coin: 4 }
const POSTS = new Set(['upload', 'send', 'launched', 'hire'])
const J = { 'content-type': 'application/json' }
export default async function handler(req) {
  const u = new URL(req.url), path = u.searchParams.get('path')
  if (path === 'where') return new Response(JSON.stringify({ base: RELAY_BASE }), { headers: { ...J, 'cache-control': 'public, s-maxage=60' } })
  if (req.method === 'POST') {
    if (!POSTS.has(path)) return new Response('{"error":"unknown"}', { status: 404, headers: J })
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    const r = await fetch(`${RELAY_BASE}/v1/${path}`, { method: 'POST', headers: { ...J, 'x-visitor-ip': ip }, body: await req.text() }).catch(() => null)
    if (!r) return new Response('{"error":"the relay is offline, try again in a minute"}', { status: 502, headers: J })
    return new Response(r.body, { status: r.status, headers: { ...J, 'cache-control': 'no-store' } })
  }
  if (!TTL[path]) return new Response('{"error":"unknown"}', { status: 404, headers: J })
  u.searchParams.delete('path')
  const r = await fetch(`${RELAY_BASE}/v1/${path}?${u.searchParams}`, { cache: 'no-store' }).catch(() => null)
  if (!r || !r.ok) return new Response('{"error":"relay offline"}', { status: 502, headers: { ...J, 'cache-control': 'no-store' } })
  return new Response(r.body, { status: r.status, headers: { ...J, 'cache-control': `public, s-maxage=${TTL[path]}, stale-while-revalidate=${TTL[path] * 3}` } })
}

// Vercel function: the shared world's presence and clock (src/net/presence.ts). It runs only
// when a visible tab asks, so with nobody playing it costs nothing. State lives in Upstash Redis
// when KV_REST_API_URL and KV_REST_API_TOKEN are set (Vercel → Storage → Upstash), and in this
// instance's memory otherwise, which only works while every player lands on the same instance.
//
// Edge runtime: Vercel bundles it (and the src/ files it imports) into one file with esbuild, and
// it needs only fetch and crypto.subtle. scripts/serve.mjs and the tests call the same handler.
import { MAX_MESSAGE_BYTES } from '../src/net/protocol.ts';
import { clockReply, handlePresence, storeFromEnv, type Reply } from '../src/net/presence.ts';

export const config = { runtime: 'edge' };

const env = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const store = storeFromEnv(env, (url, init) => fetch(url, init));

const json = (r: Reply): Response => new Response(JSON.stringify(r.body), {
  status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'GET') return json(clockReply(store, Date.now()));
  if (req.method !== 'POST') return json({ status: 405, body: { error: 'GET or POST' } });
  const text = await req.text();
  if (text.length > MAX_MESSAGE_BYTES / 64) return json({ status: 413, body: { error: 'too big' } });
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return json({ status: 400, body: { error: 'bad json' } }); }
  try { return json(await handlePresence(store, raw, Date.now())); } catch (e) {
    console.error('presence failed', e);
    return json({ status: 503, body: { error: 'store unavailable' } });
  }
}

# NOTES: Temasek 1360 MVP

Handoff notes for whoever picks this up next (human or agent). Read this, `README.md`,
`docs/DESIGN.md` and `git log` before changing anything.

## Done (10 Nov 2026): a shared world on the live site (branch `autopilot/temasek-1360-live`)

The deployed site (Vercel, static `site/`) had no server, so every tab played alone. Constraint from Nat: very
light, free tier, cost only while people are actually playing, no VM ticking around the clock.

**Options weighed**

| Option | Idle cost | Fits? | Why not / why |
|---|---|---|---|
| Node game server (`server/`) on a VM | always on | no | ticks 24/7 even with nobody there |
| Cloudflare Durable Objects, hibernating WebSockets | ~0 | yes | real authoritative realm, but a new account, a second deploy and a port of `server/` to Workers |
| PartyKit-style hibernating rooms | ~0 | yes | same as above (it is Durable Objects underneath), one more vendor |
| **Vercel function + Upstash Redis (chosen)** | **0 requests, 0 storage** | **yes** | already connected; no new deploy target; nothing runs unless a visible tab asks |

**How it works**

- **The clock is a function of time, not a loop.** `src/net/clock.ts`: realm tick = `floor((now − 1 Nov 2026 UTC) / 600 ms)`.
  Every tab computes the same tick, so the monsoon, who's in port and the countdown agree everywhere with no server
  state at all. The only thing a tab needs from the server is the time (to correct its own clock, ±RTT/2).
- **Joining moves your World onto the realm clock.** `setClock()` in `world.ts` jumps `tick` and shifts the tick-based
  timers (fight cool-down, respawns) by the same amount; if the jump crosses a monsoon it turns exactly as `step()` does
  (closes a departed trader's shop). That's the "what does a loaded save's clock mean" call: **the realm's**. Tested
  with the Act 1 bot starting at a realm tick.
- **Rules still run in the tab** (`LiveLink` wraps a `GameHost`, like the loopback), ticked up to the realm tick each
  frame (one tick per frame in a fight, as before). Back from a long-hidden tab it jumps instead of replaying.
- **Presence is the only shared state.** `api/world.ts` (Edge runtime, so Vercel bundles it and its `src/` imports into
  one file with esbuild; no question of how `.ts` import paths resolve at runtime) → `src/net/presence.ts`. A visible, active tab POSTs its pose
  (position, facing, the next ≤8 path tiles, fishing/fighting) every **5 s alone / 2 s with someone in view**, and
  gets back the players within `SEE_RADIUS` (keeps them to `FORGET_RADIUS`, as the WebSocket realm does). Others'
  walks are played forward on the shared clock between posts, so they don't jump.
- **Hidden or idle tabs stay in the world, as away** (Nat's playtest, 10 Nov: "they disappear when I tab out"). Hidden,
  or no input for 2 min → no more polling, just a tiny heartbeat (`beat`: HSET + PEXPIRE, nothing read back) at once
  (as a beacon) and every 60 s; others draw them dimmed, tagged "away", standing where they were last seen. A visible
  player who goes quiet for 15 s is shown as away too. Removed only after **10 min without any post or heartbeat**, or at
  once when the page closes (`pagehide` → `sendBeacon` leave; `pageshow` from the back/forward cache rejoins). Showing
  the tab again counts as input: it posts at once, so who's there and the clock resync immediately.
- **Storage:** one Redis hash, one HTTP request = 3 commands (HSET, PEXPIRE, HGETALL) per post, 2 per heartbeat. The
  hash expires 11 min after the last write, so an empty realm stores nothing. Without KV env vars the function keeps presence in its
  own memory (`store: "memory"` in every reply), which works only while all players hit the same instance; fine for a
  preview, not for real use.
- **Identity:** each tab makes a random 128-bit token; others see only `sha256(token)` → a 31-bit id, so nobody can post
  or leave as someone else. Capped at `MAX_PLAYERS` (64).
- **Fallbacks:** no `/api/world` (plain static host, `scripts/serve.mjs --static`) → offline as before. `?offline`
  forces offline; `?server` still uses the WebSocket game server. If posts fail mid-game the game carries on, on the
  realm clock, retrying with backoff up to 60 s.
- **Local:** `node scripts/serve.mjs` now also answers `/api/world` (memory store), so two local tabs share the world.

**Cost, at free-tier limits (Nov 2026; re-check the plan pages)**

- Requests per player-hour: 720 alone, 1,800 with someone in view, 60 for a hidden/idle tab. Zero open tabs: zero.
- Upstash Redis free: 500K commands/month → ~230 player-hours alone or ~90 together per month (a hidden tab costs
  120 commands/hour, so a tab left open in the background all month is ~90K). Over the cap Upstash
  refuses commands (no charge on the free plan); the game then just shows nobody else.
- Vercel Hobby: 1M function invocations/month → ~550+ player-hours. Hobby can't be billed for overage; it pauses.
- Expected cost: **$0**.

**Tests:** `tests/live.test.ts` (12): clock maths, `setClock` timers and monsoon turn, Act 1 on the realm clock, request
validation, `poseAt`, visibility and forgetting, stale expiry, the player cap, the Redis store (one request, three
commands, auth header, damaged records), LiveLink's lazy ticking and long-gap jump, posting only while visible and
active (and slower alone), and an e2e of two LiveLinks on the real `api/world.ts` handlers seeing each other with the
same monsoon countdown. `scripts/smoke.mjs` adds the same in Chromium on `serve.mjs`: two pages see each other, same
monsoon name and countdown (±1 s), a hidden page leaves and stops posting, a lone page posts ~0.2/s
(`smoke/11-shared-world.png`). The first smoke section now runs with `?offline`.

**Gotchas / next**

- Presence trusts the client's pose (no accounts yet), like the WebSocket server trusts saves.
- The node WebSocket server (`server/`) still keeps per-World clocks; it could adopt `realmTick` too.
- Clock skew: a phone whose clock is minutes off is corrected by the server time on the first request; if that request
  fails the tab plays offline on its own clock.
- **Not verified against the real preview from the sandbox** (its network policy blocks `*.vercel.app` and npm), only
  that Vercel builds it. Locally the same handler runs under `serve.mjs`, the tests and smoke.
- Headless Chromium drops a beacon when its whole context closes, so smoke tests hiding, not closing.

## Done (10 Nov 2026): networking roadmap step 2, first slice (branch `autopilot/temasek-1360-server-2`)

- **`src/net/realm.ts`, `Realm`:** the server now runs one shared realm instead of one world per connection.
  Progression stays per player (DESIGN: "Progression is per player"), so each player keeps their own World in a
  `GameHost`; the realm adds join/leave, ticks everyone in join order, and answers who is near whom.
  `SEE_RADIUS` 14 tiles (Chebyshev, about a screen), `FORGET_RADIUS` 16 so people at the edge don't flicker.
  `MAX_PLAYERS` 64 (the next hello gets `server full`, close 1013).
- **`src/net/delta.ts`:** `diff()` / `applyPatch()` for JSON values (set, object keys, sparse array indices).
  Revealing fog patches only the new tiles. `applyPatch` refuses `__proto__`/`constructor`/`prototype` keys.
- **`src/net/sync.ts`:** `Outbox` (server, one per connection) remembers what its client holds and sends only the
  change; `Mirror` (browser) applies it. Protocol is now **v2**: `welcome` (your id, your World once, avatars in
  view), then `state` with optional `d` (patch), `ev`, `seen` (avatars new or changed), `gone` (ids out of view).
  An idle tick is about 45 bytes, against ~3.6–10 KB before. A patch that doesn't apply drops the link and the page
  carries on offline.
- **Avatars** are `{id, x, y, facing, fishing?, fighting?}`: nothing else of another player's World leaves the
  server. The client draws them as faded-in hero puppets tagged "Pemain N" (more faded while they fight, since
  every fight is its own arena).
- **Offline is unchanged:** `LoopbackLink` still runs a bare `GameHost`, with `others: []`.
- **Tests (34 now):** delta round trips and prototype keys; realm players evolve byte-for-byte like solo games;
  visibility with the margin; the cap; a Mirror fed only deltas stays identical to the server through all of Act 1
  (and uses under a tenth of the bytes); over the socket, two clients see each other only when near, nothing about
  a far player is sent, every tick is under a fifth of a whole-World message, and the bot's patched copy equals the
  server's World at the end. Smoke opens a second online page and checks both see each other
  (`smoke/10-two-players.png`).

### Step 2: next

- **Shared clock.** Each World still keeps its own `tick`, so the monsoon (and who's in port) differs between
  players who joined at different times. A shared realm clock means moving `tick`/monsoon out of the per-player
  World, which touches saves; it needs a call on what a loaded save's clock means.
- Others only update on ticks (an intent's 'act' reply carries just your own World), so someone who stops to fish
  shows it up to 0.6 s late. Fine for now.
- Nothing is shared but presence: no chat, no seeing another's catch or fight, no co-op. Those belong to later
  design calls (DESIGN: small co-op bonuses).

## Done (10 Nov 2026): networking roadmap step 1 (branch `autopilot/temasek-1360-server`)

- **`src/net/host.ts`, `GameHost`:** owns one player's World. `submit(intent)` applies it at once through `act()`, and
  `tick()` runs `step()`. It has no timers; the driver decides when ticks happen. With `record: true` it logs
  everything, and `replay()` rebuilds the identical world (tested). Max 30 intents per tick.
- **`src/net/protocol.ts`:** the wire format (`hello`, `intent` → `state` with `welcome`/`act`/`tick`, `error`) and
  `parseIntent()`, which validates every field against the content tables (rejects `__proto__` and the like).
- **`server/`:** `node server/main.ts [port]` serves the page and `/ws` on 127.0.0.1 and ticks every session on one
  600 ms clock. `ws.ts` is a small hand-written RFC 6455 endpoint (text, fragments, ping, close, 256 KB cap,
  Origin check: same host or localhost only), so the repo still has zero dependencies and CI needed no change.
- **Client:** `src/client/net.ts` has a `Link` with two implementations. `LoopbackLink` runs a `GameHost` in the tab,
  ticked by the frame loop, so offline play behaves exactly as before, including pausing in a hidden tab.
  `SocketLink` is used when the URL has `?server`. `main.ts` no longer calls `step()`/`act()`; it sends intents and
  redraws from `receive()`. If the server can't be reached it starts offline; if it drops mid-game it carries on
  offline from the last state.
- **Tests:** `tests/net.test.ts` and `tests/server.test.ts` (25 in total now). They cover tick pacing and order,
  intents matching a local replay, bad input and floods, independent sessions, frame parsing, the RFC handshake
  key, and the Act 1 bot finishing the act **only over the socket** (about 1 s at a 3 ms tick).
  `scripts/smoke.mjs` now also plays through the real server in Chromium, then kills the server and checks the
  page carries on offline with progress kept.

## Done (31 Oct 2026)

- **Act 1 vertical slice, playable start to finish.** Wake → fish → sell → ask the headman →
  first fight → boss → return the gong → festival and cliffhanger. Then free play: keep
  fishing and trading while the monsoon cycles, and the patrol respawns for Silat practice.
- **Rules (`src/sim`):**
  - deterministic 0.6 s tick, with intents applied instantly by `act()`
  - A* walking without corner cutting
  - three skills on the RuneScape XP curve
  - 20-slot bag
  - two monsoon traders plus Mak Cik Rahmah
  - harbour tax, jamu, two pieces of gear
  - fog of war and saves
- **Combat:**
  - 11×11 arena on the world tiles; AP and MP; 4-way moves
  - the element wheel, and wind adds +1 range to ranged moves fired downwind
  - foes telegraph every attack one tick ahead (the dodge window)
  - ally AI for Pak Lawak; once-per-fight puppet move after the quest
- **Client (`src/client`):**
  - isometric canvas with painted wayang puppets for 12 looks
  - seed pod, stilt houses, balai, pasar, split gate and pendopo on Bukit Larangan
  - junk or Gujarati ship depending on the monsoon; rain, wind, fog clouds
  - quest marker, XP drops, damage numbers
  - dialogue with portraits, shop, combat bar with timing rings, Auto timing option
  - synthesised gamelan sound effects, rain bed and festival ambience
- **Checks:**
  - `npm test`: 13 tests (including regressions for the review fixes), including a bot that finishes Act 1 on 5 seeds
  - `scripts/smoke.mjs`: drives the real UI through dialogue, shop and a full fight with clicks
  - `scripts/balance.ts`
  - CI workflow: typecheck, test, build, balance, then smoke with Playwright

## Balance (`node scripts/balance.ts 40`, 7 Nov 2026)

- A bot with no timing and 3 jamu finishes 40/40 with no losses.
- With no timing and no jamu it loses to Si Todak 5 times in 40 runs, then wins on a retry
  (fixed 7 Nov; it had risen to 22 in 40 after the review fixes, see below).
- Act 1 ends around Pancing 5, Dagang 3, Silat 3.
- The bot needs about 2.5 minutes of game time. A human with reading and walking should take
  roughly 10–15 minutes (not measured).

## Review fixes (31 Oct)

A code review found 7 issues, all fixed:
- **Gong softlock:** pressing Escape on Si Todak's farewell lost the gong. It's now granted on the win, even with a full bag.
- **Departed trader:** when the monsoon turned, a trader's dialogue stayed open and you could still buy from them.
- **Back-to-back fights:** the boss could start the instant the patrol fight ended.
- **Skipped dodge window:** catching up on ticks after an idle tab could resolve an attack before you could dodge it.
- **Wasted jamu:** you could drink it at full health.
- **Lost attack:** clicking End turn while the timing ring was open threw the attack away.

## Boss-start fix (7 Nov, autopilot)

- **Cause of the extra boss losses:** the 8-tick calm after a fight held back *every*
  encounter. Walking east straight after the patrol carried you past Si Todak's 2-tile trigger to
  the arena centre (38,22), 3 tiles from him instead of 5, so the fight opened at close range. Retries started at
  the edge, which is why they won.
- **Fix (`src/sim/world.ts`):** `calmFor` records the zones you were standing in when a won fight
  ended. Only those wait out the calm; a zone you walk into during it starts at its edge. Old saves
  without `calmFor` keep the old behaviour.
- **Test:** `after a fight, the calm only holds back encounters you were already standing in`. It
  fails on the old code.

## Keyboard fixes (7 Nov, autopilot run 2)

- **Enter on a focused ability button ended your turn.** The global Enter = End turn shortcut fired as
  well as the button. A focused button now owns Enter, and Space too, except during a timing ring or
  an open dialogue (so mashing Space through a conversation never picks an answer).
- **Focus was wiped on every HUD refresh.** Dialogue buttons are now rebuilt only for a new line, and
  the first answer gets focus. The focused ability button keeps focus across rebuilds. A mouse click on
  End turn drops focus, so a stray Space next turn can't end it.
- The Bag/Skills/Quest buttons claimed `role="tablist"` without being tabs; now a labelled group of
  toggle buttons.
- **Check:** `scripts/smoke.mjs` presses Enter on an ability button in the first fight. It fails on the
  old code.
- **Smoke flake fixed:** a move click on a tile covered on screen by a puppet standing in front
  (often Pak Lawak, whose spot depends on the random seed) picks the unit instead. The test now tries
  the next tile until the step lands.

## Not done / next

1. **Nat playtest by hand:**
   - walking and fishing feel
   - whether the fight pace (one AI action about every 1.2 s) is too slow
   - timing ring windows (attack: perfect within ±0.09 s, good within ±0.22 s)
   - text length
   - sound levels (never heard by a human)
   - keyboard only: Tab to the dialogue answers and abilities, Enter to press them
2. **Decide the tentative calls** in `docs/DESIGN.md`, especially who the player is, and the
   pirate lords.
3. **Networking roadmap:**
   1. ~~move `src/sim` behind a WebSocket server that runs `step()` every 600 ms and accepts
      intents~~ done on `autopilot/temasek-1360-server` (10 Nov).
   2. send each client only what's near it: first slice done on `autopilot/temasek-1360-server-2` (shared realm,
      interest radius, deltas). Still to do: a shared clock (see "Step 2: next").
   3. Postgres saves and login
   4. atomic trades (the item-duplication lesson)
   5. one small cloud host, not the Mac mini
4. **Content:** Act 2 (6–8 acts per chapter), the kite gate, festival minigames (gasing, kite
   duels, sepak takraw, boat races), more skills one monsoon at a time.
5. **Repo:** the game lives in `zuzivian/temasek-1360` (moved from a branch of `zuzivian/new-repo` on 1 Nov 2026). The old local branch there was never pushed.

## Gotchas

- **Server trust is step-1 level.** The server trusts the save the client sends in `hello` (no accounts until
  step 3) and the timing grade in combat intents.
- **Deltas assume an ordered, lossless channel** (one WebSocket). The Outbox diffs against what it last *sent*, so
  never skip sending a message it built, or the client's copy drifts. If a transport ever drops messages, resend a
  welcome.
- **Smoke "selling earned nothing" (fixed 11 Nov):** with an unlucky seed, 9 s of fishing caught nothing, so the sell
  check failed (it hit CI on this branch). Smoke now adds one fish if the bag has none; reproduced with 0 s of fishing first.
- **Player ids are per server run**, not accounts; they restart at 1 when the server restarts.
- **Online dodge windows include latency.** The client opens the dodge ring when the windup tick *arrives* and
  closes it at the next one. The intent must reach the server before its next tick, so a slow link shortens the
  window. Not noticeable on localhost; not measured over a real network.
- **`server/node-shim.d.ts`** declares only the Node APIs the server uses. Add to it if you use more.

- **No npm network in the cloud sandbox.** The repo has zero dependencies on purpose:
  - `tsc` (global, 6.0.2) builds
  - Node 22.18+ runs `.ts` tests directly
  - `tests/node-shim.d.ts` stands in for `@types/node`
- **Imports use `.ts` extensions.** `rewriteRelativeImportExtensions` turns them into `.js` in
  `dist/`. Keep to erasable TypeScript only: no enums, namespaces or parameter properties.
- **Content positions must sit on the right tiles.** If you edit `src/sim/map-data.ts`,
  `npm test` checks that NPCs, spawns and fishing spots still land on walkable ground or spots,
  and that the story locations are reachable.
- **Content tweaks can break the playthrough.** Combat and fishing changes shift the bot's
  results, so rerun `scripts/balance.ts` after any change to `content.ts` numbers.
- **The browser loop dies on any exception.** An uncaught exception in an event handler stops
  `requestAnimationFrame`, so the smoke test fails on any `pageerror`.
- **`artifact/` is generated by `npm run build`** for publishing as a claude.ai artifact. The
  host supplies the doctype, html, head and body, so that page has none.

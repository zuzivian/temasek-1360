# NOTES: Temasek 1360 MVP

Handoff notes for whoever picks this up next (human or agent). Read this, `README.md`,
`docs/DESIGN.md` and `git log` before changing anything.

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
  - `npm test`: 12 tests (including regressions for the review fixes), including a bot that finishes Act 1 on 5 seeds
  - `scripts/smoke.mjs`: drives the real UI through dialogue, shop and a full fight with clicks
  - `scripts/balance.ts`
  - CI workflow: typecheck, test, build, balance, then smoke with Playwright

## Balance at the time of writing (`node scripts/balance.ts 40`)

- A bot with no timing and 3 jamu finishes 40/40 with no losses.
- With no timing and no jamu it loses to Si Todak about once per run on average, before winning on a retry. That's 15 losses in 30 runs after the review fixes, up from 5 in 40 before. The likely cause is the 8-tick pause between fights, which stops the boss starting while you're still mid-patrol; not investigated further.
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

## Not done / next

1. **Nat playtest by hand:**
   - walking and fishing feel
   - whether the fight pace (one AI action about every 1.2 s) is too slow
   - timing ring windows (attack: perfect within ±0.09 s, good within ±0.22 s)
   - text length
   - sound levels (never heard by a human)
2. **Decide the tentative calls** in `docs/DESIGN.md`, especially who the player is, and the
   pirate lords.
3. **Networking roadmap:**
   1. ~~move `src/sim` behind a WebSocket server that runs `step()` every 600 ms and accepts
      intents~~ done on `autopilot/temasek-1360-server` (10 Nov). Still single-player worlds, one per connection.
   2. send each client only what's near it
   3. Postgres saves and login
   4. atomic trades (the item-duplication lesson)
   5. one small cloud host, not the Mac mini
4. **Content:** Act 2 (6–8 acts per chapter), the kite gate, festival minigames (gasing, kite
   duels, sepak takraw, boat races), more skills one monsoon at a time.
5. **Repo:** the game lives in `zuzivian/temasek-1360` (moved from a branch of `zuzivian/new-repo` on 1 Nov 2026). The old local branch there was never pushed.
   prototypes. Consider giving the game its own repo, as Derby Day and Ring Studio got.

## Gotchas

- **Server trust is step-1 level.** The server trusts the save the client sends in `hello` (no accounts until
  step 3) and the timing grade in combat intents. Every state message carries the whole World (about 10 KB), which
  is fine on localhost; trimming it is step 2.
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

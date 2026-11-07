# NOTES: Temasek 1360 MVP

Handoff notes for whoever picks this up next (human or agent). Read this, `README.md`,
`docs/DESIGN.md` and `git log` before changing anything.

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
   1. move `src/sim` behind a WebSocket server that runs `step()` every 600 ms and accepts
      intents
   2. send each client only what's near it
   3. Postgres saves and login
   4. atomic trades (the item-duplication lesson)
   5. one small cloud host, not the Mac mini
4. **Content:** Act 2 (6–8 acts per chapter), the kite gate, festival minigames (gasing, kite
   duels, sepak takraw, boat races), more skills one monsoon at a time.
5. **Repo:** the game lives in `zuzivian/temasek-1360` (moved from a branch of `zuzivian/new-repo` on 1 Nov 2026). The old local branch there was never pushed.

## Gotchas

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

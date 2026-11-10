# Temasek 1360 (working title)

An isometric adventure set at the mouth of the Temasek river around 1360, drawn as painted
wayang kulit puppets. It's built on RuneScape's skills, quests and trading, plus Dofus-style grid
fights. The monsoon turns every few minutes and changes the fish, the traders in port and the
weather.

This branch is the **MVP prototype**. It's one playable act (*Babak I · Gong yang Hilang*, "the
lost gong", about 10–15 minutes) to pin down the core loop and the look and feel. It's
single-player at heart: everyone can finish it alone. On the local game server (see Play) several
players share the beach and see whoever is near them; offline, the rules run in the browser.

## Play

```sh
npm run build                         # tsc → dist/, plus artifact/ for publishing
node scripts/serve.mjs                # http://localhost:8080
```

To play through the local game server instead (it runs the rules and the 600 ms clock, and the
page only sends intents and draws what comes back; open it in two tabs to see a second player):

```sh
npm run build && node server/main.ts  # http://localhost:8080/?server
```

Without `?server` the page plays offline: the same rules run in the tab through an in-process
loopback. If the server can't be reached, or goes away mid-game, the page carries on offline.

Click to walk, talk and fish. In fights, click a blue tile to move and a foe to attack, then
press **Space** as the ring closes for a bonus. Turn on *Auto timing* on the title screen if you
never want to time anything. Scroll to zoom. Progress saves to this browser automatically.

## Deploy

`main` deploys to Vercel at **temasek.natwong.dev**. The build command is `npm run build`, and Vercel serves the standalone page in `site/`. `artifact/` is the same game shaped for a claude.ai artifact.

## The loop in Act 1

1. **Wake** in a seed pod on the beach. Pak Lawak, a clown, decides you're a talking prawn.
2. **Pancing (fishing).** Click the bubbling shallows. Fish fill your 20-slot bag.
3. **Dagang (trading).** Sell to Mak Cik Rahmah at the pasar. During the north-east monsoon a
   Quanzhou junk trader pays more for kembung; during the south-west monsoon a Gujarati cloth
   trader pays more for selar. Both lose 10% to the harbour tax.
4. **Silat (fighting).** Cross the bridge into the fog and fight perompak (pirates) on the grid.
   You're *Air* (water) and they're *Api* (fire), so your Ombak wave hits them ×1.5.
5. **Boss.** Si Todak (*Besi*, metal) at Dragon's Tooth Gate. Your Air is neutral against him,
   but Pak Lawak's chilli bombs (*Api*) beat metal, so your companion matters.
6. **Payoff.** Bring the gong home and the festival lights up. Then comes the cliffhanger: something
   that fell into the sea is singing at night.

Six elements, each beating the next: **Kayu > Tanah > Angin > Air > Api > Besi > Kayu**
(wood, earth, wind, water, fire, metal).

## Code map

| Path | What it is |
|---|---|
| `src/sim/` | The game rules. Pure, deterministic and DOM-free: `world.ts` (state, intents, 0.6 s tick), `combat.ts`, `content.ts` (people, items, dialogue, quest, encounters), `map-data.ts` (the ASCII map), `path.ts`, `skills.ts` |
| `src/net/` | Shared by browser and server: `host.ts` (`GameHost`: one player's world, `submit()` an intent, `tick()` a step, replay a log), `realm.ts` (`Realm`: every connected player on one clock, and who is near whom), `sync.ts` + `delta.ts` (send each client only its World's changes and the players near it) and `protocol.ts` (the wire messages and intent validation) |
| `server/` | The local game server: `game-server.ts` (static files plus `/ws`, one shared Realm on a 600 ms clock), `ws.ts` (a hand-written WebSocket endpoint, so still no dependencies), `main.ts` (CLI) |
| `src/client/` | The browser: `main.ts` (loop, input, HUD), `net.ts` (`LoopbackLink` offline, `SocketLink` online), `render.ts` (isometric canvas), `puppets.ts`, `audio.ts` (synthesised gamelan, no audio files) |
| `tests/` | Unit tests plus `bot.ts`, a scripted player that finishes Act 1 |
| `scripts/` | `build.mjs`, `serve.mjs`, `smoke.mjs` (headless browser playthrough with screenshots), `balance.ts` |
| `docs/DESIGN.md` | What's decided, what's tentative, what's open, and the cultural notes |
| `NOTES.md` | Handoff notes: done, in progress, next, gotchas |

## Checks

```sh
npm run typecheck      # tsc, strict
npm test               # node --test: rules, map consistency, determinism, saves, bot playthrough,
                       #   tick loop, intent validation, and the bot finishing Act 1 over a socket
node scripts/balance.ts 40
node scripts/smoke.mjs # needs Playwright + Chromium; also plays briefly through server/main.ts
```

There are no npm dependencies. Node 22.18+ runs the TypeScript tests directly, and `tsc` is the
only tool the build needs.

// Browser smoke test: serves the repo, opens the game in headless Chromium, plays a few beats
// through the real UI, fails on any page error, and saves screenshots to smoke/. Then it plays
// a short stretch through the game server (server/main.ts) and checks the offline fallback.
// Usage: node scripts/smoke.mjs   (needs Playwright; set CHROMIUM=/path/to/chrome to override)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
for (const p of ['playwright', '/opt/node-tools/node_modules/playwright']) { try { ({ chromium } = require(p)); break; } catch { /* next */ } }
if (!chromium) { console.error('Playwright not found'); process.exit(1); }

const port = 8765, onlinePort = 8766;
const server = spawn(process.execPath, ['scripts/serve.mjs', String(port)], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 400));
mkdirSync('smoke', { recursive: true });
const exe = process.env.CHROMIUM ?? (require('node:fs').existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_TUNNEL|net::ERR/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(`http://localhost:${port}/`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'smoke/1-title.png' });
  await page.click('#start');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'smoke/2-start.png' });
  // talk to Pak Lawak through the sim hook, then page through the dialogue with Space
  await page.evaluate(() => window.__game.act({ t: 'talk', npc: 'lawak' }));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'smoke/3-dialog.png' });
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(150); if (await page.isVisible('#dopts button:not(.next)')) await page.click('#dopts button:not(.next)'); }
  await page.evaluate(() => window.__game.act({ t: 'fish', spot: 0 }));
  await page.waitForTimeout(9000);
  await page.screenshot({ path: 'smoke/4-fishing.png' });
  // sell fish through the real shop UI
  await page.evaluate(() => { const w = window.__game.world; if (w.step < 2) { w.step = 2; w.fishCaught = 3; } w.player.x = 17; w.player.y = 25; window.__game.act({ t: 'talk', npc: 'rahmah' }); });
  await page.waitForTimeout(1500);
  await page.click('#dopts button:not(.next)');
  await page.waitForTimeout(300);
  if (!(await page.isVisible('#shop'))) errors.push('shop did not open');
  await page.screenshot({ path: 'smoke/5-shop.png' });
  await page.click('#sellall');
  await page.waitForTimeout(300);
  const picis = await page.evaluate(() => window.__game.world.picis);
  if (!(picis > 0)) errors.push('selling earned nothing');
  await page.click('#shopclose');

  // first fight: walk into the perompak, then move, attack with timing and end the turn by clicking
  await page.evaluate(() => { const g = window.__game, w = g.world; w.step = 4; w.lawak.following = true; w.player.x = 31; w.player.y = 21; w.explored = w.explored.map(() => 1); w.inv.push({ id: 'jamu', n: 2 }); g.act({ t: 'walk', to: { x: 32, y: 21 } }); });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'smoke/6-combat.png' });
  const fight = async () => page.evaluate(() => { const c = window.__game.world.combat; return c ? { cur: c.order[c.turn], phase: c.phase, foes: c.units.filter(u => u.side === 'foe').map(u => ({ id: u.id, x: u.x, y: u.y, hp: u.hp })), you: c.units[0] } : null; });
  let f = await fight();
  if (!f) errors.push('combat did not start');
  for (let round = 0; round < 3 && f && f.phase === 'fight'; round++) {
    for (let i = 0; i < 40 && f && f.cur !== 'you'; i++) { await page.waitForTimeout(300); f = await fight(); }
    if (!f) break;
    // step toward the nearest foe if needed, then Ombak it
    const target = f.foes.find(o => o.hp > 0);
    const dist = Math.abs(target.x - f.you.x) + Math.abs(target.y - f.you.y);
    if (dist > 4 || dist < 2) {
      const keys = await page.evaluate(() => window.__game.reach());
      const picks = keys.map(k => k.split(',').map(Number)).sort((a, b) => Math.abs(Math.abs(a[0] - target.x) + Math.abs(a[1] - target.y) - 3) - Math.abs(Math.abs(b[0] - target.x) + Math.abs(b[1] - target.y) - 3));
      // A puppet standing in front of a tile covers it on screen, so a click there picks the unit
      // instead (this depends on the random seed). Try the next tile until the step lands.
      for (const pick of picks.slice(0, 6)) {
        const p = await page.evaluate(([x, y]) => window.__game.toScreen(x, y), pick);
        await page.mouse.click(p.x, p.y);
        await page.waitForTimeout(300);
        const me = await page.evaluate(() => window.__game.world.combat?.units[0]);
        if (!me || me.x !== f.you.x || me.y !== f.you.y) { await page.waitForTimeout(1200); break; }
      }
    }
    f = await fight();
    const hpBefore = f.foes.reduce((n, o) => n + o.hp, 0);
    console.log('before attack', JSON.stringify(f));
    await page.click('#abilities .ab:nth-child(2)', { timeout: 3000 });
    const tp = await page.evaluate(([x, y]) => window.__game.toScreen(x, y), [target.x, target.y]);
    await page.mouse.click(tp.x, tp.y - 40);
    await page.waitForTimeout(650);
    await page.keyboard.press('Space');
    await page.waitForTimeout(800);
    if (round === 0) await page.screenshot({ path: 'smoke/7-attack.png' });
    f = await fight();
    if (f && f.foes.reduce((n, o) => n + o.hp, 0) >= hpBefore) errors.push(`round ${round}: attack did not land (${JSON.stringify(f)})`);
    if (f && f.phase === 'fight' && f.cur === 'you') await page.click('#endturn');
    await page.waitForTimeout(500);
    f = await fight();
  }
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'smoke/8-after.png' });
  const state = await page.evaluate(() => ({ step: window.__game.world.step, combat: !!window.__game.world.combat, hp: window.__game.world.player.hp, silat: window.__game.world.skills.silat }));
  console.log(JSON.stringify(state));
  if (!(state.silat > 0)) errors.push('no Silat XP from the fight');

  // Online: the same page against the game server (server/main.ts), then the server goes away
  // mid-game and the page must carry on offline.
  const gameServer = spawn(process.execPath, ['server/main.ts', String(onlinePort)], { stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 600));
    const on = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    on.on('pageerror', e => errors.push(`online pageerror: ${e.message}`));
    await on.goto(`http://localhost:${onlinePort}/?server`);
    await on.click('#start');
    await on.waitForFunction(() => window.__game.online, null, { timeout: 5000 });
    const t0 = await on.evaluate(() => window.__game.world.tick);
    await on.waitForTimeout(1500);
    const t1 = await on.evaluate(() => window.__game.world.tick);
    if (!(t1 - t0 >= 2 && t1 - t0 <= 4)) errors.push(`online: expected 2-4 server ticks in 1.5 s, got ${t1 - t0}`);
    // Talk to Pak Lawak and page through with the real keyboard: every answer is an intent over the socket.
    await on.evaluate(() => window.__game.act({ t: 'talk', npc: 'lawak' }));
    await on.waitForFunction(() => window.__game.world.dialog, null, { timeout: 8000 });
    for (let i = 0; i < 10 && await on.evaluate(() => !!window.__game.world.dialog); i++) {
      await on.keyboard.press('Space'); await on.waitForTimeout(250);
      if (await on.isVisible('#dopts button:not(.next)')) { await on.click('#dopts button:not(.next)'); await on.waitForTimeout(250); }
    }
    const met = await on.evaluate(() => ({ met: !!window.__game.world.flags.met_lawak, step: window.__game.world.step }));
    if (!met.met || met.step < 1) errors.push(`online: the Pak Lawak conversation did not finish (${JSON.stringify(met)})`);
    await on.screenshot({ path: 'smoke/9-online.png' });
    gameServer.kill();
    await on.waitForFunction(() => !window.__game.online, null, { timeout: 5000 });
    const t2 = await on.evaluate(() => window.__game.world.tick);
    await on.waitForTimeout(1300);
    const t3 = await on.evaluate(() => window.__game.world.tick);
    if (!(t3 > t2)) errors.push('online: the game stopped when the server went away');
    if (!(await on.evaluate(() => window.__game.world.flags.met_lawak))) errors.push('online: progress was lost when falling back offline');
    console.log(`online ok: ${t1 - t0} server ticks in 1.5 s, then offline from tick ${t2}`);
  } finally { gameServer.kill(); }
} catch (e) {
  errors.push(`script: ${e.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.kill();
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('smoke ok: screenshots in smoke/');

// Browser smoke test: serves the repo, opens the game in headless Chromium, plays a few beats
// through the real UI, fails on any page error, and saves screenshots to smoke/. Then it plays
// a short stretch through the game server (server/main.ts) and checks the offline fallback.
// In between, two pages share the world through /api/world (what the deployed site runs).
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
  await page.goto(`http://localhost:${port}/?offline`);
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
  // The catch is random: with an unlucky seed 9 s of fishing lands nothing, so make sure there is a fish to sell.
  await page.evaluate(() => { const w = window.__game.world; if (w.step < 2) { w.step = 2; w.fishCaught = 3; } if (!w.inv.some(s => s.id === 'kembung' || s.id === 'selar' || s.id === 'udang' || s.id === 'kerapu')) w.inv.push({ id: 'kembung', n: 1 }); w.player.x = 17; w.player.y = 25; window.__game.act({ t: 'talk', npc: 'rahmah' }); });
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

  // Shared world: two pages on the same static host + /api/world, as on Vercel. Each runs its own
  // rules on the realm clock; they should see each other and show the same monsoon countdown.
  {
    const posts = [];
    const live = async name => {
      const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      p.on('pageerror', e => errors.push(`${name} pageerror: ${e.message}`));
      p.on('request', r => { if (r.url().endsWith('/api/world') && r.method() === 'POST') posts.push(Date.now()); });
      await p.goto(`http://localhost:${port}/`);
      await p.click('#start');
      await p.waitForFunction(() => window.__game.mode === 'live', null, { timeout: 5000 });
      return p;
    };
    const l1 = await live('live 1'), l2 = await live('live 2');
    await l2.evaluate(() => window.__game.act({ t: 'walk', to: { x: 12, y: 27 } }));
    try {
      await l1.waitForFunction(() => window.__game.others.length === 1, null, { timeout: 12000 });
      await l2.waitForFunction(() => window.__game.others.length === 1, null, { timeout: 12000 });
    } catch { errors.push(`live: the two players did not see each other (${await l1.evaluate(() => window.__game.others.length)}, ${await l2.evaluate(() => window.__game.others.length)})`); }
    const clock = p => p.evaluate(() => ({ tick: window.__game.world.tick, left: document.getElementById('mleft').textContent, name: document.getElementById('mname').textContent }));
    const [c1, c2] = [await clock(l1), await clock(l2)];
    if (Math.abs(c1.tick - c2.tick) > 1 || c1.name !== c2.name) errors.push(`live: different clocks ${JSON.stringify([c1, c2])}`);
    const leftSecs = s => { const m = /(\d+):(\d+)/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
    if (!(Math.abs(leftSecs(c1.left) - leftSecs(c2.left)) <= 1)) errors.push(`live: different monsoon countdowns ${c1.left} vs ${c2.left}`);
    await l1.waitForTimeout(1200);
    await l1.screenshot({ path: 'smoke/11-shared-world.png' });
    // Hiding a tab keeps the player in the world, dimmed as away, on a heartbeat only; showing it
    // again resyncs at once. Closing the page (pagehide) leaves at once.
    const l2posts = () => l2.evaluate(() => window.__game.live.posts);
    const setHidden = (p, hidden) => p.evaluate(h => {
      Object.defineProperty(document, 'hidden', { value: h, configurable: true });
      Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    await setHidden(l2, true);
    const hiddenAt = await l2posts();
    try { await l1.waitForFunction(() => window.__game.others.length === 1 && window.__game.others[0].away, null, { timeout: 8000 }); }
    catch { errors.push(`live: a hidden tab was not shown as away ${JSON.stringify(await l1.evaluate(() => window.__game.others))}`); }
    await l1.waitForTimeout(2500);
    await l1.screenshot({ path: 'smoke/12-away.png' });
    if ((await l2posts()) !== hiddenAt) errors.push('live: a hidden tab kept polling');
    await setHidden(l2, false);
    try {
      await l2.waitForFunction(n => window.__game.live.posts > n && window.__game.others.length === 1, hiddenAt, { timeout: 4000 });
      await l1.waitForFunction(() => window.__game.others.length === 1 && !window.__game.others[0].away, null, { timeout: 8000 });
    } catch { errors.push(`live: coming back did not resync ${JSON.stringify(await l1.evaluate(() => window.__game.others))}`); }
    await l2.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    try { await l1.waitForFunction(() => window.__game.others.length === 0, null, { timeout: 8000 }); }
    catch { errors.push('live: a closed page was still on the beach'); }
    const t0 = Date.now(), before = posts.length;
    await l1.waitForTimeout(10_000);
    const rate = (posts.length - before) / ((Date.now() - t0) / 1000);
    if (rate > 0.35) errors.push(`live: a lone player posted ${rate.toFixed(2)}/s, expected about 0.2/s`);
    await l2.close();
    console.log(`live ok: ${c1.name}, ${c1.left} on both pages; ${posts.length} presence posts in all, ${rate.toFixed(2)}/s alone`);
    await l1.close();
  }

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
    // A second player joins the same realm: each page should see the other on the beach.
    const on2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    on2.on('pageerror', e => errors.push(`second player pageerror: ${e.message}`));
    await on2.goto(`http://localhost:${onlinePort}/?server`);
    await on2.click('#start');
    await on2.waitForFunction(() => window.__game.online, null, { timeout: 5000 });
    await on2.evaluate(() => window.__game.act({ t: 'walk', to: { x: 12, y: 27 } }));
    try {
      await on.waitForFunction(() => window.__game.others.length === 1, null, { timeout: 5000 });
      await on2.waitForFunction(() => window.__game.others.length === 1, null, { timeout: 5000 });
    } catch { errors.push(`online: the two players did not see each other (${await on.evaluate(() => window.__game.others.length)}, ${await on2.evaluate(() => window.__game.others.length)})`); }
    await on.waitForTimeout(1500);
    await on.screenshot({ path: 'smoke/10-two-players.png' });
    await on2.close();
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

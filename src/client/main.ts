// Browser client: runs the 0.6 s tick, turns clicks into intents, and keeps the HUD in sync.
import { ABILITIES, GEAR, ITEMS, MONSOON_NAME, MONSOON_WIND, NPCS, QUEST, SHOPS, SPOTS, type AbilityId, type GearId, type ItemId, type NpcId } from '../sim/content.ts';
import { DIALOG } from '../sim/content.ts';
import { canUse, current, reachable, unitById, type Grade } from '../sim/combat.ts';
import { TICK_MS, type Vec } from '../sim/core.ts';
import { MAP, elevAt, kindAt, walkable } from '../sim/map.ts';
import { SKILLS, levelForXp, levelProgress, type SkillId } from '../sim/skills.ts';
import { act, count, load, maxHp, monsoonAt, monsoonLeft, newWorld, save, shopPrice, step, type Ev, type Intent, type World } from '../sim/world.ts';
import * as audio from './audio.ts';
import { drawPortrait } from './puppets.ts';
import { EH, EL_COLOR, iso, render, screenToTile, type HitBox, type View } from './render.ts';

const SAVE_KEY = 'temasek1360.save.v1';
const OPT_KEY = 'temasek1360.opts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('game');
const ctx = canvas.getContext('2d')!;
let W = 0, H = 0, DPR = 1;
function resize(): void {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
}
resize();
addEventListener('resize', resize);

// ---------- options and save ----------
type Opts = { sound: boolean; autoTime: boolean };
let opts: Opts = { sound: true, autoTime: false };
try { opts = { ...opts, ...JSON.parse(localStorage.getItem(OPT_KEY) || '{}') }; } catch { /* storage blocked */ }
const saveOpts = () => { try { localStorage.setItem(OPT_KEY, JSON.stringify(opts)); } catch { /* ignore */ } };
function readSave(): World | null { try { const s = localStorage.getItem(SAVE_KEY); return s ? load(s) : null; } catch { return null; } }
function writeSave(): void { try { localStorage.setItem(SAVE_KEY, save(world)); } catch { /* ignore */ } }

let world: World = readSave() ?? newWorld(Math.floor(Math.random() * 1e9));
let started = false;

const view: View = {
  w: world, t: 0, alpha: 1,
  playerFrom: { x: world.player.x, y: world.player.y }, lawakFrom: { x: world.lawak.x, y: world.lawak.y },
  unitAnims: new Map(), hover: null, clickMark: null, floaters: [], shots: [],
  combatUi: { ability: null, hoverUnit: null, ring: null }, flashes: new Map(),
  zoom: Math.max(0.8, Math.min(1.5, window.innerHeight / 760))
};
const hits: HitBox[] = [];
const prevUnitPos = new Map<string, Vec>();
let cam = { camX: 0, camY: 0 };

// ---------- banners, log, floaters ----------
let bannerTimer = 0;
function banner(text: string, sub = '', ms = 1800): void {
  const b = $('banner');
  b.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => b.classList.remove('show'), ms);
}
function log(text: string, tone: string): void {
  const el = document.createElement('div');
  el.className = tone; el.textContent = text;
  const box = $('log');
  box.appendChild(el);
  while (box.children.length > 6) box.firstChild!.remove();
  window.setTimeout(() => el.remove(), 14000);
}
function floater(x: number, y: number, text: string, color: string, big = false, dy = 0): void {
  view.floaters.push({ x, y, text, color, born: view.t, big, dy });
  if (view.floaters.length > 30) view.floaters.shift();
}

// ---------- icons ----------
function itemSvg(id: ItemId): string {
  const fish = (body: string, mark = '') => `<svg viewBox="0 0 32 32"><path d="M4 16c5-7 15-8 20-2l4-4v12l-4-4c-5 6-15 5-20-2z" fill="${body}" stroke="#1a0e0a" stroke-width="1.2"/>${mark}<circle cx="9" cy="15" r="1.4" fill="#1a0e0a"/></svg>`;
  switch (id) {
    case 'udang': return `<svg viewBox="0 0 32 32"><path d="M8 8c10-2 18 6 14 15-2 4-7 4-8 0 4 0 6-3 4-6-2-4-7-5-10-3z" fill="#e88a5a" stroke="#5a2410" stroke-width="1.2"/><path d="M9 8 4 4M9 9 3 9" stroke="#5a2410" stroke-width="1.2"/></svg>`;
    case 'kembung': return fish('#6fa3c0', '<path d="M8 13h12" stroke="#2a4a6a" stroke-width="1.2"/>');
    case 'selar': return fish('#c7d6de', '<path d="M7 16h16" stroke="#e6b24a" stroke-width="2"/>');
    case 'kerapu': return fish('#a8763a', '<circle cx="14" cy="14" r="1.3" fill="#5a3a14"/><circle cx="18" cy="17" r="1.3" fill="#5a3a14"/><circle cx="13" cy="18" r="1.1" fill="#5a3a14"/>');
    case 'jamu': return `<svg viewBox="0 0 32 32"><path d="M13 4h6v5c4 2 6 5 6 9v7c0 2-2 3-4 3H11c-2 0-4-1-4-3v-7c0-4 2-7 6-9z" fill="#b5651d" stroke="#3a1a08" stroke-width="1.2"/><path d="M9 18h14" stroke="#f5d27a" stroke-width="2"/><rect x="12" y="2" width="8" height="3" rx="1" fill="#6a4a22"/></svg>`;
    case 'gong': return `<svg viewBox="0 0 32 32"><circle cx="16" cy="17" r="11" fill="#c99a2e" stroke="#5a3a0a" stroke-width="1.4"/><circle cx="16" cy="17" r="4" fill="#f5d27a" stroke="#5a3a0a"/><path d="M8 5h16" stroke="#5a3a0a" stroke-width="2"/></svg>`;
  }
}
const ABILITY_SVG: Record<AbilityId, string> = {
  tendang: '<path d="M6 26l8-6 4-10 6 2-3 9-9 7z" fill="currentColor"/>',
  ombak: '<path d="M3 20c4-6 8-6 12 0s8 6 14 0M3 13c4-6 8-6 12 0s8 6 14 0" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  jamu: '<path d="M13 4h6v5c4 2 6 5 6 9v7c0 2-2 3-4 3H11c-2 0-4-1-4-3v-7c0-4 2-7 6-9z" fill="currentColor"/>',
  bayang: '<path d="M3 17l14-3 12 2-12 3zM17 14c-3-5-1-9 3-10-1 3 0 6 2 9" fill="currentColor"/>',
  cabai: '<path d="M8 24c10 0 16-8 16-16 0 0 2-3 4-2-2 0-3 2-3 2 1 10-6 19-17 16z" fill="currentColor"/>',
  obor: '', panah: '', tikam: '', sapu: ''
};
const ABILITY_BG: Record<AbilityId, string> = { tendang: '#7a1c2c', ombak: EL_COLOR.Air, jamu: '#6a4a22', bayang: '#4a5a6e', cabai: EL_COLOR.Api, obor: '', panah: '', tikam: '', sapu: '' };

// ---------- HUD ----------
let tab: 'bag' | 'skills' | 'quest' = 'bag';
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  b.addEventListener('click', () => { tab = b.dataset.tab as typeof tab; audio.play('click'); refreshPanel(); });
}
function refreshPanel(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
  $('bag').hidden = tab !== 'bag'; $('skills').hidden = tab !== 'skills'; $('quest').hidden = tab !== 'quest';
  if (tab === 'bag') {
    const slots: string[] = [];
    for (let i = 0; i < 20; i++) {
      const s = world.inv[i];
      if (!s) { slots.push('<div class="slot"></div>'); continue; }
      const info = ITEMS[s.id];
      slots.push(`<button type="button" class="slot${s.id === 'jamu' ? ' use' : ''}" data-slot="${i}" title="${info.name} (${info.en})${s.id === 'jamu' ? ' · click to drink' : ''}">${itemSvg(s.id)}${s.n > 1 ? `<em>${s.n}</em>` : ''}</button>`);
    }
    const gear = (Object.keys(GEAR) as GearId[]).filter(g => world.gear[g]).map(g => `<span title="${GEAR[g].en}">${GEAR[g].name}</span>`).join('');
    $('bag').innerHTML = slots.join('') + (gear ? `<div class="gear">${gear}</div>` : '');
    for (const b of $('bag').querySelectorAll<HTMLButtonElement>('.slot.use')) b.addEventListener('click', () => doAct({ t: 'drink' }));
  } else if (tab === 'skills') {
    $('skills').innerHTML = SKILLS.map(s => {
      if (!s.launch) return `<div class="skill locked"><b>${s.name}</b><span class="lv">Musim ${s.season}</span><i>${s.en}</i></div>`;
      const xp = world.skills[s.id as SkillId];
      return `<div class="skill" title="${xp.toLocaleString()} XP"><b>${s.name}</b><span class="lv">${levelForXp(xp)}</span><i>${s.en}</i><div class="bar"><div style="width:${(levelProgress(xp) * 100).toFixed(1)}%"></div></div></div>`;
    }).join('') + `<div class="skill"><b>Health</b><span class="lv">${world.player.hp}</span><i>of ${maxHp(world)}</i></div>`;
  } else {
    $('quest').innerHTML = `<h3>${QUEST.title}</h3><ol>${QUEST.steps.map((s, i) => `<li class="${i < world.step ? 'done' : i === world.step ? 'now' : ''}">${i <= world.step ? s.goal : '???'}</li>`).join('')}</ol>`;
  }
}
function refreshTop(): void {
  $('goal').textContent = QUEST.steps[world.step].goal;
  const m = monsoonAt(world.tick), wd = MONSOON_WIND[m];
  $('mname').textContent = MONSOON_NAME[m];
  const secs = Math.ceil(monsoonLeft(world.tick) * TICK_MS / 1000);
  $('mleft').textContent = `turns in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const sx = wd.x - wd.y, sy = (wd.x + wd.y) * 0.5;
  ($('monsoon').querySelector('svg') as SVGElement).style.transform = `rotate(${(Math.atan2(sy, sx) * 180 / Math.PI) - 90}deg)`;
  $('pval').textContent = String(world.picis);
}

// ---------- dialogue ----------
let portraitT = 0;
function showDialog(): void {
  const d = world.dialog;
  $('dialog').hidden = !d;
  $('hud').classList.toggle('talking', !!d || !!world.combat);
  if (!d) return;
  const node = DIALOG[d.node];
  const who = node.who;
  const name = who === 'you' ? 'You' : who === 'todak' ? 'Si Todak' : NPCS[who].name;
  const look = who === 'todak' ? 'todak' : who === 'you' ? 'hero' : NPCS[who].look;
  $('dname').textContent = name;
  $('dtext').textContent = node.text;
  const pc = $<HTMLCanvasElement>('portrait'), pctx = pc.getContext('2d')!;
  drawPortrait(pctx, look, pc.width, portraitT);
  const box = $('dopts');
  box.innerHTML = '';
  const opts2 = node.options?.length ? node.options.map(o => o.label) : ['Continue'];
  opts2.forEach((label, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    if (!node.options?.length) { b.className = 'next'; b.innerHTML = `Continue <kbd>Space</kbd>`; }
    b.addEventListener('click', () => { audio.play('click'); doAct({ t: 'say', option: i }); });
    box.appendChild(b);
  });
}

// ---------- shop ----------
function showShop(): void {
  const s = world.shop;
  $('shop').hidden = !s;
  if (!s) return;
  const npc = s === 'rahmah' ? 'rahmah' : s;
  $('shopname').textContent = NPCS[npc].name;
  $('shopnote').textContent = SHOPS[s].tax ? `Pays more for some fish · harbour tax ${Math.round(SHOPS[s].tax * 100)}%` : 'Buys any fish at the usual price';
  $('sellgrid').innerHTML = world.inv.map((it, i) => {
    const p = shopPrice(s, it.id);
    return `<button type="button" class="slot${p ? ' sell' : ''}" data-slot="${i}" title="${ITEMS[it.id].name}${p ? ` · sells for ${p}` : ' · not wanted here'}">${p ? `<small>${p}</small>` : ''}${itemSvg(it.id)}${it.n > 1 ? `<em>${it.n}</em>` : ''}</button>`;
  }).join('') || '<small style="grid-column:1/-1;color:var(--muted)">Nothing to sell. Go fishing!</small>';
  for (const b of $('sellgrid').querySelectorAll<HTMLButtonElement>('.slot.sell')) b.addEventListener('click', () => doAct({ t: 'sell', slot: Number(b.dataset.slot) }));
  $('buylist').innerHTML = SHOPS[s].sells.map(id => {
    const g = (GEAR as Record<string, { name: string; en: string; price: number }>)[id];
    const info = g ?? ITEMS[id as ItemId];
    const owned = g && world.gear[id as GearId];
    return `<div class="buyrow"><b>${info.name}</b><button type="button" class="buy" data-id="${id}" ${owned || world.picis < info.price ? 'disabled' : ''}>${owned ? 'Owned' : `${info.price} picis`}</button><i>${info.en}</i></div>`;
  }).join('');
  for (const b of $('buylist').querySelectorAll<HTMLButtonElement>('.buy')) b.addEventListener('click', () => doAct({ t: 'buy', item: b.dataset.id as ItemId | GearId }));
}
$('shopclose').addEventListener('click', () => doAct({ t: 'close' }));
$('sellall').addEventListener('click', () => {
  if (!world.shop) return;
  for (let i = world.inv.length - 1; i >= 0; i--) if (shopPrice(world.shop, world.inv[i].id)) applyEvents(act(world, { t: 'sell', slot: i }));
  afterChange();
});

// ---------- combat HUD ----------
function showCombat(): void {
  const c = world.combat;
  $('combat').hidden = !c;
  $('panel').hidden = !!c;
  if (!c) return;
  const cur = current(c), you = unitById(c, 'you')!;
  const order = $('order');
  if (order.childElementCount !== c.order.length) {
    order.innerHTML = '';
    for (const id of c.order) { const cv = document.createElement('canvas'); cv.width = 84; cv.height = 84; cv.dataset.id = id; order.appendChild(cv); }
  }
  for (const cv of order.querySelectorAll('canvas')) {
    const u = unitById(c, cv.dataset.id!)!;
    drawPortrait(cv.getContext('2d')!, u.look, 84, 0);
    cv.className = (u.id === cur.id ? 'cur ' : '') + (u.alive ? '' : 'dead');
    cv.style.borderColor = u.id === cur.id ? '' : EL_COLOR[u.el];
    cv.title = `${u.name} · ${u.el} · ${u.hp}/${u.maxHp}`;
  }
  const myTurn = cur.id === 'you' && c.phase === 'fight';
  const wind = MONSOON_WIND[monsoonAt(world.tick)];
  const abs = $('abilities');
  abs.innerHTML = '';
  you.abilities.forEach((id, i) => {
    const a = ABILITIES[id];
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ab'; b.style.background = ABILITY_BG[id];
    const usedUp = a.oncePerFight && you.used.includes(id);
    const noJamu = a.consumes && count(world, 'jamu') === 0;
    b.disabled = !myTurn || you.ap < a.ap || !!usedUp || !!noJamu;
    b.setAttribute('aria-pressed', String(view.combatUi.ability === id));
    b.title = `${a.name}: ${a.en}. ${a.ap} AP${a.self ? '' : `, range ${a.min}-${a.max}${a.ranged ? ' (+1 downwind)' : ''}`}${a.el ? `, ${a.el}` : ''}${noJamu ? ' · no jamu left' : a.consumes ? ` · ${count(world, 'jamu')} left` : ''}`;
    b.innerHTML = `<span class="key">${i + 1}</span><span class="cost">${a.ap}</span><svg viewBox="0 0 32 32">${ABILITY_SVG[id]}</svg>${a.name}`;
    b.addEventListener('click', () => pickAbility(id));
    abs.appendChild(b);
  });
  $('ap').innerHTML = Array.from({ length: you.apMax }, (_, i) => `<i class="${i < you.ap && myTurn ? 'on' : ''}"></i>`).join('');
  $('mp').innerHTML = Array.from({ length: you.mpMax }, (_, i) => `<i class="${i < you.mp && myTurn ? 'on' : ''}"></i>`).join('');
  ($('endturn') as HTMLButtonElement).disabled = !myTurn;
  let hint = '';
  if (view.combatUi.ring?.kind === 'attack') hint = opts.autoTime ? '' : 'Press Space as the gold ring closes';
  else if (view.combatUi.ring?.kind === 'dodge') hint = opts.autoTime ? '' : 'Incoming! Press Space as the blue ring closes to soften it';
  else if (myTurn && view.combatUi.ability) hint = ABILITIES[view.combatUi.ability].self ? '' : `${ABILITIES[view.combatUi.ability].name}: click a glowing target`;
  else if (myTurn) hint = 'Click a blue tile to move, or a foe to attack' + (Math.abs(wind.x) > 0 ? ' · ranged moves reach +1 downwind' : '');
  else hint = `${cur.name} is acting…`;
  $('chint').textContent = hint;
  $('chint').hidden = !hint;
}

function pickAbility(id: AbilityId): void {
  const c = world.combat; if (!c) return;
  const you = unitById(c, 'you')!;
  if (current(c).id !== 'you' || view.combatUi.ring) return;
  const a = ABILITIES[id];
  audio.play('click');
  if (a.self) { if (canUse(c, you, id, you, { wind: MONSOON_WIND[monsoonAt(world.tick)], hasJamu: count(world, 'jamu') > 0 })) doAct({ t: 'combat', it: { t: 'use', ability: id, target: 'you', grade: 'none' } }); return; }
  view.combatUi.ability = view.combatUi.ability === id ? null : id;
  showCombat();
}

// Timing: a ring closes over the target; pressing near the end gives a bonus. Never a penalty.
let pendingAttack: { ability: AbilityId; target: string } | null = null;
function startAttack(ability: AbilityId, target: string): void {
  if (opts.autoTime) { doAct({ t: 'combat', it: { t: 'use', ability, target, grade: 'good' } }); return; }
  pendingAttack = { ability, target };
  view.combatUi.ring = { unit: target, start: view.t, dur: 0.75, kind: 'attack' };
  showCombat();
}
function gradeFor(remaining: number, perfect: number, good: number): Grade {
  return remaining <= perfect ? 'perfect' : remaining <= good ? 'good' : 'none';
}
function pressTiming(): void {
  const r = view.combatUi.ring;
  if (!r) return;
  const remaining = r.start + r.dur - view.t;
  if (r.kind === 'attack' && pendingAttack) {
    const g = gradeFor(Math.abs(remaining), 0.09, 0.22);
    resolveAttack(remaining < -0.05 ? 'none' : g);
  } else if (r.kind === 'dodge') {
    const g = gradeFor(remaining, 0.16, 0.34);
    view.combatUi.ring = null;
    doAct({ t: 'combat', it: { t: 'dodge', grade: g } });
    if (g !== 'none') { banner(g === 'perfect' ? 'Elak!' : 'Tahan!', g === 'perfect' ? 'Perfect dodge' : 'Braced', 700); audio.play(g === 'perfect' ? 'perfect' : 'xp'); }
  }
}
function resolveAttack(g: Grade): void {
  if (!pendingAttack) return;
  const p = pendingAttack; pendingAttack = null;
  view.combatUi.ring = null; view.combatUi.ability = null;
  if (g === 'perfect') { banner('Tepat!', 'On the beat · ×1.25', 700); }
  doAct({ t: 'combat', it: { t: 'use', ability: p.ability, target: p.target, grade: g } });
}
$('endturn').addEventListener('click', () => { if (view.combatUi.ring) return; audio.play('click'); view.combatUi.ability = null; doAct({ t: 'combat', it: { t: 'end' } }); });

// ---------- events from the simulation ----------
const SFX = new Set(['click', 'step', 'catch', 'xp', 'level', 'coin', 'gong', 'hit', 'perfect', 'miss', 'hurt', 'heal', 'victory', 'defeat', 'quest', 'open', 'splash']);
let lastTickAt = performance.now();
function applyEvents(evs: Ev[]): void {
  for (const e of evs) {
    switch (e.t) {
      case 'msg': log(e.text, e.tone); break;
      case 'sfx': if (SFX.has(e.name)) audio.play(e.name as audio.Sfx); break;
      case 'xp': floater(e.x, e.y, `+${e.amount} ${SKILLS.find(s => s.id === e.skill)!.name}`, '#f5d27a'); break;
      case 'level': banner(`${SKILLS.find(s => s.id === e.skill)!.name} ${e.level}`, 'Level up!', 1800); break;
      case 'catch': floater(e.x, e.y, ITEMS[e.item].name, '#cfe9ff', false, 22); break;
      case 'coins': floater(world.player.x, world.player.y, `+${e.amount} picis`, '#e6c06a', false, 22); break;
      case 'quest': banner(e.step >= 7 ? 'Babak I selesai' : 'Tugas baru', QUEST.steps[e.step].goal, 2600); break;
      case 'monsoon': banner(MONSOON_NAME[e.m], e.m === 'NE' ? 'Rain · Chinese junks in port · kembung bite' : 'Dry skies · a ship from Gujarat · selar bite', 2800); break;
      case 'festival': audio.setAmbient(opts.sound); break;
      case 'combatStart': banner('Lawan!', 'Fight on the grid', 1200); view.combatUi = { ability: null, hoverUnit: null, ring: null }; break;
      case 'combatEnd': pendingAttack = null; view.combatUi.ring = null; banner(e.won ? 'Menang!' : 'Kalah…', e.won ? 'Victory' : 'Pak Lawak drags you home', 1800); view.unitAnims.clear(); view.playerFrom = { x: world.player.x, y: world.player.y }; view.lawakFrom = { x: world.lawak.x, y: world.lawak.y }; break;
      case 'combat': {
        const ce = e.e, c = world.combat;
        if (ce.t === 'move') {
          const start = prevUnitPos.get(ce.unit) ?? ce.path[0];
          view.unitAnims.set(ce.unit, { from: start, path: ce.path, start: view.t });
        } else if (ce.t === 'hit') {
          const t = c ? unitById(c, ce.target) : undefined, a = c ? unitById(c, ce.unit) : undefined;
          if (t && a) {
            if (ABILITIES[ce.ability].ranged || ce.ability === 'bayang') view.shots.push({ from: { x: a.x, y: a.y }, to: { x: t.x, y: t.y }, born: view.t, color: ABILITIES[ce.ability].el ? EL_COLOR[ABILITIES[ce.ability].el!] : '#fff' });
            const delay = ABILITIES[ce.ability].ranged ? 300 : 0;
            window.setTimeout(() => {
              floater(t.x, t.y, `-${ce.dmg}`, t.side === 'hero' ? '#ffb4a8' : '#ffffff', true);
              if (ce.mult > 1) floater(t.x, t.y, 'Kuat! ×1.5', '#ffd36a', false, 28);
              else if (ce.mult < 1) floater(t.x, t.y, 'Lemah ×0.67', '#9fb4c8', false, 28);
              view.flashes.set(t.id, 0.9);
              audio.play(ce.grade === 'perfect' ? 'perfect' : t.side === 'hero' ? 'hurt' : 'hit');
            }, delay);
          }
        } else if (ce.t === 'heal') { const u = c ? unitById(c, ce.unit) : undefined; if (u) floater(u.x, u.y, `+${ce.amount}`, '#9fe8b0', true); audio.play('heal'); }
        else if (ce.t === 'windup' && ce.target === 'you') {
          const next = lastTickAt + TICK_MS;
          const dur = Math.max(0.25, (next - performance.now()) / 1000);
          if (opts.autoTime) doAct({ t: 'combat', it: { t: 'dodge', grade: 'good' } });
          else view.combatUi.ring = { unit: 'you', start: view.t, dur, kind: 'dodge' };
        } else if (ce.t === 'windup') { /* ally targeted: no prompt */ }
        else if (ce.t === 'down') { /* drawn as fallen */ }
        else if (ce.t === 'turn' && ce.unit === 'you') { view.combatUi.ability = null; }
        break;
      }
      default: break;
    }
  }
}

function afterChange(): void {
  refreshTop(); refreshPanel(); showDialog(); showShop(); showCombat();
}
function doAct(it: Intent): void {
  if (!started) return;
  if (world.combat) for (const u of world.combat.units) prevUnitPos.set(u.id, { x: u.x, y: u.y });
  applyEvents(act(world, it));
  afterChange();
}

// ---------- input ----------
function toWorld(ev: { clientX: number; clientY: number }): { wx: number; wy: number } {
  const wx = (ev.clientX - W / 2) / view.zoom + cam.camX;
  const wy = (ev.clientY - H / 2 - 40 * view.zoom) / view.zoom + cam.camY;
  return { wx, wy };
}
function pickTile(wx: number, wy: number): Vec {
  const up = screenToTile(wx, wy + EH);
  if (elevAt(MAP, up.x, up.y) > 0) return up;
  return screenToTile(wx, wy);
}
function pickHit(wx: number, wy: number): HitBox | null {
  let best: HitBox | null = null;
  for (const h of hits) if (Math.abs(wx - h.x) < 20 && wy < h.y + 8 && wy > h.y - h.h && (!best || h.depth > best.depth)) best = h;
  return best;
}
function spotAt(p: Vec): number { return SPOTS.findIndex(s => s.at.x === p.x && s.at.y === p.y); }

function hoverText(wx: number, wy: number): string {
  const c = world.combat;
  const h = pickHit(wx, wy), tile = pickTile(wx, wy);
  if (c) {
    view.combatUi.hoverUnit = h?.hit.kind === 'unit' ? h.hit.id : null;
    if (h?.hit.kind === 'unit') {
      const u = unitById(c, h.hit.id)!;
      return `<b>${u.name}</b> · ${u.el} · ${u.hp}/${u.maxHp}`;
    }
    const you = unitById(c, 'you')!;
    if (current(c).id === 'you' && reachable(c, you).has(`${tile.x},${tile.y}`)) return `Move here (${reachable(c, you).get(`${tile.x},${tile.y}`)!.length} MP)`;
    return '';
  }
  if (h?.hit.kind === 'npc') { const n = NPCS[h.hit.id as NpcId]; return `Talk to <b>${n.name}</b> · ${n.title}`; }
  const si = spotAt(tile);
  if (si >= 0) return `Fish <b>${SPOTS[si].name}</b>`;
  if (walkable(MAP, tile.x, tile.y)) return 'Walk here';
  const k = kindAt(MAP, tile.x, tile.y);
  const names: Partial<Record<string, string>> = { house: 'A stilt house', balai: 'The balai, village hall', stall: 'Pasar stall', palace: "The raja's pendopo", gate: 'Split gate of Bukit Larangan', tent: "Perompak tent", pod: 'Your seed pod, still warm', tooth: "Dragon's Tooth rock", forest: 'Jungle', palm: 'Coconut palm', river: 'The river', sea: 'The strait', shallow: 'Shallows' };
  return names[k] ?? '';
}

canvas.addEventListener('mousemove', ev => {
  if (!started) return;
  const { wx, wy } = toWorld(ev);
  view.hover = pickTile(wx, wy);
  const label = $('hoverlabel');
  const text = hoverText(wx, wy);
  label.innerHTML = text;
  label.style.display = text ? 'block' : 'none';
  label.style.left = `${ev.clientX}px`; label.style.top = `${ev.clientY}px`;
});
canvas.addEventListener('mouseleave', () => { view.hover = null; $('hoverlabel').style.display = 'none'; });

canvas.addEventListener('click', ev => {
  if (!started) return;
  audio.unlock();
  const { wx, wy } = toWorld(ev);
  const tile = pickTile(wx, wy), h = pickHit(wx, wy);
  const c = world.combat;
  if (c) {
    if (view.combatUi.ring) { pressTiming(); return; }
    if (current(c).id !== 'you' || c.phase !== 'fight') return;
    const you = unitById(c, 'you')!, wind = MONSOON_WIND[monsoonAt(world.tick)];
    if (h?.hit.kind === 'unit') {
      const target = unitById(c, h.hit.id)!;
      let ab = view.combatUi.ability;
      if (!ab) ab = (['bayang', 'ombak', 'tendang'] as AbilityId[]).find(a => you.abilities.includes(a) && canUse(c, you, a, target, { wind })) ?? null;
      if (ab && canUse(c, you, ab, target, { wind, hasJamu: count(world, 'jamu') > 0 })) { startAttack(ab, target.id); return; }
      if (target.side === 'foe') log(view.combatUi.ability ? 'Out of range for that move.' : 'No move reaches them from here. Step closer.', 'warn');
      return;
    }
    if (reachable(c, you).has(`${tile.x},${tile.y}`)) { view.combatUi.ability = null; doAct({ t: 'combat', it: { t: 'step', to: tile } }); return; }
    view.combatUi.ability = null; showCombat();
    return;
  }
  if (world.dialog) { return; }
  let ok = true;
  if (h?.hit.kind === 'npc') doAct({ t: 'talk', npc: h.hit.id as NpcId });
  else if (spotAt(tile) >= 0) doAct({ t: 'fish', spot: spotAt(tile) });
  else if (walkable(MAP, tile.x, tile.y)) doAct({ t: 'walk', to: tile });
  else ok = false;
  view.clickMark = { x: tile.x, y: tile.y, at: view.t, ok };
});
canvas.addEventListener('wheel', ev => {
  ev.preventDefault();
  view.zoom = Math.max(0.6, Math.min(2, view.zoom * (ev.deltaY > 0 ? 0.92 : 1.08)));
}, { passive: false });

addEventListener('keydown', ev => {
  if (!started) return;
  audio.unlock();
  const c = world.combat;
  if (ev.code === 'Space') {
    ev.preventDefault();
    if (view.combatUi.ring) { pressTiming(); return; }
    if (world.dialog) { const n = DIALOG[world.dialog.node]; if (!n.options?.length) doAct({ t: 'say', option: 0 }); }
    return;
  }
  if (ev.key === 'Escape') { if (c) { view.combatUi.ability = null; showCombat(); } else doAct({ t: 'close' }); return; }
  if (c && (ev.key === 'e' || ev.key === 'E' || ev.key === 'Enter') && current(c).id === 'you' && !view.combatUi.ring) { view.combatUi.ability = null; doAct({ t: 'combat', it: { t: 'end' } }); return; }
  if (c && /^[1-9]$/.test(ev.key)) { const you = unitById(c, 'you')!; const id = you.abilities[Number(ev.key) - 1]; if (id) pickAbility(id); return; }
  if (world.dialog && /^[1-9]$/.test(ev.key)) doAct({ t: 'say', option: Number(ev.key) - 1 });
});

$('mute').addEventListener('click', () => {
  opts.sound = !opts.sound; saveOpts();
  audio.unlock(); audio.setMuted(!opts.sound);
  $('mute').textContent = opts.sound ? '♪' : '✕';
});

// ---------- title screen ----------
const optSound = $<HTMLInputElement>('opt-sound'), optAuto = $<HTMLInputElement>('opt-autotime');
optSound.checked = opts.sound; optAuto.checked = opts.autoTime;
optSound.addEventListener('change', () => { opts.sound = optSound.checked; saveOpts(); });
optAuto.addEventListener('change', () => { opts.autoTime = optAuto.checked; saveOpts(); });
if (readSave()) $('continue').hidden = false;
function begin(fresh: boolean): void {
  audio.unlock();
  audio.setMuted(!opts.sound);
  $('mute').textContent = opts.sound ? '♪' : '✕';
  if (fresh) { world = newWorld(Math.floor(Math.random() * 1e9)); view.w = world; }
  view.playerFrom = { x: world.player.x, y: world.player.y }; view.lawakFrom = { x: world.lawak.x, y: world.lawak.y };
  started = true;
  lastTickAt = performance.now();
  $('title').hidden = true; $('hud').hidden = false;
  audio.setRain(monsoonAt(world.tick) === 'NE' ? 0.6 : 0);
  if (world.step >= 7) audio.setAmbient(true);
  afterChange();
  banner('Babak I', QUEST.title.split('· ')[1], 2400);
  if (fresh) log('You wake inside a split, glowing seed on a strange beach.', 'quest');
}
$('start').addEventListener('click', () => begin(true));
$('continue').addEventListener('click', () => begin(false));
document.addEventListener('visibilitychange', () => { if (!started) return; if (document.hidden) writeSave(); else lastTickAt = performance.now(); });

// ---------- main loop ----------
let lastFrame = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  view.t += dt;
  portraitT += dt;
  if (started) {
    let guard = 0;
    while (now - lastTickAt >= TICK_MS && guard++ < (world.combat ? 1 : 5)) {
      lastTickAt += TICK_MS;
      view.playerFrom = { x: world.player.x, y: world.player.y };
      view.lawakFrom = { x: world.lawak.x, y: world.lawak.y };
      if (world.combat) for (const u of world.combat.units) prevUnitPos.set(u.id, { x: u.x, y: u.y });
      // a dodge window closes when its tick arrives
      if (view.combatUi.ring?.kind === 'dodge') view.combatUi.ring = null;
      const before = { step: world.step, inv: world.inv.length, dialog: world.dialog?.node, combat: !!world.combat, turn: world.combat?.turn, hp: world.player.hp, shop: world.shop, picis: world.picis };
      const m0 = monsoonAt(world.tick);
      const evs = step(world, []);
      applyEvents(evs);
      if (monsoonAt(world.tick) !== m0) { audio.setRain(monsoonAt(world.tick) === 'NE' ? 0.6 : 0); showShop(); }
      if (world.tick % 10 === 0) writeSave();
      const changed = before.step !== world.step || before.inv !== world.inv.length || before.dialog !== world.dialog?.node || before.combat !== !!world.combat || before.turn !== world.combat?.turn || before.hp !== world.player.hp || before.shop !== world.shop || before.picis !== world.picis || evs.some(e => e.t === 'combat');
      if (changed) afterChange(); else refreshTop();
    }
    if (now - lastTickAt > TICK_MS * 5) lastTickAt = now;
    view.alpha = Math.max(0, Math.min(1, (now - lastTickAt) / TICK_MS));
    // attack ring times out on its own: no press means a normal hit
    const r = view.combatUi.ring;
    if (r && r.kind === 'attack' && view.t > r.start + r.dur + 0.12) resolveAttack('none');
    for (const [k, f] of view.flashes) { const nf = f - dt * 2.5; if (nf <= 0) view.flashes.delete(k); else view.flashes.set(k, nf); }
    view.shots = view.shots.filter(s => view.t - s.born < 0.5);
    audio.setWindPan(MONSOON_WIND[monsoonAt(world.tick)].x);
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  view.w = world;
  cam = render(ctx, view, W, H, hits);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Exposed for the smoke test and for poking at the game from the console.
(window as unknown as { __game: unknown }).__game = {
  get world() { return world; },
  act: (it: Intent) => doAct(it),
  begin,
  /** Client pixel position of a tile's centre, for scripted clicks. */
  toScreen: (x: number, y: number) => { const [sx, sy] = iso(x, y, elevAt(MAP, x, y)); return { x: (sx - cam.camX) * view.zoom + W / 2, y: (sy - cam.camY) * view.zoom + H / 2 + 40 * view.zoom }; },
  reach: () => { const c = world.combat; return c ? [...reachable(c, unitById(c, 'you')!).keys()] : []; }
};

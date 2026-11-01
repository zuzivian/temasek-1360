// Canvas renderer: isometric tiles, painted objects, puppets, fog, weather and combat overlays.
import { ABILITIES, ENCOUNTERS, MONSOON_WIND, NPCS, type AbilityId, type Look, type NpcId } from '../sim/content.ts';
import { inBox, reachable, canUse, current, maxRange, type CombatState, type Unit } from '../sim/combat.ts';
import type { Element, Vec } from '../sim/core.ts';
import { MAP, elevAt, kindAt, type TileKind } from '../sim/map.ts';
import { count, isExplored, monsoonAt, npcPresent, questTarget, type World } from '../sim/world.ts';
import { drawPuppet } from './puppets.ts';

export const TW = 64, TH = 32, EH = 14;
export const PUP_S = 0.31;

export const EL_COLOR: Record<Element, string> = { Kayu: '#4f8f3c', Tanah: '#a8763a', Angin: '#4aa39a', Air: '#2f6fb8', Api: '#d4532a', Besi: '#8a96a6' };

export function iso(x: number, y: number, e = 0): [number, number] {
  return [(x - y) * (TW / 2), (x + y) * (TH / 2) - e * EH];
}
export function screenToTile(sx: number, sy: number): Vec {
  const fx = sx / (TW / 2), fy = sy / (TH / 2);
  return { x: Math.floor((fx + fy) / 2 + 0.5), y: Math.floor((fy - fx) / 2 + 0.5) };
}

const hash = (i: number, j: number): number => {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export type Floater = { x: number; y: number; text: string; color: string; born: number; big?: boolean; dy?: number };
export type Anim = { from: Vec; path: Vec[]; start: number };
export type CombatUi = { ability: AbilityId | null; hoverUnit: string | null; ring: { unit: string; start: number; dur: number; kind: 'attack' | 'dodge' } | null };

export type View = {
  w: World;
  t: number;
  alpha: number;
  playerFrom: Vec; lawakFrom: Vec;
  unitAnims: Map<string, Anim>;
  hover: Vec | null;
  clickMark: { x: number; y: number; at: number; ok: boolean } | null;
  floaters: Floater[];
  combatUi: CombatUi;
  flashes: Map<string, number>;
  zoom: number;
  shots: { from: Vec; to: Vec; born: number; color: string }[];
};

function poly(ctx: CanvasRenderingContext2D, pts: [number, number][]): void {
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}
function diamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, k = 1): void {
  poly(ctx, [[cx, cy - (TH / 2) * k], [cx + (TW / 2) * k, cy], [cx, cy + (TH / 2) * k], [cx - (TW / 2) * k, cy]]);
}

const lerpV = (a: Vec, b: Vec, k: number): Vec => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
function alongPath(from: Vec, path: Vec[], k: number): Vec {
  if (!path.length) return from;
  k = Math.max(0, Math.min(1, k));
  const pts = [from, ...path], seg = Math.min(pts.length - 2, Math.floor(k * (pts.length - 1)));
  const local = k * (pts.length - 1) - seg;
  return lerpV(pts[seg], pts[seg + 1], Math.min(1, local));
}

// ---------- ground ----------
const WATER_KINDS = new Set<TileKind>(['sea', 'shallow', 'river', 'spot']);

function groundColor(k: TileKind, h: number, x: number, y: number, t: number): string {
  switch (k) {
    case 'sea': return `hsl(${196 + h * 4},52%,${36 + Math.sin(t * 1.4 + x * 0.7 + y * 0.45) * 3}%)`;
    case 'shallow': case 'spot': return `hsl(${184 + h * 4},46%,${52 + Math.sin(t * 1.6 + x * 0.6 + y * 0.5) * 3}%)`;
    case 'river': return `hsl(${190 + h * 4},40%,${42 + Math.sin(t * 2 + y * 0.9) * 3}%)`;
    case 'sand': case 'tent': case 'fire': case 'tooth': return `hsl(41,${52 + h * 8}%,${73 + h * 5}%)`;
    case 'scorch': return `hsl(30,${30 + h * 8}%,${48 + h * 5}%)`;
    case 'pod': return `hsl(30,30%,50%)`;
    case 'forest': return `hsl(${108 + h * 8},34%,${27 + h * 5}%)`;
    case 'hill': case 'palace': case 'spring': case 'gate': return `hsl(${82 + h * 8},38%,${46 + h * 6}%)`;
    case 'bridge': return `hsl(190,40%,42%)`;
    default: return `hsl(${82 + h * 14},40%,${44 + h * 8}%)`;
  }
}

function drawGround(ctx: CanvasRenderingContext2D, v: View, x: number, y: number): void {
  const k = kindAt(MAP, x, y), e = elevAt(MAP, x, y), h = hash(x, y);
  const [cx, cy] = iso(x, y, e);
  if (e > 0) {
    ctx.fillStyle = '#6a5232'; poly(ctx, [[cx - TW / 2, cy], [cx, cy + TH / 2], [cx, cy + TH / 2 + EH * e], [cx - TW / 2, cy + EH * e]]); ctx.fill();
    ctx.fillStyle = '#54402a'; poly(ctx, [[cx, cy + TH / 2], [cx + TW / 2, cy], [cx + TW / 2, cy + EH * e], [cx, cy + TH / 2 + EH * e]]); ctx.fill();
  }
  ctx.fillStyle = groundColor(k, h, x, y, v.t);
  diamond(ctx, cx, cy); ctx.fill();
  if (!WATER_KINDS.has(k)) { ctx.strokeStyle = 'rgba(0,0,0,0.05)'; ctx.lineWidth = 1; ctx.stroke(); }
  // detail
  if (k === 'grass' && h > 0.8) {
    ctx.strokeStyle = 'rgba(30,70,20,0.45)'; ctx.lineWidth = 1.2; ctx.beginPath();
    ctx.moveTo(cx - 4, cy + 2); ctx.lineTo(cx - 6, cy - 5); ctx.moveTo(cx, cy + 2); ctx.lineTo(cx, cy - 6); ctx.moveTo(cx + 4, cy + 2); ctx.lineTo(cx + 6, cy - 5); ctx.stroke();
  } else if (k === 'sand' && h > 0.75) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.arc(cx + (h - 0.8) * 60, cy + 3, 1.6, 0, 7); ctx.fill();
  } else if (k === 'shallow' || k === 'sea' || k === 'river') {
    if (h < 0.18) {
      const p = (v.t * 0.5 + h * 10) % 1;
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * Math.sin(p * Math.PI)})`; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(cx - 10, cy - 1 + p * 3); ctx.quadraticCurveTo(cx - 1, cy - 4 + p * 3, cx + 8, cy - 2 + p * 3); ctx.stroke();
    }
    // foam where water meets land
    if (k === 'shallow') for (const [dx, dy] of [[0, -1], [-1, 0]]) {
      if (!WATER_KINDS.has(kindAt(MAP, x + dx, y + dy))) {
        ctx.strokeStyle = `rgba(255,255,255,${0.45 + 0.2 * Math.sin(v.t * 2 + x)})`; ctx.lineWidth = 2;
        ctx.beginPath();
        if (dy === -1) { ctx.moveTo(cx, cy - TH / 2 + 2); ctx.lineTo(cx + TW / 2 - 3, cy); } else { ctx.moveTo(cx - TW / 2 + 3, cy); ctx.lineTo(cx, cy - TH / 2 + 2); }
        ctx.stroke();
      }
    }
  } else if (k === 'spring') {
    ctx.fillStyle = '#5fb6c8'; ctx.beginPath(); ctx.ellipse(cx, cy, 16, 7, 0, 0, 7); ctx.fill();
  }
  if (k === 'spot') {
    for (let i = 0; i < 5; i++) {
      const p = (v.t * 0.8 + i / 5) % 1, a = i * 1.3 + Math.floor(v.t * 0.8 + i / 5);
      ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - p)})`; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.ellipse(cx + Math.cos(a) * 9, cy + Math.sin(a) * 4, 2 + p * 7, 1 + p * 3, 0, 0, 7); ctx.stroke();
    }
  }
  if (k === 'bridge') {
    ctx.fillStyle = '#8a6438'; diamond(ctx, cx, cy, 0.9); ctx.fill();
    ctx.strokeStyle = '#5a3e20'; ctx.lineWidth = 1.2; ctx.beginPath();
    for (let i = -2; i <= 2; i++) { ctx.moveTo(cx + i * 9 - 10, cy + i * 4.5 - 5); ctx.lineTo(cx + i * 9 + 10, cy + i * 4.5 + 5); }
    ctx.stroke();
  }
}

// ---------- objects ----------
function tree(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number): void {
  ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(cx, cy + 2, 22, 9, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#5a3e22'; ctx.fillRect(cx - 2.5, cy - 18, 5, 18);
  const g = 30 + h * 10;
  for (const [dx, dy, r, l] of [[-10, -26, 14, 0], [10, -28, 14, 4], [0, -40, 16, 8], [-4, -30, 12, 12]]) {
    ctx.fillStyle = `hsl(${110 + h * 20},38%,${g - 6 + l}%)`; ctx.beginPath(); ctx.arc(cx + dx, cy + dy - h * 6, r, 0, 7); ctx.fill();
  }
}
function palm(ctx: CanvasRenderingContext2D, cx: number, cy: number, t: number, h: number, wind: Vec, storm: number): void {
  const wx = (wind.x - wind.y) * 0.7;
  const lean = wx * 14 + Math.sin(t * 1.7 + h * 9) * 3 * (1 + storm), tx = cx + lean, ty = cy - 56;
  ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.beginPath(); ctx.ellipse(cx + 8, cy + 2, 20, 7, 0, 0, 7); ctx.fill();
  ctx.strokeStyle = '#7a5a35'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo(cx + lean * 0.2, cy - 30, tx, ty); ctx.stroke();
  ctx.strokeStyle = '#3f7a2e'; ctx.lineWidth = 4;
  for (let k = 0; k < 7; k++) {
    const ang = -Math.PI / 2 + (k - 3) * 0.55;
    ctx.beginPath(); ctx.moveTo(tx, ty);
    ctx.quadraticCurveTo(tx + Math.cos(ang) * 16 + wx * 6, ty + Math.sin(ang) * 14 - 6, tx + Math.cos(ang) * 28 + wx * 10, ty + Math.sin(ang) * 12 + 16); ctx.stroke();
  }
}
function house(ctx: CanvasRenderingContext2D, x: number, y: number, big = false): void {
  const a = big ? 28 : 20, b = big ? 14 : 10, e = 12, hw = big ? 18 : 14;
  ctx.fillStyle = 'rgba(0,0,0,0.16)'; ctx.beginPath(); ctx.ellipse(x, y + 4, a * 1.2, b * 1.1, 0, 0, 7); ctx.fill();
  ctx.strokeStyle = '#4a3520'; ctx.lineWidth = 2; ctx.beginPath();
  for (const [dx, dy] of [[-a + 3, 0], [0, b - 2], [a - 3, 0]]) { ctx.moveTo(x + dx, y + dy); ctx.lineTo(x + dx, y + dy - e); }
  ctx.stroke();
  const L: [number, number] = [x - a, y - e], F: [number, number] = [x, y + b - e], R: [number, number] = [x + a, y - e];
  ctx.fillStyle = big ? '#b98a4c' : '#c8a466'; poly(ctx, [L, F, [F[0], F[1] - hw], [L[0], L[1] - hw]]); ctx.fill();
  ctx.fillStyle = big ? '#93693a' : '#a9864d'; poly(ctx, [F, R, [R[0], R[1] - hw], [F[0], F[1] - hw]]); ctx.fill();
  ctx.fillStyle = '#5a3f22'; poly(ctx, [[x - 12, y - e - 4], [x - 7, y - e - 2], [x - 7, y - e - 12], [x - 12, y - e - 14]]); ctx.fill();
  const ap: [number, number] = [x, y - e - hw - (big ? 32 : 24)], k = 1.32;
  const Lr: [number, number] = [x - a * k, y - e - hw + 2], Fr: [number, number] = [x, y + b * k - e - hw + 2], Rr: [number, number] = [x + a * k, y - e - hw + 2];
  ctx.fillStyle = big ? '#8a2f22' : '#7a5530'; poly(ctx, [Lr, Fr, ap]); ctx.fill();
  ctx.fillStyle = big ? '#6a2318' : '#5e4024'; poly(ctx, [Fr, Rr, ap]); ctx.fill();
  if (big) { ctx.fillStyle = '#f0c75a'; for (let q = 1; q < 5; q++) { const f = q / 5; ctx.beginPath(); ctx.arc(Fr[0] + (ap[0] - Fr[0]) * f, Fr[1] + (ap[1] - Fr[1]) * f, 1.8, 0, 7); ctx.fill(); } }
  else { ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.lineWidth = 1; ctx.beginPath(); for (let q = 1; q < 4; q++) { const f = q / 4; ctx.moveTo(Lr[0] + (ap[0] - Lr[0]) * f, Lr[1] + (ap[1] - Lr[1]) * f); ctx.lineTo(Fr[0] + (ap[0] - Fr[0]) * f, Fr[1] + (ap[1] - Fr[1]) * f); ctx.lineTo(Rr[0] + (ap[0] - Rr[0]) * f, Rr[1] + (ap[1] - Rr[1]) * f); } ctx.stroke(); }
}
function stall(ctx: CanvasRenderingContext2D, x: number, y: number, h: number): void {
  ctx.strokeStyle = '#4a2e16'; ctx.lineWidth = 2.5; ctx.beginPath();
  for (const dx of [-16, 16]) { ctx.moveTo(x + dx, y); ctx.lineTo(x + dx, y - 26); } ctx.stroke();
  ctx.fillStyle = h > 0.5 ? '#c0392b' : '#2f6fb8'; poly(ctx, [[x - 26, y - 24], [x + 26, y - 24], [x + 14, y - 38], [x - 14, y - 38]]); ctx.fill();
  ctx.fillStyle = '#f0c75a'; for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.arc(x + i * 10, y - 24, 2, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#a5763a'; ctx.fillRect(x - 18, y - 10, 36, 7);
  for (let k = 0; k < 4; k++) { ctx.fillStyle = ['#6fa3c0', '#c7d6de', '#e6b24a', '#4f8f3c'][k]; ctx.beginPath(); ctx.ellipse(x - 12 + k * 8, y - 12, 4, 2.4, 0, 0, 7); ctx.fill(); }
}
function gatePillar(ctx: CanvasRenderingContext2D, x: number, y: number, side: number): void {
  let yy = y;
  for (const [w, h] of [[24, 20], [20, 17], [16, 15], [11, 13], [6, 11]]) {
    const x0 = side < 0 ? x + 8 - w : x - 8;
    ctx.fillStyle = '#b4532f'; ctx.fillRect(x0, yy - h, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.2)'; if (side < 0) ctx.fillRect(x0, yy - h, 3, h); else ctx.fillRect(x0 + w - 3, yy - h, 3, h);
    ctx.strokeStyle = 'rgba(60,20,10,0.3)'; ctx.lineWidth = 1; ctx.beginPath(); for (let m = yy - 4; m > yy - h; m -= 5) { ctx.moveTo(x0, m); ctx.lineTo(x0 + w, m); } ctx.stroke();
    yy -= h;
  }
}
function pendopo(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(x, y + 6, 90, 34, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#9a4a2a'; poly(ctx, [[x - 80, y], [x, y + 30], [x + 80, y], [x, y - 30]]); ctx.fill();
  ctx.strokeStyle = '#4a2a14'; ctx.lineWidth = 4; ctx.beginPath();
  for (const [dx, dy] of [[-54, 0], [0, 20], [54, 0], [0, -20], [-24, 10], [24, 10]]) { ctx.moveTo(x + dx, y + dy); ctx.lineTo(x + dx, y + dy - 34); } ctx.stroke();
  for (const [w, h, c] of [[100, 18, '#7a2418'], [70, 18, '#8a2f22'], [40, 18, '#7a2418']] as [number, number, string][]) {
    const yy = y - 34 - (100 - w) * 0.6;
    ctx.fillStyle = c; poly(ctx, [[x - w, yy], [x, yy + w * 0.36], [x + w, yy], [x, yy - w * 0.36 - h]]); ctx.fill();
    ctx.fillStyle = '#f0c75a'; ctx.beginPath(); ctx.arc(x, yy - w * 0.36 - h, 3, 0, 7); ctx.fill();
  }
}
function tent(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.beginPath(); ctx.ellipse(x, y + 3, 28, 10, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#3a2a22'; poly(ctx, [[x - 28, y], [x, y - 36], [x + 4, y + 10]]); ctx.fill();
  ctx.fillStyle = '#2a1e18'; poly(ctx, [[x + 4, y + 10], [x, y - 36], [x + 28, y]]); ctx.fill();
  ctx.fillStyle = '#c0392b'; poly(ctx, [[x, y - 36], [x + 14, y - 44], [x, y - 48]]); ctx.fill();
}
function campfire(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  ctx.fillStyle = '#4a3a2a'; for (let k = 0; k < 6; k++) { const a = k / 6 * 6.28; ctx.beginPath(); ctx.arc(x + Math.cos(a) * 12, y + Math.sin(a) * 5, 3, 0, 7); ctx.fill(); }
  const fl = 1 + Math.sin(t * 12) * 0.12 + Math.sin(t * 7.3) * 0.08;
  const g = ctx.createRadialGradient(x, y - 10, 2, x, y - 10, 36 * fl);
  g.addColorStop(0, 'rgba(255,240,180,0.9)'); g.addColorStop(0.4, 'rgba(255,150,50,0.5)'); g.addColorStop(1, 'rgba(255,120,30,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y - 10, 36 * fl, 0, 7); ctx.fill();
  ctx.fillStyle = '#ffcf6a'; ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.quadraticCurveTo(x, y - 26 * fl, x + 7, y); ctx.fill();
}
function rock(ctx: CanvasRenderingContext2D, x: number, y: number, tall: boolean): void {
  if (tall) {
    ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.beginPath(); ctx.ellipse(x, y + 4, 26, 10, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#6f6a66'; poly(ctx, [[x - 22, y + 4], [x - 12, y - 58], [x + 2, y - 74], [x + 10, y - 40], [x + 22, y + 4]]); ctx.fill();
    ctx.fillStyle = '#8f8a84'; poly(ctx, [[x - 12, y - 58], [x + 2, y - 74], [x - 2, y - 30], [x - 14, y]]); ctx.fill();
  } else {
    ctx.fillStyle = '#7d8590'; ctx.beginPath(); ctx.ellipse(x, y - 6, 16, 11, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#9aa3ae'; ctx.beginPath(); ctx.ellipse(x - 4, y - 10, 7, 4, 0, 0, 7); ctx.fill();
  }
}
function pod(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  const pulse = 0.5 + 0.5 * Math.sin(t * 2);
  const g = ctx.createRadialGradient(x, y - 18, 4, x, y - 18, 60);
  g.addColorStop(0, `rgba(140,255,230,${0.35 + 0.25 * pulse})`); g.addColorStop(1, 'rgba(140,255,230,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y - 18, 60, 0, 7); ctx.fill();
  // a split seed pod, grown rather than built
  for (const side of [-1, 1]) {
    ctx.fillStyle = side < 0 ? '#3a5a52' : '#2c4a44';
    ctx.beginPath(); ctx.moveTo(x, y + 6); ctx.bezierCurveTo(x + side * 34, y + 2, x + side * 38, y - 34, x + side * 12, y - 46); ctx.quadraticCurveTo(x + side * 16, y - 18, x, y + 6); ctx.fill();
    ctx.strokeStyle = `rgba(150,255,230,${0.5 + 0.4 * pulse})`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x + side * 4, y); ctx.bezierCurveTo(x + side * 24, y - 4, x + side * 28, y - 26, x + side * 12, y - 40); ctx.stroke();
  }
  ctx.fillStyle = `rgba(190,255,240,${0.6 + 0.3 * pulse})`; ctx.beginPath(); ctx.ellipse(x, y - 12, 7, 12, 0, 0, 7); ctx.fill();
}
function ship(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, kind: 'junk' | 'gujarat' | 'pirate', wind: Vec): void {
  y += Math.sin(t * 1.6 + x) * 2;
  const lean = (wind.x - wind.y) * 8;
  ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(x, y + 6, 54, 12, 0, 0, 7); ctx.fill();
  ctx.fillStyle = kind === 'pirate' ? '#1e140e' : '#5a3b22'; poly(ctx, [[x - 56, y - 10], [x + 56, y - 16], [x + 40, y + 6], [x - 40, y + 6]]); ctx.fill();
  if (kind === 'junk') { ctx.fillStyle = '#8a2a1a'; ctx.fillRect(x - 56, y - 18, 22, 10); }
  ctx.strokeStyle = '#3a2614'; ctx.lineWidth = 3;
  const masts = kind === 'pirate' ? [0] : [-18, 16];
  for (const m of masts) {
    ctx.beginPath(); ctx.moveTo(x + m, y - 10); ctx.lineTo(x + m, y - 78); ctx.stroke();
    if (kind === 'junk') {
      ctx.fillStyle = '#9b3b25'; poly(ctx, [[x + m - 2, y - 76], [x + m + lean + 26, y - 74], [x + m + lean + 24, y - 22], [x + m - 2, y - 22]]); ctx.fill();
      ctx.strokeStyle = 'rgba(40,10,0,0.5)'; ctx.lineWidth = 1.2; ctx.beginPath(); for (let q = 1; q < 6; q++) { const yy = y - 76 + q * 9; ctx.moveTo(x + m - 2, yy); ctx.lineTo(x + m + lean + 25, yy + 1); } ctx.stroke();
      ctx.strokeStyle = '#3a2614'; ctx.lineWidth = 3;
    } else {
      ctx.fillStyle = kind === 'gujarat' ? '#f2e8d0' : '#2a2a2a';
      poly(ctx, [[x + m - 18, y - 80], [x + m + lean + 24, y - 64], [x + m + lean + 14, y - 22], [x + m - 22, y - 26]]); ctx.fill();
      if (kind === 'pirate') { ctx.fillStyle = '#c0392b'; poly(ctx, [[x + m, y - 80], [x + m + 18, y - 76], [x + m, y - 72]]); ctx.fill(); }
    }
  }
}
function lanternString(ctx: CanvasRenderingContext2D, a: [number, number], b: [number, number], t: number, wind: Vec): void {
  const sag = 26, sway = Math.sin(t * 1.3) * 3 + (wind.x - wind.y) * 4;
  ctx.strokeStyle = 'rgba(40,10,10,0.8)'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(...a);
  ctx.quadraticCurveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + sag, ...b); ctx.stroke();
  for (let k = 1; k < 8; k++) {
    const u = k / 8, x = (1 - u) ** 2 * a[0] + 2 * (1 - u) * u * (a[0] + b[0]) / 2 + u * u * b[0];
    const y = (1 - u) ** 2 * a[1] + 2 * (1 - u) * u * ((a[1] + b[1]) / 2 + sag) + u * u * b[1];
    const lx = x + sway, ly = y + 12;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lx, ly - 6); ctx.stroke();
    ctx.fillStyle = 'rgba(255,220,140,0.3)'; ctx.beginPath(); ctx.arc(lx, ly, 12, 0, 7); ctx.fill();
    ctx.fillStyle = k % 2 ? '#d4532a' : '#e6b24a'; ctx.beginPath(); ctx.ellipse(lx, ly, 5, 7, 0, 0, 7); ctx.fill();
  }
}

// ---------- fog ----------
function fogPuff(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  const [cx, cy] = iso(x, y), h = hash(x + 5, y + 9);
  const drift = Math.sin(t * 0.25 + h * 6) * 4;
  const cols = ['rgba(188,206,226,0.96)', 'rgba(214,226,238,0.96)', 'rgba(236,242,248,0.96)'];
  cols.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.ellipse(cx + drift + (h - 0.5) * 10, cy - 6 - i * 5, 44 - i * 10, 26 - i * 6, 0, 0, 7); ctx.fill();
  });
}

// ---------- entities ----------
type Drawable = { depth: number; draw: () => void };

function hpBar(ctx: CanvasRenderingContext2D, x: number, y: number, hp: number, max: number, color: string): void {
  ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x - 20, y, 40, 6);
  ctx.fillStyle = color; ctx.fillRect(x - 19, y + 1, 38 * Math.max(0, hp / max), 4);
}

export function npcLook(id: NpcId): Look { return NPCS[id].look; }

/** Screen position (feet) of everything clickable, for hit testing in main.ts. */
export type Hit = { kind: 'npc'; id: NpcId } | { kind: 'unit'; id: string };
export type HitBox = { hit: Hit; x: number; y: number; h: number; depth: number };

export function render(ctx: CanvasRenderingContext2D, v: View, width: number, height: number, hits: HitBox[]): { camX: number; camY: number } {
  const w = v.w, t = v.t, m = monsoonAt(w.tick), wind = MONSOON_WIND[m], storm = m === 'NE' ? 1 : 0;
  const c = w.combat;
  hits.length = 0;
  // camera follows the player (or the current unit in a fight)
  const you = c ? c.units.find(u => u.id === 'you')! : null;
  const pRender = c ? unitPos(v, you!) : lerpV(v.playerFrom, w.player, v.alpha);
  const [camX, camY] = iso(pRender.x, pRender.y, elevAt(MAP, Math.round(pRender.x), Math.round(pRender.y)));
  ctx.save();
  ctx.fillStyle = storm ? '#2a5068' : '#2f6f93';
  ctx.fillRect(0, 0, width, height);
  ctx.translate(width / 2, height / 2 + 40 * v.zoom);
  ctx.scale(v.zoom, v.zoom);
  ctx.translate(-camX, -camY);

  // visible tile range
  const halfW = width / 2 / v.zoom + TW, halfH = height / 2 / v.zoom + TH * 4;
  const visible = (x: number, y: number) => { const [sx, sy] = iso(x, y); return Math.abs(sx - camX) < halfW && sy - camY > -halfH - 60 && sy - camY < halfH + 60; };

  for (let s = 0; s < MAP.w + MAP.h; s++) for (let x = 0; x <= s; x++) {
    const y = s - x; if (x >= MAP.w || y >= MAP.h || !visible(x, y)) continue;
    drawGround(ctx, v, x, y);
  }

  // combat floor overlays
  if (c) drawCombatFloor(ctx, v, c);

  // hover and click marks
  if (v.hover && !c) {
    const [hx, hy] = iso(v.hover.x, v.hover.y, elevAt(MAP, v.hover.x, v.hover.y));
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5; diamond(ctx, hx, hy, 0.92); ctx.stroke();
  }
  if (v.clickMark && t - v.clickMark.at < 0.6) {
    const k = (t - v.clickMark.at) / 0.6, [mx, my] = iso(v.clickMark.x, v.clickMark.y, elevAt(MAP, v.clickMark.x, v.clickMark.y));
    ctx.strokeStyle = v.clickMark.ok ? `rgba(255,224,74,${1 - k})` : `rgba(255,80,60,${1 - k})`; ctx.lineWidth = 3;
    const r = 8 + k * 4; ctx.beginPath(); ctx.moveTo(mx - r, my - r / 2); ctx.lineTo(mx + r, my + r / 2); ctx.moveTo(mx + r, my - r / 2); ctx.lineTo(mx - r, my + r / 2); ctx.stroke();
  }

  // objects and people, back to front
  const list: Drawable[] = [];
  for (let y = 0; y < MAP.h; y++) for (let x = 0; x < MAP.w; x++) {
    if (!visible(x, y)) continue;
    const k = kindAt(MAP, x, y), e = elevAt(MAP, x, y), [cx, cy] = iso(x, y, e), h = hash(x, y), d = x + y;
    switch (k) {
      case 'forest': list.push({ depth: d, draw: () => tree(ctx, cx, cy, h) }); break;
      case 'palm': list.push({ depth: d, draw: () => palm(ctx, cx, cy, t, h, wind, storm) }); break;
      case 'house': list.push({ depth: d, draw: () => house(ctx, cx, cy) }); break;
      case 'balai': list.push({ depth: d, draw: () => house(ctx, cx, cy, true) }); break;
      case 'stall': list.push({ depth: d, draw: () => stall(ctx, cx, cy, h) }); break;
      case 'gate': list.push({ depth: d, draw: () => gatePillar(ctx, cx, cy, x < 10 ? -1 : 1) }); break;
      case 'rock': list.push({ depth: d, draw: () => rock(ctx, cx, cy, false) }); break;
      case 'tooth': list.push({ depth: d, draw: () => rock(ctx, cx, cy, true) }); break;
      case 'tent': list.push({ depth: d, draw: () => tent(ctx, cx, cy) }); break;
      case 'fire': list.push({ depth: d, draw: () => campfire(ctx, cx, cy, t) }); break;
      case 'pod': list.push({ depth: d, draw: () => pod(ctx, cx, cy, t) }); break;
      case 'palace': if (x === 11 && y === 5) { const [px, py] = iso(9.5, 4.5, 1); list.push({ depth: d, draw: () => pendopo(ctx, px, py) }); } break;
      default: break;
    }
  }
  // ships follow the monsoon
  const [sx, sy] = iso(22.5, 30.5);
  list.push({ depth: 53, draw: () => ship(ctx, sx, sy, t, m === 'NE' ? 'junk' : 'gujarat', wind) });
  const [px2, py2] = iso(45, 23);
  list.push({ depth: 68, draw: () => ship(ctx, px2, py2, t, 'pirate', wind) });
  if (w.step >= 7) {
    const a = iso(11, 23), b = iso(18, 23);
    list.push({ depth: 34, draw: () => lanternString(ctx, [a[0], a[1] - 60], [b[0], b[1] - 60], t, wind) });
  }

  const S = PUP_S;
  const hop = w.step >= 7 ? Math.abs(Math.sin(t * 5)) * 4 : 0;
  // NPCs
  for (const id of Object.keys(NPCS) as NpcId[]) {
    if (!npcPresent(w, id)) continue;
    if (id === 'lawak' && (c || w.lawak.following)) continue;
    const p = NPCS[id].home, e = elevAt(MAP, p.x, p.y), [nx, ny] = iso(p.x, p.y, e);
    list.push({ depth: p.x + p.y + 0.5, draw: () => drawPuppet(ctx, NPCS[id].look, nx, ny - 4 - (id === 'kids' ? 0 : hop), S, NPCS[id].facing, t, { phase: p.x }) });
    hits.push({ hit: { kind: 'npc', id }, x: nx, y: ny, h: 80, depth: p.x + p.y });
  }
  if (!c) {
    // idle foes waiting at their spawn
    for (const e of w.enc) {
      if (!e.alive) continue;
      for (const f of ENCOUNTERS.find(s => s.id === e.id)!.foes) {
        const [fx, fy] = iso(f.at.x, f.at.y);
        list.push({ depth: f.at.x + f.at.y + 0.5, draw: () => drawPuppet(ctx, f.look, fx, fy - 4, S, -1, t, { phase: f.at.y }) });
      }
    }
    if (w.lawak.following) {
      const lp = lerpV(v.lawakFrom, w.lawak, v.alpha), [lx, ly] = iso(lp.x, lp.y);
      list.push({ depth: lp.x + lp.y + 0.45, draw: () => drawPuppet(ctx, 'clown', lx, ly - 4 - bob(v, lp), S, w.lawak.x >= w.player.x ? -1 : 1, t, { phase: 2 }) });
      hits.push({ hit: { kind: 'npc', id: 'lawak' }, x: lx, y: ly, h: 60, depth: lp.x + lp.y });
    }
    const [ex, ey] = iso(pRender.x, pRender.y, elevAt(MAP, Math.round(pRender.x), Math.round(pRender.y)));
    list.push({
      depth: pRender.x + pRender.y + 0.6, draw: () => {
        if (w.player.fishing && w.player.task?.t === 'fish') drawLine(ctx, ex, ey, w.player.task.spot, t, w.player.facing);
        drawPuppet(ctx, 'hero', ex, ey - 4 - bob(v, pRender), S, w.player.facing, t);
      }
    });
  } else {
    for (const u of c.units) {
      const up = unitPos(v, u), [ux, uy] = iso(up.x, up.y);
      list.push({ depth: up.x + up.y + 0.6, draw: () => drawUnit(ctx, v, c, u, ux, uy) });
      if (u.alive) hits.push({ hit: { kind: 'unit', id: u.id }, x: ux, y: uy, h: u.boss ? 100 : 80, depth: up.x + up.y });
    }
  }
  list.sort((a, b) => a.depth - b.depth);
  for (const d of list) d.draw();

  // fog of the unknown
  for (let s = 0; s < MAP.w + MAP.h; s++) for (let x = 0; x <= s; x++) {
    const y = s - x; if (x >= MAP.w || y >= MAP.h || !visible(x, y)) continue;
    if (!isExplored(w, x, y)) fogPuff(ctx, x, y, t);
  }

  // quest marker: a bobbing gold diamond over wherever the story wants you to go
  const qt = !c ? questTarget(w) : null;
  if (qt) {
    const [qx, qy] = iso(qt.x, qt.y, elevAt(MAP, qt.x, qt.y)), b = Math.sin(t * 3) * 5;
    const near = Math.hypot(qt.x - pRender.x, qt.y - pRender.y) < 1.6;
    if (!near) {
      ctx.fillStyle = '#ffd24a'; ctx.strokeStyle = '#5a1420'; ctx.lineWidth = 2;
      poly(ctx, [[qx, qy - 118 + b], [qx + 9, qy - 104 + b], [qx, qy - 90 + b], [qx - 9, qy - 104 + b]]); ctx.fill(); ctx.stroke();
    }
  }
  for (const s2 of v.shots) {
    const age = (t - s2.born) / 0.35; if (age < 0 || age > 1) continue;
    const [ax, ay] = iso(s2.from.x, s2.from.y), [bx, by] = iso(s2.to.x, s2.to.y);
    const x = ax + (bx - ax) * age, y = ay + (by - ay) * age - 40 - Math.sin(age * Math.PI) * 60;
    const g = ctx.createRadialGradient(x, y, 1, x, y, 16); g.addColorStop(0, '#fff8e0'); g.addColorStop(0.4, s2.color); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 16, 0, 7); ctx.fill();
  }
  // floating numbers
  for (const f of v.floaters) {
    const age = t - f.born; if (age > 1.6) continue;
    const [fx, fy] = iso(f.x, f.y);
    ctx.font = `800 ${f.big ? 22 : 15}px "IBM Plex Sans", system-ui, sans-serif`; ctx.textAlign = 'center';
    ctx.globalAlpha = Math.max(0, 1 - age / 1.6);
    const ty = fy - 90 - (f.dy ?? 0) - age * 30;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeText(f.text, fx, ty);
    ctx.fillStyle = f.color; ctx.fillText(f.text, fx, ty);
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // weather in screen space
  if (storm) { ctx.fillStyle = 'rgba(25,40,70,0.16)'; ctx.fillRect(0, 0, width, height); drawRain(ctx, t, width, height, wind); }
  drawWind(ctx, t, width, height, wind);
  // festival warmth
  if (w.step >= 7) { const g = ctx.createRadialGradient(width / 2, height / 2, 50, width / 2, height / 2, Math.max(width, height) * 0.8); g.addColorStop(0, 'rgba(255,190,90,0)'); g.addColorStop(1, 'rgba(255,150,60,0.18)'); ctx.fillStyle = g; ctx.fillRect(0, 0, width, height); }
  return { camX, camY };
}

function bob(v: View, p: Vec): number {
  const moving = Math.abs(p.x - Math.round(p.x)) + Math.abs(p.y - Math.round(p.y)) > 0.05;
  return moving ? Math.abs(Math.sin(v.t * 14)) * 3 : 0;
}

function drawLine(ctx: CanvasRenderingContext2D, x: number, y: number, spot: number, t: number, f: 1 | -1): void {
  void spot;
  const tipX = x + f * 40, tipY = y - 66, bx = x + f * 54, by = y + 6 + Math.sin(t * 2.6) * 1.5;
  ctx.strokeStyle = '#3a2614'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + f * 6, y - 30); ctx.lineTo(tipX, tipY); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(tipX, tipY); ctx.quadraticCurveTo(bx - f * 4, y - 30, bx, by); ctx.stroke();
  ctx.fillStyle = '#e8432f'; ctx.beginPath(); ctx.arc(bx, by, 3, 0, 7); ctx.fill();
}

const STEP_SECS = 0.16;
function unitPos(v: View, u: Unit): Vec {
  const a = v.unitAnims.get(u.id);
  if (!a || !a.path.length) return { x: u.x, y: u.y };
  const k = Math.max(0, Math.min(1, (v.t - a.start) / (STEP_SECS * a.path.length)));
  return alongPath(a.from, a.path, k);
}

function drawUnit(ctx: CanvasRenderingContext2D, v: View, c: CombatState, u: Unit, x: number, y: number): void {
  const t = v.t, cur = current(c).id === u.id;
  ctx.strokeStyle = EL_COLOR[u.el]; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(x, y, 24, 11, 0, 0, 7); ctx.stroke();
  if (cur && c.phase === 'fight') { ctx.fillStyle = 'rgba(255,224,120,0.18)'; ctx.fill(); }
  if (!u.alive) {
    ctx.save(); ctx.globalAlpha = 0.35; ctx.translate(x, y); ctx.scale(1, 0.4); drawPuppet(ctx, u.look, 0, 0, PUP_S, u.facing, t, { still: true }); ctx.restore();
    return;
  }
  const hoverT = v.combatUi.hoverUnit === u.id;
  drawPuppet(ctx, u.look, x, y - 4, PUP_S * (u.boss ? 1.1 : 1), u.facing, t, { phase: u.x, flash: v.flashes.get(u.id) ?? (hoverT ? 0.25 : 0) });
  const top = y - (u.boss ? 104 : 86);
  hpBar(ctx, x, top, u.hp, u.maxHp, u.side === 'hero' ? '#5fd18b' : '#ef6a5a');
  if (u.boss) { ctx.font = '700 12px "IBM Plex Sans", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.strokeText(u.name, x, top - 6); ctx.fillStyle = '#ffd0c8'; ctx.fillText(u.name, x, top - 6); }
  if (cur && c.phase === 'fight') {
    ctx.fillStyle = '#ffe08a'; const b = Math.sin(t * 6) * 3;
    poly(ctx, [[x - 7, top - 22 + b], [x + 7, top - 22 + b], [x, top - 12 + b]]); ctx.fill();
  }
  if (c.windup && c.windup.unit === u.id) {
    ctx.font = '900 26px "IBM Plex Sans", system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText('!', x + 26, top + 4); ctx.fillStyle = '#ff5a3a'; ctx.fillText('!', x + 26, top + 4);
  }
  // timing ring
  const ring = v.combatUi.ring;
  if (ring && ring.unit === u.id) {
    const k = Math.min(1, (t - ring.start) / ring.dur);
    const r = 70 - 52 * k;
    ctx.strokeStyle = ring.kind === 'attack' ? 'rgba(255,224,120,0.95)' : 'rgba(140,220,255,0.95)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(x, y - 40, r, r * 0.8, 0, 0, 7); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(x, y - 40, 18, 14.4, 0, 0, 7); ctx.stroke();
  }
}

function drawCombatFloor(ctx: CanvasRenderingContext2D, v: View, c: CombatState): void {
  const w = v.w, wind = MONSOON_WIND[monsoonAt(w.tick)];
  const me = current(c);
  const reach = me.ctrl === 'player' && c.phase === 'fight' && !v.combatUi.ability ? reachable(c, me) : new Map<string, Vec[]>();
  const ab = me.ctrl === 'player' ? v.combatUi.ability : null;
  for (let y = 0; y < MAP.h; y++) for (let x = 0; x < MAP.w; x++) {
    const inside = inBox(c.box, { x, y });
    const e = elevAt(MAP, x, y), [cx, cy] = iso(x, y, e);
    if (!inside) { ctx.fillStyle = 'rgba(10,8,20,0.35)'; diamond(ctx, cx, cy); ctx.fill(); continue; }
    if (kindAt(MAP, x, y) !== 'sand' && kindAt(MAP, x, y) !== 'grass' && kindAt(MAP, x, y) !== 'scorch') continue;
    // songket grid on the battlefield
    ctx.strokeStyle = 'rgba(230,178,74,0.55)'; ctx.lineWidth = 1.2; diamond(ctx, cx, cy, 0.55); ctx.stroke();
    ctx.strokeStyle = 'rgba(120,40,30,0.25)'; ctx.lineWidth = 1; diamond(ctx, cx, cy); ctx.stroke();
    if (reach.has(`${x},${y}`)) { ctx.fillStyle = 'rgba(70,140,255,0.32)'; diamond(ctx, cx, cy, 0.94); ctx.fill(); }
    if (ab) {
      const a = ABILITIES[ab];
      const d = Math.abs(x - me.x) + Math.abs(y - me.y);
      const max = a.ranged ? maxRange(ab, me, { x, y }, wind) : a.max;
      const lineOk = !a.line || x === me.x || y === me.y;
      if (!a.self && d >= a.min && d <= max && lineOk) { ctx.fillStyle = 'rgba(235,90,60,0.22)'; diamond(ctx, cx, cy, 0.94); ctx.fill(); }
    }
  }
  if (ab) {
    for (const u of c.units) {
      if (!u.alive || !canUse(c, me, ab, u, { wind, hasJamu: count(w, 'jamu') > 0 })) continue;
      const [ux, uy] = iso(u.x, u.y);
      ctx.strokeStyle = `rgba(255,224,120,${0.6 + 0.4 * Math.sin(v.t * 8)})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(ux, uy, 30, 14, 0, 0, 7); ctx.stroke();
    }
  }
  if (c.windup) {
    const a = c.units.find(u => u.id === c.windup!.unit), b = c.units.find(u => u.id === c.windup!.target);
    if (a && b) {
      const [ax, ay] = iso(a.x, a.y), [bx, by] = iso(b.x, b.y);
      ctx.strokeStyle = 'rgba(255,90,60,0.8)'; ctx.setLineDash([6, 6]); ctx.lineDashOffset = -v.t * 30; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(ax, ay - 30); ctx.quadraticCurveTo((ax + bx) / 2, Math.min(ay, by) - 70, bx, by - 30); ctx.stroke(); ctx.setLineDash([]);
    }
  }
}

function drawRain(ctx: CanvasRenderingContext2D, t: number, w: number, h: number, wind: Vec): void {
  const dx = (wind.x - wind.y) * 60, dy = 520;
  ctx.strokeStyle = 'rgba(210,225,255,0.35)'; ctx.lineWidth = 1.2; ctx.beginPath();
  for (let i = 0; i < 160; i++) {
    const a = hash(i, 1), b = hash(i, 2), s = 0.6 + hash(i, 3) * 0.6;
    const x = ((a * w + t * dx * s) % w + w) % w, y = ((b * h + t * dy * s) % h + h) % h;
    ctx.moveTo(x, y); ctx.lineTo(x + dx * 0.035, y + dy * 0.035);
  }
  ctx.stroke();
}
function drawWind(ctx: CanvasRenderingContext2D, t: number, w: number, h: number, wind: Vec): void {
  const sx = (wind.x - wind.y), sy = (wind.x + wind.y) * 0.5, m = Math.hypot(sx, sy) || 1, ux = sx / m, uy = sy / m;
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1.4; ctx.beginPath();
  for (let i = 0; i < 40; i++) {
    const a = hash(i, 7), b = hash(i, 8), s = 0.5 + hash(i, 9);
    const x = ((a * w + t * ux * 120 * s) % w + w) % w, y = ((b * h + t * uy * 120 * s) % h + h) % h;
    ctx.moveTo(x, y); ctx.lineTo(x - ux * 22, y - uy * 22);
  }
  ctx.stroke();
}

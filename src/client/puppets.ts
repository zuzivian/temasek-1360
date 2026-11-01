// Painted wayang kulit puppets, drawn as flat cut-leather figures. Coordinates are in puppet
// units: feet at (0, 0), head near y = -260, facing right when f = 1.
import type { Look } from '../sim/content.ts';

type Pt = [number, number];
type Role = 'body' | 'cloth' | 'skin' | 'face' | 'gold' | 'hair' | 'cap';
type Part = [Role, Pt[]];
type Geo = { parts: Part[]; back: [Role, Pt[], number]; front: [Role, Pt[], number][]; holes: [number, number, number][]; eye: Pt; height: number };

const SATRIA = (a: number): Geo => ({
  parts: [
    ['body', [[-30, 0], [40, 0], [30, -8], [-24, -8]]],
    ['cloth', [[-28, -8], [36, -8], [22, -60], [30, -95], [-6, -112], [-22, -80], [-16, -50]]],
    ['skin', [[-10, -110], [14, -110], [18, -150], [10, -186], [-6, -186], [-14, -150]]],
    ['face', [[-6, -186], [-9, -206], [-6, -224], [4, -230], [12, -222], [18, -212], [30, -204], [16, -200], [12, -195], [4, -188]]],
    ['gold', [[-8, -224], [8, -230], [12, -248], [2, -264], [-6, -252], [-14, -240]]],
    ['gold', [[-12, -236], [-36, -226], [-46, -204], [-30, -212], [-16, -222]]]
  ],
  back: ['skin', [[-4, -176], [-22, -128], [-12, -86]], 7],
  front: [['skin', [[8, -178], [32, -132], [58, -150 + a]], 7]],
  holes: [[-4, -30, 2.4], [8, -30, 2.4], [20, -30, 2.4], [-10, -50, 2], [4, -50, 2], [16, -50, 2], [0, -72, 2.2], [12, -72, 2.2], [-2, -244, 2], [4, -254, 1.6]],
  eye: [16, -212], height: 264
});
const PUTRI = (a: number): Geo => ({
  parts: [
    ['body', [[-24, 0], [30, 0], [24, -6], [-20, -6]]],
    ['cloth', [[-22, -6], [28, -6], [20, -70], [16, -112], [-8, -114], [-14, -70]]],
    ['skin', [[-8, -112], [12, -112], [14, -150], [8, -182], [-6, -182], [-12, -150]]],
    ['face', [[-6, -182], [-8, -200], [-4, -216], [6, -220], [12, -212], [16, -204], [24, -198], [14, -194], [10, -190], [4, -184]]],
    ['hair', [[-8, -212], [6, -224], [-4, -232], [-26, -226], [-32, -210], [-22, -200]]],
    ['gold', [[-2, -220], [10, -222], [6, -230], [-4, -228]]]
  ],
  back: ['skin', [[-2, -172], [-16, -130], [-6, -96]], 6],
  front: [['skin', [[6, -172], [24, -132], [40, -142 + a * 0.5]], 6]],
  holes: [[-6, -24, 2], [6, -24, 2], [16, -24, 2], [0, -44, 2], [12, -44, 2], [4, -64, 2], [-26, -214, 1.8]],
  eye: [12, -206], height: 232
});
const BUTA = (a: number): Geo => ({
  parts: [
    ['body', [[-40, 0], [50, 0], [40, -10], [-34, -10]]],
    ['cloth', [[-40, -10], [50, -10], [40, -70], [46, -100], [-30, -110], [-44, -70]]],
    ['skin', [[-30, -108], [44, -100], [58, -150], [42, -200], [-10, -210], [-36, -160]]],
    ['face', [[-10, -205], [40, -200], [58, -214], [72, -230], [60, -246], [48, -262], [10, -272], [-14, -258], [-22, -230]]],
    ['gold', [[-14, -258], [-8, -292], [6, -270], [18, -304], [28, -272], [40, -298], [48, -262]]]
  ],
  back: ['skin', [[-6, -190], [-30, -140], [-18, -100]], 11],
  front: [['skin', [[30, -190], [72, -140], [92, -172 + a]], 12], ['body', [[92, -172 + a], [118, -250 + a]], 9]],
  holes: [[-20, -40, 3], [0, -40, 3], [20, -40, 3], [-10, -62, 2.6], [10, -62, 2.6], [30, -62, 2.6], [8, -150, 3], [24, -170, 2.4], [6, -278, 2], [28, -280, 2]],
  eye: [40, -238], height: 300
});
const CLOWN = (a: number): Geo => ({
  parts: [
    ['body', [[-26, 0], [30, 0], [24, -8], [-20, -8]]],
    ['skin', [[-24, -8], [30, -8], [44, -40], [40, -80], [20, -104], [-10, -106], [-30, -80], [-34, -40]]],
    ['cloth', [[-24, -8], [30, -8], [42, -36], [-32, -36]]],
    ['face', [[-12, -104], [18, -104], [30, -118], [26, -140], [10, -150], [-8, -146], [-18, -130]]],
    ['gold', [[-8, -146], [-2, -164], [4, -150]]]
  ],
  back: ['skin', [[-6, -94], [-20, -60], [-8, -40]], 8],
  front: [['skin', [[14, -94], [36, -70], [50, -86 + a]], 8]],
  holes: [[-16, -20, 2.2], [-4, -20, 2.2], [8, -20, 2.2], [20, -20, 2.2], [-10, -30, 2.2], [2, -30, 2.2], [14, -30, 2.2], [26, -30, 2.2]],
  eye: [18, -128], height: 164
});

type Pal = Record<Role, string> & { line: string; dots: string };
const P = (o: Partial<Pal>): Pal => ({ body: '#5c3018', cloth: '#a3302a', skin: '#d29a3c', face: '#c48a28', gold: '#f0c75a', hair: '#1d1410', cap: '#3a2a1a', line: '#2a1208', dots: '#f6dc8a', ...o });

const LOOKS: Record<Look, { geo: (a: number) => Geo; pal: Pal; scale: number; extra?: 'spear' | 'bow' | 'bill' | 'beard' | 'turban' | 'cap' | 'blangkon' | 'top' | 'band' | 'glow' }> = {
  hero: { geo: SATRIA, pal: P({ cloth: '#1f4f78', skin: '#cfa46a', face: '#c3935a', gold: '#8ff0e2', dots: '#8ff0e2', body: '#14324c' }), scale: 1, extra: 'glow' },
  clown: { geo: CLOWN, pal: P({ body: '#3a2414', cloth: '#1d1d1d', skin: '#e2cfa6', face: '#efe1c0', gold: '#1d1d1d', dots: '#f4f0e6' }), scale: 1.15 },
  putri: { geo: PUTRI, pal: P({ cloth: '#6b3a1e', skin: '#d6a35a', face: '#c99550', dots: '#f0d48a' }), scale: 1 },
  elder: { geo: SATRIA, pal: P({ cloth: '#5a4a2a', skin: '#c9955a', face: '#bd8a50', gold: '#efe7d2', dots: '#efe7d2' }), scale: 1, extra: 'beard' },
  guard: { geo: SATRIA, pal: P({ cloth: '#8a1f1f', skin: '#c08a48', face: '#b07a3a' }), scale: 1.05, extra: 'spear' },
  dalang: { geo: SATRIA, pal: P({ cloth: '#20202a', skin: '#c7924e', face: '#b9844a', gold: '#7a4a22', dots: '#d9b25a' }), scale: 1, extra: 'blangkon' },
  trader: { geo: SATRIA, pal: P({ cloth: '#284a7a', skin: '#e0b884', face: '#d6aa74', gold: '#1a1a24', dots: '#e6d2a0' }), scale: 1, extra: 'cap' },
  gujarati: { geo: SATRIA, pal: P({ cloth: '#e8dcc0', skin: '#b07a46', face: '#a5703e', gold: '#d98a1a', dots: '#d98a1a', body: '#7a5a2a' }), scale: 1, extra: 'turban' },
  child: { geo: CLOWN, pal: P({ body: '#5a3a1a', cloth: '#2f6a3a', skin: '#d29a5a', face: '#d8a868', gold: '#2a1a0e', dots: '#f0d48a' }), scale: 0.75, extra: 'top' },
  pirate: { geo: BUTA, pal: P({ body: '#2a1a12', cloth: '#3a2a22', skin: '#9a4a2a', face: '#a8502e', gold: '#c0392b', dots: '#e6a04a' }), scale: 0.8, extra: 'band' },
  archer: { geo: BUTA, pal: P({ body: '#2a1a12', cloth: '#4a2a1a', skin: '#9a5a2a', face: '#a8602e', gold: '#c0392b', dots: '#e6a04a' }), scale: 0.78, extra: 'bow' },
  todak: { geo: BUTA, pal: P({ body: '#1e2630', cloth: '#2a3f5a', skin: '#5a6f86', face: '#6f87a0', gold: '#d0d8e0', dots: '#e8eef4' }), scale: 1.12, extra: 'bill' }
};

export const lookHeight = (look: Look): number => LOOKS[look].geo(0).height * LOOKS[look].scale;

export type PuppetOpts = { phase?: number; still?: boolean; alpha?: number; flash?: number };

/** Draw a painted puppet with its feet at (x, y). `s` is screen pixels per puppet unit. */
export function drawPuppet(ctx: CanvasRenderingContext2D, look: Look, x: number, y: number, s: number, f: 1 | -1, t: number, o: PuppetOpts = {}): void {
  const L = LOOKS[look];
  s *= L.scale;
  const a = o.still ? 0 : Math.sin(t * 1.4 + (o.phase ?? 0)) * 6;
  const g = L.geo(a), pal = L.pal;
  const X = (px: number) => x + px * s * f, Y = (py: number) => y + py * s;
  ctx.save();
  if (o.alpha !== undefined) ctx.globalAlpha = o.alpha;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // the central rod that holds every wayang puppet
  ctx.strokeStyle = '#2a1a0e'; ctx.lineWidth = Math.max(1.5, 5 * s);
  ctx.beginPath(); ctx.moveTo(x, y - 4 * s); ctx.lineTo(x, y + 30 * s); ctx.stroke();
  if (L.extra === 'glow') {
    const gr = ctx.createRadialGradient(x, y - 130 * s, 10 * s, x, y - 130 * s, 170 * s);
    gr.addColorStop(0, 'rgba(120,240,220,0.22)'); gr.addColorStop(1, 'rgba(120,240,220,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y - 130 * s, 170 * s, 0, 7); ctx.fill();
  }
  if (L.extra === 'spear') { ctx.strokeStyle = '#5a3a1a'; ctx.lineWidth = 4 * s; ctx.beginPath(); ctx.moveTo(X(70), Y(20)); ctx.lineTo(X(70), Y(-320)); ctx.stroke(); ctx.fillStyle = '#c9ccd2'; ctx.beginPath(); ctx.moveTo(X(62), Y(-318)); ctx.lineTo(X(70), Y(-352)); ctx.lineTo(X(78), Y(-318)); ctx.fill(); }
  const limb = (role: Role, pts: Pt[], w: number) => {
    ctx.strokeStyle = pal[role]; ctx.lineWidth = w * s; ctx.beginPath();
    pts.forEach(([px, py], k) => (k ? ctx.lineTo(X(px), Y(py)) : ctx.moveTo(X(px), Y(py)))); ctx.stroke();
  };
  limb(...g.back);
  for (const [role, pts] of g.parts) {
    ctx.beginPath(); pts.forEach(([px, py], k) => (k ? ctx.lineTo(X(px), Y(py)) : ctx.moveTo(X(px), Y(py)))); ctx.closePath();
    ctx.fillStyle = pal[role]; ctx.fill();
    ctx.strokeStyle = pal.line; ctx.lineWidth = Math.max(0.8, 2.4 * s); ctx.stroke();
  }
  for (const fr of g.front) limb(...fr);
  ctx.fillStyle = pal.dots;
  for (const [px, py, r] of g.holes) { ctx.beginPath(); ctx.arc(X(px), Y(py), Math.max(0.6, r * s), 0, 7); ctx.fill(); }
  ctx.fillStyle = look === 'todak' ? '#ff5a3a' : pal.line;
  ctx.beginPath(); ctx.arc(X(g.eye[0]), Y(g.eye[1]), Math.max(0.9, (g.height > 280 ? 5 : 2.4) * s), 0, 7); ctx.fill();
  // accessories
  ctx.lineWidth = Math.max(0.8, 2.2 * s); ctx.strokeStyle = pal.line;
  switch (L.extra) {
    case 'beard': ctx.fillStyle = '#efe7d2'; ctx.beginPath(); ctx.moveTo(X(8), Y(-196)); ctx.lineTo(X(20), Y(-168)); ctx.lineTo(X(2), Y(-178)); ctx.closePath(); ctx.fill(); ctx.stroke(); break;
    case 'blangkon': ctx.fillStyle = '#7a4a22'; ctx.beginPath(); ctx.ellipse(X(0), Y(-226), 18 * s, 12 * s, 0, 0, 7); ctx.fill(); ctx.stroke(); break;
    case 'cap': ctx.fillStyle = '#1a1a24'; ctx.beginPath(); ctx.ellipse(X(2), Y(-228), 16 * s, 8 * s, 0, Math.PI, 0); ctx.fill(); ctx.stroke(); break;
    case 'turban': ctx.fillStyle = '#d98a1a'; ctx.beginPath(); ctx.ellipse(X(-2), Y(-232), 22 * s, 15 * s, 0, 0, 7); ctx.fill(); ctx.stroke(); break;
    case 'band': ctx.strokeStyle = '#e0402a'; ctx.lineWidth = 7 * s; ctx.beginPath(); ctx.moveTo(X(-18), Y(-250)); ctx.lineTo(X(52), Y(-246)); ctx.stroke(); break;
    case 'bow': ctx.strokeStyle = '#6a4a22'; ctx.lineWidth = 4 * s; ctx.beginPath(); ctx.arc(X(100), Y(-200), 70 * s, f > 0 ? -1.2 : Math.PI - 1.9, f > 0 ? 1.9 : Math.PI + 1.2); ctx.stroke(); break;
    case 'bill': ctx.fillStyle = '#d0d8e0'; ctx.beginPath(); ctx.moveTo(X(64), Y(-236)); ctx.lineTo(X(150), Y(-232)); ctx.lineTo(X(66), Y(-224)); ctx.closePath(); ctx.fill(); ctx.stroke(); break;
    case 'top': { const sp = t * 18; ctx.fillStyle = '#c0392b'; ctx.beginPath(); ctx.ellipse(X(60), Y(-6), 14 * s, 9 * s, 0, 0, 7); ctx.fill(); ctx.strokeStyle = '#f0c75a'; ctx.beginPath(); ctx.moveTo(X(60) + Math.cos(sp) * 12 * s, Y(-6)); ctx.lineTo(X(60) - Math.cos(sp) * 12 * s, Y(-6)); ctx.stroke(); break; }
  }
  if (o.flash) {
    ctx.globalCompositeOperation = 'lighter';
    const gr = ctx.createRadialGradient(x, y - 140 * s, 5 * s, x, y - 140 * s, 150 * s);
    gr.addColorStop(0, `rgba(255,240,220,${o.flash})`); gr.addColorStop(1, 'rgba(255,240,220,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y - 140 * s, 150 * s, 0, 7); ctx.fill();
  }
  ctx.restore();
}

/** Small face portrait for dialogue boxes and the turn order bar. */
export function drawPortrait(ctx: CanvasRenderingContext2D, look: Look, size: number, t: number): void {
  ctx.clearRect(0, 0, size, size);
  const L = LOOKS[look], g = L.geo(0);
  // frame on the eye: head spans about 80 units on most puppets, more on the big ogres
  const span = L.geo === BUTA ? 120 : L.geo === CLOWN ? 70 : 80;
  const k = size * 0.62 / span;
  drawPuppet(ctx, look, size * 0.5 - g.eye[0] * k + 4, size * 0.48 - g.eye[1] * k, k / L.scale, 1, t, { still: true });
}

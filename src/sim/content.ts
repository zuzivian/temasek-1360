// Act 1 content: items, people, encounters, quest steps and dialogue.
// Lines are short on purpose: the player should be playing, not reading.
import type { Element, Vec } from './core.ts';

// ---------- items ----------
export type FishId = 'udang' | 'kembung' | 'selar' | 'kerapu';
export type ItemId = FishId | 'jamu' | 'gong';
export type GearId = 'joran' | 'kail' | 'kain';

export type ItemInfo = { name: string; en: string; stack: boolean; price: number };
export const ITEMS: Record<ItemId, ItemInfo> = {
  udang: { name: 'Udang', en: 'prawn', stack: false, price: 3 },
  kembung: { name: 'Ikan kembung', en: 'mackerel', stack: false, price: 4 },
  selar: { name: 'Ikan selar', en: 'scad', stack: false, price: 6 },
  kerapu: { name: 'Ikan kerapu', en: 'grouper', stack: false, price: 15 },
  jamu: { name: 'Jamu', en: 'herbal tonic, heals 18', stack: true, price: 8 },
  gong: { name: 'Gong pesta', en: 'the festival gong', stack: false, price: 0 }
};
export const FISH: Record<FishId, { level: number; xp: number }> = {
  udang: { level: 1, xp: 14 },
  kembung: { level: 1, xp: 20 },
  selar: { level: 5, xp: 32 },
  kerapu: { level: 10, xp: 70 }
};
export const GEAR: Record<GearId, { name: string; en: string; price: number; seller: NpcId | null }> = {
  joran: { name: 'Joran buluh', en: 'bamboo fishing rod', price: 0, seller: null },
  kail: { name: 'Kail tembaga', en: 'copper hook: bites come faster', price: 40, seller: 'lim' },
  kain: { name: 'Kain Gujarat', en: 'Gujarat cotton vest: +10 max health', price: 60, seller: 'ratan' }
};

export const INV_SLOTS = 20;

// ---------- monsoon ----------
export type Monsoon = 'NE' | 'SW';
/** Real minutes are short here so a 15-minute session sees the wind turn. */
export const MONSOON_TICKS = 500;
export const MONSOON_NAME: Record<Monsoon, string> = { NE: 'Angin Timur Laut', SW: 'Angin Barat Daya' };
/** Direction the wind blows toward, in map space (x east, y south). */
export const MONSOON_WIND: Record<Monsoon, Vec> = { NE: { x: -0.7071, y: 0.7071 }, SW: { x: 0.7071, y: -0.7071 } };

// ---------- fishing spots ----------
export type SpotInfo = { at: Vec; name: string; table: (m: Monsoon) => [FishId, number][] };
export const SPOTS: SpotInfo[] = [
  { at: { x: 5, y: 30 }, name: 'Pod shallows', table: m => (m === 'NE' ? [['kembung', 3], ['selar', 1]] : [['kembung', 1], ['selar', 3]]) },
  { at: { x: 12, y: 29 }, name: 'Beach shallows', table: m => (m === 'NE' ? [['kembung', 3], ['selar', 1]] : [['kembung', 1], ['selar', 3]]) },
  { at: { x: 20, y: 27 }, name: 'River mouth', table: () => [['udang', 3], ['kembung', 1]] },
  { at: { x: 26, y: 29 }, name: 'East beach', table: m => (m === 'NE' ? [['kembung', 2], ['selar', 2]] : [['selar', 3], ['kembung', 1]]) },
  { at: { x: 43, y: 21 }, name: "Dragon's Tooth reef", table: () => [['kerapu', 2], ['selar', 1]] }
];

// ---------- people ----------
export type NpcId = 'lawak' | 'rahmah' | 'penghulu' | 'hulubalang' | 'dalang' | 'lim' | 'ratan' | 'kids';
export type Look = 'hero' | 'clown' | 'putri' | 'elder' | 'guard' | 'dalang' | 'trader' | 'gujarati' | 'child' | 'pirate' | 'archer' | 'todak';
export type NpcInfo = { name: string; title: string; look: Look; home: Vec; facing: 1 | -1; monsoon?: Monsoon; shop?: 'rahmah' | 'lim' | 'ratan' };
export const NPCS: Record<NpcId, NpcInfo> = {
  lawak: { name: 'Pak Lawak', title: 'a clown who found you', look: 'clown', home: { x: 10, y: 28 }, facing: -1 },
  rahmah: { name: 'Mak Cik Rahmah', title: 'fish seller', look: 'putri', home: { x: 17, y: 24 }, facing: 1, shop: 'rahmah' },
  penghulu: { name: 'Tok Penghulu', title: 'village headman', look: 'elder', home: { x: 14, y: 26 }, facing: 1 },
  hulubalang: { name: 'Hulubalang', title: 'guard of the forbidden hill', look: 'guard', home: { x: 10, y: 10 }, facing: 1 },
  dalang: { name: 'Dalang Wiru', title: 'puppet master from Java', look: 'dalang', home: { x: 12, y: 24 }, facing: 1 },
  lim: { name: 'Lim', title: 'junk trader from Quanzhou', look: 'trader', home: { x: 17, y: 26 }, facing: 1, monsoon: 'NE', shop: 'lim' },
  ratan: { name: 'Ratan', title: 'cloth trader from Gujarat', look: 'gujarati', home: { x: 17, y: 26 }, facing: 1, monsoon: 'SW', shop: 'ratan' },
  kids: { name: 'Budak gasing', title: 'top-spinning kids', look: 'child', home: { x: 11, y: 20 }, facing: 1 }
};

/** What each shop pays per fish, as a multiple of the base price. Traders pay more but the harbour takes 10%. */
export const SHOPS: Record<'rahmah' | 'lim' | 'ratan', { buys: Partial<Record<FishId, number>>; tax: number; sells: (ItemId | GearId)[] }> = {
  rahmah: { buys: { udang: 1, kembung: 1, selar: 1, kerapu: 1 }, tax: 0, sells: ['jamu'] },
  lim: { buys: { kembung: 1.75, kerapu: 1.3 }, tax: 0.1, sells: ['kail'] },
  ratan: { buys: { selar: 1.75, kerapu: 1.3 }, tax: 0.1, sells: ['kain'] }
};

// ---------- combat ----------
export type AbilityId = 'tendang' | 'ombak' | 'jamu' | 'bayang' | 'cabai' | 'obor' | 'panah' | 'tikam' | 'sapu';
export type Ability = {
  name: string; en: string; ap: number; min: number; max: number; dmg: [number, number]; el: Element | null;
  ranged?: boolean; heal?: number; consumes?: ItemId; self?: boolean; aoeAdjacent?: boolean; line?: boolean; oncePerFight?: boolean;
};
export const ABILITIES: Record<AbilityId, Ability> = {
  tendang: { name: 'Tendang', en: 'silat kick', ap: 3, min: 1, max: 1, dmg: [6, 9], el: null },
  ombak: { name: 'Ombak', en: 'wave', ap: 4, min: 2, max: 4, dmg: [8, 12], el: 'Air', ranged: true },
  jamu: { name: 'Jamu', en: 'drink a tonic', ap: 2, min: 0, max: 0, dmg: [0, 0], el: null, heal: 18, consumes: 'jamu', self: true },
  bayang: { name: 'Bayang Todak', en: 'swordfish shadow', ap: 5, min: 1, max: 5, dmg: [14, 18], el: 'Besi', ranged: true, oncePerFight: true },
  cabai: { name: 'Cabai', en: 'chilli bomb', ap: 4, min: 1, max: 3, dmg: [5, 8], el: 'Api', ranged: true },
  obor: { name: 'Obor', en: 'torch swing', ap: 4, min: 1, max: 1, dmg: [5, 8], el: 'Api' },
  panah: { name: 'Panah api', en: 'fire arrow', ap: 4, min: 2, max: 4, dmg: [4, 6], el: 'Api', ranged: true },
  tikam: { name: 'Tikam Todak', en: 'swordfish lunge', ap: 5, min: 1, max: 3, dmg: [10, 14], el: 'Besi', line: true },
  sapu: { name: 'Sapu', en: 'tail sweep', ap: 4, min: 1, max: 1, dmg: [7, 9], el: 'Besi', aoeAdjacent: true }
};

export type FoeSpec = { name: string; look: Look; el: Element; hp: number; ap: number; mp: number; abilities: AbilityId[]; at: Vec; boss?: boolean };
export type EncounterSpec = { id: 'patrol' | 'todak'; center: Vec; trigger: number; requiresStep: number; repeat: boolean; respawnTicks: number; bark: string; foes: FoeSpec[] };
export const ENCOUNTERS: EncounterSpec[] = [
  {
    id: 'patrol', center: { x: 34, y: 21 }, trigger: 3, requiresStep: 4, repeat: true, respawnTicks: 120,
    bark: 'Oi! This beach belongs to Si Todak!',
    foes: [
      { name: 'Perompak', look: 'pirate', el: 'Api', hp: 22, ap: 4, mp: 3, abilities: ['obor'], at: { x: 36, y: 20 } },
      { name: 'Perompak', look: 'pirate', el: 'Api', hp: 22, ap: 4, mp: 3, abilities: ['obor'], at: { x: 36, y: 23 } }
    ]
  },
  {
    id: 'todak', center: { x: 38, y: 22 }, trigger: 2, requiresStep: 5, repeat: false, respawnTicks: 0,
    bark: 'A prawn and a clown? Take them!',
    foes: [
      { name: 'Si Todak', look: 'todak', el: 'Besi', hp: 72, ap: 5, mp: 3, abilities: ['tikam', 'sapu'], at: { x: 41, y: 22 }, boss: true },
      { name: 'Pemanah', look: 'archer', el: 'Api', hp: 18, ap: 4, mp: 2, abilities: ['panah'], at: { x: 41, y: 24 } }
    ]
  }
];

export const RESPAWN: Vec = { x: 9, y: 28 };
export const START: Vec = { x: 8, y: 29 };

// ---------- quest ----------
export type QuestStep = { id: string; goal: string };
export const QUEST: { title: string; steps: QuestStep[] } = {
  title: 'Babak I · Gong yang Hilang',
  steps: [
    { id: 'wake', goal: 'Talk to the man by the pod' },
    { id: 'fish', goal: 'Catch 3 fish in the bubbling shallows' },
    { id: 'sell', goal: 'Sell fish to Mak Cik Rahmah at the pasar' },
    { id: 'penghulu', goal: 'Ask Tok Penghulu at the balai what is wrong' },
    { id: 'cross', goal: 'Cross the bridge and chase the perompak east' },
    { id: 'todak', goal: "Take the gong back from Si Todak at Dragon's Tooth" },
    { id: 'return', goal: 'Bring the gong home to Tok Penghulu' },
    { id: 'done', goal: 'Babak I complete. Fish, trade, and watch the wind.' }
  ]
};

// ---------- dialogue ----------
export type DialogAct = { flag?: string; gear?: GearId; give?: [ItemId, number]; take?: ItemId; shop?: 'rahmah' | 'lim' | 'ratan'; heal?: boolean; unlock?: AbilityId };
export type DialogOption = { label: string; next?: string; act?: DialogAct };
export type DialogNode = { who: NpcId | 'you' | 'todak'; text: string; options?: DialogOption[]; next?: string; act?: DialogAct };

export const DIALOG: Record<string, DialogNode> = {
  // Pak Lawak
  'lawak.wake': { who: 'lawak', text: 'Aiyo! A giant udang crawled out of that glowing seed!', options: [{ label: "I'm not a prawn.", next: 'lawak.wake2' }, { label: 'Where am I?', next: 'lawak.where' }] },
  'lawak.where': { who: 'lawak', text: 'Temasek! Best river mouth in the whole strait. Ask anyone. Ask me. I said it.', next: 'lawak.wake2' },
  'lawak.wake2': { who: 'lawak', text: "A talking udang. Even better. I'm Pak Lawak. Nobody laughs at my jokes, so I'm keeping you.", next: 'lawak.wake3' },
  'lawak.wake3': { who: 'lawak', text: 'You look hungry. Take my old rod. Catch three fish where the water bubbles.', act: { flag: 'met_lawak', gear: 'joran' } },
  'lawak.fish': { who: 'lawak', text: 'Click the bubbling water. Wait. Patience made me this handsome.' },
  'lawak.sell': { who: 'lawak', text: 'Now sell them to Mak Cik Rahmah at the pasar. She haggles like a monitor lizard.' },
  'lawak.penghulu': { who: 'lawak', text: 'Tok Penghulu is at the balai. He always looks worried. Today he has a reason.' },
  'lawak.cross': { who: 'lawak', text: "East, over the bridge, into the mist. I'll come. Mostly to throw chillies." },
  'lawak.todak': { who: 'lawak', text: 'Si Todak has a nose like a swordfish. People say so to his face only once.' },
  'lawak.return': { who: 'lawak', text: "We have the gong! Walk proudly to the balai. I'll walk behind you, also proudly." },
  'lawak.done': { who: 'lawak', text: 'Look at the sea tonight. Something out there is humming. Probably not a fish.' },
  // Mak Cik Rahmah
  'rahmah.first': { who: 'rahmah', text: 'Fresh fish? You smell like the inside of a coconut. Fine, I still buy.', options: [{ label: 'Trade', act: { shop: 'rahmah' } }] },
  'rahmah.hi': { who: 'rahmah', text: 'Buying, selling, or standing there like a prawn?', options: [{ label: 'Trade', act: { shop: 'rahmah' } }, { label: 'Bye' }] },
  // Tok Penghulu
  'penghulu.busy': { who: 'penghulu', text: 'Not now, young udang. Big troubles. Go eat something.' },
  'penghulu.ask': { who: 'penghulu', text: 'The festival gong is gone. Perompak from Dragon\'s Tooth took it. No gong, no festival.', next: 'penghulu.ask2' },
  'penghulu.ask2': { who: 'penghulu', text: 'No festival, no luck for the trading season. You came from the sea. The sea owes us.', options: [{ label: "I'll get it back.", act: { flag: 'asked_penghulu' } }, { label: 'Why me?', next: 'penghulu.why' }] },
  'penghulu.why': { who: 'penghulu', text: 'Because the clown is already following you, and I cannot afford two clowns.', options: [{ label: "Fine. I'll get it back.", act: { flag: 'asked_penghulu' } }] },
  'penghulu.wait': { who: 'penghulu', text: 'East, over the bridge. Buy jamu from Rahmah first. Perompak hit hard.' },
  'penghulu.gong': { who: 'penghulu', text: 'The gong! Strike it, strike it! Tonight Temasek feasts!', act: { flag: 'returned_gong', take: 'gong', heal: true } },
  'penghulu.done': { who: 'penghulu', text: 'The traders talk about you now. Mostly about the smell, but still.' },
  // Hulubalang
  'hulubalang.hi': { who: 'hulubalang', text: 'Bukit Larangan. Forbidden hill. Only the raja goes up.', options: [{ label: 'I fell from the sky.', next: 'hulubalang.sky' }, { label: 'Sorry.' }] },
  'hulubalang.sky': { who: 'hulubalang', text: 'Then fly up. ...No? Then no.' },
  // Dalang Wiru
  'dalang.hi': { who: 'dalang', text: 'Every shadow has a story. Bring me an interesting one.' },
  'dalang.carve': { who: 'dalang', text: "That swordfish's shadow is still stuck to your heels. Hold still. I'll cut it into a puppet.", next: 'dalang.carve2' },
  'dalang.carve2': { who: 'dalang', text: 'There. Bayang Todak. Raise it in a fight and his shadow strikes for you. Once.', act: { flag: 'puppet_todak', unlock: 'bayang' } },
  'dalang.done': { who: 'dalang', text: 'The best shadows come from the strangest lights. And there is a strange light out at sea.' },
  // traders
  'lim.hi': { who: 'lim', text: 'The north-east wind brought my junk from Quanzhou. I pay well for kembung. The harbour tax pays less well.', options: [{ label: 'Trade', act: { shop: 'lim' } }, { label: 'Bye' }] },
  'ratan.hi': { who: 'ratan', text: 'The south-west wind carried us from Gujarat. Cotton for your fish. Selar especially.', options: [{ label: 'Trade', act: { shop: 'ratan' } }, { label: 'Bye' }] },
  'kids.hi': { who: 'kids', text: 'Watch my gasing spin! At the festival I will beat everybody. Even you, prawn.' },
  // Si Todak
  'todak.flee': { who: 'todak', text: 'Keep your noisy gong! A star fell into the sea, and at night it sings. Si Todak will have it!', next: 'todak.flee2' },
  'todak.flee2': { who: 'lawak', text: 'He swam off faster than my jokes land. And he left the gong!' }
};

/** Which dialogue node an NPC opens with, given the quest step and flags. */
export function openingNode(npc: NpcId, step: number, flags: Record<string, boolean>): string {
  switch (npc) {
    case 'lawak': return ['lawak.wake', 'lawak.fish', 'lawak.sell', 'lawak.penghulu', 'lawak.cross', 'lawak.todak', 'lawak.return', 'lawak.done'][Math.min(step, 7)];
    case 'rahmah': return step === 2 && !flags.sold ? 'rahmah.first' : 'rahmah.hi';
    case 'penghulu': return step < 3 ? 'penghulu.busy' : step === 3 ? 'penghulu.ask' : step < 6 ? 'penghulu.wait' : step === 6 ? 'penghulu.gong' : 'penghulu.done';
    case 'hulubalang': return 'hulubalang.hi';
    case 'dalang': return step >= 7 && !flags.puppet_todak ? 'dalang.carve' : step >= 7 ? 'dalang.done' : 'dalang.hi';
    case 'lim': return 'lim.hi';
    case 'ratan': return 'ratan.hi';
    case 'kids': return 'kids.hi';
  }
}

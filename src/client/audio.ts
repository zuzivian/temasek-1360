// Synthesised audio for the Temasek prototype: slendro gamelan flavoured SFX,
// a gentle looping ambience and a rain bed. Pure Web Audio, no assets.
//
// Nothing here may throw. Before unlock() is called every function is a silent
// no-op (setters only remember their value and apply it once the context exists).

export type Sfx =
  | 'click'
  | 'step'
  | 'catch'
  | 'xp'
  | 'level'
  | 'coin'
  | 'gong'
  | 'hit'
  | 'perfect'
  | 'miss'
  | 'hurt'
  | 'heal'
  | 'victory'
  | 'defeat'
  | 'quest'
  | 'open'
  | 'splash';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Slendro-like 5-tone scale (Hz), lowest octave used. */
const SCALE: readonly number[] = [293.7, 336.9, 389.4, 448.3, 515.8];

/** 16-step ambient melody as scale indexes. */
const AMBIENT_MELODY: readonly number[] = [2, 3, 4, 3, 2, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 1];
const AMBIENT_STEP = 0.3; // seconds per step
const LOOKAHEAD = 0.4; // seconds scheduled ahead
const TICK_MS = 100;
const MIN_GAP_MS = 40; // per-name rate limit

/** Frequency of scale degree `idx`; idx may be negative or exceed 4 (octaves). */
function note(idx: number): number {
  const oct = Math.floor(idx / 5);
  const deg = ((idx % 5) + 5) % 5;
  return (SCALE[deg] ?? SCALE[0] ?? 293.7) * Math.pow(2, oct);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Part = readonly [freq: number, amp: number, decay: number];
type SfxFn = (c: AudioContext, t: number, out: AudioNode) => void;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let sfxBus: GainNode | null = null;
let ambFade: GainNode | null = null;
let ambBus: GainNode | null = null;
let rainBus: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

let muted = false;

// Rain
let rainAmount = 0;
let windPan = 0;
let rainSrc: AudioBufferSourceNode | null = null;
let rainGain: GainNode | null = null;
let rainLowpass: BiquadFilterNode | null = null;
let rainPanner: StereoPannerNode | null = null;

// Ambient
let ambientWanted = false;
let ambientTimer: ReturnType<typeof setInterval> | null = null;
let ambientStopTimer: ReturnType<typeof setTimeout> | null = null;
let ambientNext = 0;
let ambientStep = 0;

const lastPlay: Record<string, number> = {};

// ---------------------------------------------------------------------------
// Synthesis helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Additive voice: sum of sine partials, each with its own exponential decay. */
function voice(
  c: AudioContext,
  out: AudioNode,
  t: number,
  dur: number,
  vol: number,
  parts: readonly Part[],
  pan = 0,
  lp = 0,
): void {
  const mix = c.createGain();
  let tail: AudioNode = mix;
  if (lp > 0) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lp;
    tail.connect(f);
    tail = f;
  }
  if (pan !== 0) {
    const p = c.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    tail.connect(p);
    tail = p;
  }
  tail.connect(out);
  const nyquist = c.sampleRate / 2;
  for (const [freq, amp, decay] of parts) {
    if (freq >= nyquist) continue;
    const end = t + Math.max(0.1, dur * decay);
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amp * vol), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    o.connect(g);
    g.connect(mix);
    o.start(t);
    o.stop(end + 0.05);
  }
}

/** Metallophone / bonang timbre: f, ~2.01f, ~3.03f, higher partials die faster. */
function bell(
  c: AudioContext,
  out: AudioNode,
  t: number,
  f: number,
  dur: number,
  vol: number,
  brightness = 1,
  pan = 0,
  lp = 0,
): void {
  voice(
    c,
    out,
    t,
    dur,
    vol,
    [
      [f, 1, 1],
      [f * 2.01, 0.45 * brightness, 0.55],
      [f * 3.03, 0.2 * brightness, 0.3],
    ],
    pan,
    lp,
  );
}

/** Gong: detuned twin fundamentals give the slow "wah" beating. */
function gong(
  c: AudioContext,
  out: AudioNode,
  t: number,
  f: number,
  beat: number,
  dur: number,
  vol: number,
): void {
  voice(
    c,
    out,
    t,
    dur,
    vol,
    [
      [f, 1, 1],
      [f + beat, 0.85, 1],
      [f * 2.01, 0.4, 0.6],
      [f * 2.78, 0.2, 0.4],
      [f * 4.1, 0.1, 0.22],
    ],
  );
}

/** Pitched sine drop (drum body / thud). */
function thump(
  c: AudioContext,
  out: AudioNode,
  t: number,
  f0: number,
  f1: number,
  drop: number,
  len: number,
  vol: number,
): void {
  const o = c.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + drop);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + len + 0.05);
}

/** Filtered burst of the shared noise buffer. */
function noise(
  c: AudioContext,
  out: AudioNode,
  t: number,
  dur: number,
  type: BiquadFilterType,
  f0: number,
  f1: number,
  q: number,
  vol: number,
  attack = 0.005,
): void {
  const buf = noiseBuf;
  if (!buf) return;
  const s = c.createBufferSource();
  s.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f);
  f.connect(g);
  g.connect(out);
  const offset = Math.random() * Math.max(0, buf.duration - dur - 0.05);
  s.start(t, offset, dur + 0.02);
}

/** Kendang slap: short pitched drop + bandpassed noise crack. */
function kendang(c: AudioContext, out: AudioNode, t: number, vol: number): void {
  thump(c, out, t, 180, 80, 0.08, 0.16, vol);
  noise(c, out, t, 0.06, 'bandpass', 1900, 1500, 1.4, vol * 0.8);
}

// ---------------------------------------------------------------------------
// Sound definitions
// ---------------------------------------------------------------------------

const SFX: Record<Sfx, SfxFn> = {
  click: (c, t, out) => {
    noise(c, out, t, 0.02, 'bandpass', 2200, 1800, 2, 0.22, 0.002);
    thump(c, out, t, 1100, 700, 0.015, 0.03, 0.18);
  },

  step: (c, t, out) => {
    // One cheap filtered noise burst, nearly inaudible.
    const f = 380 + Math.random() * 160;
    noise(c, out, t, 0.05, 'lowpass', f, f * 0.7, 0.7, 0.05, 0.008);
  },

  catch: (c, t, out) => {
    bell(c, out, t, note(5), 0.9, 0.3, 1.3);
    bell(c, out, t + 0.13, note(7), 1.1, 0.3, 1.3);
  },

  xp: (c, t, out) => {
    bell(c, out, t, note(2), 0.7, 0.2, 0.6);
  },

  level: (c, t, out) => {
    const seq = [0, 1, 2, 4];
    seq.forEach((deg, i) => bell(c, out, t + i * 0.14, note(deg), 0.8, 0.26, 0.9));
    gong(c, out, t + 0.6, 98, 1.2, 2.2, 0.4);
  },

  coin: (c, t, out) => {
    const clinks: ReadonlyArray<readonly [number, number]> = [
      [0, 2637],
      [0.07, 3322],
      [0.13, 2960],
    ];
    for (const [dt, f] of clinks) {
      voice(c, out, t + dt, 0.25, 0.14, [
        [f, 1, 1],
        [f * 1.5, 0.5, 0.6],
        [f * 2.32, 0.3, 0.35],
      ]);
    }
  },

  gong: (c, t, out) => {
    gong(c, out, t, 65, 2, 3, 0.55);
  },

  hit: (c, t, out) => {
    thump(c, out, t, 120, 50, 0.12, 0.2, 0.7);
    kendang(c, out, t + 0.01, 0.35);
  },

  perfect: (c, t, out) => {
    gong(c, out, t, note(-5), 0.8, 1.4, 0.35);
    [8, 9, 10].forEach((deg, i) => bell(c, out, t + 0.04 + i * 0.06, note(deg), 0.5, 0.12, 1.6));
  },

  miss: (c, t, out) => {
    thump(c, out, t, 320, 200, 0.04, 0.07, 0.3);
    noise(c, out, t, 0.04, 'lowpass', 900, 600, 0.8, 0.15, 0.003);
  },

  hurt: (c, t, out) => {
    thump(c, out, t, 110, 45, 0.18, 0.28, 0.75);
    noise(c, out, t, 0.15, 'lowpass', 900, 400, 0.8, 0.28);
  },

  heal: (c, t, out) => {
    bell(c, out, t, note(1), 1.2, 0.2, 0.4);
    bell(c, out, t + 0.18, note(3), 1.4, 0.2, 0.4);
  },

  victory: (c, t, out) => {
    [2, 3, 4, 5].forEach((deg, i) => bell(c, out, t + i * 0.16, note(deg), 0.9, 0.26, 1));
    gong(c, out, t + 0.7, 98, 1.3, 2.5, 0.42);
  },

  defeat: (c, t, out) => {
    [-2, -4, -5].forEach((deg, i) => bell(c, out, t + i * 0.28, note(deg), 1.2, 0.26, 0.5, 0, 900));
  },

  quest: (c, t, out) => {
    [5, 7, 9].forEach((deg, i) => bell(c, out, t + i * 0.08, note(deg), 0.8, 0.24, 1.3));
  },

  open: (c, t, out) => {
    noise(c, out, t, 0.25, 'bandpass', 700, 2400, 0.9, 0.14, 0.06);
  },

  splash: (c, t, out) => {
    noise(c, out, t, 0.5, 'bandpass', 1400, 450, 0.7, 0.3, 0.02);
    noise(c, out, t + 0.05, 0.25, 'highpass', 3000, 3000, 0.7, 0.08, 0.01);
  },
};

// ---------------------------------------------------------------------------
// Rain / wind
// ---------------------------------------------------------------------------

function applyRain(): void {
  const c = ctx;
  if (!c || !rainBus) return;
  const amount = clamp(rainAmount, 0, 1);
  if (!rainSrc && amount > 0 && noiseBuf) {
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 500;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3000;
    const g = c.createGain();
    g.gain.value = 0;
    const p = c.createStereoPanner();
    p.pan.value = clamp(windPan, -1, 1) * 0.4;
    src.connect(hp);
    hp.connect(lp);
    lp.connect(g);
    g.connect(p);
    p.connect(rainBus);
    src.start();
    rainSrc = src;
    rainGain = g;
    rainLowpass = lp;
    rainPanner = p;
  }
  if (rainGain && rainLowpass) {
    const now = c.currentTime;
    rainGain.gain.cancelScheduledValues(now);
    rainGain.gain.setTargetAtTime(amount, now, 0.5);
    rainLowpass.frequency.cancelScheduledValues(now);
    rainLowpass.frequency.setTargetAtTime(2500 + amount * 4000, now, 0.5);
  }
}

function applyPan(): void {
  const c = ctx;
  if (!c || !rainPanner) return;
  const now = c.currentTime;
  rainPanner.pan.cancelScheduledValues(now);
  rainPanner.pan.setTargetAtTime(clamp(windPan, -1, 1) * 0.4, now, 0.5);
}

// ---------------------------------------------------------------------------
// Ambient gamelan loop
// ---------------------------------------------------------------------------

function scheduleAmbientStep(c: AudioContext, t: number, step: number): void {
  const out = ambFade;
  if (!out) return;
  const i = step % 16;
  const deg = AMBIENT_MELODY[i] ?? 0;
  const pan = i % 2 === 0 ? -0.45 : 0.45;
  const accent = i % 4 === 0 ? 1 : 0.7;
  bell(c, out, t, note(deg), 1.3, 0.45 * accent, 0.5, pan);
  if (i === 0) gong(c, out, t, 73.4, 1.5, 3, 0.45);
}

function ambientTick(): void {
  try {
    const c = ctx;
    if (!c || !ambientWanted) return;
    const now = c.currentTime;
    if (ambientNext < now) ambientNext = now + 0.05;
    const horizon = now + LOOKAHEAD;
    while (ambientNext < horizon) {
      scheduleAmbientStep(c, ambientNext, ambientStep);
      ambientNext += AMBIENT_STEP;
      ambientStep += 1;
    }
  } catch {
    // ignore
  }
}

function fadeAmbient(target: number): void {
  const c = ctx;
  if (!c || !ambFade) return;
  const now = c.currentTime;
  const g = ambFade.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(target, now + 2);
}

function applyAmbient(): void {
  const c = ctx;
  if (!c) return;
  if (ambientStopTimer !== null) {
    clearTimeout(ambientStopTimer);
    ambientStopTimer = null;
  }
  if (ambientWanted) {
    if (ambientTimer === null) {
      ambientStep = 0;
      ambientNext = c.currentTime + 0.1;
      ambientTimer = setInterval(ambientTick, TICK_MS);
      ambientTick();
    }
    fadeAmbient(1);
  } else {
    fadeAmbient(0);
    ambientStopTimer = setTimeout(() => {
      ambientStopTimer = null;
      if (!ambientWanted && ambientTimer !== null) {
        clearInterval(ambientTimer);
        ambientTimer = null;
      }
    }, 2100);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function buildGraph(c: AudioContext): void {
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 24;
  comp.ratio.value = 4;
  comp.attack.value = 0.005;
  comp.release.value = 0.2;

  const m = c.createGain();
  m.gain.value = muted ? 0 : 1;
  comp.connect(m);
  m.connect(c.destination);

  const sfx = c.createGain();
  sfx.gain.value = 0.5;
  sfx.connect(comp);

  const fade = c.createGain();
  fade.gain.value = 0;
  const amb = c.createGain();
  amb.gain.value = 0.18;
  fade.connect(amb);
  amb.connect(comp);

  const rain = c.createGain();
  rain.gain.value = 0.25;
  rain.connect(comp);

  // One reusable white-noise buffer (2 s; also the rain loop).
  const len = Math.floor(c.sampleRate * 2);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  master = m;
  sfxBus = sfx;
  ambFade = fade;
  ambBus = amb;
  rainBus = rain;
  noiseBuf = buf;
}

export function unlock(): void {
  try {
    if (!ctx) {
      const g = globalThis as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctor = g.AudioContext ?? g.webkitAudioContext;
      if (!Ctor) return;
      const c = new Ctor();
      try {
        buildGraph(c);
      } catch {
        ctx = null;
        return;
      }
      ctx = c;
      applyRain();
      applyPan();
      applyAmbient();
    }
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  } catch {
    // Web Audio unavailable: stay silent.
  }
}

export function play(name: Sfx): void {
  try {
    const c = ctx;
    const out = sfxBus;
    if (!c || !out || muted) return;
    const fn = SFX[name];
    if (!fn) return;
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const last = lastPlay[name];
    if (last !== undefined && nowMs - last < MIN_GAP_MS) return;
    lastPlay[name] = nowMs;
    if (c.state === 'suspended') c.resume().catch(() => {});
    fn(c, c.currentTime + 0.005, out);
  } catch {
    // ignore
  }
}

export function setMuted(m: boolean): void {
  muted = m;
  try {
    const c = ctx;
    if (!c || !master) return;
    const now = c.currentTime;
    const g = master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(m ? 0 : 1, now + 0.05);
  } catch {
    // ignore
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setRain(amount: number): void {
  rainAmount = Number.isFinite(amount) ? clamp(amount, 0, 1) : 0;
  try {
    applyRain();
  } catch {
    // ignore
  }
}

export function setAmbient(on: boolean): void {
  ambientWanted = on;
  try {
    applyAmbient();
  } catch {
    // ignore
  }
}

export function setWindPan(x: number): void {
  windPan = Number.isFinite(x) ? clamp(x, -1, 1) : 0;
  try {
    applyPan();
  } catch {
    // ignore
  }
}

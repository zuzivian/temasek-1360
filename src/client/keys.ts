// What a key press should do, as a pure function so tests can pin it down without a browser.
export type KeyState = {
  key: string;
  code: string;
  /** The key went to a button or input (a focused control owns Enter and Space). */
  onButton: boolean;
  inCombat: boolean;
  /** It is the hero's turn in combat. */
  myTurn: boolean;
  /** A timing ring is open. */
  ring: boolean;
  /** A dialogue is open. */
  dialog: boolean;
  /** The open dialogue line has no answers, just Continue. */
  continueLine: boolean;
};

export type KeyAction =
  | { t: 'none' }
  | { t: 'timing' }
  | { t: 'say'; option: number }
  | { t: 'close' }
  | { t: 'cancelAbility' }
  | { t: 'endTurn' }
  | { t: 'ability'; n: number };

export function keyAction(s: KeyState): KeyAction {
  // A focused button owns Enter and Space, so keyboard players can press it (Enter on an ability
  // button used to also end the turn). Space still belongs to a timing ring or an open dialogue,
  // so mashing Space through a conversation never picks an answer by accident.
  if (s.code === 'Space') {
    if (s.onButton && !s.ring && !s.dialog) return { t: 'none' };
    if (s.ring) return { t: 'timing' };
    if (s.continueLine) return { t: 'say', option: 0 };
    return { t: 'none' };
  }
  if (s.onButton && s.key === 'Enter') return { t: 'none' };
  if (s.key === 'Escape') return s.inCombat ? { t: 'cancelAbility' } : { t: 'close' };
  if (s.inCombat && (s.key === 'e' || s.key === 'E' || s.key === 'Enter') && s.myTurn && !s.ring) return { t: 'endTurn' };
  if (/^[1-9]$/.test(s.key)) {
    if (s.inCombat) return { t: 'ability', n: Number(s.key) };
    if (s.dialog) return { t: 'say', option: Number(s.key) - 1 };
  }
  return { t: 'none' };
}

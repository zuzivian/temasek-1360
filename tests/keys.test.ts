import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyAction, type KeyState } from '../src/client/keys.ts';

const base: KeyState = { key: '', code: '', onButton: false, inCombat: true, myTurn: true, ring: false, dialog: false, continueLine: false };

test('Enter on a focused ability button does not end the turn', () => {
  assert.deepEqual(keyAction({ ...base, key: 'Enter', code: 'Enter', onButton: true }), { t: 'none' });
});

test('Enter with nothing focused still ends your turn, and only on your turn', () => {
  assert.deepEqual(keyAction({ ...base, key: 'Enter', code: 'Enter' }), { t: 'endTurn' });
  assert.deepEqual(keyAction({ ...base, key: 'Enter', code: 'Enter', myTurn: false }), { t: 'none' });
  assert.deepEqual(keyAction({ ...base, key: 'Enter', code: 'Enter', ring: true }), { t: 'none' });
});

test('Space on a focused button presses it, but still belongs to a timing ring or dialogue', () => {
  assert.deepEqual(keyAction({ ...base, key: ' ', code: 'Space', onButton: true }), { t: 'none' });
  assert.deepEqual(keyAction({ ...base, key: ' ', code: 'Space', onButton: true, ring: true }), { t: 'timing' });
  assert.deepEqual(keyAction({ ...base, key: ' ', code: 'Space', inCombat: false, dialog: true, continueLine: true, onButton: true }), { t: 'say', option: 0 });
  assert.deepEqual(keyAction({ ...base, key: ' ', code: 'Space', inCombat: false, dialog: true, continueLine: false, onButton: true }), { t: 'none' });
});

test('number keys pick abilities in combat and answers in dialogue', () => {
  assert.deepEqual(keyAction({ ...base, key: '2', code: 'Digit2' }), { t: 'ability', n: 2 });
  assert.deepEqual(keyAction({ ...base, key: '3', code: 'Digit3', inCombat: false, dialog: true }), { t: 'say', option: 2 });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Notebook } from '../types';
import { holdText, ignoredText, notebookEmpty, trustedCount } from './notebook';

const nb = (over: Partial<Notebook> = {}): Notebook => ({ agent: 'optimizer', name: 'Optimizer', notes: [], lessons: [], holds: [], ignored: 0, ...over });
const lesson = (trusted: boolean) => ({ text: 't', trusted, verdict: 'hurt' as const, agree: 5, against: 0, unclear: 0, setting: 'risk.slPoints', change: 'down', market: 'XAUUSD 1m', lastAt: 1 });

test('a notebook is empty only when there is nothing to show', () => {
  assert.equal(notebookEmpty(nb()), true);
  assert.equal(notebookEmpty(nb({ notes: ['x'] })), false);
  assert.equal(notebookEmpty(nb({ lessons: [lesson(false)] })), false);
});

test('trusted lessons are counted apart from the rest', () => {
  assert.equal(trustedCount(nb({ lessons: [lesson(true), lesson(false), lesson(true)] })), 2);
});

test('holds and uncounted changes are spelled out', () => {
  assert.match(holdText({ setting: 'risk.slPoints', market: 'XAUUSD 1m' }), /risk\.slPoints in XAUUSD 1m/);
  assert.equal(ignoredText(0), null);
  assert.match(ignoredText(1)!, /^1 scored change not/);
  assert.match(ignoredText(3)!, /^3 scored changes not/);
});

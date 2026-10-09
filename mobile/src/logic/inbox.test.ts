import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { InboxItem } from '../types';
import { badgeText, EMPTY_BODY, repeatNote, sortItems, usableActions } from './inbox';

const item = (over: Partial<InboxItem>): InboxItem => ({
  id: 'a', kind: 'digest', status: 'open', severity: 'info', title: 't', body: '', count: 1, createdAt: 1, updatedAt: 1, actions: ['dismiss'], ...over,
});

test('empty state tells the user they can leave', () => assert.equal(EMPTY_BODY, 'You can close the app.'));

test('badge hides at zero and caps at 99+', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(3), '3');
  assert.equal(badgeText(250), '99+');
});

test('critical items come first, then newest', () => {
  const sorted = sortItems([item({ id: 'old', createdAt: 1 }), item({ id: 'new', createdAt: 5 }), item({ id: 'bad', createdAt: 2, severity: 'critical' })]);
  assert.deepEqual(sorted.map((i) => i.id), ['bad', 'new', 'old']);
});

test('buttons that are not built yet are never shown', () => {
  assert.deepEqual(usableActions(item({ actions: ['approve', 'undo', 'stage', 'reject'] })), ['approve', 'reject']);
});

test('repeat note only appears for repeats', () => {
  assert.equal(repeatNote({ count: 1 }), '');
  assert.equal(repeatNote({ count: 4 }), 'Happened 4 times');
});

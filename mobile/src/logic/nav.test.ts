import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NAV } from './nav';

// T-0.6
test('there are exactly 8 tabs, in order: dashboard, inbox, strategies, testboard, journal, agents, profile, help', () => {
  assert.deepEqual(
    NAV.map((n) => n.tab),
    ['dashboard', 'inbox', 'strategies', 'testboard', 'journal', 'agents', 'profile', 'help'],
  );
});

test('levels and activity are not tabs', () => {
  const tabs = NAV.map((n) => n.tab as string);
  assert.ok(!tabs.includes('levels'));
  assert.ok(!tabs.includes('activity'));
});

test('every tab has a label, icon and hint', () => {
  for (const n of NAV) {
    assert.ok(n.label && n.icon && n.hint, n.tab);
  }
});

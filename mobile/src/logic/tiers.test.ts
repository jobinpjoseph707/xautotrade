import { test } from 'node:test';
import assert from 'node:assert/strict';

import { capLabel, strategyLine, usageLabel, usageTone, usedShare } from './tiers';
import type { TierSummary } from '../types';

const tier = (o: Partial<TierSummary> = {}): TierSummary => ({ tier: 5, name: 'Aggressive', capPct: 0.6, openRiskPct: 0.2, strategies: [], ...o });

// TR-1
test('TR-1 a tier reads its cap, its open risk and how full it is', () => {
  assert.equal(capLabel(tier()), 'cap 0.60%');
  assert.equal(usageLabel(tier()), '0.20% of 0.60%');
  assert.equal(usageLabel(tier({ openRiskPct: null })), 'open risk not available');
  assert.ok(Math.abs((usedShare(tier()) ?? 0) - 1 / 3) < 1e-9);
  assert.equal(usedShare(tier({ openRiskPct: null })), null);
});

// TR-2
test('TR-2 a tier turns amber at 80% of its cap and red at 100%', () => {
  assert.equal(usageTone(tier({ openRiskPct: 0.4 })), 'neutral');
  assert.equal(usageTone(tier({ openRiskPct: 0.48 })), 'warning');
  assert.equal(usageTone(tier({ openRiskPct: 0.6 })), 'critical');
  assert.equal(usageTone(tier({ openRiskPct: null })), 'neutral');
});

// TR-3
test('TR-3 strategies are listed by name, and a provisional tier says so', () => {
  assert.equal(strategyLine(tier()), 'No strategies');
  assert.equal(strategyLine(tier({ strategies: [{ id: 'a', name: 'Gold', provisional: false }, { id: 'b', name: 'Euro', provisional: true }] })), 'Gold, Euro (provisional)');
});

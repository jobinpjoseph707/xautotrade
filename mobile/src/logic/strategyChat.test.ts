import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_BUTTONS, isWeakEvidence, whatIfError, whatIfRows } from './strategyChat';

test('four buttons, in the order the Help page lists them', () => {
  assert.deepEqual(CHAT_BUTTONS.map((b) => b.label), ['Tune', 'Diagnose', 'Tighten risk', 'Critique']);
  assert.deepEqual(CHAT_BUTTONS.map((b) => b.button), ['tune', 'diagnose', 'tighten', 'critique']);
});

test('what-if rows put before and after side by side', () => {
  const rows = whatIfRows({ whatIf: { before: { strategyId: 'a', trades: 42, profitFactor: 0.8, netProfitPct: -1 }, after: { strategyId: 'a', trades: 40, profitFactor: 1.3, netProfitPct: 2.5, maxDrawdownPct: 4 } } });
  assert.deepEqual(rows.find((r) => r.label === 'Profit factor'), { label: 'Profit factor', before: '0.8', after: '1.3' });
  assert.deepEqual(rows.find((r) => r.label === 'Net result'), { label: 'Net result', before: '-1%', after: '2.5%' });
  assert.equal(rows.find((r) => r.label === 'Max drawdown')!.before, 'n/a');
});

test('no rows without a what-if or when a backtest failed, and the failure is reported', () => {
  assert.deepEqual(whatIfRows({}), []);
  const failed = { whatIf: { before: { strategyId: 'a', error: 'no candles' }, after: { strategyId: 'a' } } };
  assert.deepEqual(whatIfRows(failed), []);
  assert.match(whatIfError(failed) ?? '', /no candles/);
  assert.equal(whatIfError({}), null);
});

test('fewer than 30 trades on either side is flagged as weak evidence', () => {
  const mk = (b: number, a: number) => ({ whatIf: { before: { strategyId: 'x', trades: b }, after: { strategyId: 'x', trades: a } } });
  assert.equal(isWeakEvidence(mk(100, 29)), true);
  assert.equal(isWeakEvidence(mk(100, 100)), false);
  assert.equal(isWeakEvidence({}), false);
});

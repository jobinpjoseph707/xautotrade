import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chatUsage } from '../store.js';

test('chatUsage: records add up and group by tag', () => {
  // A unique tag per run — the backing DB is a real (persistent) file shared
  // across the whole test process, so summing "since the beginning of time"
  // would pick up rows from other tests/runs. Filtering by tag isolates ours.
  const tag = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  chatUsage.add({ ts: now, tag, model: 'sonnet', inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
  chatUsage.add({ ts: now + 1, tag, model: 'sonnet', inputTokens: 20, outputTokens: 10 }); // no cost reported — should not crash
  chatUsage.add({ ts: now + 2, tag: 'other_tag', inputTokens: 1000, outputTokens: 1000, costUsd: 5 });

  const summary = chatUsage.summary(now - 1000);
  const mine = summary.byTag.find((b) => b.tag === tag);
  assert.ok(mine, 'tag group missing from summary');
  assert.equal(mine!.calls, 2);
  assert.equal(mine!.totalTokens, 100 + 50 + 20 + 10);
  assert.ok(Math.abs(mine!.costUsd - 0.01) < 1e-9);

  // A window that excludes everything we just wrote sees none of it.
  const empty = chatUsage.summary(now + 10_000);
  assert.equal(empty.byTag.find((b) => b.tag === tag), undefined);
});

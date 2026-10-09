import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INBOX_KINDS, TESTBOARD_VERDICTS } from '../types';
import { NAV } from './nav';
import { allEntries, entryById, helpEntryIdFor, ROUTINE, TAB_ACTIONS, VERDICT_ENTRIES, WHEN_YOU_SEE } from './help';

const everyText = (): string[] => [
  ...allEntries().flatMap((e) => [e.see, e.means, e.do, e.open?.label ?? '']),
  ...ROUTINE.flatMap((r) => [r.title, ...r.steps]),
  ...TAB_ACTIONS.map((t) => t.line),
];

// HP-1
test('HP-1 every inbox card type has a "what to do" entry', () => {
  for (const kind of INBOX_KINDS) {
    assert.ok(allEntries().some((e) => e.kind === kind), `no Help entry for Inbox kind "${kind}"`);
  }
});

// HP-2
test('HP-2 every Testboard verdict has a "what to do" entry', () => {
  for (const v of TESTBOARD_VERDICTS as readonly string[]) {
    assert.ok(VERDICT_ENTRIES.some((e) => e.verdict === v), `no Help entry for verdict "${v}"`);
  }
  assert.equal(VERDICT_ENTRIES.length, TESTBOARD_VERDICTS.length, 'Phase 1 ships the list empty');
});

// HP-3
test('HP-3 every tab has exactly one action line, and no removed tab is mentioned', () => {
  assert.deepEqual(TAB_ACTIONS.map((t) => t.tab), NAV.map((n) => n.tab), 'same tabs, same order as the navigation');
  assert.equal(TAB_ACTIONS.length, 8);
  for (const t of TAB_ACTIONS) assert.ok(t.line.trim().length > 0);
  for (const text of everyText()) {
    assert.ok(!/chart lines/i.test(text), `mentions the removed Chart lines tab: ${text}`);
    assert.ok(!/\bactivity\b/i.test(text), `mentions the removed Activity tab: ${text}`);
  }
});

// HP-4
const VERBS = /^(Nothing|Tap|Open|Read|Check|Click|Wait|Set|Raise|Lower|Widen|Ask|Reject|Approve|Stop|Press|Remove|Leave|Find|Act|Look|Dismiss|Restart)\b/;
test('HP-4 every entry has what you see, what it means and what to do', () => {
  for (const e of allEntries()) {
    for (const [part, text] of [['see', e.see], ['means', e.means], ['do', e.do]] as const) {
      assert.ok(text.trim().length > 10, `${e.id}.${part} is empty or too short`);
    }
    assert.match(e.do, VERBS, `${e.id}: "what to do" must start with an action verb or "Nothing" (got "${e.do.slice(0, 30)}")`);
  }
  const ids = allEntries().map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'entry ids are unique');
  for (const g of WHEN_YOU_SEE) assert.ok(g.entries.length > 0, `${g.id} is empty`);
});

// HP-5
test('HP-5 Help never promises profit', () => {
  for (const text of everyText()) {
    assert.ok(!/guarantee|will profit|risk-free|risk free|can.t lose|sure thing/i.test(text), `profit promise: ${text}`);
  }
});

test('the daily routine comes first and says the Inbox is the place to start', () => {
  assert.match(ROUTINE[0].title, /Every day/);
  assert.match(ROUTINE[0].steps[0], /Inbox/);
});

test('each Inbox card links to an existing entry for its own kind', () => {
  for (const kind of INBOX_KINDS) {
    const id = helpEntryIdFor({ kind });
    const entry = entryById(id);
    assert.ok(entry, `${kind} -> ${id}`);
    assert.equal(entry!.kind, kind);
  }
  assert.equal(helpEntryIdFor({ kind: 'safety_action', title: 'Daily loss cap hit: equity is down 3.1% today' }), 'safety-cap');
  assert.equal(helpEntryIdFor({ kind: 'safety_action', title: '"Bot one" was left paused after a 41-minute outage' }), 'safety-outage');
  assert.equal(helpEntryIdFor({ kind: 'proposal', title: 'Update "X": risk.fixedLot', body: 'smaller size' }), 'proposal');
  assert.equal(helpEntryIdFor({ kind: 'proposal', title: 'Update "X"', body: 'This loosens a risk limit (maxLot).' }), 'proposal-loosens');
});

test('the buttons in Help point at real tabs', () => {
  const tabs = new Set(NAV.map((n) => n.tab));
  for (const e of allEntries()) if (e.open) assert.ok(tabs.has(e.open.tab), e.id);
});

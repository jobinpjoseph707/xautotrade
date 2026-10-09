import test from 'node:test';
import assert from 'node:assert/strict';
import { istDate, istDateTime, istDateTimeSeconds, istFull, istTime, istTimeSeconds } from './time';

// 2026-10-09 22:00:00 UTC is 03:30 on 10 Oct in India (UTC+5:30).
const T = Date.UTC(2026, 9, 9, 22, 0, 0);

// TM-1
test('TM-1 times are shown in Indian Standard Time, UTC+5:30', () => {
  assert.equal(istTime(T), '03:30');
  assert.equal(istTimeSeconds(T + 9000), '03:30:09');
  assert.match(istDateTime(T), /10 Oct.*03:30/);
  assert.match(istDateTimeSeconds(T + 9000), /10 Oct.*03:30:09/);
  assert.match(istFull(T), /10 Oct 2026.*03:30/);
  assert.equal(istDate(T), '10 Oct');
});

// TM-2
test('TM-2 the result does not depend on the computer time zone and uses a 24-hour clock', () => {
  const noon = Date.UTC(2026, 0, 15, 12, 0, 0); // 17:30 IST
  assert.equal(istTime(noon), '17:30');
  const evening = Date.UTC(2026, 0, 15, 18, 29, 0); // 23:59 IST, still the same day
  assert.equal(istTime(evening), '23:59');
  assert.equal(istDate(evening), '15 Jan');
  assert.equal(istDate(evening + 60_000), '16 Jan'); // 00:00 IST
});

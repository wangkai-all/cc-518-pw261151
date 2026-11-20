import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWallTime,
  formatInZone,
  offsetLabel,
  parseFixedOffset,
  HOUR_MS,
} from '../src/time.js';

test('固定偏移：UTC+08 本地时间解析为正确的 UTC 瞬间', () => {
  const r = resolveWallTime('2026-11-21T09:00:00', 'UTC+08:00');
  assert.equal(r.status, 'ok');
  assert.equal(new Date(r.instant).toISOString(), '2026-11-21T01:00:00.000Z');
  assert.equal(r.offsetMinutes, 480);
});

test('IANA 时区：上海无 DST，解析稳定', () => {
  const r = resolveWallTime('2026-11-21T09:30:00', 'Asia/Shanghai');
  assert.equal(r.status, 'ok');
  assert.equal(new Date(r.instant).toISOString(), '2026-11-21T01:30:00.000Z');
  const back = formatInZone(r.instant, 'Asia/Shanghai');
  assert.equal(back.wall, '2026-11-21T09:30:00');
});

test('跨时区等价：09:05 UTC+08 与 01:05 UTC 是同一瞬间', () => {
  const a = resolveWallTime('2026-11-21T09:05:00', 'Asia/Shanghai');
  const b = resolveWallTime('2026-11-21T01:05:00', 'UTC');
  assert.equal(a.instant, b.instant);
});

test('纽约 EST（11 月）偏移为 UTC-05:00', () => {
  const r = resolveWallTime('2026-11-20T20:05:00', 'America/New_York');
  assert.equal(r.status, 'ok');
  assert.equal(r.offsetMinutes, -300);
  assert.equal(new Date(r.instant).toISOString(), '2026-11-21T01:05:00.000Z');
});

test('纽约 EDT（8 月）偏移为 UTC-04:00', () => {
  const r = resolveWallTime('2026-08-15T12:00:00', 'America/New_York');
  assert.equal(r.offsetMinutes, -240);
});

test('DST 回拨歧义：01:30 对应两个瞬间，默认取较早者', () => {
  const r = resolveWallTime('2026-11-01T01:30:00', 'America/New_York');
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.alternatives.length, 2);
  // 较早瞬间仍处于 EDT (UTC-04)：01:30 EDT = 05:30Z
  assert.equal(new Date(r.instant).toISOString(), '2026-11-01T05:30:00.000Z');
  // 较晚瞬间为 EST (UTC-05)：01:30 EST = 06:30Z
  assert.equal(new Date(r.alternatives[1]).toISOString(), '2026-11-01T06:30:00.000Z');
  assert.match(r.message, /夏令时/);
  assert.equal(r.alternatives[1] - r.alternatives[0], HOUR_MS);
});

test('DST 前跳缺口：02:30 不存在，按时间流逝顺延到 03:30 EDT', () => {
  const r = resolveWallTime('2026-03-08T02:30:00', 'America/New_York');
  assert.equal(r.status, 'gap');
  // 02:30 之后墙上第一个出现的有效时间是 03:30 EDT = 07:30Z
  assert.equal(new Date(r.instant).toISOString(), '2026-03-08T07:30:00.000Z');
  const back = formatInZone(r.instant, 'America/New_York');
  assert.equal(back.wall, '2026-03-08T03:30:00');
});

test('DST 边界外的正常时间往返一致', () => {
  for (const t of ['2026-01-15T10:00:00', '2026-07-15T10:00:00']) {
    const r = resolveWallTime(t, 'America/New_York');
    assert.equal(formatInZone(r.instant, 'America/New_York').wall, t);
  }
});

test('南半球悉尼：10 月春令时缺口与 4 月秋令时回拨', () => {
  const gap = resolveWallTime('2026-10-04T02:30:00', 'Australia/Sydney');
  assert.equal(gap.status, 'gap');
  assert.equal(new Date(gap.instant).toISOString(), '2026-10-03T16:30:00.000Z');

  const amb = resolveWallTime('2026-04-05T02:30:00', 'Australia/Sydney');
  assert.equal(amb.status, 'ambiguous');
  assert.equal(amb.alternatives.length, 2);
  assert.equal(new Date(amb.instant).toISOString(), '2026-04-04T15:30:00.000Z');
  assert.equal(new Date(amb.alternatives[1]).toISOString(), '2026-04-04T16:30:00.000Z');
});

test('伦敦与半小时/45 分固定偏移解析', () => {
  const london = resolveWallTime('2026-10-25T01:30:00', 'Europe/London');
  assert.equal(london.status, 'ambiguous');
  assert.equal(resolveWallTime('2026-01-01T00:00:00', 'UTC+05:30').offsetMinutes, 330);
  assert.equal(resolveWallTime('2026-01-01T00:00:00', 'UTC-03:45').offsetMinutes, -225);
});

test('非法时间格式抛错', () => {
  assert.throws(() => resolveWallTime('not-a-time', 'UTC'), /非法本地时间/);
});

test('offsetLabel 与 parseFixedOffset', () => {
  assert.equal(offsetLabel(0), 'UTC');
  assert.equal(offsetLabel(480), 'UTC+08:00');
  assert.equal(offsetLabel(-210), 'UTC-03:30');
  assert.equal(parseFixedOffset('GMT-05:00'), -300);
  assert.equal(parseFixedOffset('UTC'), 0);
  assert.equal(parseFixedOffset('Asia/Shanghai'), null);
});

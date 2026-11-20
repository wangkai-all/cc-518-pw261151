import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDuplicates, dedupeEvents } from '../src/dedup.js';

function ev(id, overrides = {}) {
  return {
    id,
    type: 'failure',
    entityId: 'task_x',
    source: 'monitor',
    fingerprintKey: null,
    message: '任务失败',
    instant: 0,
    ...overrides,
  };
}

test('相同指纹键 + 时间窗内：判为重复，最早事件为主', () => {
  const events = [
    ev('a', { instant: 1_000_000, fingerprintKey: 'fp1' }),
    ev('b', { instant: 1_200_000, fingerprintKey: 'fp1' }),
  ];
  const { groups, duplicateOf } = detectDuplicates(events);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].primaryId, 'a');
  assert.deepEqual(groups[0].duplicateIds, ['b']);
  assert.equal(duplicateOf.get('b'), 'a');
});

test('跨时区镜像事件在 UTC 归一后识别为重复（同一瞬间、不同挂钟表达）', () => {
  const events = [
    ev('us', {
      instant: Date.parse('2026-11-21T01:05:00Z'),
      source: 'monitor-us',
      fingerprintKey: 'fp-na',
      localTime: '2026-11-20T20:05:00',
      zone: 'America/New_York',
    }),
    ev('global', {
      instant: Date.parse('2026-11-21T01:05:02Z'), // 全球视图镜像晚 2 秒推送
      source: 'monitor-global',
      fingerprintKey: 'fp-na',
      localTime: '2026-11-21T01:05:00',
      zone: 'UTC',
    }),
  ];
  const { groups } = detectDuplicates(events);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].duplicateIds, ['global']);
});

test('同源 + 文本归一化相同 + 30 分钟窗内：判为重复（数字噪声被忽略）', () => {
  const events = [
    ev('a', { instant: 0, message: 'Spark 排队等待 executor #12' }),
    ev('b', { instant: 10 * 60_000, message: 'Spark 排队等待 executor #99' }),
  ];
  const { groups } = detectDuplicates(events);
  assert.equal(groups.length, 1);
});

test('超出时间窗的同类事件不算重复', () => {
  const events = [
    ev('a', { instant: 0, message: '同文本' }),
    ev('b', { instant: 31 * 60_000, message: '同文本' }),
  ];
  const { groups } = detectDuplicates(events);
  assert.equal(groups.length, 0);
});

test('不同实体或不同类型不算重复', () => {
  const events = [
    ev('a', { entityId: 't1' }),
    ev('b', { entityId: 't2' }),
    ev('c', { type: 'retry' }),
  ];
  const { groups } = detectDuplicates(events);
  assert.equal(groups.length, 0);
});

test('dedupeEvents 只保留主事件', () => {
  const events = [
    ev('a', { instant: 0, fingerprintKey: 'fp1' }),
    ev('b', { instant: 1000, fingerprintKey: 'fp1' }),
  ];
  const kept = dedupeEvents(events);
  assert.deepEqual(kept.map((e) => e.id), ['a']);
});

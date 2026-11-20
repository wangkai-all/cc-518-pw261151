import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCase, analyzeCase, findCandidates, diffVersions } from '../src/engine.js';
import { candidateKey } from '../src/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(readFileSync(join(here, '..', 'data', 'sample-data.json'), 'utf8'));

test('样例构建：实体/事件数量、时区告警、去重分组', () => {
  const built = buildCase(sample);
  assert.equal(built.entities.length, 9);
  // 21 条原始事件，跨时区镜像与同源重复各成组
  assert.equal(built.events.length, 21);
  assert.ok(built.duplicateGroups.length >= 2, `应至少识别两组重复，实际 ${built.duplicateGroups.length}`);

  // 跨时区镜像：纽约 20:05 与 UTC 01:05 同指纹 -> 重复
  const mirror = built.duplicateGroups.find((g) => g.duplicateIds.includes('ev_na_fail_mirror'));
  assert.ok(mirror, '跨时区镜像事件应被识别为重复');
  assert.equal(mirror.primaryId, 'ev_na_fail');

  // 同源 10 分钟内的重复排队告警
  const repeat = built.duplicateGroups.find((g) => g.duplicateIds.includes('ev_pool_wait_repeat'));
  assert.ok(repeat, '同源重复排队告警应被识别');

  // DST 探针事件产生时区告警
  const warnings = built.tzWarnings.map((w) => w.eventId);
  assert.ok(warnings.includes('ev_dst_gap_probe'));
  assert.ok(warnings.includes('ev_dst_ambiguous_probe'));
});

test('违约识别：显式违约 + 任务 SLA 隐式推导，共 2 个', () => {
  const built = buildCase(sample);
  const ids = built.breaches.map((b) => b.id);
  assert.ok(ids.includes('ev_svc_breach'));
  const derived = built.breaches.find((b) => b.source === 'derived');
  assert.ok(derived, '09:30 SLA 的日报构建应被推导为违约');
  assert.equal(derived.entityId, 'task_report_build');
  // 10:42 - 09:30 = 72 分钟
  assert.equal(derived.overdueMinutes, 72);
  assert.equal(derived.severity, 'critical');
});

test('根因候选：多上游共同致因，且区分证据充分/高度疑似/待确认', () => {
  const built = buildCase(sample);
  const breach = built.breaches.find((b) => b.id === 'ev_svc_breach');
  const candidates = findCandidates(built, breach);
  const byEntity = Object.fromEntries(candidates.map((c) => [c.entityId, c]));

  // 候选集 = 违约实体 + 全部祖先
  assert.ok(candidates.length >= 7);
  for (const id of [
    'svc_exec_dashboard',
    'task_report_build',
    'task_etl_merge',
    'task_ingest_na',
    'task_ingest_cn',
    'ds_sales_na',
    'res_spark_pool',
    'ds_sales_eu',
  ]) {
    assert.ok(byEntity[id], `候选应包含 ${id}`);
  }

  // 北美接入：failure 重证据 + 关键路径 -> 证据充分
  assert.equal(byEntity.task_ingest_na.machineStrength, 'confirmed');
  assert.ok(byEntity.task_ingest_na.evidence.some((e) => e.type === 'failure'));
  // 镜像重复事件不得作为第二条证据
  const naEvidence = byEntity.task_ingest_na.evidence.map((e) => e.eventId);
  assert.ok(!naEvidence.includes('ev_na_fail_mirror'));
  assert.ok(naEvidence.includes('ev_na_fail'));

  // 待确认原因：无直接故障事件的实体（北美源数据集本身只有历史探针）
  assert.equal(byEntity.ds_sales_na.machineStrength, 'unconfirmed');
  assert.equal(byEntity.ds_sales_na.evidence.length, 0);

  // 非关键路径（欧洲数据 critical:false）有低分延迟证据时仍只能到待确认/疑似
  const eu = byEntity.ds_sales_eu;
  assert.notEqual(eu.pathCritical, true);

  // 每条候选带传导链
  assert.deepEqual(byEntity.task_ingest_na.path[0], 'svc_exec_dashboard');
  assert.ok(byEntity.task_ingest_na.path.includes('task_ingest_na'));

  // 排序：证据充分者排在待确认者之前
  assert.ok(candidates[0].score >= candidates[candidates.length - 1].score);
});

test('贡献分钟数与重复事件剔除：Spark 池等待 38 分钟', () => {
  const built = buildCase(sample);
  const breach = built.breaches.find((b) => b.id === 'ev_svc_breach');
  const candidates = findCandidates(built, breach);
  const pool = candidates.find((c) => c.entityId === 'res_spark_pool');
  assert.equal(pool.contributionMinutes, 38);
  // 两条排队告警只保留一条证据
  assert.equal(pool.evidence.filter((e) => e.type === 'resource_wait').length, 1);
});

test('影响链：违约传导到高管驾驶舱并挂接业务影响事件', () => {
  const built = buildCase(sample);
  const analysis = analyzeCase(built);
  const chain = analysis.impacts['ev_svc_breach'];
  const svc = chain.find((c) => c.entityId === 'svc_exec_dashboard');
  assert.ok(svc);
  assert.equal(svc.impactEvents.length, 1);
  assert.match(svc.impactEvents[0].message, /高管早会/);
});

test('版本重算：新增证据后重算，人工判定黏滞不被覆盖', () => {
  const built = buildCase(sample);
  const v1 = analyzeCase(built);

  // 分析师把「欧洲数据集」人工确认为根因（机器判断并不支持）
  const judgments = [
    {
      breachId: 'ev_svc_breach',
      entityId: 'ds_sales_eu',
      verdict: 'confirmed',
      by: 'analyst-kai',
      at: '2026-11-21T02:00:00Z',
      note: '供应商确认当日抽数口径异常',
      version: 1,
    },
  ];
  const v2 = analyzeCase(built, { ...v1, judgments });
  const eu2 = v2.candidates['ev_svc_breach'].find((c) => c.entityId === 'ds_sales_eu');
  assert.equal(eu2.strength, 'confirmed'); // 人工结论生效
  assert.equal(eu2.humanVerdict.by, 'analyst-kai');
  assert.equal(eu2.machineDiffers, true); // 机器仍不认为它是 confirmed，分歧被显式暴露
  assert.notEqual(eu2.machineStrength, 'confirmed');

  // 再追加一条欧洲侧新证据重算：分数变化，但人工确认仍保留
  const enriched = structuredClone(sample);
  enriched.events.push({
    id: 'ev_eu_delay_new',
    type: 'delay',
    entityId: 'ds_sales_eu',
    localTime: '2026-11-20T20:30:00',
    zone: 'UTC',
    delayMinutes: 20,
    source: 'kafka-eu',
    message: '补录：欧洲抽数延迟 20 分钟',
  });
  const built3 = buildCase(enriched);
  const v3 = analyzeCase(built3, { ...v2, judgments });
  const eu3 = v3.candidates['ev_svc_breach'].find((c) => c.entityId === 'ds_sales_eu');
  assert.equal(eu3.strength, 'confirmed', '人工判定必须黏滞');
  assert.equal(eu3.humanVerdict.by, 'analyst-kai');
  assert.ok(eu3.evidence.some((e) => e.eventId === 'ev_eu_delay_new'));

  // 人工排除同样黏滞
  const judgments2 = [
    ...judgments,
    {
      breachId: 'ev_svc_breach',
      entityId: 'res_spark_pool',
      verdict: 'rejected',
      by: 'analyst-kai',
      at: '2026-11-21T02:05:00Z',
      note: '排队时长不足以解释 72 分钟延迟',
      version: 2,
    },
  ];
  const v4 = analyzeCase(built3, { ...v3, judgments: judgments2 });
  const pool = v4.candidates['ev_svc_breach'].find((c) => c.entityId === 'res_spark_pool');
  assert.equal(pool.strength, 'rejected');
  assert.equal(pool.humanVerdict.verdict, 'rejected');
});

test('版本 diff：识别新增候选与分数变化', () => {
  const built = buildCase(sample);
  const v1 = analyzeCase(built);
  const enriched = structuredClone(sample);
  enriched.events.push({
    id: 'ev_eu_delay_new',
    type: 'delay',
    entityId: 'ds_sales_eu',
    localTime: '2026-11-20T20:30:00',
    zone: 'UTC',
    delayMinutes: 20,
    source: 'kafka-eu',
    message: '补录：欧洲抽数延迟 20 分钟',
  });
  const v2 = analyzeCase(buildCase(enriched), v1);
  const d = diffVersions(v1, v2);
  assert.equal(d.toVersion, 2);
  const changedEu = d.changed.find((c) => c.key === candidateKey({ breachId: 'ev_svc_breach', entityId: 'ds_sales_eu' }));
  assert.ok(changedEu);
  assert.ok(changedEu.score[1] > changedEu.score[0]);
});

test('因果时序：违约之后的事件不能作为根因证据', () => {
  const data = structuredClone(sample);
  data.events.push({
    id: 'ev_future_failure',
    type: 'failure',
    entityId: 'task_ingest_na',
    localTime: '2026-11-22T09:00:00',
    zone: 'America/New_York',
    source: 'monitor-us',
    message: '违约次日才发生的失败',
  });
  const built = buildCase(data);
  const breach = built.breaches.find((b) => b.id === 'ev_svc_breach');
  const candidates = findCandidates(built, breach);
  const na = candidates.find((c) => c.entityId === 'task_ingest_na');
  assert.ok(!na.evidence.some((e) => e.eventId === 'ev_future_failure'));
});

test('图结构变化后失去候选的人工判定进入 orphanJudgments 留档，不被静默丢弃', () => {
  const built1 = buildCase(sample);
  const v1 = analyzeCase(built1);
  const judgments = [
    {
      breachId: 'ev_svc_breach',
      entityId: 'ds_sales_eu',
      verdict: 'confirmed',
      by: 'kai',
      at: '2026-11-21T02:00:00Z',
      note: '曾确认欧洲数据为根因',
      version: 1,
    },
  ];

  // 从图中移除欧洲数据集及其关系与事件
  const shrunk = structuredClone(sample);
  shrunk.entities = shrunk.entities.filter((e) => e.id !== 'ds_sales_eu');
  shrunk.relations = shrunk.relations.filter((r) => r.from !== 'ds_sales_eu' && r.to !== 'ds_sales_eu');
  shrunk.events = shrunk.events.filter((e) => e.entityId !== 'ds_sales_eu');

  const built2 = buildCase(shrunk);
  const v2 = analyzeCase(built2, { ...v1, judgments });
  const eu = v2.candidates['ev_svc_breach'].find((c) => c.entityId === 'ds_sales_eu');
  assert.equal(eu, undefined);
  assert.equal(v2.orphanJudgments.length, 1);
  assert.equal(v2.orphanJudgments[0].entityId, 'ds_sales_eu');
  assert.equal(v2.orphanJudgments[0].note, '曾确认欧洲数据为根因');
  // 判定本身仍保留在 judgments 中，可继续审计
  assert.equal(v2.judgments.length, 1);
});

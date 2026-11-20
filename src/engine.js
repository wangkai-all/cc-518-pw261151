/**
 * 根因分析引擎（纯函数，无状态）。
 *
 * 流程：
 *   规范化输入 -> 构建因果图 -> 识别 SLA 违约 -> 去重 ->
 *   对每个违约在祖先实体中评分根因候选 -> 按证据强度分级 ->
 *   合并历史人工判定（黏滞，不被新证据覆盖）。
 *
 * 设计约束：同一输入 + 同一历史判定，必然得到同一结果，
 * 这样「新增证据后重算」可以通过版本快照逐版对比。
 */

import {
  normalizeEntity,
  normalizeEvent,
  EVIDENCE_STRENGTH,
  candidateKey,
  ENTITY_TYPES,
} from './model.js';
import { CausalGraph } from './graph.js';
import { detectDuplicates } from './dedup.js';
import { HOUR_MS, MINUTE_MS, formatInZone, formatInstant, resolveWallTime } from './time.js';

const LOOKBACK_MS = 12 * HOUR_MS; // 违约前 12 小时内的事件才算直接证据
const CONFIRMED_SCORE = 32;
const PROBABLE_SCORE = 8;

/** 入口：把原始 case JSON 规范化为可分析的内部结构。 */
export function buildCase(rawCase) {
  const entities = (rawCase.entities || []).map(normalizeEntity);
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const graph = new CausalGraph(entities, rawCase.relations || []);
  graph.topoSort(); // 提前失败：有环数据不允许进入分析

  const events = (rawCase.events || []).map((ev) => {
    const ent = entityById.get(ev.entityId);
    if (!ent) throw new Error(`事件 ${ev.id} 引用了不存在的实体 ${ev.entityId}`);
    return normalizeEvent(ev, ent.zone);
  });
  events.sort((a, b) => a.instant - b.instant || a.id.localeCompare(b.id));

  const breaches = detectBreaches(entities, events);
  const { groups: duplicateGroups, duplicateOf } = detectDuplicates(events);
  const tzWarnings = events.filter((e) => e.tzWarning).map((e) => ({
    eventId: e.id,
    entityId: e.entityId,
    message: e.tzWarning,
  }));

  return {
    caseId: rawCase.caseId || 'default',
    title: rawCase.title || '未命名案例',
    entities,
    entityById,
    graph,
    events,
    breaches,
    duplicateGroups,
    duplicateOf,
    tzWarnings,
  };
}

/**
 * 违约识别：
 *  1) 显式 sla_breach 事件；
 *  2) 隐式推导：带 slaDueLocal（每日 HH:mm，实体本地时区）的任务/服务，
 *     其 finish/arrival 事件晚于当日应交付时间。
 */
function detectBreaches(entities, events) {
  const breaches = [];

  for (const ev of events) {
    if (ev.type === 'sla_breach') {
      breaches.push({
        id: ev.id,
        entityId: ev.entityId,
        instant: ev.instant,
        expectedDue: ev.raw.expectedDueInstant ?? null,
        actualInstant: ev.instant,
        overdueMinutes: ev.delayMinutes ?? null,
        severity: ev.severity || 'high',
        source: 'explicit',
        message: ev.message,
      });
    }
  }

  for (const ent of entities) {
    if (!ENTITY_TYPES[ent.type].slaApplicable || !ent.metadata?.slaDueLocal) continue;
    const done = events
      .filter((e) => e.entityId === ent.id && (e.type === 'finish' || e.type === 'arrival'))
      .sort((a, b) => a.instant - b.instant);
    for (const ev of done) {
      const due = dailyDueInstant(ev.instant, ent.metadata.slaDueLocal, ent.zone);
      if (ev.instant > due) {
        const id = `derived_breach_${ent.id}_${ev.id}`;
        if (breaches.some((b) => b.id === id)) continue;
        breaches.push({
          id,
          entityId: ent.id,
          instant: ev.instant,
          expectedDue: due,
          actualInstant: ev.instant,
          overdueMinutes: Math.round((ev.instant - due) / MINUTE_MS),
          severity: (ev.instant - due) / MINUTE_MS > 60 ? 'critical' : 'high',
          source: 'derived',
          message: `${ent.name} 实际完成晚于 SLA 交付时间 ${ent.metadata.slaDueLocal} ${ent.zone}`,
        });
      }
    }
  }

  breaches.sort((a, b) => a.instant - b.instant);
  return breaches;
}

/** 取 instant 所在日期、实体时区下每日 HH:mm 交付点的 UTC 瞬间。 */
function dailyDueInstant(instant, hhmm, zone) {
  const { wall } = formatInZone(instant, zone);
  const [date] = wall.split('T');
  const probe = `${date}T${hhmm.length === 5 ? hhmm + ':00' : hhmm}`;
  return resolveWallTime(probe, zone).instant;
}

/** 单条事件的证据权重与说明。 */
function signalOf(ev) {
  switch (ev.type) {
    case 'failure':
      return { weight: 40, detail: ev.message || '任务失败' };
    case 'delay':
      return {
        weight: Math.min(30, 10 + (ev.delayMinutes ?? 0) * 0.5),
        detail: `数据延迟 ${ev.delayMinutes ?? '?'} 分钟${ev.message ? '：' + ev.message : ''}`,
      };
    case 'resource_wait':
      return {
        weight: Math.min(25, 8 + (ev.waitMinutes ?? 0) * 0.4),
        detail: `资源等待 ${ev.waitMinutes ?? '?'} 分钟${ev.message ? '：' + ev.message : ''}`,
      };
    case 'retry':
      return { weight: 10, detail: ev.message || '任务重试' };
    case 'impact':
      return { weight: 12, detail: ev.message || '业务影响事件' };
    default:
      return null;
  }
}

/**
 * 对单个违约计算全部根因候选。
 * 候选集 = 违约实体自身 + 图上全部祖先（上游）。
 */
export function findCandidates(built, breach) {
  const { graph, events, duplicateOf } = built;
  const ancestorIds = graph.ancestors(breach.entityId);
  const candidateIds = [breach.entityId, ...ancestorIds];

  const candidates = candidateIds.map((entityId) => {
    const path = graph.pathBetween(breach.entityId, entityId); // 违约实体 -> 上游
    const hops = path.length - 1;
    const pathEdges = path.slice(1).map((to, i) => graph.edge(path[i], to));
    const pathCritical = pathEdges.every((e) => e?.critical ?? true);

    const evidence = [];
    let signalScore = 0;
    let retryCount = 0;
    let contributionMinutes = 0;
    let latestSignalAt = null;

    for (const ev of events) {
      if (ev.entityId !== entityId) continue;
      if (duplicateOf.has(ev.id)) continue; // 重复告警不计入证据
      if (ev.instant > breach.instant) continue; // 因果时序：证据必须早于违约
      if (breach.instant - ev.instant > LOOKBACK_MS) continue;

      const sig = signalOf(ev);
      if (!sig) continue;
      let weight = sig.weight;
      if (ev.type === 'retry') {
        retryCount += 1;
        if (retryCount > 1) weight = 5; // 多次重试证据边际递减
      }
      signalScore += weight;
      latestSignalAt = Math.max(latestSignalAt ?? ev.instant, ev.instant);
      evidence.push({
        eventId: ev.id,
        type: ev.type,
        instant: ev.instant,
        localTime: ev.localTime,
        zone: ev.zone,
        weight: Math.round(weight * 10) / 10,
        detail: sig.detail,
      });
      if (ev.type === 'delay') contributionMinutes = Math.max(contributionMinutes, ev.delayMinutes ?? 0);
      if (ev.type === 'resource_wait') contributionMinutes = Math.max(contributionMinutes, ev.waitMinutes ?? 0);
      if (ev.type === 'failure' && ev.delayMinutes != null) {
        contributionMinutes = Math.max(contributionMinutes, ev.delayMinutes);
      }
    }

    signalScore = Math.min(60, signalScore);
    const propagation = Math.pow(0.92, hops);
    const criticality = pathCritical ? 1.15 : 0.85;
    const score = Math.round(signalScore * propagation * criticality * 10) / 10;

    // 证据强度分级（机器判断）
    let machineStrength;
    if (evidence.length === 0) {
      machineStrength = 'unconfirmed';
    } else if (signalScore >= CONFIRMED_SCORE && pathCritical) {
      machineStrength = 'confirmed';
    } else if (signalScore >= PROBABLE_SCORE) {
      machineStrength = 'probable';
    } else {
      machineStrength = 'unconfirmed';
    }

    return {
      breachId: breach.id,
      entityId,
      score,
      machineStrength,
      strength: machineStrength, // 无人工判定时与机器判断一致
      humanVerdict: null,
      evidence,
      path,
      pathCritical,
      hops,
      contributionMinutes,
      latestSignalAt,
      changedFromPrev: false,
    };
  });

  candidates.sort((a, b) => b.score - a.score || a.hops - b.hops || a.entityId.localeCompare(b.entityId));
  return candidates;
}

/**
 * 合并人工判定（黏滞规则）：
 * - 人工已确认/已排除的候选，strength 以人工为准，机器结果另存 machineStrength；
 * - 新证据可以改变分数、新增候选，但不会覆盖人工结论，仅置 machineDiffers 标记；
 * - 人工判定时引用的候选若因图变更消失，保留在 orphanJudgments 中可审计。
 */
export function applyJudgments(candidates, priorJudgments = []) {
  const byKey = new Map(priorJudgments.map((j) => [candidateKey(j), j]));
  const orphanJudgments = [];
  const seen = new Set();

  for (const c of candidates) {
    const key = candidateKey(c);
    seen.add(key);
    const j = byKey.get(key);
    if (!j) continue;
    c.humanVerdict = {
      verdict: j.verdict, // confirmed | rejected
      by: j.by,
      at: j.at,
      note: j.note || '',
      version: j.version || null,
    };
    c.strength = j.verdict === 'confirmed' ? 'confirmed' : 'rejected';
    c.machineDiffers = c.machineStrength !== 'confirmed' && j.verdict === 'confirmed'
      ? true
      : j.verdict === 'rejected' && c.machineStrength === 'confirmed';
  }

  for (const j of priorJudgments) {
    if (!seen.has(candidateKey(j))) orphanJudgments.push(j);
  }
  return orphanJudgments;
}

/** 计算违约对下游业务服务的影响链（违约实体自身为服务时也纳入）。 */
export function impactChain(built, breach) {
  const { graph, events } = built;
  const reach = graph.reachableDownstream(breach.entityId);
  const self = built.entityById.get(breach.entityId);
  if (self.type === 'service') reach.set(breach.entityId, [breach.entityId]);

  const impacted = [];
  for (const [entityId, path] of reach) {
    const ent = built.entityById.get(entityId);
    if (ent.type !== 'service') continue;
    const impactEvents = events.filter(
      (e) => e.entityId === entityId && e.type === 'impact' && e.instant >= breach.instant - HOUR_MS,
    );
    const pathEdges = path.slice(1).map((to, i) => graph.edge(path[i], to));
    impacted.push({
      entityId,
      name: ent.name,
      path,
      pathCritical: pathEdges.every((e) => e?.critical ?? true),
      impactEvents: impactEvents.map((e) => ({
        eventId: e.id,
        instant: e.instant,
        severity: e.severity,
        message: e.message,
      })),
    });
  }
  return impacted;
}

/**
 * 完整分析：输出可序列化、可存档的版本快照。
 * @param prior 上一版分析结果（用于 changedFromPrev 标记与人工判定继承）
 */
export function analyzeCase(built, prior = null) {
  const priorByIdx = new Map();
  if (prior?.candidates) {
    for (const list of Object.values(prior.candidates)) {
      for (const c of list) priorByIdx.set(candidateKey(c), c);
    }
  }
  const priorJudgments = prior?.judgments || [];

  const candidatesByBreach = {};
  const orphanSeen = new Set();
  const orphanJudgments = [];
  for (const breach of built.breaches) {
    const list = findCandidates(built, breach);
    const orphans = applyJudgments(list, priorJudgments);
    for (const j of orphans) {
      const key = candidateKey(j);
      if (!orphanSeen.has(key)) {
        orphanSeen.add(key);
        orphanJudgments.push(j);
      }
    }
    for (const c of list) {
      const prev = priorByIdx.get(candidateKey(c));
      if (prev) {
        c.changedFromPrev =
          prev.score !== c.score ||
          prev.machineStrength !== c.machineStrength ||
          prev.contributionMinutes !== c.contributionMinutes;
      } else {
        c.changedFromPrev = true; // 本版新增候选
      }
    }
    candidatesByBreach[breach.id] = list;
  }

  const impacts = {};
  for (const breach of built.breaches) {
    impacts[breach.id] = impactChain(built, breach);
  }

  const stats = summarize(built, candidatesByBreach);

  return {
    version: prior ? prior.version + 1 : 1,
    computedAt: new Date().toISOString(),
    caseId: built.caseId,
    breaches: built.breaches,
    candidates: candidatesByBreach,
    impacts,
    duplicateGroups: built.duplicateGroups,
    tzWarnings: built.tzWarnings,
    judgments: priorJudgments,
    // 图/违约结构变化后失去对应候选的人工判定：保留留档，不静默丢弃
    orphanJudgments,
    stats,
  };
}

function summarize(built, candidatesByBreach) {
  const all = Object.values(candidatesByBreach).flat();
  return {
    entityCount: built.entities.length,
    eventCount: built.events.length,
    duplicateCount: built.duplicateGroups.reduce((n, g) => n + g.duplicateIds.length, 0),
    breachCount: built.breaches.length,
    confirmedRoots: all.filter((c) => c.strength === 'confirmed').length,
    unconfirmedRoots: all.filter((c) => c.strength === 'unconfirmed').length,
    rejectedRoots: all.filter((c) => c.strength === 'rejected').length,
  };
}

/** 两版分析的结构化 diff，供前端「版本对比」展示。 */
export function diffVersions(vOld, vNew) {
  const idx = (v) => {
    const m = new Map();
    for (const list of Object.values(v.candidates)) for (const c of list) m.set(candidateKey(c), c);
    return m;
  };
  const oldMap = idx(vOld);
  const newMap = idx(vNew);
  const added = [], removed = [], changed = [];

  for (const [key, c] of newMap) {
    const o = oldMap.get(key);
    if (!o) added.push({ key, candidate: c });
    else if (o.score !== c.score || o.machineStrength !== c.machineStrength || o.strength !== c.strength) {
      changed.push({
        key,
        score: [o.score, c.score],
        machineStrength: [o.machineStrength, c.machineStrength],
        strength: [o.strength, c.strength],
        humanVerdictKept: !!c.humanVerdict && c.strength === c.humanVerdict.verdict,
      });
    }
  }
  for (const [key, c] of oldMap) {
    if (!newMap.has(key)) removed.push({ key, candidate: c });
  }
  return {
    fromVersion: vOld.version,
    toVersion: vNew.version,
    added,
    removed,
    changed,
    breachCount: [vOld.breaches.length, vNew.breaches.length],
    duplicateCount: [vOld.stats.duplicateCount, vNew.stats.duplicateCount],
  };
}

/** 供 UI/日志复用的格式化。 */
export function formatEvidenceTime(ev) {
  return formatInstant(ev.instant, ev.zone);
}

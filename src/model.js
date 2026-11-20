/**
 * 领域模型：实体规范化、枚举与校验。
 *
 * 输入（sample-data.json 等）使用面向人类的字段；引擎内部统一转为
 * 带 id / UTC 瞬间的规范结构。原始字段全部保留，便于审计回放。
 */

import { resolveWallTime } from './time.js';

export const ENTITY_TYPES = Object.freeze({
  task: {
    label: '任务',
    kinds: ['sla', 'etl', 'compute'],
    slaApplicable: true,
  },
  dataset: {
    label: '数据集',
    kinds: ['source', 'intermediate', 'report'],
    slaApplicable: false,
  },
  resource: {
    label: '资源',
    kinds: ['queue', 'compute_pool', 'storage', 'network'],
    slaApplicable: false,
  },
  service: {
    label: '业务服务',
    kinds: ['report', 'api', 'pipeline'],
    slaApplicable: true,
  },
});

export const RELATION_TYPES = Object.freeze({
  depends_on: { label: '依赖', causal: true },
  produces: { label: '产出', causal: true, reverse: 'depends_on' },
  waits_for: { label: '等待资源', causal: true },
  serves: { label: '服务于', causal: true, reverse: 'served_by' },
  served_by: { label: '支撑', causal: false, reverse: 'serves' },
});

export const EVENT_TYPES = Object.freeze({
  delay: { label: '数据延迟', category: 'data', icon: '🐢' },
  failure: { label: '任务失败', category: 'execution', icon: '💥' },
  retry: { label: '重试', category: 'execution', icon: '🔁' },
  resource_wait: { label: '资源等待', category: 'resource', icon: '⏸' },
  resource_release: { label: '资源释放', category: 'resource', icon: '▶' },
  arrival: { label: '数据到达', category: 'data', icon: '📥' },
  start: { label: '任务启动', category: 'execution', icon: '🚀' },
  finish: { label: '任务完成', category: 'execution', icon: '✅' },
  sla_breach: { label: 'SLA 违约', category: 'impact', icon: '🚨' },
  impact: { label: '业务影响', category: 'impact', icon: '📉' },
  action: { label: '处置动作', category: 'remediation', icon: '🛠' },
});

export const EVIDENCE_STRENGTH = Object.freeze({
  confirmed: { label: '证据充分', rank: 3 },
  probable: { label: '高度疑似', rank: 2 },
  unconfirmed: { label: '待确认', rank: 1 },
});

export const REMEDIATION_STATUSES = Object.freeze([
  'open', // 待处理
  'investigating', // 排查中
  'mitigated', // 已缓解
  'resolved', // 已解决
  'accepted', // 已接受（风险接受/预期内）
]);

export const REMEDIATION_LABELS = Object.freeze({
  open: '待处理',
  investigating: '排查中',
  mitigated: '已缓解',
  resolved: '已解决',
  accepted: '已接受',
});

export const SEVERITY_LABELS = Object.freeze({
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
});

let seq = 0;
export function uid(prefix) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** 规范化单个实体输入。 */
export function normalizeEntity(raw) {
  if (!raw || !raw.id) throw new Error(`实体缺少 id: ${JSON.stringify(raw)}`);
  const def = ENTITY_TYPES[raw.type];
  if (!def) throw new Error(`实体 ${raw.id} 的类型非法: ${raw.type}`);
  if (raw.kind && !def.kinds.includes(raw.kind)) {
    throw new Error(`实体 ${raw.id} 的 kind=${raw.kind} 不属于类型 ${raw.type}`);
  }
  return {
    id: raw.id,
    type: raw.type,
    kind: raw.kind || def.kinds[0],
    name: raw.name || raw.id,
    owner: raw.owner || null,
    zone: raw.zone || 'UTC',
    slaMinutes: raw.slaMinutes ?? null,
    metadata: raw.metadata || {},
    raw,
  };
}

/** 规范化单条关系。内部统一存为 from ->(depends_on/waits_for/serves/produces)-> to 的有向边。 */
export function normalizeRelation(raw) {
  if (!raw.from || !raw.to || !raw.type) {
    throw new Error(`关系缺少 from/to/type: ${JSON.stringify(raw)}`);
  }
  if (!RELATION_TYPES[raw.type]) throw new Error(`关系类型非法: ${raw.type}`);
  return {
    from: raw.from,
    to: raw.to,
    type: raw.type,
    critical: raw.critical ?? (raw.type === 'depends_on' || raw.type === 'waits_for'),
    note: raw.note || '',
  };
}

/**
 * 规范化单条原始事件：把本地挂钟时间解析为 UTC 瞬间。
 * 解析告警（夏令时歧义/缺口）挂在 tzWarning 上，不阻断入库。
 */
export function normalizeEvent(raw, entityZone = 'UTC') {
  if (!raw.id) throw new Error(`事件缺少 id: ${JSON.stringify(raw)}`);
  if (!EVENT_TYPES[raw.type]) throw new Error(`事件 ${raw.id} 的类型非法: ${raw.type}`);
  if (!raw.entityId) throw new Error(`事件 ${raw.id} 缺少 entityId`);
  const zone = raw.zone || entityZone;
  const resolved = resolveWallTime(raw.localTime, zone);
  return {
    id: raw.id,
    type: raw.type,
    entityId: raw.entityId,
    localTime: raw.localTime,
    zone,
    instant: resolved.instant,
    tzWarning: resolved.status === 'ok' ? null : resolved.message,
    delayMinutes: raw.delayMinutes ?? null,
    waitMinutes: raw.waitMinutes ?? null,
    severity: raw.severity || null,
    message: raw.message || '',
    source: raw.source || 'manual',
    fingerprintKey: raw.fingerprintKey || null,
    raw,
  };
}

/** 根因候选的持久化形态（仓库里保存的判断结果）。 */
export function candidateKey(c) {
  return `${c.breachId}::${c.entityId}`;
}

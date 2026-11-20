/**
 * 重复事件识别。
 *
 * 同一监控系统对同一故障常重复告警（重试/重复推送/多区域镜像）。
 * 判定规则（全部满足才算重复）：
 *   1. 同一 entityId + 同一 type；
 *   2. 来源系统相同（source），或显式带有相同 fingerprintKey；
 *   3. UTC 瞬间落在时间窗 windowMs 内（默认 30 分钟）；
 *   4. 描述文本归一化后相同，或二者共用 fingerprintKey。
 *
 * 跨时区事件先经 model.js 解析为 UTC 瞬间再比较，因此
 * "09:05 UTC+08" 与 "01:05 UTC" 这类镜像事件可被正确识别。
 */

const DEFAULT_WINDOW_MS = 30 * 60_000;

function textFingerprint(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[#\d]{2,}/g, '#') // 忽略重试序号、数字噪声（attempt 3、#1234）
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {Array} events 已规范化（含 instant）的事件
 * @param {{windowMs?: number}} opts
 * @returns {{ groups: Array<{primaryId, duplicateIds, reason}>, duplicateOf: Map<string,string> }}
 */
export function detectDuplicates(events, opts = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const buckets = new Map();

  for (const ev of events) {
    // 带指纹键时跨来源系统全局分桶（镜像告警来自不同 monitor 也必须归并）；
    // 否则按来源系统分桶，避免把不同系统的巧合同名事件误并
    const key = ev.fingerprintKey
      ? `fp:${ev.fingerprintKey}|${ev.entityId}|${ev.type}`
      : `${ev.entityId}|${ev.type}|${ev.source}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(ev);
  }

  const groups = [];
  const duplicateOf = new Map();

  for (const bucket of buckets.values()) {
    const sorted = [...bucket].sort((a, b) => a.instant - b.instant || a.id.localeCompare(b.id));
    let cluster = [];

    const flush = (reason) => {
      if (cluster.length > 1) {
        const primary = cluster[0];
        const duplicateIds = cluster.slice(1).map((e) => e.id);
        for (const id of duplicateIds) duplicateOf.set(id, primary.id);
        groups.push({ primaryId: primary.id, duplicateIds, reason });
      }
      cluster = [];
    };

    for (const ev of sorted) {
      if (cluster.length === 0) {
        cluster = [ev];
        continue;
      }
      const anchor = cluster[0];
      const inWindow = ev.instant - anchor.instant <= windowMs;
      const sameFp = anchor.fingerprintKey && ev.fingerprintKey && anchor.fingerprintKey === ev.fingerprintKey;
      const sameText = textFingerprint(anchor.message) === textFingerprint(ev.message);
      if (inWindow && (sameFp || sameText)) {
        cluster.push(ev);
      } else {
        flush(anchor.fingerprintKey ? '相同指纹键' : '时间窗内同源重复告警');
        cluster = [ev];
      }
    }
    flush(cluster[0]?.fingerprintKey ? '相同指纹键' : '时间窗内同源重复告警');
  }

  return { groups, duplicateOf };
}

/** 去重后的事件视图：每组只保留最早一条，重复事件附 _duplicateOf。 */
export function dedupeEvents(events, opts = {}) {
  const { duplicateOf } = detectDuplicates(events, opts);
  return events
    .filter((e) => !duplicateOf.has(e.id))
    .map((e) => ({ ...e, _duplicateOf: null }));
}

import { el, fmtDualZone, EVENT_META } from './api.js';

/**
 * 时间线视图。
 * 每个违约一个区块：违约标记置顶，其前 12 小时窗口内的全部事件按 UTC 排序。
 * 重复事件折叠为半透明条目并标明主事件；DST 告警挂黄色标签。
 */
export function renderTimeline(view, root) {
  const { events, analysis, duplicateOf, entities } = view;
  const entityById = Object.fromEntries(entities.map((e) => [e.id, e]));
  root.innerHTML = '';

  if (!analysis.breaches.length) {
    root.appendChild(el('div', { class: 'empty' }, '当前没有识别到 SLA 违约。'));
    return;
  }

  for (const breach of analysis.breaches) {
    const block = el('div', { class: 'breach-block' });
    const ent = entityById[breach.entityId];

    const head = el('div', { class: 'breach-head' }, [
      el('h3', {}, `🚨 ${ent?.name || breach.entityId}`),
      el('span', { class: `pill ${breach.severity}` }, breach.severity === 'critical' ? '严重' : '高影响'),
      el('span', { class: `pill ${breach.source}` }, breach.source === 'explicit' ? '显式告警' : 'SLA 推导'),
      el('span', { class: 'contrib' },
        breach.overdueMinutes != null ? `逾期 ${breach.overdueMinutes} 分钟` : ''),
    ]);
    block.appendChild(head);

    const marker = el('div', { class: 'breach-marker' }, [
      el('div', { html: `<b>${breach.message}</b>` }),
      el('div', { class: 'tl-msg' },
        breach.expectedDue
          ? `应交付 ${fmtDualZone(breach.expectedDue, ent?.zone || 'UTC').local} ｜ 实际 ${fmtDualZone(breach.actualInstant, ent?.zone || 'UTC').local}`
          : `发生于 ${fmtDualZone(breach.instant, ent?.zone || 'UTC').local}`),
    ]);
    block.appendChild(marker);

    const windowStart = breach.instant - 12 * 3600_000;
    const inWindow = events.filter((e) => e.instant <= breach.instant && e.instant >= windowStart);

    const tl = el('div', { class: 'timeline' });
    for (const ev of inWindow) {
      const meta = EVENT_META[ev.type] || { label: ev.type, cat: '', icon: '❓' };
      const dupOf = duplicateOf[ev.id];
      const { main, local } = fmtDualZone(ev.instant, ev.zone);
      const owner = entityById[ev.entityId];

      const item = el('div', { class: `tl-item cat-${meta.cat}${dupOf ? ' duplicate' : ''}` });
      item.appendChild(el('div', {}, [
        el('span', { class: 'tl-time' }, main),
        el('span', { class: 'tl-zone' }, `原始: ${local} @${ev.zone}`),
      ]));
      item.appendChild(el('div', { class: 'tl-title' }, [
        `${meta.icon} ${meta.label} · ${owner?.name || ev.entityId}`,
        dupOf ? el('span', { class: 'tl-tag dup' }, `重复事件 → 主事件 ${dupOf}`) : null,
        ev.tzWarning ? el('span', { class: 'tl-tag tzwarn', title: ev.tzWarning }, '⚠ 夏令时告警') : null,
      ]));
      if (ev.message) item.appendChild(el('div', { class: 'tl-msg' }, ev.message));
      if ((ev.delayMinutes ?? ev.waitMinutes) != null) {
        item.appendChild(el('div', { class: 'tl-msg' },
          `影响时长 ${ev.delayMinutes ?? ev.waitMinutes} 分钟 ｜ 来源: ${ev.source}`));
      }
      tl.appendChild(item);
    }
    block.appendChild(tl);
    root.appendChild(block);
  }

  // 时区告警汇总（可能落在窗口外，如历史探针）
  const warns = analysis.tzWarnings || [];
  if (warns.length) {
    const box = el('div', { class: 'banner warn' });
    box.innerHTML = `<b>⚠ 时区解析告警（${warns.length}）</b>：以下事件的本地时间落在夏令时缺口/回拨区间，已按规则归一，鼠标悬停时间线标签可查看详情。`;
    box.appendChild(el('ul', { style: 'margin:6px 0 0 18px' },
      warns.map((w) => el('li', {}, `${w.eventId}：${w.message}`))));
    root.prepend(box);
  }
}

import {
  el, api, toast, fmtInstant, fmtDualZone,
  STRENGTH_META, EVENT_META,
} from './api.js';

let selectedBreachId = null;
let onPathHighlight = null;

export function setPathHighlightHandler(fn) {
  onPathHighlight = fn;
}

export function renderCandidates(view, root) {
  const { analysis, entities } = view;
  const entityById = Object.fromEntries(entities.map((e) => [e.id, e]));
  root.innerHTML = '';

  if (!selectedBreachId || !analysis.candidates[selectedBreachId]) {
    selectedBreachId = analysis.breaches[0]?.id ?? null;
  }

  // 违约切换器
  const selector = el('div', { class: 'breach-selector' });
  for (const b of analysis.breaches) {
    const ent = entityById[b.entityId];
    const chip = el('button', {
      class: `breach-chip${b.id === selectedBreachId ? ' active' : ''}`,
      onclick: () => {
        selectedBreachId = b.id;
        renderCandidates(view, root);
      },
    }, [
      el('div', { class: 't' }, `🚨 ${ent?.name || b.entityId}`),
      el('div', { class: 's' },
        `${fmtInstant(b.instant)} ｜ ${b.overdueMinutes != null ? `逾期 ${b.overdueMinutes} 分钟` : ''}`),
    ]);
    selector.appendChild(chip);
  }
  root.appendChild(selector);

  const candidates = analysis.candidates[selectedBreachId] || [];
  const impacts = analysis.impacts[selectedBreachId] || [];

  // 业务影响链
  if (impacts.length) {
    for (const imp of impacts) {
      const box = el('div', { class: 'impact-box' }, [
        el('h4', {}, `📉 业务影响：${imp.name}（${imp.entityId}）`),
        el('div', { class: 'cand-path' },
          '传导链：' + imp.path.map((id) => entityById[id]?.name || id).join(' → ') +
          (imp.pathCritical ? '' : '（含非关键路径）')),
        ...imp.impactEvents.map((ie) =>
          el('div', { style: 'margin-top:6px' },
            `${fmtInstant(ie.instant)} ｜ [${ie.severity || '影响'}] ${ie.message}`)),
      ]);
      root.appendChild(box);
    }
  }

  // 分级汇总
  const counts = candidates.reduce((acc, c) => {
    acc[c.strength] = (acc[c.strength] || 0) + 1;
    return acc;
  }, {});
  root.appendChild(el('div', { class: 'panel-hint', style: 'margin-top:14px' },
    `共 ${candidates.length} 个根因候选：证据充分 ${counts.confirmed || 0} ｜ 高度疑似 ${counts.probable || 0} ｜ 待确认 ${counts.unconfirmed || 0} ｜ 人工排除 ${counts.rejected || 0}。评分综合了证据权重、传导跳数衰减与路径关键性。`));

  for (const c of candidates) {
    root.appendChild(renderCandidate(c, view, selectedBreachId, entityById));
  }
}

function renderCandidate(c, view, breachId, entityById) {
  const meta = STRENGTH_META[c.strength];
  const ent = entityById[c.entityId];
  const card = el('div', { class: `candidate ${meta.cls}` });

  const pathText = c.path
    .map((id, i) => {
      const name = entityById[id]?.name || id;
      return i === 0 ? `<b>${escapeHtml(name)}</b>` : escapeHtml(name);
    })
    .join(' → ');

  const head = el('div', {
    class: 'cand-head',
    onclick: () => body.classList.toggle('hidden'),
  }, [
    el('span', { class: 'cand-name' }, `${ent?.name || c.entityId}`),
    el('span', { class: `pill ${meta.cls}` }, meta.label + (c.humanVerdict ? '（人工）' : '')),
    el('span', { class: 'cand-score' }, `评分 ${c.score}`),
    el('span', { class: 'cand-path', html: pathText + (c.pathCritical ? '' : ' · 非关键路径') }),
    el('span', { class: 'contrib' },
      c.contributionMinutes ? `贡献 ${c.contributionMinutes} 分钟` : ''),
  ]);

  const body = el('div', { class: 'cand-body' });

  // 证据列表
  if (c.evidence.length) {
    body.appendChild(el('div', { style: 'margin-top:10px;font-weight:600;font-size:13px' },
      `支撑证据（${c.evidence.length}，重复事件已剔除）`));
    const ul = el('ul', { class: 'evidence-list' });
    for (const ev of c.evidence) {
      const em = EVENT_META[ev.type] || { icon: '❓', label: ev.type };
      const { local } = fmtDualZone(ev.instant, ev.zone);
      ul.appendChild(el('li', {}, [
        el('span', { class: 'ev-time' }, local),
        el('span', {}, `${em.icon} ${em.label}：${ev.detail}`),
        el('span', { class: 'ev-w' }, `权重 +${ev.weight}`),
      ]));
    }
    body.appendChild(ul);
  } else {
    body.appendChild(el('div', { class: 'no-evidence' },
      '⚠ 违约窗口内没有该实体的直接故障证据 —— 仅因依赖关系列为候选，需补充证据确认。'));
  }

  // 人工判定黏滞 + 机器分歧
  if (c.humanVerdict) {
    body.appendChild(el('div', { class: 'human-note' },
      `🧑‍⚖️ 人工${c.humanVerdict.verdict === 'confirmed' ? '确认' : '排除'}：${c.humanVerdict.by} ｜ v${c.humanVerdict.version} ｜ ${c.humanVerdict.note || '无备注'}`));
  }
  if (c.machineDiffers) {
    body.appendChild(el('div', { class: 'machine-diff' },
      `⚙ 机器当前判断为「${STRENGTH_META[c.machineStrength].label}」，与人工结论不一致 —— 重算不会覆盖人工判断，分歧保留待复核。`));
  }
  if (c.changedFromPrev && view.currentVersion > 1) {
    body.appendChild(el('div', { class: 'machine-diff', style: 'background:#eaf0ff;border-color:#b7c9f8;color:#243f9e' },
      '↻ 本候选在最近一次重算中有新增证据或评分变化。'));
  }

  // 操作区
  const actions = el('div', { class: 'cand-actions', style: 'margin-top:10px' });
  const confirmBtn = el('button', {
    class: 'btn tiny primary',
    onclick: async (e) => {
      e.stopPropagation();
      const note = prompt('确认为根因的依据（可选）：', c.humanVerdict?.note || '');
      if (note === null) return;
      await judge(breachId, c.entityId, 'confirmed', note, view);
    },
  }, '✓ 人工确认');
  const rejectBtn = el('button', {
    class: 'btn tiny danger',
    onclick: async (e) => {
      e.stopPropagation();
      const note = prompt('排除该候选的依据（可选）：', c.humanVerdict?.note || '');
      if (note === null) return;
      await judge(breachId, c.entityId, 'rejected', note, view);
    },
  }, '✕ 人工排除');
  const pathBtn = el('button', {
    class: 'btn tiny ghost',
    onclick: (e) => {
      e.stopPropagation();
      onPathHighlight?.(c.path);
    },
  }, '🔗 在依赖图高亮此链');
  actions.append(confirmBtn, rejectBtn, pathBtn);
  body.appendChild(actions);

  card.append(head, body);
  return card;
}

async function judge(breachId, entityId, verdict, note, view) {
  try {
    await api.addJudgment({ breachId, entityId, verdict, by: 'analyst@web', note });
    toast('人工判定已保存，该结论将在后续重算中黏滞保留');
    await view.reload();
  } catch (err) {
    toast(err.message, true);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

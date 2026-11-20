import { el, api, toast, STRENGTH_META } from './api.js';

/**
 * 版本对比视图。
 * 历史版本快照不可变；选择两版后展示：新增/消失候选、评分与强度变化，
 * 并明确标出「人工判定已保留」的条目，证明重算不覆盖原判断。
 */
export function renderVersions(view, root, dialog) {
  root.innerHTML = '';
  const meta = view.versionMeta;

  root.appendChild(el('div', { class: 'panel-hint' },
    '每次新增证据或写入人工判定都会产生不可变版本快照。选择任意两版进行结构化对比。'));

  const grid = el('div', { class: 'version-grid' });
  for (const m of [...meta].reverse()) {
    const s = m.stats;
    grid.appendChild(el('div', {
      class: `version-card${m.version === view.currentVersion ? ' current' : ''}`,
    }, [
      el('h4', {}, `v${m.version}${m.version === view.currentVersion ? '（当前）' : ''}`),
      el('div', { class: 'contrib' }, new Date(m.computedAt).toLocaleString('zh-CN')),
      el('ul', { style: 'margin:8px 0 0;padding-left:18px;font-size:13px' }, [
        el('li', {}, `违约 ${s.breachCount} ｜ 事件 ${s.eventCount}（重复折叠 ${s.duplicateCount}）`),
        el('li', {}, `证据充分 ${s.confirmedRoots} ｜ 待确认 ${s.unconfirmedRoots} ｜ 人工排除 ${s.rejectedRoots}`),
      ]),
    ]));
  }
  root.appendChild(grid);

  const controls = el('div', { class: 'diff-controls', style: 'margin-top:20px' });
  const fromSel = el('select', {}, meta.map((m) => el('option', { value: m.version }, `v${m.version}`)));
  const toSel = el('select', {},
    meta.map((m) => el('option', {
      value: m.version,
      ...(m.version === view.currentVersion ? { selected: '' } : {}),
    }, `v${m.version}`)));
  controls.append(
    el('span', { style: 'font-weight:600' }, '对比'),
    fromSel, el('span', {}, '→'), toSel,
    el('button', {
      class: 'btn tiny primary',
      onclick: async () => {
        try {
          const d = await api.diff(fromSel.value, toSel.value);
          showDiff(d, dialog);
        } catch (err) {
          toast(err.message, true);
        }
      },
    }, '生成对比'),
  );
  root.appendChild(controls);
}

function showDiff(d, dialog) {
  const body = el('div', { class: 'dialog-body' });
  body.appendChild(el('h2', {}, `版本对比：v${d.fromVersion} → v${d.toVersion}`));
  body.appendChild(el('p', { class: 'dialog-hint' },
    `违约数 ${d.breachCount[0]} → ${d.breachCount[1]} ｜ 重复事件 ${d.duplicateCount[0]} → ${d.duplicateCount[1]}`));

  const table = el('table', { class: 'diff-table' });
  table.appendChild(el('thead', {}, el('tr', {}, [
    el('th', {}, '候选'), el('th', {}, '变化'), el('th', {}, '人工判定'),
  ])));
  const tbody = el('tbody');

  for (const a of d.added) {
    tbody.appendChild(el('tr', {}, [
      el('td', {}, a.key),
      el('td', {}, `🆕 新增候选，评分 ${a.candidate.score}（${STRENGTH_META[a.candidate.strength].label}）`),
      el('td', {}, a.candidate.humanVerdict ? '已保留' : '—'),
    ]));
  }
  for (const r of d.removed) {
    tbody.appendChild(el('tr', {}, [
      el('td', {}, r.key),
      el('td', {}, '❌ 候选消失（实体/违约结构变化）'),
      el('td', {}, r.candidate.humanVerdict ? '判定留档可审计' : '—'),
    ]));
  }
  for (const c of d.changed) {
    tbody.appendChild(el('tr', {}, [
      el('td', {}, c.key),
      el('td', {}, [
        el('div', {}, `评分 ${c.score[0]} → ${c.score[1]}`),
        el('div', { class: 'contrib' },
          `机器判断 ${STRENGTH_META[c.machineStrength[0]].label} → ${STRENGTH_META[c.machineStrength[1]].label}`),
      ]),
      el('td', {}, c.humanVerdictKept
        ? el('span', { class: 'pill confirmed' }, '✓ 人工判定未被覆盖')
        : '—'),
    ]));
  }
  if (!d.added.length && !d.removed.length && !d.changed.length) {
    tbody.appendChild(el('tr', {}, el('td', { colspan: '3', class: 'empty' }, '两版之间没有候选层面的差异。')));
  }
  table.appendChild(tbody);
  body.appendChild(table);
  body.appendChild(el('div', { class: 'dialog-actions' },
    el('button', { class: 'btn primary', onclick: () => dialog.close() }, '关闭')));

  dialog.innerHTML = '';
  dialog.appendChild(body);
  dialog.showModal();
}

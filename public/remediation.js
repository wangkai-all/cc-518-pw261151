import { el, api, toast, fmtInstant, STATUS_META, STATUS_FLOW } from './api.js';

/** 处置工单：状态机（非法迁移在后端拒绝）、负责人指派、流转历史。 */
export function renderRemediation(view, root) {
  root.innerHTML = '';
  const { remediation, analysis, entities } = view;
  const entityById = Object.fromEntries(entities.map((e) => [e.id, e]));

  for (const breach of analysis.breaches) {
    const ticket = remediation[breach.id];
    if (!ticket) continue;
    const ent = entityById[breach.entityId];
    const card = el('div', { class: 'rem-card' });

    const head = el('div', { class: 'rem-head' }, [
      el('h3', { style: 'margin:0;font-size:15px' }, `🛠 ${ent?.name || breach.entityId} 的处置工单`),
      el('span', { class: `pill ${(STATUS_META[ticket.status] || {}).cls || ''}` },
        STATUS_META[ticket.status]?.label || ticket.status),
      el('span', { class: 'contrib' }, `负责人：${ticket.owner || '未指派'}`),
    ]);
    card.appendChild(head);

    // 状态机
    const flow = el('div', { class: 'status-flow' });
    const allStatuses = ['open', 'investigating', 'mitigated', 'resolved', 'accepted'];
    const allowed = STATUS_FLOW[ticket.status] || [];
    for (const s of allStatuses) {
      const isCurrent = s === ticket.status;
      const isAllowed = allowed.includes(s);
      const step = el('button', {
        class: `status-step${isCurrent ? ' current' : ''}${isAllowed ? ' allowed' : ''}`,
        ...(isAllowed ? {
          onclick: async () => {
            const note = prompt(`流转到「${STATUS_META[s].label}」的备注（可选）：`, '');
            if (note === null) return;
            try {
              await api.transition(breach.id, { to: s, by: 'analyst@web', note });
              toast(`状态已流转：${STATUS_META[ticket.status].label} → ${STATUS_META[s].label}`);
              await view.reload();
            } catch (err) {
              toast(err.message, true);
            }
          },
        } : {}),
      }, STATUS_META[s].label);
      flow.appendChild(step);
    }
    card.appendChild(flow);

    // 指派
    const assignRow = el('div', { class: 'assign-row' }, [
      el('input', {
        placeholder: '输入负责人名字',
        value: ticket.owner || '',
        id: `owner-${breach.id}`,
        style: 'max-width:220px',
      }),
      el('button', {
        class: 'btn tiny',
        onclick: async () => {
          const owner = document.getElementById(`owner-${breach.id}`).value.trim();
          try {
            await api.assign(breach.id, owner || null);
            toast(owner ? `已指派给 ${owner}` : '已取消指派');
            await view.reload();
          } catch (err) {
            toast(err.message, true);
          }
        },
      }, '指派负责人'),
    ]);
    card.appendChild(assignRow);

    // 历史
    const history = el('ul', { class: 'history' });
    for (const h of [...ticket.history].reverse()) {
      history.appendChild(el('li', {}, [
        el('div', {}, [
          el('span', { class: 'h-time' }, fmtInstant(Date.parse(h.at))),
          ` · ${h.by} · ${h.from ? STATUS_META[h.from]?.label || h.from : '—'} → ${STATUS_META[h.to]?.label || h.to}`,
        ]),
        h.note ? el('div', { class: 'tl-msg' }, h.note) : null,
      ]));
    }
    card.appendChild(el('div', { style: 'margin-top:12px;font-weight:600;font-size:13px' }, '流转历史'));
    card.appendChild(history);
    root.appendChild(card);
  }

  if (!analysis.breaches.length) {
    root.appendChild(el('div', { class: 'empty' }, '暂无违约，也就没有处置工单。'));
  }
}

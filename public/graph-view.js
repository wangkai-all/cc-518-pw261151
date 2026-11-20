import { el, TYPE_COLORS, EVENT_META, fmtInstant } from './api.js';

const NODE_W = 168;
const NODE_H = 58;
const COL_GAP = 96;
const ROW_GAP = 74;

/**
 * 分层 SVG 依赖图。
 * 节点 level 来自引擎拓扑分层（叶子在左），同层按名称排序避免布局跳动。
 * 边 A -> B 表示 A 依赖 B；critical=false 渲染为虚线。
 */
export function renderGraph(view, root, detailRoot, highlightPath = null) {
  const { graph, entities } = view;
  root.innerHTML = '';
  detailRoot.classList.add('hidden');

  const levels = new Map();
  for (const n of graph.nodes) {
    if (!levels.has(n.level)) levels.set(n.level, []);
    levels.get(n.level).push(n);
  }
  const maxLevel = Math.max(...graph.nodes.map((n) => n.level));
  const rows = Math.max(...[...levels.values()].map((g) => g.length));

  const pos = new Map();
  for (const [lvl, group] of levels) {
    group.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const x = 28 + lvl * (NODE_W + COL_GAP);
    const totalH = group.length * NODE_H + (group.length - 1) * ROW_GAP;
    const y0 = Math.max(28, (rows * (NODE_H + ROW_GAP) - totalH) / 2);
    group.forEach((n, i) => pos.set(n.id, { x, y: y0 + i * (NODE_H + ROW_GAP), node: n }));
  }

  const width = 56 + (maxLevel + 1) * NODE_W + maxLevel * COL_GAP;
  const height = 56 + rows * NODE_H + (rows - 1) * ROW_GAP;
  const svg = el('svg', {
    class: 'graph',
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    xmlns: 'http://www.w3.org/2000/svg',
  });

  // 箭头标记
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#98a2b3"></path>
    </marker>
    <marker id="arrow-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#2f54eb"></path>
    </marker>`;
  svg.appendChild(defs);

  const hlSet = highlightPath ? new Set(highlightPath) : null;

  // 边
  for (const e of graph.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x + NODE_W;
    const y2 = b.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    const onPath = hlSet && hlSet.has(e.from) && hlSet.has(e.to);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class',
      `graph-edge ${e.critical ? 'critical' : 'noncritical'}${onPath ? ' highlight' : ''}${hlSet && !onPath ? ' dim' : ''}`);
    g.innerHTML = `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 4},${y2}" marker-end="url(#${onPath ? 'arrow-hl' : 'arrow'})"></path>`;
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', mx);
    label.setAttribute('y', (y1 + y2) / 2 - 5);
    label.setAttribute('text-anchor', 'middle');
    label.textContent = e.typeLabel + (e.critical ? '' : '（非关键）');
    g.appendChild(label);
    svg.appendChild(g);
  }

  // 节点
  const entityById = Object.fromEntries(entities.map((x) => [x.id, x]));
  for (const [id, { x, y, node }] of pos) {
    const color = TYPE_COLORS[node.type] || '#666';
    const onPath = hlSet?.has(id);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `graph-node${onPath ? ' highlight' : ''}${hlSet && !onPath ? ' dim' : ''}`);
    g.setAttribute('transform', `translate(${x},${y})`);
    g.innerHTML = `
      <rect width="${NODE_W}" height="${NODE_H}" rx="10" fill="#fff" stroke="${color}"></rect>
      <text x="12" y="22" fill="${color}" font-weight="700">${escapeXml(node.name)}</text>
      <text x="12" y="42" fill="#5b6678" font-size="11">${typeLabel(node)} · ${node.zone}</text>`;
    g.style.cursor = 'pointer';
    g.addEventListener('click', () => showNodeDetail(view, id, detailRoot));
    svg.appendChild(g);
  }

  root.appendChild(el('div', { class: 'legend' }, [
    el('span', { html: '<i></i>关键依赖（故障可沿此链传播）' }),
    el('span', { html: '<i class="dashed"></i>非关键路径（有兜底/降级）' }),
    ...Object.entries(TYPE_COLORS).map(([t, c]) =>
      el('span', { html: `<i style="border-top-color:${c}"></i>${typeLabel({ type: t })}` })),
  ]));
  root.appendChild(svg);
}

function typeLabel(node) {
  return { task: '任务', dataset: '数据集', resource: '资源', service: '业务服务' }[node.type] || node.type;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function showNodeDetail(view, entityId, detailRoot) {
  const ent = view.entities.find((e) => e.id === entityId);
  const evs = view.events.filter((e) => e.entityId === entityId);
  detailRoot.classList.remove('hidden');
  detailRoot.innerHTML = '';
  detailRoot.appendChild(el('h4', { style: 'margin:0 0 10px' }, `${ent.name}（${ent.id}）`));

  const dl = el('dl', { class: 'kv' }, [
    el('dt', {}, '类型'), el('dd', {}, `${typeLabel(ent)} / ${ent.kind}`),
    el('dt', {}, '负责人'), el('dd', {}, ent.owner || '—'),
    el('dt', {}, '时区'), el('dd', {}, ent.zone),
    ent.slaMinutes != null ? el('dt', {}, 'SLA') : null,
    ent.slaMinutes != null ? el('dd', {}, `${ent.slaMinutes} 分钟`) : null,
  ]);
  detailRoot.appendChild(dl);

  detailRoot.appendChild(el('div', { style: 'margin-top:12px;font-weight:600' }, `事件（${evs.length}）`));
  const ul = el('ul', { class: 'evidence-list' });
  for (const ev of evs) {
    const meta = EVENT_META[ev.type] || { label: ev.type, icon: '❓' };
    const dup = view.duplicateOf[ev.id];
    ul.appendChild(el('li', {}, [
      el('span', { class: 'ev-time' }, fmtInstant(ev.instant)),
      el('span', {}, `${meta.icon} ${meta.label}${dup ? '（重复，已折叠）' : ''}：${ev.message || '—'}`),
    ]));
  }
  detailRoot.appendChild(ul);
  detailRoot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

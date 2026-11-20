import {
  api, toast, el, setDisplayZone, fmtInstant,
  STRENGTH_META, STATUS_META,
} from './api.js';
import { renderTimeline } from './timeline.js';
import { renderGraph } from './graph-view.js';
import { renderCandidates, setPathHighlightHandler } from './candidates.js';
import { renderRemediation } from './remediation.js';
import { renderVersions } from './versions.js';

const state = {
  view: null,
  activeTab: 'timeline',
  highlightPath: null,
};

async function load() {
  state.view = await api.getCase();
  // 给子视图一个统一的刷新入口
  state.view.reload = async () => {
    await load();
    renderAll();
  };
  renderAll();
}

function renderAll() {
  const v = state.view;
  document.getElementById('case-title').textContent = v.title;
  document.getElementById('case-meta').textContent =
    `${v.caseId} ｜ ${v.entities.length} 个实体 ｜ ${v.events.length} 条事件 ｜ 识别重复 ${v.analysis.stats.duplicateCount} 条`;
  document.getElementById('version-badge').textContent = `分析版本 v${v.currentVersion}`;

  renderKpis(v);
  renderBanners(v);
  renderActiveTab();
}

function renderKpis(v) {
  const s = v.analysis.stats;
  const openTickets = Object.values(v.remediation).filter((r) => r.status === 'open' || r.status === 'investigating').length;
  const items = [
    { num: s.breachCount, label: 'SLA 违约', alarm: s.breachCount > 0 },
    { num: s.confirmedRoots, label: '证据充分根因', ok: s.confirmedRoots > 0 },
    { num: s.unconfirmedRoots, label: '待确认候选', alarm: s.unconfirmedRoots > 0 },
    { num: s.duplicateCount, label: '折叠重复事件' },
    { num: openTickets, label: '未闭环工单', alarm: openTickets > 0 },
    { num: `v${v.currentVersion}`, label: '分析版本' },
  ];
  const row = document.getElementById('kpi-row');
  row.innerHTML = '';
  for (const it of items) {
    row.appendChild(el('div', { class: `kpi${it.alarm ? ' alarm' : ''}${it.ok ? ' ok' : ''}` }, [
      el('div', { class: 'num' }, String(it.num)),
      el('div', { class: 'label' }, it.label),
    ]));
  }
}

function renderBanners(v) {
  const slot = document.getElementById('banner-slot');
  slot.innerHTML = '';
  const dupGroups = v.analysis.duplicateGroups || [];
  if (dupGroups.length) {
    const total = dupGroups.reduce((n, g) => n + g.duplicateIds.length, 0);
    const banner = el('div', { class: 'banner info' });
    banner.innerHTML = `🔁 <b>重复事件折叠 ${total} 条</b>（${dupGroups.length} 组）：同一故障的重复告警/跨时区镜像只保留最早一条参与根因评分，其余在时间线半透明展示。`;
    slot.appendChild(banner);
  }
  const warns = v.analysis.tzWarnings || [];
  if (warns.length) {
    const banner = el('div', { class: 'banner warn' });
    banner.innerHTML = `🌍 <b>跨时区/夏令时提示 ${warns.length} 条</b>：所有事件已按各自时区解析为 UTC 瞬间再参与分析；落在 DST 缺口或回拨区间的本地时间按规则归一，详情见时间线标签。`;
    slot.appendChild(banner);
  }
  // 机器与人工分歧提醒
  let diffs = 0;
  for (const list of Object.values(v.analysis.candidates)) {
    diffs += list.filter((c) => c.machineDiffers).length;
  }
  if (diffs) {
    const banner = el('div', { class: 'banner warn' });
    banner.innerHTML = `⚖ <b>${diffs} 个候选存在人机判断分歧</b>：人工结论已黏滞保留，机器新判断并列展示在根因候选页，等待复核。`;
    slot.appendChild(banner);
  }
  const orphans = v.analysis.orphanJudgments || [];
  if (orphans.length) {
    const banner = el('div', { class: 'banner warn' });
    banner.innerHTML = `📂 <b>${orphans.length} 条历史人工判定在当前图结构中已无对应候选</b>，已保留留档（版本快照的 orphanJudgments 字段），不会静默丢失。`;
    slot.appendChild(banner);
  }
}

function renderActiveTab() {
  const v = state.view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.activeTab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  const panel = document.getElementById(`panel-${state.activeTab}`);
  panel.classList.add('active');

  if (state.activeTab === 'timeline') renderTimeline(v, panel);
  if (state.activeTab === 'graph') {
    renderGraph(v, document.getElementById('graph-container'),
      document.getElementById('graph-detail'), state.highlightPath);
  }
  if (state.activeTab === 'candidates') renderCandidates(v, panel);
  if (state.activeTab === 'remediation') renderRemediation(v, panel);
  if (state.activeTab === 'versions') renderVersions(v, panel, document.getElementById('diff-dialog'));
}

/* ---------------- 交互绑定 ---------------- */

document.getElementById('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  state.activeTab = tab.dataset.tab;
  renderActiveTab();
});

document.getElementById('display-tz').addEventListener('change', (e) => {
  setDisplayZone(e.target.value);
  renderActiveTab();
});

setPathHighlightHandler((path) => {
  state.highlightPath = path;
  state.activeTab = 'graph';
  renderActiveTab();
  toast('已在依赖图高亮该根因传导链');
});

// 新增证据对话框
const dlg = document.getElementById('evidence-dialog');
document.getElementById('btn-add-evidence').addEventListener('click', () => {
  const form = document.getElementById('evidence-form');
  form.reset();
  const entitySel = document.getElementById('evidence-entity');
  entitySel.innerHTML = '';
  for (const ent of state.view.entities) {
    entitySel.appendChild(el('option', { value: ent.id }, `${ent.name}（${ent.id}）`));
  }
  const zoneSel = document.getElementById('evidence-zone');
  zoneSel.innerHTML = '';
  const zones = [...new Set(state.view.entities.map((e) => e.zone))];
  for (const z of ['UTC', 'Asia/Shanghai', 'America/New_York', ...zones.filter((x) => !['UTC', 'Asia/Shanghai', 'America/New_York'].includes(x))]) {
    zoneSel.appendChild(el('option', { value: z }, z));
  }
  // 默认本地时间取当前 UTC 时间
  form.elements.localTime.value = new Date().toISOString().slice(0, 19);
  dlg.showModal();
});
document.getElementById('evidence-cancel').addEventListener('click', () => dlg.close());

document.getElementById('evidence-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    id: fd.get('id').trim(),
    entityId: fd.get('entityId'),
    type: fd.get('type'),
    localTime: fd.get('localTime').trim(),
    zone: fd.get('zone'),
    source: fd.get('source') || 'manual',
    message: fd.get('message') || '',
  };
  const minutes = fd.get('minutes');
  if (minutes) {
    if (payload.type === 'resource_wait') payload.waitMinutes = Number(minutes);
    else payload.delayMinutes = Number(minutes);
  }
  try {
    const { diff } = await api.addEvents([payload]);
    dlg.close();
    const changed = diff.added.length + diff.changed.length;
    toast(`证据已入库并重算为新版本：${changed} 个候选发生变化，历史判断未被覆盖`);
    await load();
    state.activeTab = 'candidates';
    renderActiveTab();
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById('btn-reset').addEventListener('click', async () => {
  if (!confirm('确定用种子数据重建？所有版本、人工判定与处置记录都会清空。')) return;
  await api.reset();
  state.highlightPath = null;
  toast('已重置为初始演示数据（v1）');
  await load();
});

load().catch((err) => {
  document.getElementById('case-title').textContent = '加载失败';
  toast(err.message, true);
  console.error(err);
});

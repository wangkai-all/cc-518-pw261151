/** 薄 API 客户端：统一错误信息。 */
async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

export const api = {
  getCase: () => request('/api/case'),
  addEvents: (events) => request('/api/events', { method: 'POST', body: { events } }),
  addJudgment: (j) => request('/api/judgments', { method: 'POST', body: j }),
  transition: (breachId, payload) =>
    request(`/api/remediation/${encodeURIComponent(breachId)}/transition`, { method: 'POST', body: payload }),
  assign: (breachId, owner) =>
    request(`/api/remediation/${encodeURIComponent(breachId)}/assign`, { method: 'POST', body: { owner } }),
  diff: (from, to) => request(`/api/diff?from=${from}&to=${to}`),
  getVersion: (n) => request(`/api/versions/${n}`),
  reset: () => request('/api/reset', { method: 'POST' }),
};

export function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/** 全局可变更的展示时区；浏览器原生 Intl 完成 UTC -> 本地挂钟时间。 */
let displayZone = 'UTC';
export function setDisplayZone(z) {
  displayZone = z;
}

export function fmtInstant(instant) {
  try {
    const dtf = new Intl.DateTimeFormat('zh-CN', {
      timeZone: displayZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'shortOffset',
    });
    const parts = {};
    for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second} ${parts.timeZoneName || ''}`;
  } catch {
    return new Date(instant).toISOString();
  }
}

/** 同时展示展示时区与事件原始时区，审计跨时区事件。 */
export function fmtDualZone(instant, originalZone) {
  const main = fmtInstant(instant);
  let local = '';
  try {
    const dtf = new Intl.DateTimeFormat('zh-CN', {
      timeZone: originalZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      timeZoneName: 'shortOffset',
    });
    const parts = {};
    for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
    const hour = parts.hour === '24' ? '00' : parts.hour;
    local = `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute} ${parts.timeZoneName || originalZone}`;
  } catch {
    local = originalZone;
  }
  return { main, local };
}

export const STRENGTH_META = {
  confirmed: { label: '证据充分', cls: 'confirmed' },
  probable: { label: '高度疑似', cls: 'probable' },
  unconfirmed: { label: '待确认', cls: 'unconfirmed' },
  rejected: { label: '人工已排除', cls: 'rejected' },
};

export const STATUS_META = {
  open: { label: '待处理', cls: 'high' },
  investigating: { label: '排查中', cls: 'medium' },
  mitigated: { label: '已缓解', cls: 'probable' },
  resolved: { label: '已解决', cls: 'confirmed' },
  accepted: { label: '已接受', cls: 'unconfirmed' },
};

export const STATUS_FLOW = {
  open: ['investigating', 'accepted', 'resolved'],
  investigating: ['mitigated', 'resolved', 'accepted', 'open'],
  mitigated: ['resolved', 'investigating', 'accepted'],
  resolved: ['investigating'],
  accepted: ['investigating'],
};

export const EVENT_META = {
  delay: { label: '数据延迟', cat: 'data', icon: '🐢' },
  failure: { label: '任务失败', cat: 'execution', icon: '💥' },
  retry: { label: '重试', cat: 'execution', icon: '🔁' },
  resource_wait: { label: '资源等待', cat: 'resource', icon: '⏸' },
  resource_release: { label: '资源释放', cat: 'resource', icon: '▶' },
  arrival: { label: '数据到达', cat: 'data', icon: '📥' },
  start: { label: '任务启动', cat: 'execution', icon: '🚀' },
  finish: { label: '任务完成', cat: 'execution', icon: '✅' },
  sla_breach: { label: 'SLA 违约', cat: 'impact', icon: '🚨' },
  impact: { label: '业务影响', cat: 'impact', icon: '📉' },
  action: { label: '处置动作', cat: 'remediation', icon: '🛠' },
};

export const TYPE_COLORS = {
  task: '#2f54eb',
  dataset: '#0e8a5f',
  resource: '#b25e09',
  service: '#c81e1e',
};

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

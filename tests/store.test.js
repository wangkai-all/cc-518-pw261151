import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaseStore } from '../src/store.js';
import { REMEDIATION_STATUSES } from '../src/model.js';

let dir;
let file;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'sla-store-'));
  file = join(dir, 'store.json');
});

after(() => rmSync(dir, { recursive: true, force: true }));

function seed() {
  // 最小案例：A 依赖 B，B 失败导致 A 违约
  return {
    caseId: 'mini',
    title: '最小案例',
    entities: [
      { id: 'a', type: 'service', kind: 'report', name: 'A', zone: 'UTC' },
      { id: 'b', type: 'task', kind: 'etl', name: 'B', zone: 'UTC' },
    ],
    relations: [{ from: 'a', to: 'b', type: 'depends_on' }],
    events: [
      { id: 'e1', type: 'failure', entityId: 'b', localTime: '2026-11-21T00:00:00', zone: 'UTC', message: 'B 失败' },
      { id: 'e2', type: 'sla_breach', entityId: 'a', localTime: '2026-11-21T01:00:00', zone: 'UTC', delayMinutes: 60, severity: 'high', message: 'A 违约' },
    ],
  };
}

test('reset 生成 v1 与初始工单', () => {
  const store = new CaseStore(file).load(seed());
  const view = store.currentView();
  assert.equal(view.currentVersion, 1);
  assert.equal(view.analysis.breaches.length, 1);
  assert.equal(view.remediation['e2'].status, 'open');
  // 文件确实落盘
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.versions.length, 1);
});

test('appendEvents 产生新版本且原快照保留', () => {
  const store = new CaseStore(file).load(seed());
  const { analysis, diff, appended } = store.appendEvents([
    { id: 'e3', type: 'delay', entityId: 'b', localTime: '2026-11-21T00:20:00', zone: 'UTC', delayMinutes: 15, source: 'm', message: '补充延迟证据' },
  ]);
  assert.deepEqual(appended, ['e3']);
  assert.equal(analysis.version, 2);
  assert.equal(store.state.versions.length, 2);
  assert.equal(store.state.versions[0].version, 1); // 历史版本不被覆盖
  assert.ok(diff.changed.length >= 1);
});

test('重复事件 id 拒绝入库', () => {
  const store = new CaseStore(file).load(seed());
  assert.throws(
    () => store.appendEvents([{ id: 'e1', type: 'retry', entityId: 'b', localTime: '2026-11-21T00:30:00', zone: 'UTC' }]),
    /已存在/,
  );
});

test('人工判定写入后跨重算黏滞，并记录分歧', () => {
  const store = new CaseStore(file).load(seed());
  store.addJudgment({ breachId: 'e2', entityId: 'b', verdict: 'confirmed', by: 'kai', note: '确认 B 为根因' });
  let view = store.currentView();
  const c = view.analysis.candidates['e2'].find((x) => x.entityId === 'b');
  assert.equal(c.strength, 'confirmed');
  assert.equal(c.humanVerdict.by, 'kai');

  // 再追加证据重算
  store.appendEvents([
    { id: 'e4', type: 'retry', entityId: 'b', localTime: '2026-11-21T00:40:00', zone: 'UTC', source: 'm', message: '又一次重试' },
  ]);
  view = store.currentView();
  const c2 = view.analysis.candidates['e2'].find((x) => x.entityId === 'b');
  assert.equal(c2.strength, 'confirmed', '重算后人工判定仍在');
  assert.equal(c2.humanVerdict.by, 'kai');
  assert.equal(view.judgments.length, 1);
});

test('人工排除（rejected）同样黏滞', () => {
  const store = new CaseStore(file).load(seed());
  store.addJudgment({ breachId: 'e2', entityId: 'b', verdict: 'rejected', by: 'kai', note: '排除' });
  const c = store.currentView().analysis.candidates['e2'].find((x) => x.entityId === 'b');
  assert.equal(c.strength, 'rejected');
});

test('处置状态机：合法流转成功并留痕，非法流转被拒', () => {
  const store = new CaseStore(file).load(seed());
  store.transitionRemediation('e2', { to: 'investigating', by: 'kai', note: '开始排查' });
  assert.equal(store.state.remediation['e2'].status, 'investigating');
  store.transitionRemediation('e2', { to: 'mitigated', by: 'kai' });
  store.transitionRemediation('e2', { to: 'resolved', by: 'kai' });
  assert.equal(store.state.remediation['e2'].status, 'resolved');
  // resolved 不能直接去 open
  assert.throws(() => store.transitionRemediation('e2', { to: 'open' }), /非法状态流转/);
  // resolved 可以重开到 investigating
  store.transitionRemediation('e2', { to: 'investigating', by: 'kai', note: '复盘重开' });
  const history = store.state.remediation['e2'].history;
  assert.ok(history.some((h) => h.from === 'resolved' && h.to === 'investigating'));
});

test('指派 owner 记录在工单上', () => {
  const store = new CaseStore(file).load(seed());
  store.assignRemediation('e2', 'oncall-lin');
  assert.equal(store.state.remediation['e2'].owner, 'oncall-lin');
});

test('未知违约/非法 verdict 报错', () => {
  const store = new CaseStore(file).load(seed());
  assert.throws(() => store.transitionRemediation('nope', { to: 'resolved' }), /工单不存在/);
  assert.throws(() => store.addJudgment({ breachId: 'e2', entityId: 'b', verdict: 'maybe' }), /verdict/);
});

test('重新 load 后状态完整恢复（持久化往返）', () => {
  const reloadFile = join(dir, 'reload.json');
  const store1 = new CaseStore(reloadFile).load(seed());
  store1.addJudgment({ breachId: 'e2', entityId: 'b', verdict: 'confirmed', by: 'kai' });
  const store2 = new CaseStore(reloadFile).load();
  assert.equal(store2.currentView().currentVersion, 2);
  const c = store2.currentView().analysis.candidates['e2'].find((x) => x.entityId === 'b');
  assert.equal(c.strength, 'confirmed');
});

test('所有处置状态枚举合法', () => {
  assert.deepEqual(REMEDIATION_STATUSES, ['open', 'investigating', 'mitigated', 'resolved', 'accepted']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CausalGraph } from '../src/graph.js';
import { normalizeEntity } from '../src/model.js';

function ents(ids) {
  return ids.map((id) => normalizeEntity({ id, type: 'task', name: id }));
}

test('拓扑排序：上游先于下游', () => {
  const g = new CausalGraph(
    ents(['a', 'b', 'c', 'd']),
    [
      { from: 'b', to: 'a', type: 'depends_on' }, // b 依赖 a
      { from: 'c', to: 'b', type: 'depends_on' },
      { from: 'd', to: 'b', type: 'depends_on' },
    ],
  );
  const order = g.topoSort();
  assert.ok(order.indexOf('a') < order.indexOf('b'));
  assert.ok(order.indexOf('b') < order.indexOf('c'));
  assert.ok(order.indexOf('b') < order.indexOf('d'));
});

test('有环时报错并给出环路径', () => {
  const g = new CausalGraph(
    ents(['a', 'b', 'c']),
    [
      { from: 'a', to: 'b', type: 'depends_on' },
      { from: 'b', to: 'c', type: 'depends_on' },
      { from: 'c', to: 'a', type: 'depends_on' },
    ],
  );
  assert.throws(() => g.topoSort(), /依赖图存在环/);
  const cycles = g.findCycles();
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0], ['a', 'b', 'c', 'a']);
});

test('自环被识别', () => {
  const g = new CausalGraph(ents(['a']), [{ from: 'a', to: 'a', type: 'depends_on' }]);
  assert.throws(() => g.topoSort(), /环/);
});

test('祖先/下游可达性与路径', () => {
  const g = new CausalGraph(
    ents(['root', 'mid', 'leaf', 'other']),
    [
      { from: 'mid', to: 'root', type: 'depends_on' },
      { from: 'leaf', to: 'mid', type: 'depends_on' },
    ],
  );
  assert.deepEqual([...g.ancestors('leaf')].sort(), ['mid', 'root']);
  const reach = g.reachableDownstream('root');
  assert.ok(reach.has('leaf'));
  assert.deepEqual(reach.get('leaf'), ['root', 'mid', 'leaf']);
  assert.deepEqual(g.pathBetween('leaf', 'root'), ['leaf', 'mid', 'root']);
  assert.equal(g.pathBetween('leaf', 'other'), null);
});

test('同对实体的多重关系合并为一条边，critical 取或', () => {
  const g = new CausalGraph(
    ents(['a', 'b']),
    [
      { from: 'a', to: 'b', type: 'depends_on', critical: false },
      { from: 'a', to: 'b', type: 'waits_for', critical: true },
    ],
  );
  const edge = g.edge('a', 'b');
  assert.deepEqual(edge.types.sort(), ['depends_on', 'waits_for']);
  assert.equal(edge.critical, true);
  assert.equal(g.upstream('a').length, 1);
});

test('关系引用不存在的实体时报错', () => {
  assert.throws(
    () => new CausalGraph(ents(['a']), [{ from: 'a', to: 'ghost', type: 'depends_on' }]),
    /不存在的实体/,
  );
});

test('toViewData 提供层级布局', () => {
  const g = new CausalGraph(
    ents(['a', 'b', 'c']),
    [
      { from: 'b', to: 'a', type: 'depends_on' },
      { from: 'c', to: 'b', type: 'depends_on' },
    ],
  );
  const view = g.toViewData();
  const level = Object.fromEntries(view.nodes.map((n) => [n.id, n.level]));
  assert.equal(level.a, 0);
  assert.equal(level.b, 1);
  assert.equal(level.c, 2);
});

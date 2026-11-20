/**
 * 因果依赖图。
 *
 * 边方向约定：from --depends_on/waits_for/serves--> to
 * 即「from 依赖 to」，故障沿 to -> from 方向向上游传播。
 * 图必须无环（含自环）；构建期做 Kahn 拓扑校验并给出具体环路径。
 */

import { normalizeRelation, RELATION_TYPES } from './model.js';

export class CausalGraph {
  constructor(entities, relations) {
    this.entities = new Map(entities.map((e) => [e.id, e]));
    this.relations = relations.map(normalizeRelation);
    this.adj = new Map(); // from -> Set(to)
    this.reverse = new Map(); // to -> Set(from)
    this.edgeMeta = new Map(); // "from->to" -> 关系（含类型/critical）

    for (const id of this.entities.keys()) {
      this.adj.set(id, new Set());
      this.reverse.set(id, new Set());
    }
    for (const r of this.relations) {
      if (!this.entities.has(r.from)) throw new Error(`关系引用了不存在的实体: ${r.from}`);
      if (!this.entities.has(r.to)) throw new Error(`关系引用了不存在的实体: ${r.to}`);
      // 同对实体间允许多种关系，但有向边只建一次；元数据合并
      this.adj.get(r.from).add(r.to);
      this.reverse.get(r.to).add(r.from);
      const key = edgeKey(r.from, r.to);
      const prev = this.edgeMeta.get(key);
      if (prev) {
        prev.types = [...new Set([...prev.types, r.type])];
        prev.critical = prev.critical || r.critical;
        if (r.note) prev.notes.push(r.note);
      } else {
        this.edgeMeta.set(key, {
          from: r.from,
          to: r.to,
          types: [r.type],
          critical: r.critical,
          notes: r.note ? [r.note] : [],
        });
      }
    }

    this._topo = null;
    this._cycles = null;
  }

  outEdges(id) {
    return [...(this.adj.get(id) || [])].map((to) => this.edgeMeta.get(edgeKey(id, to)));
  }

  /** 直接上游（被依赖方）。 */
  upstream(id) {
    return [...(this.adj.get(id) || [])];
  }

  /** 直接下游（依赖方，故障传播方向的下一跳）。 */
  downstream(id) {
    return [...(this.reverse.get(id) || [])];
  }

  edge(from, to) {
    return this.edgeMeta.get(edgeKey(from, to)) || null;
  }

  /** Kahn 拓扑排序；有环时抛出带环路径的错误。 */
  topoSort() {
    if (this._topo) return this._topo;
    const indeg = new Map([...this.entities.keys()].map((id) => [id, this.adj.get(id).size]));
    const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const down of this.reverse.get(id)) {
        indeg.set(down, indeg.get(down) - 1);
        if (indeg.get(down) === 0) queue.push(down);
      }
    }
    if (order.length !== this.entities.size) {
      const cycles = this.findCycles();
      const msg = cycles.map((c) => c.join(' -> ')).join('; ');
      throw new Error(`依赖图存在环: ${msg}`);
    }
    this._topo = order;
    return order;
  }

  /** DFS 找环（用于报错信息），返回若干条环路径。 */
  findCycles() {
    if (this._cycles) return this._cycles;
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map([...this.entities.keys()].map((id) => [id, WHITE]));
    const stack = [];
    const cycles = [];

    const dfs = (u) => {
      color.set(u, GRAY);
      stack.push(u);
      for (const v of this.adj.get(u)) {
        if (color.get(v) === GRAY) {
          const i = stack.indexOf(v);
          cycles.push([...stack.slice(i), v]);
        } else if (color.get(v) === WHITE) {
          dfs(v);
        }
      }
      stack.pop();
      color.set(u, BLACK);
    };

    for (const id of this.entities.keys()) {
      if (color.get(id) === WHITE) dfs(id);
    }
    this._cycles = cycles;
    return cycles;
  }

  /**
   * 从 start 出发沿「下游」方向（故障传播方向）可达的全部实体，
   * 含每条可达路径。用于根因 -> 违约的传导链证明。
   */
  reachableDownstream(start) {
    const paths = new Map(); // entityId -> 一条完整路径（节点 id 数组）
    const walk = (u, path) => {
      for (const d of this.reverse.get(u)) {
        if (path.includes(d)) continue; // 理论上有环检测兜底
        const next = [...path, d];
        const old = paths.get(d);
        // 保留更短路径作为展示链
        if (!old || next.length < old.length) paths.set(d, next);
        walk(d, next);
      }
    };
    walk(start, [start]);
    return paths;
  }

  /** 从 target 沿上游方向的全部祖先实体（可能导致 target 的候选集）。 */
  ancestors(target) {
    const seen = new Set();
    const walk = (u) => {
      for (const up of this.adj.get(u)) {
        if (!seen.has(up)) {
          seen.add(up);
          walk(up);
        }
      }
    };
    walk(target);
    return seen;
  }

  /** 两个实体间的一条上游路径（from 依赖链上能否到达 to）。 */
  pathBetween(fromId, toId) {
    if (fromId === toId) return [fromId];
    const queue = [[fromId]];
    const seen = new Set([fromId]);
    while (queue.length) {
      const path = queue.shift();
      const cur = path[path.length - 1];
      for (const up of this.adj.get(cur)) {
        if (up === toId) return [...path, up];
        if (!seen.has(up)) {
          seen.add(up);
          queue.push([...path, up]);
        }
      }
    }
    return null;
  }

  /** 给前端用的序列化结构（带简单分层布局信息）。 */
  toViewData() {
    const order = this.topoSort();
    // 层级 = 上游最长链长度；叶子（无上游）在第 0 层
    const level = new Map();
    for (const id of order) {
      const ups = this.adj.get(id);
      level.set(id, ups.size === 0 ? 0 : Math.max(...[...ups].map((u) => (level.get(u) ?? 0) + 1)));
    }
    const nodes = [...this.entities.values()].map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      kind: e.kind,
      zone: e.zone,
      level: level.get(e.id),
    }));
    const edges = [...this.edgeMeta.values()].map((m) => ({
      from: m.from,
      to: m.to,
      types: m.types,
      typeLabel: m.types.map((t) => RELATION_TYPES[t].label).join('/'),
      critical: m.critical,
      notes: m.notes,
    }));
    return { nodes, edges };
  }
}

function edgeKey(from, to) {
  return `${from}->${to}`;
}

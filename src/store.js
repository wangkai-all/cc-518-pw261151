/**
 * 案例存储与应用服务。
 *
 * 持久化文件结构（data/store.json）：
 *   rawCase      原始案例数据（实体/关系/事件），只追加、不就地修改
 *   versions     每次分析的不可变版本快照（analyzeCase 的完整返回）
 *   judgments    人工判定（确认/排除），跨版本永久保留
 *   remediation  每个违约的处置状态机与流转历史
 *
 * 重算原则：新增证据 -> 生成新版本快照 -> 人工判定原样继承，
 * 历史版本永不覆盖，前端可逐版对比。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildCase, analyzeCase, diffVersions } from './engine.js';
import { candidateKey, REMEDIATION_STATUSES } from './model.js';

const LEGAL_TRANSITIONS = {
  open: ['investigating', 'accepted', 'resolved'],
  investigating: ['mitigated', 'resolved', 'accepted', 'open'],
  mitigated: ['resolved', 'investigating', 'accepted'],
  resolved: ['investigating'], // 复盘后重开
  accepted: ['investigating'], // 风险接受后被推翻
};

export class CaseStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = null;
  }

  load(seedRawCase = null) {
    if (existsSync(this.filePath)) {
      this.state = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } else if (seedRawCase) {
      this.reset(seedRawCase);
    } else {
      throw new Error(`存储文件不存在且未提供种子数据: ${this.filePath}`);
    }
    return this;
  }

  /** 从种子数据全量重建（清空版本与判定）。 */
  reset(seedRawCase) {
    this.state = {
      rawCase: structuredClone(seedRawCase),
      versions: [],
      judgments: [],
      remediation: {},
    };
    const built = buildCase(this.state.rawCase);
    const v1 = analyzeCase(built, null);
    this.state.versions.push(v1);
    for (const breach of built.breaches) {
      this.state.remediation[breach.id] = {
        breachId: breach.id,
        status: 'open',
        owner: null,
        history: [
          {
            from: null,
            to: 'open',
            at: new Date().toISOString(),
            by: 'system',
            note: '违约识别，工单创建',
          },
        ],
      };
    }
    this.persist();
    return this.currentView();
  }

  persist() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.filePath); // 原子替换，避免写一半被读到
  }

  get currentVersion() {
    return this.state.versions[this.state.versions.length - 1];
  }

  /** 前端首屏所需的完整视图。 */
  currentView() {
    const built = buildCase(this.state.rawCase);
    return {
      caseId: built.caseId,
      title: built.title,
      graph: built.graph.toViewData(),
      entities: built.entities.map(({ raw, ...e }) => e),
      events: built.events,
      duplicateOf: Object.fromEntries(built.duplicateOf),
      currentVersion: this.currentVersion.version,
      analysis: this.currentVersion,
      versionMeta: this.state.versions.map((v) => ({
        version: v.version,
        computedAt: v.computedAt,
        stats: v.stats,
      })),
      judgments: this.state.judgments,
      remediation: this.state.remediation,
    };
  }

  /**
   * 追加一批事件并重算（不覆盖任何历史判断）。
   * @returns {{analysis, diff, appended}}
   */
  appendEvents(newEvents) {
    if (!Array.isArray(newEvents) || newEvents.length === 0) {
      throw new Error('newEvents 必须是非空数组');
    }
    const existingIds = new Set(this.state.rawCase.events.map((e) => e.id));
    const appended = [];
    for (const ev of newEvents) {
      if (existingIds.has(ev.id)) {
        throw new Error(`事件 id 已存在，拒绝重复入库: ${ev.id}`);
      }
      this.state.rawCase.events.push(structuredClone(ev));
      appended.push(ev.id);
    }

    const prior = this.currentVersion;
    const built = buildCase(this.state.rawCase);
    const next = analyzeCase(built, { ...prior, judgments: this.state.judgments });
    this.state.versions.push(next);

    // 新识别出的违约自动建工单
    for (const breach of built.breaches) {
      if (!this.state.remediation[breach.id]) {
        this.state.remediation[breach.id] = {
          breachId: breach.id,
          status: 'open',
          owner: null,
          history: [
            {
              from: null,
              to: 'open',
              at: new Date().toISOString(),
              by: 'system',
              note: `v${next.version} 重算新识别的违约`,
            },
          ],
        };
      }
    }

    const diff = diffVersions(prior, next);
    this.persist();
    return { analysis: next, diff, appended };
  }

  /**
   * 新增人工判定。判定一旦写入即黏滞：后续任何重算都不会覆盖，
   * 机器判断与人工不一致时以 machineDiffers 标记暴露。
   */
  addJudgment({ breachId, entityId, verdict, by = 'analyst', note = '' }) {
    if (!['confirmed', 'rejected'].includes(verdict)) {
      throw new Error(`verdict 只能是 confirmed / rejected，收到: ${verdict}`);
    }
    const exists = this.currentVersion.breaches.some((b) => b.id === breachId);
    if (!exists) throw new Error(`违约不存在: ${breachId}`);

    const key = `${breachId}::${entityId}`;
    const judgment = {
      breachId,
      entityId,
      verdict,
      by,
      at: new Date().toISOString(),
      note,
      version: this.currentVersion.version,
    };
    // 同一候选的新判定覆盖旧判定条目（保留审计轨迹在 note 里），但键不变
    const idx = this.state.judgments.findIndex((j) => candidateKey(j) === key);
    if (idx >= 0) {
      judgment.history = [...(this.state.judgments[idx].history || []), this.state.judgments[idx]];
      this.state.judgments[idx] = judgment;
    } else {
      this.state.judgments.push(judgment);
    }

    const prior = this.currentVersion;
    const built = buildCase(this.state.rawCase);
    const next = analyzeCase(built, { ...prior, judgments: this.state.judgments });
    this.state.versions.push(next);
    this.persist();
    return { analysis: next, judgment };
  }

  /** 处置状态机流转，非法迁移直接拒绝。 */
  transitionRemediation(breachId, { to, by = 'analyst', note = '' }) {
    const r = this.state.remediation[breachId];
    if (!r) throw new Error(`违约工单不存在: ${breachId}`);
    if (!REMEDIATION_STATUSES.includes(to)) throw new Error(`未知处置状态: ${to}`);
    const allowed = LEGAL_TRANSITIONS[r.status] || [];
    if (!allowed.includes(to)) {
      throw new Error(`非法状态流转: ${r.status} -> ${to}（允许: ${allowed.join(', ')}）`);
    }
    const from = r.status;
    r.status = to;
    r.history.push({ from, to, at: new Date().toISOString(), by, note });
    this.persist();
    return r;
  }

  assignRemediation(breachId, owner) {
    const r = this.state.remediation[breachId];
    if (!r) throw new Error(`违约工单不存在: ${breachId}`);
    r.owner = owner;
    r.history.push({
      from: r.status,
      to: r.status,
      at: new Date().toISOString(),
      by: owner || 'system',
      note: owner ? `指派给 ${owner}` : '取消指派',
    });
    this.persist();
    return r;
  }

  diff(fromVersion, toVersion) {
    const a = this.state.versions.find((v) => v.version === Number(fromVersion));
    const b = this.state.versions.find((v) => v.version === Number(toVersion));
    if (!a || !b) throw new Error('版本号不存在');
    return diffVersions(a, b);
  }

  getVersion(version) {
    const v = this.state.versions.find((x) => x.version === Number(version));
    if (!v) throw new Error(`版本不存在: ${version}`);
    return v;
  }
}

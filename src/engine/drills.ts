import { confirmHandover, reconcile, tick, type Session, type TraceEvent } from './handover';
import { allocateRoutes } from './routing';
import type { Scenario } from '../types';

/**
 * 交接演练：预设脚本 + 逐步执行器。
 * 每个演练步骤 = 可选的故障注入 / 自动确认开关 / 补发迟到确认，
 * 然后推进一个片段（边界处理在 tick 内完成）。
 * 全部纯函数、确定性：同一脚本从同一起点执行两遍，轨迹完全一致。
 */

export interface DrillStep {
  /** 步骤说明（写入调度日志） */
  note: string;
  /** 故障注入：把译员置为在线/离线（幂等，重复注入会被识别并忽略） */
  faults?: Array<{ interpreterId: string; online: boolean }>;
  /** 切换自动确认开关 */
  autoConfirm?: boolean;
  /** 对该频道最近一个已终结的交接补发迟到确认 */
  lateConfirm?: string;
}

export interface DrillScript {
  id: string;
  name: string;
  summary: string;
  steps: DrillStep[];
}

export const DRILL_SCRIPTS: DrillScript[] = [
  {
    id: 'blip-recover',
    name: '主力瞬断与恢复',
    summary: '主力断线→备援边界接手→确认→主力返岗切回；含重复恢复注入（应被忽略）',
    steps: [
      { note: '基线运行一个片段' },
      {
        note: '注入故障：王（主力）断线，陈（备援）上岗 → 边界切换至陈',
        faults: [
          { interpreterId: 'int-wang', online: false },
          { interpreterId: 'int-chen', online: true },
        ],
      },
      { note: '边界后新路由确认，交接完成' },
      { note: '备援平稳服务一个片段' },
      {
        note: '主力返岗，备援撤下 → 边界切回王',
        faults: [
          { interpreterId: 'int-wang', online: true },
          { interpreterId: 'int-chen', online: false },
        ],
      },
      {
        note: '重复注入同一恢复事件（应被忽略）；切回确认',
        faults: [
          { interpreterId: 'int-wang', online: true },
          { interpreterId: 'int-chen', online: false },
        ],
      },
      { note: '平稳运行，演练完成' },
    ],
  },
  {
    id: 'early-return-late-ack',
    name: '快速返岗回退与迟到确认',
    summary: '切换后主力迅速返岗→安排回退→回退生效；备援迟到的确认被忽略',
    steps: [
      {
        note: '注入故障：王断线，陈上岗；关闭自动确认 → 边界切换至陈（未确认）',
        faults: [
          { interpreterId: 'int-wang', online: false },
          { interpreterId: 'int-chen', online: true },
        ],
        autoConfirm: false,
      },
      {
        note: '主力迅速返岗，备援撤下：目标恢复为旧路由 → 边界回退至王',
        faults: [
          { interpreterId: 'int-wang', online: true },
          { interpreterId: 'int-chen', online: false },
        ],
      },
      { note: '陈的确认姗姗来迟（应被忽略，不改变在播）', lateConfirm: 'ch-en' },
      { note: '恢复自动确认，重新对齐静默频道', autoConfirm: true },
      { note: '确认全部交接，演练完成' },
    ],
  },
  {
    id: 'ack-timeout',
    name: '确认超时回退与恢复',
    summary: '切换后确认丢失→超时回退→旧路由不可用转静默→主力恢复后重新交接',
    steps: [
      {
        note: '注入故障：王断线，陈上岗；关闭自动确认（模拟确认丢失）→ 边界切换至陈',
        faults: [
          { interpreterId: 'int-wang', online: false },
          { interpreterId: 'int-chen', online: true },
        ],
        autoConfirm: false,
      },
      { note: '确认超时：回退；王仍离线，频道转静默' },
      {
        note: '主力返岗，备援撤下；恢复自动确认 → 边界重新交接至王',
        faults: [
          { interpreterId: 'int-wang', online: true },
          { interpreterId: 'int-chen', online: false },
        ],
        autoConfirm: true,
      },
      { note: '新路由确认，恢复完成' },
    ],
  },
];

export interface DrillWork {
  scenario: Scenario;
  session: Session;
  autoConfirm: boolean;
}

export interface DrillStepOutcome {
  work: DrillWork;
  /** 面向调度日志的说明行 */
  notes: string[];
  /** 本步新产生的交接轨迹事件 */
  events: TraceEvent[];
}

/** 幂等置位：状态未变时 changed=false（重复注入） */
export function setOnline(
  scenario: Scenario,
  id: string,
  online: boolean,
): { scenario: Scenario; changed: boolean; name: string } {
  const it = scenario.interpreters.find((i) => i.id === id);
  if (!it) return { scenario, changed: false, name: id };
  if (it.online === online) return { scenario, changed: false, name: it.name };
  return {
    scenario: {
      ...scenario,
      interpreters: scenario.interpreters.map((i) => (i.id === id ? { ...i, online } : i)),
    },
    changed: true,
    name: it.name,
  };
}

/** 执行一个演练步骤：注入/开关/补发确认 → 对齐 → 推进片段 */
export function applyDrillStep(work: DrillWork, step: DrillStep): DrillStepOutcome {
  let { scenario, session, autoConfirm } = work;
  const notes: string[] = [];
  const events: TraceEvent[] = [];

  let autoConfirmChanged = false;
  if (step.autoConfirm !== undefined && step.autoConfirm !== autoConfirm) {
    autoConfirm = step.autoConfirm;
    autoConfirmChanged = true;
    notes.push(autoConfirm ? '自动确认已开启' : '自动确认已关闭（确认需手动，否则超时回退）');
  }

  let scenarioChanged = false;
  for (const f of step.faults ?? []) {
    const r = setOnline(scenario, f.interpreterId, f.online);
    scenario = r.scenario;
    if (r.changed) {
      scenarioChanged = true;
      notes.push(`故障注入：${r.name} ${f.online ? '恢复上线' : '断线离席'}`);
    } else {
      notes.push(`重复注入：${r.name} 已${f.online ? '在线' : '离线'}，事件忽略`);
    }
  }

  // 场景或确认策略变化后重新对齐（纯推进片段不对齐，避免超时回退被立即重试）
  if (scenarioChanged || autoConfirmChanged) {
    const alloc = allocateRoutes(scenario.floor, scenario.channels, scenario.interpreters);
    const r = reconcile(session, alloc);
    session = r.session;
    events.push(...r.events);
  }

  if (step.lateConfirm) {
    const done = [...session.completed].reverse().find((h) => h.channelId === step.lateConfirm);
    if (done) {
      const r = confirmHandover(session, done.id);
      session = r.session;
      events.push(...r.events);
      notes.push('补发迟到的确认');
    }
  }

  const t = tick(session, scenario, { autoConfirm });
  session = t.session;
  events.push(...t.events);

  return { work: { scenario, session, autoConfirm }, notes, events };
}

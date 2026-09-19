import type { Allocation, Route } from './routing';
import type { Scenario } from '../types';

/**
 * 译员交接会话引擎（纯函数、确定性）。
 *
 * 路由引擎给出的是"目标分配"，本引擎维护的是"实际在播"：
 * 音频按片段（segment）推进，每条频道任一时刻至多一条在播路由，
 * 在播指针只在片段边界变更 —— 短暂断线、迟到确认、重复恢复
 * 都不会让两条通道同时播放。
 *
 * 交接生命周期：prepare（准备，等待边界）→ switch（边界切换生效，待确认）
 * → confirmed（确认，终态）；确认超时或旧路由恢复时回退：
 * switch → rollback（已安排，待边界）→ rolledback（终态）；
 * 准备阶段故障提前恢复则 cancelled（终态）。
 */

/** 确认窗口：切换生效后多少个片段边界内必须收到确认，否则回退 */
export const CONFIRM_WINDOW = 1;

/** 派发记录与轨迹的保留上限（超出丢弃最旧） */
const DISPATCH_CAP = 400;
const TRACE_CAP = 200;
const COMPLETED_CAP = 20;

export type HandoverPhase =
  | 'prepare' // 准备：已发起，等待下一片段边界
  | 'switch' // 切换：边界已切到新路由，等待确认
  | 'rollback' // 回退：已安排，等待边界切回旧路由
  | 'confirmed' // 已确认：交接完成（终态）
  | 'rolledback' // 已回退（终态）
  | 'cancelled'; // 已取消（终态）

export interface Handover {
  id: string;
  channelId: string;
  phase: HandoverPhase;
  /** 切换前在播路由（null = 此前静默） */
  from: Route | null;
  /** 目标路由（null = 目标即静默/断路） */
  to: Route | null;
  /** 发起时的片段号 */
  startedAt: number;
  /** 计划生效的边界片段号 */
  boundaryAt: number;
  /** 实际切换生效的片段号（未生效为 null） */
  switchedAt: number | null;
  /** 确认截止片段号（超时未确认则回退） */
  confirmDeadline: number | null;
}

export type TraceKind =
  | 'prepare' // 交接发起
  | 'switch' // 边界切换生效
  | 'confirm' // 新路由确认
  | 'rollback-plan' // 安排回退（旧路由恢复可用）
  | 'rollback' // 回退生效（含确认超时）
  | 'cancel' // 准备阶段取消（边界前恢复）
  | 'replace' // 被新交接取代
  | 'late-confirm'; // 迟到确认（已忽略）

/** 交接事件轨迹：切换前后全程留痕 */
export interface TraceEvent {
  id: number;
  handoverId: string;
  channelId: string;
  kind: TraceKind;
  /** 事件发生时的片段号 */
  segment: number;
  from: Route | null;
  to: Route | null;
  note?: string;
}

/** 一片段一频道的音频派发记录：该片段的音频发给了哪条路由（null = 静默） */
export interface DispatchRecord {
  segment: number;
  channelId: string;
  routeKey: string | null;
}

export interface LiveChannel {
  route: Route | null;
  /** 当前在播路由开始服务的片段号 */
  since: number;
}

export interface Session {
  /** 当前音频片段号（从 1 开始） */
  segment: number;
  /** 每频道当前在播路由 */
  live: Record<string, LiveChannel>;
  /** 进行中的交接（每频道至多一个） */
  active: Handover[];
  /** 已终结的交接（保留轨迹，供迟到确认识别） */
  completed: Handover[];
  /** 交接事件轨迹 */
  trace: TraceEvent[];
  /** 每片段每频道的派发记录 */
  dispatch: DispatchRecord[];
  /** 交接编号发生器 */
  seq: number;
  /** 轨迹编号发生器 */
  traceSeq: number;
}

export interface StepResult {
  session: Session;
  /** 本步新产生的轨迹事件（已并入 session.trace） */
  events: TraceEvent[];
}

/** 路由指纹：译员编号按段连接；静默为 null */
export function routeKeyOf(route: Route | null): string | null {
  return route ? route.legs.map((l) => l.interpreterId).join('>') : null;
}

export function sameRoute(a: Route | null, b: Route | null): boolean {
  return routeKeyOf(a) === routeKeyOf(b);
}

/** 路由当前是否可播：所有段的译员都在线（静默视为可行） */
export function viable(route: Route | null, scenario: Scenario): boolean {
  if (!route) return true;
  return route.legs.every((l) => {
    const it = scenario.interpreters.find((i) => i.id === l.interpreterId);
    return it !== undefined && it.online;
  });
}

/** 频道的目标路由：分配正常为路由本身，断路/席位不足为 null（静默） */
export function desiredRoute(allocation: Allocation, channelId: string): Route | null {
  const o = allocation.byChannel.get(channelId);
  return o && o.status === 'ok' ? o.route : null;
}

/** 频道当前进行中的交接（若有） */
export function activeHandover(session: Session, channelId: string): Handover | undefined {
  return session.active.find((h) => h.channelId === channelId);
}

/** 某频道在指定片段实际派发的路由指纹（无记录为 undefined） */
export function dispatchAt(session: Session, channelId: string, segment: number): string | null | undefined {
  const rec = session.dispatch.find((d) => d.channelId === channelId && d.segment === segment);
  return rec ? rec.routeKey : undefined;
}

function clone<T>(x: T): T {
  return structuredClone(x);
}

function emitInto(s: Session, events: TraceEvent[], h: Handover, kind: TraceKind, note?: string): void {
  const ev: TraceEvent = {
    id: ++s.traceSeq,
    handoverId: h.id,
    channelId: h.channelId,
    kind,
    segment: s.segment,
    from: h.from,
    to: h.to,
    note,
  };
  s.trace.push(ev);
  if (s.trace.length > TRACE_CAP) s.trace = s.trace.slice(-TRACE_CAP);
  events.push(ev);
}

/** 交接终结：移出进行中列表，保留在已完成列表供轨迹与迟到确认查询 */
function complete(s: Session, h: Handover): void {
  s.active = s.active.filter((x) => x.id !== h.id);
  s.completed.push(h);
  if (s.completed.length > COMPLETED_CAP) s.completed = s.completed.slice(-COMPLETED_CAP);
}

/** 回退结果文案：切回旧路由 / 回到静默 / 旧路由已不可用被迫静默 */
function rollbackNote(h: Handover, target: Route | null): string {
  if (target) return '已切回旧路由';
  return h.from === null ? '回到静默' : '旧路由不可用，频道静默';
}

/** 初始会话：片段 1，各频道直接在目标路由上开播（无交接） */
export function initSession(scenario: Scenario, allocation: Allocation): Session {
  const live: Record<string, LiveChannel> = {};
  const dispatch: DispatchRecord[] = [];
  for (const ch of scenario.channels) {
    const route = desiredRoute(allocation, ch.id);
    live[ch.id] = { route, since: 1 };
    dispatch.push({ segment: 1, channelId: ch.id, routeKey: routeKeyOf(route) });
  }
  return { segment: 1, live, active: [], completed: [], trace: [], dispatch, seq: 0, traceSeq: 0 };
}

function startHandover(s: Session, events: TraceEvent[], channelId: string, from: Route | null, to: Route | null): void {
  const h: Handover = {
    id: `ho-${++s.seq}`,
    channelId,
    phase: 'prepare',
    from,
    to,
    startedAt: s.segment,
    boundaryAt: s.segment + 1,
    switchedAt: null,
    confirmDeadline: null,
  };
  s.active.push(h);
  emitInto(s, events, h, 'prepare', `将于片段 #${h.boundaryAt} 边界生效`);
}

/**
 * 对齐目标分配与实际在播（幂等，场景变更后调用；推进片段时不调用）。
 * - 目标 ≠ 在播且无进行中交接 → 发起交接（准备阶段）；
 * - 目标 = 进行中交接的目标 → 不动（重复恢复/重复注入是 no-op）；
 * - 目标恢复为交接前路由 → 准备阶段直接取消，已切换则安排回退；
 * - 目标变为第三条路由 → 原交接取消，按当前在播重新发起。
 */
export function reconcile(session: Session, allocation: Allocation): StepResult {
  const s = clone(session);
  const events: TraceEvent[] = [];

  for (const channelId of Object.keys(s.live)) {
    const desired = desiredRoute(allocation, channelId);
    const liveRoute = s.live[channelId]?.route ?? null;
    const h = s.active.find((x) => x.channelId === channelId);

    if (!h) {
      if (!sameRoute(desired, liveRoute)) startHandover(s, events, channelId, liveRoute, desired);
      continue;
    }

    if (sameRoute(desired, h.to)) continue; // 目标未变：幂等

    if (sameRoute(desired, h.from)) {
      if (h.phase === 'prepare') {
        h.phase = 'cancelled';
        emitInto(s, events, h, 'cancel', '边界前已恢复，交接取消');
        complete(s, h);
      } else if (h.phase === 'switch') {
        h.phase = 'rollback';
        emitInto(s, events, h, 'rollback-plan', '旧路由恢复可用，安排回退');
      } // 已安排回退或已终结：无需处理
      continue;
    }

    // 目标变为第三条路由：取代当前交接，从当前在播重新发起
    h.phase = 'cancelled';
    emitInto(s, events, h, 'replace', '目标路由已变化，原交接被取代');
    complete(s, h);
    if (!sameRoute(desired, liveRoute)) startHandover(s, events, channelId, liveRoute, desired);
  }
  return { session: s, events };
}

/**
 * 推进一个片段（边界处理）。顺序：先执行已安排的回退，
 * 再让到期的准备交接在边界切换，最后处理确认/超时。
 * 在播指针只在本函数内变更 —— 片段中途的故障不影响当片段派发。
 */
export function tick(session: Session, scenario: Scenario, opts: { autoConfirm: boolean }): StepResult {
  const s = clone(session);
  const events: TraceEvent[] = [];
  s.segment += 1;

  // 1) 已安排的回退在边界生效
  for (const h of [...s.active]) {
    if (h.phase !== 'rollback') continue;
    const target = viable(h.from, scenario) ? h.from : null;
    s.live[h.channelId] = { route: target, since: s.segment };
    h.phase = 'rolledback';
    emitInto(s, events, h, 'rollback', rollbackNote(h, target));
    complete(s, h);
  }

  // 2) 准备 → 切换（边界生效；目标为静默则无需确认直接完成）
  for (const h of [...s.active]) {
    if (h.phase !== 'prepare' || s.segment < h.boundaryAt) continue;
    s.live[h.channelId] = { route: h.to, since: s.segment };
    h.switchedAt = s.segment;
    if (h.to === null) {
      h.phase = 'confirmed';
      emitInto(s, events, h, 'switch', '频道进入静默');
      complete(s, h);
    } else {
      h.phase = 'switch';
      h.confirmDeadline = s.segment + CONFIRM_WINDOW;
      emitInto(s, events, h, 'switch');
    }
  }

  // 3) 已切换交接：确认（自动确认开启且目标可行）或超时回退
  for (const h of [...s.active]) {
    if (h.phase !== 'switch' || h.switchedAt === null || s.segment <= h.switchedAt) continue;
    if (opts.autoConfirm && viable(h.to, scenario)) {
      h.phase = 'confirmed';
      emitInto(s, events, h, 'confirm');
      complete(s, h);
    } else if (h.confirmDeadline !== null && s.segment >= h.confirmDeadline) {
      const target = viable(h.from, scenario) ? h.from : null;
      s.live[h.channelId] = { route: target, since: s.segment };
      h.phase = 'rolledback';
      emitInto(s, events, h, 'rollback', `确认超时，${rollbackNote(h, target)}`);
      complete(s, h);
    }
  }

  // 4) 记录本片段各频道派发（每频道每片段恰一条）
  for (const [channelId, lc] of Object.entries(s.live)) {
    s.dispatch.push({ segment: s.segment, channelId, routeKey: routeKeyOf(lc.route) });
  }
  if (s.dispatch.length > DISPATCH_CAP) s.dispatch = s.dispatch.slice(-DISPATCH_CAP);

  return { session: s, events };
}

/**
 * 确认交接（手动确认或补发）。
 * 仅"已切换待确认"阶段可确认；已终结的交接收到确认记为迟到确认并忽略，
 * 不改变任何在播状态。
 */
export function confirmHandover(session: Session, handoverId: string): StepResult {
  const s = clone(session);
  const events: TraceEvent[] = [];

  const act = s.active.find((h) => h.id === handoverId);
  if (act) {
    if (act.phase === 'switch') {
      act.phase = 'confirmed';
      emitInto(s, events, act, 'confirm', '手动确认');
      complete(s, act);
    } // 准备/回退阶段不可确认：忽略
    return { session: s, events };
  }

  const done = s.completed.find((h) => h.id === handoverId);
  if (done) emitInto(s, events, done, 'late-confirm', '交接已终结，确认不再生效');
  return { session: s, events };
}

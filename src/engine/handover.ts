import { allocateRoutes, compareChannels, findCandidateRoutes, type ChannelOutcome, type Route } from './routing';
import type { Scenario } from '../types';

/**
 * 译员交接引擎
 * =================
 * A 版本的 allocateRoutes 只回答“此刻路由表里应该是谁”，是纯配置态。
 * 现场故障是：主译员短暂断线时路由表已重算，下一段音频却仍发给旧通道，
 * 恢复后旧译员又重新上线造成两条通道同时播放（重复播放）。
 *
 * 本引擎在路由表与音频通道之间加入一个按【语言频道 × 音频片段边界】生效的
 * 交接状态机，并维护一份只增不改的【播放会话台账】：
 *
 *   - 路由变化（含中继频道枢纽译员联动、席位不足失声）只产生“待交接”，
 *     绝不中途改派当前片段；
 *   - 片段边界上原子交接：旧会话在边界关闭，新会话在边界之后开启，
 *     同一语言频道任意片段至多一条在播会话（互斥不变量）；
 *   - 准备 → 切换 → 确认 期间旧通道一直守到边界，备援只热备不开声；
 *   - 短暂断线（边界前恢复则整段吸收）、迟到确认（只登记）、
 *     重复恢复（去重幂等）都不会造成两条通道同时播放；
 *   - 确认丢失 / 迟到超截止 → 自动回退旧通道。
 */

// ---------------------------------------------------------------- 类型

/** 交接阶段：准备（备援热备，旧通道继续）/ 切换（边界执行）/ 确认（新通道在播） */
export type HandoverPhase = 'preparing' | 'switching' | 'confirming';

export type FailKind = 'blip' | 'late-ack' | 'drop-ack' | 'backup-offline' | 'none';

/** 一段在某频道上真正出声的播放会话；同一频道任意时刻至多一条 open */
export interface PlaybackSession {
  id: string;
  channelId: string;
  /** 实际出声的路由（可能 1 段直译或 2 段中继） */
  route: Route;
  startTick: number;
  /** null 表示仍在播；覆盖片段 [startTick, endTick)，边界恰好相接不重叠 */
  endTick: number | null;
  /** handover=正常交接关闭；silence=无可用译员失声；revert=确认失败回退 */
  close?: 'handover' | 'silence' | 'revert';
}

/** 一次交接尝试（一次路由漂移启动一条） */
export interface HandoverTicket {
  id: string;
  channelId: string;
  fromRoute: Route;
  /** 缺省表示目标是“失声”（枢纽离线且无备援 / 席位不足） */
  toRoute?: Route;
  phase: HandoverPhase;
  /** 发起交接时的片段号；切换只允许在其后的边界发生 */
  openTick: number;
  /** 已执行切换的片段号（confirming 起有值） */
  switchTick?: number;
  fail: FailKind;
  /** 短暂断线自动恢复边界（含此 tick 的边界结算时恢复） */
  blipUntil?: number;
  /** 断线返岗是否已结算（防止重复恢复） */
  blipRecovered?: boolean;
  /** 已推送过“确认超出窗口”告警（轨迹只记一次） */
  lateWarned?: boolean;
  /** true=失声频道的恢复票（没有旧会话要关，边界直接由新路开声） */
  recover?: boolean;
  finished: boolean;
  /** completed=确认完成；reverted=回退；abandoned=放弃旧路继续；silenced=切到失声 */
  outcome?: 'completed' | 'reverted' | 'abandoned' | 'silenced';
}

export type EventTone = 'ok' | 'warn' | 'bad' | 'info';

/** 保留切换前后的事件轨迹：每条事件记录片段号、频道、阶段、文案 */
export interface HandoverEvent {
  id: number;
  tick: number;
  channelId: string | null;
  phase: HandoverPhase | 'system';
  tone: EventTone;
  text: string;
}

export type AutoSpeed = 'normal' | 'fast';

export interface HandoverState {
  scenario: Scenario;
  /** 已完成播放的音频片段数（当前片段编号 = tick） */
  tick: number;
  tickets: Record<string, HandoverTicket>;
  sessions: PlaybackSession[];
  events: HandoverEvent[];
  /** 当前生效路由：channelId → Route（键缺失表示该频道失声） */
  effective: Record<string, Route>;
  running: boolean;
  speed: AutoSpeed;
  past: HandoverState[];
  future: HandoverState[];
  seq: number;
}

// ---------------------------------------------------------------- 动作

export type HandoverAction =
  | { type: 'advance' }
  | { type: 'toggleRun' }
  | { type: 'setSpeed'; speed: AutoSpeed }
  | { type: 'injectDisconnect'; channelId: string; durationTicks?: number }
  | { type: 'reconnect'; channelId: string }
  | { type: 'injectFail'; channelId: string; fail: Exclude<FailKind, 'none' | 'blip'> }
  | { type: 'resolveTicket'; ticketId: string }
  | { type: 'toggleInterpreter'; id: string }
  | { type: 'removeInterpreter'; id: string }
  | { type: 'setCapacity'; id: string; capacity: number }
  | { type: 'addInterpreter'; draft: { name: string; source: string; target: string; capacity: number } }
  | { type: 'setPriority'; channelId: string; priority: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset' }
  | { type: 'hydrate'; state: HandoverState };

// ---------------------------------------------------------------- 常量

/** 新通道开声后，备援须在此片段数内完成确认 */
export const CONFIRM_TICKS = 2;
/** 超过此片段数仍未确认（丢失/迟到）→ 自动回退 */
export const CONFIRM_DEADLINE = CONFIRM_TICKS + 2;
/** 断线宽限：断线后的前 GRACE_TICKS 次边界裁决顺延，旧通道靠缓冲续播；
 *  宽限结束主译员仍未恢复才真正切换——短暂断线被整段吸收 */
export const GRACE_TICKS = 1;
const MAX_EVENTS = 160;
const STORAGE_KEY = 'relaymap-handover-v1';

// ---------------------------------------------------------------- 纯工具

export function firstLegId(route: Route): string {
  return route.legs[0].interpreterId;
}

function routeKey(r: Route): string {
  return r.legs.map((l) => l.interpreterId).join('>');
}

function sameRoute(a: Route | undefined, b: Route | undefined): boolean {
  if (!a || !b) return a === b;
  return routeKey(a) === routeKey(b);
}

export function cloneRoute(r: Route): Route {
  return { relay: r.relay, legs: r.legs.map((l) => ({ ...l })) };
}

interface SeqRef {
  n: number;
}

function pushEvent(events: HandoverEvent[], seq: SeqRef, e: Omit<HandoverEvent, 'id'>): HandoverEvent[] {
  return [...events, { ...e, id: ++seq.n }].slice(-MAX_EVENTS);
}

// ---------------------------------------------------------------- 初始化

function initialEffective(scenario: Scenario): Record<string, Route> {
  const alloc = allocateRoutes(scenario.floor, scenario.channels, scenario.interpreters);
  const eff: Record<string, Route> = {};
  for (const ch of scenario.channels) {
    const o = alloc.byChannel.get(ch.id);
    if (o?.status === 'ok') eff[ch.id] = cloneRoute(o.route);
  }
  return eff;
}

export function createHandoverInitialState(scenario: Scenario): HandoverState {
  const effective = initialEffective(scenario);
  const sessions: PlaybackSession[] = [];
  let seq = 0;
  for (const ch of [...scenario.channels].sort(
    (a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1),
  )) {
    const route = effective[ch.id];
    if (route) {
      sessions.push({
        id: `sess-${++seq}`,
        channelId: ch.id,
        route: cloneRoute(route),
        startTick: 0,
        endTick: null,
      });
    }
  }
  const events: HandoverEvent[] = [
    {
      id: ++seq,
      tick: 0,
      channelId: null,
      phase: 'system',
      tone: 'info',
      text: '交接台就绪：路由按语言通道 × 音频片段边界生效，切换需经 准备 → 切换 → 确认',
    },
  ];
  return {
    scenario,
    tick: 0,
    tickets: {},
    sessions,
    events,
    effective,
    running: false,
    speed: 'normal',
    past: [],
    future: [],
    seq,
  };
}

// ---------------------------------------------------------------- 路由漂移检测（在役粘滞）

interface Drift {
  channelId: string;
  /** undefined 表示当前配置下该频道应失声（无路由 / 席位不足） */
  desired: Route | undefined;
}

/**
 * 逐频道按优先级贪心重算（与 allocateRoutes 同算法），但返回每频道的
 * “配置态最优路由”。交接引擎只把它用作失效检测的参照，不直接改派音频。
 */
function computeDesired(scenario: Scenario): Map<string, Route | undefined> {
  const capacity = new Map(scenario.interpreters.map((i) => [i.id, i.capacity]));
  const loads = new Map<string, number>();
  const result = new Map<string, Route | undefined>();
  const freeOf = (id: string) => (loads.get(id) ?? 0) < (capacity.get(id) ?? 0);
  for (const ch of [...scenario.channels].sort(compareChannels)) {
    const candidates = findCandidateRoutes(scenario.floor, ch.target, scenario.interpreters);
    if (candidates.length === 0) {
      result.set(ch.id, undefined);
      continue;
    }
    const chosen = candidates.find((r) => r.legs.every((l) => freeOf(l.interpreterId)));
    if (chosen) {
      for (const l of chosen.legs) loads.set(l.interpreterId, (loads.get(l.interpreterId) ?? 0) + 1);
      result.set(ch.id, chosen);
    } else {
      result.set(ch.id, undefined); // 席位不足 → 失声
    }
  }
  return result;
}

/**
 * 找出生效路由已“失效”的频道——只有失效才发起交接（在役粘滞）：
 *  - 在役路由上有译员离线；
 *  - 在役路由在当前容量竞争中失去席位（更高优先级频道挤占）。
 * 仅仅“出现另一条可用/更优备援”不算漂移：备援热备、主译员归来都不抖动。
 * 目标失声（无路由 / 席位不足）时 desired 为 undefined。
 */
function detectDrifts(s: HandoverState): Drift[] {
  const desired = computeDesired(s.scenario);
  const capacity = new Map(s.scenario.interpreters.map((i) => [i.id, i.capacity]));
  // 以“所有在役路由继续占席”为前提重放容量竞争，检验每个在役路由能否保住席位
  const effectiveLoads = new Map<string, number>();
  for (const ch of [...s.scenario.channels].sort(compareChannels)) {
    const r = s.effective[ch.id];
    if (r) for (const l of r.legs) effectiveLoads.set(l.interpreterId, (effectiveLoads.get(l.interpreterId) ?? 0) + 1);
  }

  const drifts: Drift[] = [];
  for (const ch of s.scenario.channels) {
    const current = s.effective[ch.id];
    const wish = desired.get(ch.id);
    if (!current) {
      if (wish) drifts.push({ channelId: ch.id, desired: wish }); // 失声 → 恢复
      continue;
    }
    const allOnline = current.legs.every((l) =>
      s.scenario.interpreters.some((i) => i.id === l.interpreterId && i.online),
    );
    const keepsSeat = current.legs.every(
      (l) => (effectiveLoads.get(l.interpreterId) ?? 0) <= (capacity.get(l.interpreterId) ?? 0),
    );
    if (!allOnline || !keepsSeat) {
      drifts.push({ channelId: ch.id, desired: wish });
    }
  }
  return drifts;
}

/** 供 UI 的当前配置态分配（状态徽标仍展示 broken/blocked） */
export function currentAllocation(s: HandoverState) {
  return allocateRoutes(s.scenario.floor, s.scenario.channels, s.scenario.interpreters);
}

/** 供 UI 诊断使用 */
export function outcomeOf(s: HandoverState, channelId: string): ChannelOutcome | undefined {
  return currentAllocation(s).byChannel.get(channelId);
}

function openTicketOf(s: HandoverState, channelId: string): HandoverTicket | undefined {
  return Object.values(s.tickets).find((t) => t.channelId === channelId && !t.finished);
}

// ---------------------------------------------------------------- 发起准备

/** 为所有“尚无票”的漂移频道发起交接准备（失声恢复也等下一边界才开声） */
function openDriftTickets(s: HandoverState, seq: SeqRef): void {
  for (const d of detectDrifts(s)) {
    if (openTicketOf(s, d.channelId)) continue;
    const current = s.effective[d.channelId];
    if (!current && !d.desired) continue; // 本来就失声，仍然失声
    const id = `tk-${++seq.n}`;
    const recover = !current;
    const ticket: HandoverTicket = {
      id,
      channelId: d.channelId,
      fromRoute: current ? cloneRoute(current) : cloneRoute(d.desired as Route), // 失声恢复时仅占位
      toRoute: d.desired ? cloneRoute(d.desired) : undefined,
      phase: 'preparing',
      openTick: s.tick,
      fail: 'none',
      recover,
      finished: false,
    };
    s.events = pushEvent(s.events, seq, {
      tick: s.tick,
      channelId: d.channelId,
      phase: 'preparing',
      tone: current ? 'warn' : 'ok',
      text: current
        ? d.desired
          ? `${chName(s, d.channelId)}：在役路由失效，备援 ${describeRoute(s, d.desired)} 热备——当前片段由 ${describeRoute(s, current)} 继续播完，下一边界交接`
          : `${chName(s, d.channelId)}：在役路由 ${describeRoute(s, current)} 失效且无备援，当前片段播完后边界静音`
        : `${chName(s, d.channelId)}：路由恢复为 ${describeRoute(s, d.desired as Route)}，下一片段边界重新开声`,
    });
    s.tickets = { ...s.tickets, [id]: ticket };
  }
}

// ---------------------------------------------------------------- 边界核心：advance

/**
 * 推进一步 = 一个音频片段走到边界。顺序经过严格设计：
 *  1. 结算注入的短暂断线窗口（在边界让主译员恢复在线）；
 *  2. confirming 票在边界判定自动确认 / 迟到 / 超时回退；
 *  3. tick++ 越过边界；
 *  4. 检测路由漂移，为新漂移发起准备（旧通道继续播本片段）；
 *  5. preparing 票：漂移消失则放弃吸收；备援不可达则放弃/静音；
 *     到边界且备援在线则原子切换；
 *  6. 新片段开声：每个频道解析出唯一在播会话（互斥）。
 */
function advance(base: HandoverState): HandoverState {
  const s = snapshotForUndo(base);
  const seq: SeqRef = { n: s.seq };
  const atTick = s.tick;

  // 1) 短暂断线窗口在边界结算：主译员恢复在线
  //    blipUntil=N 表示断线持续 N 个片段：在第 N 个边界决策前（atTick+1>=N）恢复。
  //    调度只看 blipUntil/blipRecovered，不受 fail 标志（可能被“迟到确认”覆盖）影响。
  for (const t of Object.values(s.tickets)) {
    if (t.blipUntil === undefined || t.blipRecovered) continue;
    if (t.finished && t.phase !== 'confirming') continue;
    if (atTick + 1 < t.blipUntil) continue;
    const oldId = firstLegId(t.fromRoute);
    const interp = s.scenario.interpreters.find((i) => i.id === oldId);
    t.blipRecovered = true;
    if (t.fail === 'blip') t.fail = 'none';
    t.blipUntil = atTick + 1;
    if (interp && !interp.online) {
      s.scenario = {
        ...s.scenario,
        interpreters: s.scenario.interpreters.map((i) => (i.id === oldId ? { ...i, online: true } : i)),
      };
      s.events = pushEvent(s.events, seq, {
        tick: atTick,
        channelId: t.channelId,
        phase: t.phase,
        tone: 'info',
        text: `${interp.name} 连线在片段边界恢复（频道 ${chName(s, t.channelId)}）；${
          t.phase === 'confirming' ? '备援正在岗，旧主不立即切回，避免双播' : '交接于本边界重新评估'
        }`,
      });
    }
    s.tickets = { ...s.tickets, [t.id]: { ...t } };
  }

  // 2) 确认阶段在边界结算
  for (const t of Object.values(s.tickets)) {
    if (t.phase !== 'confirming' || t.finished || t.switchTick === undefined) continue;
    const elapsed = atTick - t.switchTick;
    if ((t.fail === 'drop-ack' || t.fail === 'late-ack') && elapsed >= CONFIRM_DEADLINE) {
      const boundaryTick = atTick + 1; // 第 2 步尚未越过边界
      if (oldRouteFeasible(s, t.channelId, t.fromRoute)) {
        revertTicket(s, t, seq, boundaryTick, t.fail === 'late-ack' ? '备援确认迟到超过截止时间' : '确认信号丢失超过截止时间');
      } else {
        // 旧通道已不可回退（译员仍离线 / 无席位）：维持备援，登记为带告警闭环
        t.fail = 'none';
        s.tickets = { ...s.tickets, [t.id]: { ...t } };
        completeTicket(s, t, seq, '确认超时但旧通道已不可用，维持当前备援出声');
      }
    } else if (t.fail === 'none' && elapsed >= CONFIRM_TICKS) {
      completeTicket(s, t, seq, '片段边界收到备援确认');
    } else if (elapsed > CONFIRM_TICKS && !t.lateWarned) {
      // 已过确认窗口但未到回退截止：只告警，音频维持新通道
      t.lateWarned = true;
      s.tickets = { ...s.tickets, [t.id]: { ...t } };
      s.events = pushEvent(s.events, seq, {
        tick: atTick,
        channelId: t.channelId,
        phase: 'confirming',
        tone: 'warn',
        text: `${chName(s, t.channelId)}：备援确认迟到（已 ${elapsed} 片段，窗口 ${CONFIRM_TICKS}），新通道维持出声；超过截止 ${CONFIRM_DEADLINE} 且旧路可行才回退`,
      });
    }
  }

  // 3) 越过边界
  s.tick = atTick + 1;
  s.seq = seq.n;

  // 4) 检测路由漂移 → 发起准备（本边界先挂 preparing，裁决在下一边界，
  //    保证“发起交接的那个片段”始终由旧通道完整播完）
  openDriftTickets(s, seq);

  // 5) 准备中的票在边界上做一致性批量裁决（按频道优先级统一结算席位，
  //    避免同边界内先切者影响后切者的判断）：
  //    - 旧路仍可行（译员已在边界前恢复且有席位）→ 吸收，取消交接；
  //    - 否则取有席位的最优备援路由 → 原子切换；
  //    - 都没有 → 边界静音。
  decideBoundary(s, seq);

  // 6) 新片段开声
  reconcileSessions(s, seq);

  s.seq = seq.n;
  return pruneFinished(s);
}

/** 边界批量裁决：见 advance 第 5 步 */
function decideBoundary(s: HandoverState, seq: SeqRef): void {
  const preparing = Object.values(s.tickets)
    .filter((t) => t.phase === 'preparing' && !t.finished && s.tick >= t.openTick + 1)
    .sort(
      (a, b) =>
        channelPriority(s, a.channelId) - channelPriority(s, b.channelId) ||
        a.openTick - b.openTick ||
        (a.id < b.id ? -1 : 1),
    );
  if (preparing.length === 0) return;

  // 席位台账：先计入“不参与本次裁决”的频道（确认中 / 无票频道）的在役路由
  const deciding = new Set(preparing.map((t) => t.channelId));
  const loads = new Map<string, number>();
  for (const ch of s.scenario.channels) {
    if (deciding.has(ch.id)) continue;
    const r = s.effective[ch.id];
    if (r) for (const l of r.legs) loads.set(l.interpreterId, (loads.get(l.interpreterId) ?? 0) + 1);
  }
  const cap = (id: string) => s.scenario.interpreters.find((i) => i.id === id)?.capacity ?? 0;
  const online = (id: string) => s.scenario.interpreters.some((i) => i.id === id && i.online);
  const hasSeats = (r: Route) => r.legs.every((l) => (loads.get(l.interpreterId) ?? 0) < cap(l.interpreterId));
  const reserve = (r: Route) => r.legs.forEach((l) => loads.set(l.interpreterId, (loads.get(l.interpreterId) ?? 0) + 1));

  for (const t of preparing) {
    // 失声频道的恢复：没有旧会话要关，边界直接由新路开声
    if (t.recover && t.toRoute) {
      const feasible =
        t.toRoute.legs.every((l) => online(l.interpreterId)) && hasSeats(t.toRoute);
      if (feasible) {
        reserve(t.toRoute);
        commitSwitch(s, t, seq);
        const done = s.tickets[t.id];
        if (done) s.tickets = { ...s.tickets, [t.id]: { ...done, recover: true } };
      } else {
        // 恢复票的目标又失效：保持失声，移除该票（下轮漂移会重新开票）
        t.toRoute = undefined;
        t.finished = true;
        t.outcome = 'abandoned';
        s.tickets = { ...s.tickets, [t.id]: { ...t } };
      }
      continue;
    }

    const oldFeasible =
      t.fromRoute.legs.every((l) => online(l.interpreterId)) && hasSeats(t.fromRoute);
    if (oldFeasible) {
      reserve(t.fromRoute);
      abandonTicket(s, t, seq, '主译员在边界前恢复且席位充足，交接取消，旧通道连续出声（断线被整段吸收）');
      continue;
    }
    // 宽限边界：旧路刚失效的前 GRACE_TICKS 次裁决顺延（抖动缓冲续播），
    // 让短暂断线有机会在真正改派前恢复
    if (s.tick - t.openTick <= GRACE_TICKS) {
      reserve(t.fromRoute); // 缓冲占位：旧译员仍按在役计席（他在缓冲内“续播”）
      s.events = pushEvent(s.events, seq, {
        tick: s.tick,
        channelId: t.channelId,
        phase: 'preparing',
        tone: 'warn',
        text: `${chName(s, t.channelId)}：断线宽限边界——${describeRoute(s, t.fromRoute)} 靠抖动缓冲续播本片段，交接顺延，不停播不双播`,
      });
      continue;
    }
    // 最优备援：跳数少优先、译员编号字典序（与全局分配一致的确定性）
    const ch = s.scenario.channels.find((c) => c.id === t.channelId);
    if (!ch) continue;
    const alt = findCandidateRoutes(s.scenario.floor, ch.target, s.scenario.interpreters)
      .filter((r) => !sameRoute(r, t.fromRoute))
      .find((r) => r.legs.every((l) => online(l.interpreterId)) && hasSeats(r));
    if (!alt) {
      t.toRoute = undefined;
      silenceTicket(s, t, seq);
      continue;
    }
    t.toRoute = cloneRoute(alt);
    reserve(alt);
    commitSwitch(s, t, seq);
  }
}

function channelPriority(s: HandoverState, channelId: string): number {
  return s.scenario.channels.find((c) => c.id === channelId)?.priority ?? 99;
}

/** 回退前校验：旧路由译员在线，且除当前频道外的在役占用之外仍有余席 */
function oldRouteFeasible(s: HandoverState, channelId: string, old: Route): boolean {
  const loads = new Map<string, number>();
  for (const ch of s.scenario.channels) {
    if (ch.id === channelId) continue;
    const r = s.effective[ch.id];
    if (r) for (const l of r.legs) loads.set(l.interpreterId, (loads.get(l.interpreterId) ?? 0) + 1);
  }
  return old.legs.every((l) => {
    const it = s.scenario.interpreters.find((x) => x.id === l.interpreterId);
    return !!it?.online && (loads.get(l.interpreterId) ?? 0) < it.capacity;
  });
}

/** 边界原子切换：关旧会话、生效路由切到备援、置确认中；新会话由 reconcile 开启 */
function commitSwitch(s: HandoverState, t: HandoverTicket, seq: SeqRef): void {
  const to = t.toRoute as Route;
  s.sessions = s.sessions.map((sess) =>
    sess.channelId === t.channelId && sess.endTick === null
      ? { ...sess, endTick: s.tick, close: 'handover' as const }
      : sess,
  );
  s.effective = { ...s.effective, [t.channelId]: cloneRoute(to) };
  t.phase = 'confirming';
  t.switchTick = s.tick;
  s.tickets = { ...s.tickets, [t.id]: { ...t } };
  s.events = pushEvent(s.events, seq, {
    tick: s.tick,
    channelId: t.channelId,
    phase: 'switching',
    tone: 'info',
    text: t.recover
      ? `${chName(s, t.channelId)}：片段边界恢复开声——${describeRoute(s, to)} 自片段 ${s.tick} 出声`
      : `${chName(s, t.channelId)}：片段边界切换——${describeRoute(s, t.fromRoute)} 在边界关流，${describeRoute(s, to)} 自片段 ${s.tick} 开声（无重叠）`,
  });
}

/** 边界静音：关会话、移除生效路由 */
function silenceTicket(s: HandoverState, t: HandoverTicket, seq: SeqRef): void {
  s.sessions = s.sessions.map((sess) =>
    sess.channelId === t.channelId && sess.endTick === null
      ? { ...sess, endTick: s.tick, close: 'silence' as const }
      : sess,
  );
  delete s.effective[t.channelId];
  t.phase = 'switching';
  t.finished = true;
  t.outcome = 'silenced';
  s.tickets = { ...s.tickets, [t.id]: { ...t } };
  s.events = pushEvent(s.events, seq, {
    tick: s.tick,
    channelId: t.channelId,
    phase: 'switching',
    tone: 'bad',
    text: `${chName(s, t.channelId)}：片段 ${s.tick} 边界静音，等待译员资源恢复（不会有第二条通道顶替发声）`,
  });
}

/** 每频道在当前片段解析出唯一在播会话：刚切换的开新会话，其余延续 */
function reconcileSessions(s: HandoverState, seq: SeqRef): void {
  const sessions = [...s.sessions];
  for (const ch of s.scenario.channels) {
    const route = s.effective[ch.id];
    const open = sessions.find((x) => x.channelId === ch.id && x.endTick === null);

    if (!route) {
      if (open) {
        sessions[sessions.indexOf(open)] = { ...open, endTick: s.tick, close: 'silence' };
      }
      continue;
    }

    if (open) {
      if (!sameRoute(open.route, route)) {
        // 防御性路径：正常流程中切换总是先关旧会话。关闭再重开，仍保持互斥。
        sessions[sessions.indexOf(open)] = { ...open, endTick: s.tick, close: 'handover' };
        sessions.push({
          id: `sess-${++seq.n}`,
          channelId: ch.id,
          route: cloneRoute(route),
          startTick: s.tick,
          endTick: null,
        });
      }
      continue;
    }

    sessions.push({
      id: `sess-${++seq.n}`,
      channelId: ch.id,
      route: cloneRoute(route),
      startTick: s.tick,
      endTick: null,
    });
    const tk = openTicketOf(s, ch.id);
    s.events = pushEvent(s.events, seq, {
      tick: s.tick,
      channelId: ch.id,
      phase: tk?.phase ?? 'system',
      tone: 'ok',
      text:
        tk && tk.phase === 'confirming'
          ? `${ch.name}：新通道已开声，等待备援确认（${CONFIRM_TICKS} 个片段内，逾期回退）`
          : `${ch.name}：片段 ${s.tick} 起由 ${describeRoute(s, route)} 出声`,
    });
  }
  s.sessions = sessions;
}

/** 确认完成：票据闭环，旧通道保持关闭 */
function completeTicket(s: HandoverState, t: HandoverTicket, seq: SeqRef, reason: string): void {
  t.phase = 'confirming';
  t.finished = true;
  t.outcome = 'completed';
  t.fail = 'none';
  s.tickets = { ...s.tickets, [t.id]: { ...t } };
  s.events = pushEvent(s.events, seq, {
    tick: s.tick,
    channelId: t.channelId,
    phase: 'confirming',
    tone: 'ok',
    text: `${chName(s, t.channelId)}：${reason}，交接闭环（${describeRoute(s, t.fromRoute)} → ${t.toRoute ? describeRoute(s, t.toRoute) : '静音'}）`,
  });
}

/** 回退：新会话即刻关闭，生效路由还原；下一片段由旧通道重新开声 */
/** 回退：新会话在指定边界关闭，生效路由还原；下一片段由旧通道重新开声 */
function revertTicket(s: HandoverState, t: HandoverTicket, seq: SeqRef, atBoundary: number, reason: string): void {
  s.sessions = s.sessions.map((sess) =>
    sess.channelId === t.channelId && sess.endTick === null && t.toRoute && sameRoute(sess.route, t.toRoute)
      ? { ...sess, endTick: atBoundary, close: 'revert' as const }
      : sess,
  );
  s.effective = { ...s.effective, [t.channelId]: cloneRoute(t.fromRoute) };
  t.phase = 'switching';
  t.finished = true;
  t.outcome = 'reverted';
  s.tickets = { ...s.tickets, [t.id]: { ...t } };
  s.events = pushEvent(s.events, seq, {
    tick: atBoundary,
    channelId: t.channelId,
    phase: 'switching',
    tone: 'bad',
    text: `${chName(s, t.channelId)}：${reason}，回退旧通道——${describeRoute(s, t.fromRoute)} 自片段 ${atBoundary} 重新接管，新通道已关流`,
  });
}

/** 放弃交接：旧通道原样继续（无会话变化） */
function abandonTicket(s: HandoverState, t: HandoverTicket, seq: SeqRef, reason: string): void {
  t.phase = 'preparing';
  t.finished = true;
  t.outcome = 'abandoned';
  t.fail = 'none';
  s.tickets = { ...s.tickets, [t.id]: { ...t } };
  s.events = pushEvent(s.events, seq, {
    tick: s.tick,
    channelId: t.channelId,
    phase: 'preparing',
    tone: 'info',
    text: `${chName(s, t.channelId)}：${reason}`,
  });
}

/** 手动确认：窗口内才闭环；窗口外登记迟到；重复/陈旧信号幂等忽略 */
function resolveTicket(base: HandoverState, ticketId: string): HandoverState {
  const t0 = base.tickets[ticketId];
  if (!t0 || t0.finished || t0.phase !== 'confirming') return base;
  const s = snapshotForUndo(base);
  const seq: SeqRef = { n: s.seq };
  const t = s.tickets[ticketId];
  const elapsed = s.tick - (t.switchTick ?? s.tick);
  if (elapsed > CONFIRM_TICKS) {
    t.fail = 'late-ack';
    s.tickets = { ...s.tickets, [ticketId]: { ...t } };
    s.events = pushEvent(s.events, seq, {
      tick: s.tick,
      channelId: t.channelId,
      phase: 'confirming',
      tone: 'warn',
      text: `${chName(s, t.channelId)}：备援确认迟到（第 ${elapsed} 片段，窗口 ${CONFIRM_TICKS}），登记迟到；超过截止 ${CONFIRM_DEADLINE} 仍将回退`,
    });
    s.seq = seq.n;
    return s;
  }
  completeTicket(s, t, seq, '操作员确认备援信号');
  s.seq = seq.n;
  return pruneFinished(s);
}

// ---------------------------------------------------------------- 故障注入

/** 主译员短暂断线：立即离线并发起准备，blipTicks 边界后自动返岗 */
function injectDisconnect(base: HandoverState, channelId: string, blipTicks = 2): HandoverState {
  const s = snapshotForUndo(base);
  const seq: SeqRef = { n: s.seq };
  const route = s.effective[channelId];
  if (!route) return base;
  const interpId = firstLegId(route);
  const interp = s.scenario.interpreters.find((i) => i.id === interpId);
  if (!interp || !interp.online) return base;

  s.scenario = {
    ...s.scenario,
    interpreters: s.scenario.interpreters.map((i) => (i.id === interpId ? { ...i, online: false } : i)),
  };
  s.events = pushEvent(s.events, seq, {
    tick: s.tick,
    channelId,
    phase: 'system',
    tone: 'bad',
    text: `${chName(s, channelId)}：主译员 ${interp.name} 短暂断线（预计 ${blipTicks} 片段）——当前片段不切走，备援将于边界接手`,
  });
  openDriftTickets(s, seq);
  for (const t of Object.values(s.tickets)) {
    if (t.channelId === channelId || (t.fromRoute && firstLegId(t.fromRoute) === interpId && !t.finished)) {
      t.fail = 'blip';
      t.blipUntil = s.tick + blipTicks;
      s.tickets = { ...s.tickets, [t.id]: { ...t } };
    }
  }
  s.seq = seq.n;
  return s;
}

/** 手动重连（模拟主译员恢复）：幂等；重复恢复不重播，切换后不抢通道 */
function reconnect(base: HandoverState, channelId: string): HandoverState {
  const s = snapshotForUndo(base);
  const seq: SeqRef = { n: s.seq };
  const ticket =
    Object.values(s.tickets).find((t) => t.channelId === channelId && !t.finished) ??
    Object.values(s.tickets).find((t) => t.channelId === channelId && t.phase === 'confirming');
  const targetId = ticket
    ? firstLegId(ticket.fromRoute)
    : s.scenario.interpreters.find((i) => !i.online && i.source === s.scenario.floor)?.id;
  if (!targetId) return base;
  const interp = s.scenario.interpreters.find((i) => i.id === targetId);
  if (!interp) return base;

  if (interp.online) {
    s.events = pushEvent(s.events, seq, {
      tick: s.tick,
      channelId,
      phase: 'system',
      tone: 'info',
      text: `${chName(s, channelId)}：${interp.name} 的重复恢复信号已忽略（幂等），维持当前在播者，不重播、不双播`,
    });
    s.seq = seq.n;
    return s;
  }

  s.scenario = {
    ...s.scenario,
    interpreters: s.scenario.interpreters.map((i) => (i.id === targetId ? { ...i, online: true } : i)),
  };
  for (const t of Object.values(s.tickets)) {
    if (!t.finished && firstLegId(t.fromRoute) === targetId && t.blipUntil !== undefined && !t.blipRecovered) {
      t.fail = 'none';
      t.blipUntil = s.tick;
      t.blipRecovered = true;
      s.tickets = { ...s.tickets, [t.id]: { ...t } };
    }
  }

  const switched = !!openTicketOf(s, channelId)?.switchTick;
  s.events = pushEvent(s.events, seq, {
    tick: s.tick,
    channelId,
    phase: ticket?.phase ?? 'system',
    tone: switched ? 'info' : 'ok',
    text: switched
      ? `${chName(s, channelId)}：主译员 ${interp.name} 恢复连线，但备援正在岗——旧主不立即抢通道；如需切回将另走一次完整交接`
      : `${chName(s, channelId)}：主译员 ${interp.name} 恢复连线，下一边界复核若漂移消失则取消交接、旧通道连续出声`,
  });
  s.seq = seq.n;
  return s;
}

/** 故障注入：迟到确认 / 确认丢失 / 备援离线 */
function injectFail(base: HandoverState, channelId: string, fail: Exclude<FailKind, 'none' | 'blip'>): HandoverState {
  const s = snapshotForUndo(base);
  const seq: SeqRef = { n: s.seq };

  if (fail === 'backup-offline') {
    const t = openTicketOf(s, channelId);
    const backupId = t?.toRoute ? firstLegId(t.toRoute) : undefined;
    const id =
      backupId ??
      (() => {
        // 尚无票时，对当前在役译员的同方向备援下手
        const cur = s.effective[channelId];
        if (!cur) return undefined;
        const leg = cur.legs[0];
        return findCandidateRoutes(s.scenario.floor, leg.target, s.scenario.interpreters)
          .flatMap((r) => r.legs.map((l) => l.interpreterId))
          .find((x) => x !== leg.interpreterId);
      })();
    if (!id) return base;
    s.scenario = {
      ...s.scenario,
      interpreters: s.scenario.interpreters.map((i) => (i.id === id ? { ...i, online: false } : i)),
    };
    s.events = pushEvent(s.events, seq, {
      tick: s.tick,
      channelId,
      phase: t?.phase ?? 'preparing',
      tone: 'bad',
      text: `${chName(s, channelId)}：注入故障——备援 ${nameOf(s, id)} 离线；边界交接将被拒绝并保持当前通道`,
    });
    if (t) {
      t.fail = 'backup-offline';
      s.tickets = { ...s.tickets, [t.id]: { ...t } };
    }
    s.seq = seq.n;
    return s;
  }

  const t = openTicketOf(s, channelId);
  if (!t || t.phase !== 'confirming') {
    s.events = pushEvent(s.events, seq, {
      tick: s.tick,
      channelId,
      phase: 'system',
      tone: 'info',
      text: `${chName(s, channelId)}：当前没有确认中的交接，“${fail === 'late-ack' ? '迟到确认' : '确认丢失'}”注入已忽略`,
    });
    s.seq = seq.n;
    return s;
  }
  t.fail = fail;
  s.tickets = { ...s.tickets, [t.id]: { ...t } };
  s.events = pushEvent(s.events, seq, {
    tick: s.tick,
    channelId,
    phase: 'confirming',
    tone: 'warn',
    text:
      fail === 'late-ack'
        ? `${chName(s, channelId)}：注入故障——备援确认将迟到（超过 ${CONFIRM_TICKS} 片段窗口，${CONFIRM_DEADLINE} 片段后回退）`
        : `${chName(s, channelId)}：注入故障——备援确认信号丢失（${CONFIRM_DEADLINE} 片段后自动回退旧通道）`,
  });
  s.seq = seq.n;
  return s;
}

// ---------------------------------------------------------------- 场景变更（译员表 / 优先级）

/** 应用一次场景配置变更：当前片段继续由在役路由播，漂移立即挂准备票，下一边界裁决 */
function applyScenarioChange(base: HandoverState, mutate: (s: Scenario) => Scenario): HandoverState {
  const s = snapshotForUndo(base);
  const seq: SeqRef = { n: s.seq };
  s.scenario = mutate(s.scenario);
  openDriftTickets(s, seq);
  s.seq = seq.n;
  return pruneFinished(s);
}

function toggleInterpreter(base: HandoverState, id: string): HandoverState {
  const it = base.scenario.interpreters.find((i) => i.id === id);
  if (!it) return base;
  return applyScenarioChange(base, (sc) => ({
    ...sc,
    interpreters: sc.interpreters.map((i) => (i.id === id ? { ...i, online: !i.online } : i)),
  }));
}

function removeInterpreter(base: HandoverState, id: string): HandoverState {
  return applyScenarioChange(base, (sc) => ({
    ...sc,
    interpreters: sc.interpreters.filter((i) => i.id !== id),
  }));
}

function setCapacity(base: HandoverState, id: string, capacity: number): HandoverState {
  return applyScenarioChange(base, (sc) => ({
    ...sc,
    interpreters: sc.interpreters.map((i) => (i.id === id ? { ...i, capacity } : i)),
  }));
}

let customInterpSeq = 0;

function addInterpreter(
  base: HandoverState,
  draft: { name: string; source: string; target: string; capacity: number },
): HandoverState {
  if (draft.source === draft.target) return base;
  const id = `int-custom-${++customInterpSeq}-${base.seq}`;
  return applyScenarioChange(base, (sc) => ({
    ...sc,
    interpreters: [...sc.interpreters, { id, online: true, ...draft }],
  }));
}

function setPriority(base: HandoverState, channelId: string, priority: number): HandoverState {
  return applyScenarioChange(base, (sc) => ({
    ...sc,
    channels: sc.channels.map((c) => (c.id === channelId ? { ...c, priority } : c)),
  }));
}

// ---------------------------------------------------------------- 撤销/重做/快照

function snapshotForUndo(s: HandoverState): HandoverState {
  return {
    ...s,
    tickets: Object.fromEntries(Object.entries(s.tickets).map(([k, v]) => [k, { ...v }])),
    sessions: s.sessions.map((x) => ({ ...x, route: cloneRoute(x.route) })),
    events: [...s.events],
    effective: Object.fromEntries(Object.entries(s.effective).map(([k, v]) => [k, cloneRoute(v)])),
    scenario: {
      ...s.scenario,
      interpreters: s.scenario.interpreters.map((i) => ({ ...i })),
      channels: s.scenario.channels.map((c) => ({ ...c })),
      languages: s.scenario.languages,
    },
    past: [],
    future: [],
  };
}

function withHistory(prev: HandoverState, next: HandoverState): HandoverState {
  if (next === prev) return prev;
  const hist = snapshotForUndo(prev);
  return { ...next, past: [...prev.past, hist].slice(-50), future: [] };
}

function stripHistory(s: HandoverState): HandoverState {
  return { ...s, past: [], future: [] };
}

function pruneFinished(s: HandoverState): HandoverState {
  const all = Object.values(s.tickets);
  const finished = all.filter((t) => t.finished).sort((a, b) => b.openTick - a.openTick || (a.id < b.id ? 1 : -1));
  const keep = new Set(finished.slice(0, 10).map((t) => t.id));
  const tickets: Record<string, HandoverTicket> = {};
  for (const t of all) if (!t.finished || keep.has(t.id)) tickets[t.id] = t;
  return { ...s, tickets };
}

// ---------------------------------------------------------------- 名称辅助

function chName(s: HandoverState, channelId: string): string {
  return s.scenario.channels.find((c) => c.id === channelId)?.name ?? channelId;
}

function nameOf(s: HandoverState, id: string): string {
  return s.scenario.interpreters.find((i) => i.id === id)?.name ?? id;
}

function legText(s: HandoverState, interpreterId: string): string {
  const i = s.scenario.interpreters.find((x) => x.id === interpreterId);
  if (!i) return interpreterId;
  const ln = (code: string) => s.scenario.languages.find((l) => l.code === code)?.name ?? code;
  return `${i.name}（${ln(i.source)}→${ln(i.target)}）`;
}

function describeRoute(s: HandoverState, r: Route): string {
  return r.legs.map((l) => legText(s, l.interpreterId)).join(' → ');
}

// ---------------------------------------------------------------- 持久化（刷新恢复）

export function persistHandover(state: HandoverState): void {
  try {
    const { past: _p, future: _f, ...rest } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...rest, running: false }));
  } catch {
    /* 存储不可用时静默：演练仍可在当前页面继续 */
  }
}

export function loadHandover(): HandoverState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HandoverState;
    if (typeof parsed.tick !== 'number' || !parsed.scenario || !parsed.effective) return null;
    return { ...parsed, running: false, past: [], future: [] };
  } catch {
    return null;
  }
}

export function clearPersistedHandover(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- Reducer

export function handoverReducer(base: HandoverState, action: HandoverAction): HandoverState {
  switch (action.type) {
    case 'advance':
      return withHistory(base, advance(base));
    case 'toggleRun':
      return { ...base, running: !base.running };
    case 'setSpeed':
      return { ...base, speed: action.speed };
    case 'injectDisconnect':
      return withHistory(base, injectDisconnect(base, action.channelId, action.durationTicks ?? 2));
    case 'reconnect':
      return withHistory(base, reconnect(base, action.channelId));
    case 'injectFail':
      return withHistory(base, injectFail(base, action.channelId, action.fail));
    case 'resolveTicket':
      return withHistory(base, resolveTicket(base, action.ticketId));
    case 'toggleInterpreter':
      return withHistory(base, toggleInterpreter(base, action.id));
    case 'removeInterpreter':
      return withHistory(base, removeInterpreter(base, action.id));
    case 'setCapacity':
      return withHistory(base, setCapacity(base, action.id, action.capacity));
    case 'addInterpreter':
      return withHistory(base, addInterpreter(base, action.draft));
    case 'setPriority':
      return withHistory(base, setPriority(base, action.channelId, action.priority));
    case 'undo': {
      if (base.past.length === 0) return base;
      const prev = base.past[base.past.length - 1];
      return {
        ...prev,
        running: false,
        speed: base.speed,
        past: base.past.slice(0, -1),
        future: [stripHistory(base), ...base.future].slice(0, 50),
      };
    }
    case 'redo': {
      if (base.future.length === 0) return base;
      const next = base.future[0];
      return {
        ...next,
        running: false,
        speed: base.speed,
        past: [...base.past, stripHistory(base)].slice(-50),
        future: base.future.slice(1),
      };
    }
    case 'reset':
      return createHandoverInitialState(base.scenario);
    case 'hydrate':
      return action.state;
    default:
      return base;
  }
}

// ---------------------------------------------------------------- 选择器 / 自检

export function openSession(s: HandoverState, channelId: string): PlaybackSession | undefined {
  return s.sessions.find((x) => x.channelId === channelId && x.endTick === null);
}

export function openTicket(s: HandoverState, channelId: string): HandoverTicket | undefined {
  return openTicketOf(s, channelId);
}

export function ticketOf(s: HandoverState, ticketId: string): HandoverTicket | undefined {
  return s.tickets[ticketId];
}

/** 未结束票据（按频道优先级） */
export function activeTickets(s: HandoverState): HandoverTicket[] {
  const prio = new Map(s.scenario.channels.map((c) => [c.id, c.priority]));
  return Object.values(s.tickets)
    .filter((t) => !t.finished)
    .sort((a, b) => (prio.get(a.channelId) ?? 99) - (prio.get(b.channelId) ?? 99) || a.openTick - b.openTick);
}

/** 最近完结的票据（轨迹用） */
export function recentFinishedTickets(s: HandoverState, count = 10): HandoverTicket[] {
  return Object.values(s.tickets)
    .filter((t) => t.finished)
    .sort((a, b) => b.openTick - a.openTick || (a.id < b.id ? 1 : -1))
    .slice(0, count);
}

/**
 * 互斥不变量：同一频道任意片段号上至多一条会话覆盖；会话只允许边界相接。
 * 任何操作序列后调用都必须成立。
 */
export function assertNoOverlap(sessions: PlaybackSession[]): void {
  const byChannel = new Map<string, PlaybackSession[]>();
  for (const sess of sessions) {
    const arr = byChannel.get(sess.channelId) ?? [];
    arr.push(sess);
    byChannel.set(sess.channelId, arr);
  }
  for (const [channelId, arr] of byChannel) {
    const open = arr.filter((x) => x.endTick === null);
    if (open.length > 1) throw new Error(`互斥被破坏：频道 ${channelId} 有 ${open.length} 条同时在播会话`);
    const timeline = arr
      .map((x) => ({ start: x.startTick, end: x.endTick ?? Number.POSITIVE_INFINITY }))
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < timeline.length; i++) {
      if (timeline[i].start < timeline[i - 1].end) {
        throw new Error(`互斥被破坏：频道 ${channelId} 会话在片段上重叠`);
      }
    }
  }
}

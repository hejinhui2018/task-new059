import type { Allocation, ChannelOutcome, Gap, Route } from '../engine/routing';
import { compareChannels } from '../engine/routing';
import type { HandoverPhase, TraceEvent, TraceKind } from '../engine/handover';
import type { Scenario } from '../types';

/** 描述上下文：名称解析都经过它 */
export interface Ctx {
  scenario: Scenario;
  allocation: Allocation;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info';

export function langName(ctx: Ctx, code: string): string {
  return ctx.scenario.languages.find((l) => l.code === code)?.name ?? code;
}

export function interpreterName(ctx: Ctx, id: string): string {
  return ctx.scenario.interpreters.find((i) => i.id === id)?.name ?? id;
}

export function interpreterCapacity(ctx: Ctx, id: string): number {
  return ctx.scenario.interpreters.find((i) => i.id === id)?.capacity ?? 0;
}

/** 频道状态徽标：图标 + 文字（不依赖颜色传达状态） */
export function statusLabel(ctx: Ctx, o: ChannelOutcome): { icon: string; text: string; tone: Tone } {
  if (o.status === 'ok') {
    return o.route.relay
      ? { icon: '✓', text: `正常 · 经${langName(ctx, o.route.relay)}中继`, tone: 'ok' }
      : { icon: '✓', text: '正常 · 直译', tone: 'ok' };
  }
  if (o.status === 'blocked') return { icon: '⚠', text: '席位不足', tone: 'warn' };
  return { icon: '✕', text: '断路', tone: 'bad' };
}

/** 把一处断路缺口翻译成可读的处置提示 */
export function gapText(ctx: Ctx, g: Gap): string {
  const leg = `${langName(ctx, g.source)}→${langName(ctx, g.target)}`;
  const offline = g.offlineInterpreterIds.map((id) => interpreterName(ctx, id));
  const suffix =
    offline.length > 0
      ? `（可恢复：${offline.join('、')}，当前离线）`
      : g.role === 'direct'
        ? '（可添加该方向译员）'
        : '（无该方向译员）';
  switch (g.role) {
    case 'direct':
      return `缺少 ${leg} 直译译员${suffix}`;
    case 'relay-first':
      return `经${langName(ctx, g.via ?? '')}中继的前段 ${leg} 无在线译员${suffix}`;
    case 'relay-second':
      return `经${langName(ctx, g.via ?? '')}中继的后段 ${leg} 无在线译员${suffix}`;
  }
}

/** 正在占用某译员席位的频道名（按优先级顺序） */
export function occupants(ctx: Ctx, interpreterId: string): string[] {
  const names: string[] = [];
  for (const ch of [...ctx.scenario.channels].sort(compareChannels)) {
    const o = ctx.allocation.byChannel.get(ch.id);
    if (o?.status === 'ok' && o.route.legs.some((l) => l.interpreterId === interpreterId)) {
      names.push(ch.name);
    }
  }
  return names;
}

/** 调度日志用的状态切换文案 */
export function transitionText(ctx: Ctx, channelName: string, o: ChannelOutcome): string {
  if (o.status === 'ok') {
    const how = o.route.relay ? `经${langName(ctx, o.route.relay)}中继` : '直译';
    return `✓ ${channelName} 恢复收听（${how}）`;
  }
  if (o.status === 'blocked') {
    const full = o.fullInterpreters.map((id) => interpreterName(ctx, id)).join('、');
    return `⚠ ${channelName} 席位不足：${full} 已满载`;
  }
  const first = o.gaps[0];
  return `✕ ${channelName} 中断：${first ? gapText(ctx, first) : '无可用路由'}`;
}

/** 路由的紧凑文案：译员名按跳连接；空路由为"静默" */
export function routeText(ctx: Ctx, route: Route | null): string {
  if (!route) return '（静默）';
  return route.legs.map((l) => interpreterName(ctx, l.interpreterId)).join(' → ');
}

/** 交接阶段徽标：图标 + 文字 + 色调（不单独依赖颜色） */
export function phaseLabel(phase: HandoverPhase): { icon: string; text: string; tone: Tone } {
  switch (phase) {
    case 'prepare':
      return { icon: '⏳', text: '准备中', tone: 'info' };
    case 'switch':
      return { icon: '⇄', text: '已切换·待确认', tone: 'warn' };
    case 'rollback':
      return { icon: '↩', text: '回退中', tone: 'warn' };
    case 'confirmed':
      return { icon: '✓', text: '已确认', tone: 'ok' };
    case 'rolledback':
      return { icon: '↩', text: '已回退', tone: 'bad' };
    case 'cancelled':
      return { icon: '✕', text: '已取消', tone: 'info' };
  }
}

const TRACE_TONE: Record<TraceKind, Tone> = {
  prepare: 'info',
  switch: 'warn',
  confirm: 'ok',
  'rollback-plan': 'warn',
  rollback: 'bad',
  cancel: 'info',
  replace: 'warn',
  'late-confirm': 'info',
};

export function traceTone(kind: TraceKind): Tone {
  return TRACE_TONE[kind];
}

function channelName(ctx: Ctx, channelId: string): string {
  return ctx.scenario.channels.find((c) => c.id === channelId)?.name ?? channelId;
}

/** 交接轨迹事件的可读文案（带频道名与片段号） */
export function traceText(ctx: Ctx, ev: TraceEvent): string {
  const ch = channelName(ctx, ev.channelId);
  const from = routeText(ctx, ev.from);
  const to = routeText(ctx, ev.to);
  const note = ev.note ? `（${ev.note}）` : '';
  switch (ev.kind) {
    case 'prepare':
      return `【${ch}】交接发起：${from} ⇒ ${to}${note}`;
    case 'switch':
      return ev.to ? `【${ch}】边界切换生效：${to} 接播` : `【${ch}】边界切换生效：频道静默`;
    case 'confirm':
      return `【${ch}】新路由已确认${note}`;
    case 'rollback-plan':
      return `【${ch}】安排回退${note}`;
    case 'rollback':
      return `【${ch}】回退生效${note}`;
    case 'cancel':
      return `【${ch}】交接取消${note}`;
    case 'replace':
      return `【${ch}】交接被取代${note}`;
    case 'late-confirm':
      return `【${ch}】迟到确认已忽略${note}`;
  }
}

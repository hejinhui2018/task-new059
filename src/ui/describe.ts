import type { Allocation, ChannelOutcome, Gap } from '../engine/routing';
import { compareChannels } from '../engine/routing';
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

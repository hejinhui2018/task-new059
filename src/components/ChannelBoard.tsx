import type { Allocation } from '../engine/routing';
import { compareChannels } from '../engine/routing';
import {
  openSession,
  openTicket,
  type HandoverState,
  type HandoverTicket,
} from '../engine/handover';
import type { Scenario } from '../types';
import {
  gapText,
  interpreterCapacity,
  interpreterName,
  langName,
  occupants,
  statusLabel,
  type Ctx,
} from '../ui/describe';

interface Props {
  scenario: Scenario;
  allocation: Allocation;
  selectedChannelId: string | null;
  onSelect: (id: string | null) => void;
  onPriorityChange: (channelId: string, priority: number) => void;
  /** 交接引擎状态：存在时展示实际在播路由与交接阶段（配置态 vs 播放态） */
  handover?: HandoverState;
}

function clampPriority(raw: string, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(99, Math.max(1, n));
}

const PHASE_BADGE: Record<HandoverTicket['phase'], { icon: string; text: string; cls: string }> = {
  preparing: { icon: '◔', text: '交接准备 · 旧通道续播', cls: 'badge-prepare' },
  switching: { icon: '⇄', text: '边界切换', cls: 'badge-switch' },
  confirming: { icon: '◉', text: '新通道确认中', cls: 'badge-confirm' },
};

export default function ChannelBoard({
  scenario,
  allocation,
  selectedChannelId,
  onSelect,
  onPriorityChange,
  handover,
}: Props) {
  const ctx: Ctx = { scenario, allocation };
  const channels = [...scenario.channels].sort(compareChannels);

  return (
    <section className="panel" aria-label="频道状态板">
      <h2>频道状态板</h2>
      <div className="ch-list">
        {channels.map((ch) => {
          const o = allocation.byChannel.get(ch.id);
          if (!o) return null;
          const s = statusLabel(ctx, o);
          const selected = selectedChannelId === ch.id;
          const live = handover ? openSession(handover, ch.id) : undefined;
          const ticket = handover ? openTicket(handover, ch.id) : undefined;
          const muted = handover && !live;
          const badge = ticket ? PHASE_BADGE[ticket.phase] : null;
          return (
            <article
              key={ch.id}
              className={`ch-card tone-${s.tone} ${selected ? 'selected' : ''} ${muted ? 'is-muted' : ''}`}
              onClick={() => onSelect(selected ? null : ch.id)}
            >
              <header className="ch-head">
                <label className="prio-ctrl" onClick={(e) => e.stopPropagation()}>
                  <span>优先级</span>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={ch.priority}
                    aria-label={`${ch.name}优先级`}
                    onChange={(e) => onPriorityChange(ch.id, clampPriority(e.target.value, ch.priority))}
                  />
                </label>
                <h3>{ch.name}</h3>
                <span className="ch-target">→ {langName(ctx, ch.target)}</span>
                {handover && (
                  <span className={`live-chip ${live ? 'live-on' : 'live-mute'}`}>
                    {live ? '🔊 播放中' : '🔇 静音'}
                  </span>
                )}
                <span className={`chip tone-${s.tone}`}>
                  {s.icon} {s.text}
                </span>
              </header>

              {badge && (
                <div className={`handover-banner ${badge.cls}`}>
                  {badge.icon} {badge.text}
                  {ticket?.switchTick !== undefined && ` · ${handover ? handover.tick - ticket.switchTick! : 0}/2 片段`}
                </div>
              )}

              {o.status === 'ok' && (
                <div className="ch-body">
                  {handover && live && (
                    <p className="live-route">
                      <span className="live-tag">实际出声</span>
                      {live.route.legs
                        .map((leg) => `${interpreterName(ctx, leg.interpreterId)}（${langName(ctx, leg.source)}→${langName(ctx, leg.target)}）`)
                        .join(' → ')}
                      <span className="live-seg">片段 #{live.startTick} 起</span>
                    </p>
                  )}
                  <ol className="route-legs">
                    {o.route.legs.map((leg, i) => {
                      const load = allocation.loads.get(leg.interpreterId) ?? 0;
                      const cap = interpreterCapacity(ctx, leg.interpreterId);
                      return (
                        <li key={leg.interpreterId}>
                          <span className="leg-no">{i + 1}</span>
                          <span className="leg-name">{interpreterName(ctx, leg.interpreterId)}</span>
                          <span className="leg-dir">
                            {langName(ctx, leg.source)} → {langName(ctx, leg.target)}
                          </span>
                          <span className="leg-seats">
                            占 1 席 · 译员负载 {load}/{cap}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                  {o.route.relay && <p className="relay-note">经 {langName(ctx, o.route.relay)} 中继 · 共 2 跳</p>}
                </div>
              )}

              {o.status === 'blocked' && (
                <div className="ch-body">
                  <p className="route-line">
                    可用路径：
                    {o.route.legs
                      .map((leg) => `${interpreterName(ctx, leg.interpreterId)}（${langName(ctx, leg.source)}→${langName(ctx, leg.target)}）`)
                      .join(' → ')}
                  </p>
                  {o.fullInterpreters.map((id) => {
                    const load = allocation.loads.get(id) ?? 0;
                    const cap = interpreterCapacity(ctx, id);
                    const usedBy = occupants(ctx, id);
                    return (
                      <p key={id} className="warn-line">
                        ⚠ {interpreterName(ctx, id)} 席位已满（{load}/{cap}）
                        {usedBy.length > 0 && `，被 ${usedBy.join('、')} 占用`}
                      </p>
                    );
                  })}
                  <p className="hint">建议：提高该频道优先级、扩充译员容量，或增加直译译员。</p>
                </div>
              )}

              {o.status === 'broken' && (
                <div className="ch-body">
                  <p className="broken-title">✕ 断路原因：</p>
                  <ul className="gap-list">
                    {o.gaps.map((g, i) => (
                      <li key={i}>{gapText(ctx, g)}</li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

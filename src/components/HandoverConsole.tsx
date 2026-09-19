import type { Dispatch } from 'react';
import {
  activeTickets,
  firstLegId,
  openSession,
  type AutoSpeed,
  type HandoverAction,
  type HandoverState,
  type HandoverTicket,
} from '../engine/handover';
import { compareChannels } from '../engine/routing';

interface Props {
  state: HandoverState;
  selectedChannelId: string | null;
  onSelectChannel: (id: string) => void;
  dispatch: Dispatch<HandoverAction>;
}

const SPEED_MS: Record<AutoSpeed, number> = { normal: 1200, fast: 550 };
export const AUTO_INTERVAL_MS: Record<AutoSpeed, number> = {
  normal: SPEED_MS.normal,
  fast: SPEED_MS.fast,
};

const PHASE_META: Record<HandoverTicket['phase'], { icon: string; text: string; cls: string }> = {
  preparing: { icon: '◔', text: '准备·热备', cls: 'phase-prepare' },
  switching: { icon: '⇄', text: '切换', cls: 'phase-switch' },
  confirming: { icon: '◉', text: '确认中', cls: 'phase-confirm' },
};

const OUTCOME_TEXT: Record<NonNullable<HandoverTicket['outcome']>, { text: string; cls: string }> = {
  completed: { text: '✓ 已完成', cls: 'out-ok' },
  reverted: { text: '↩ 已回退', cls: 'out-bad' },
  abandoned: { text: '⊘ 已吸收/放弃', cls: 'out-info' },
  silenced: { text: '🔇 已静音', cls: 'out-warn' },
};

function legText(state: HandoverState, id: string): string {
  const it = state.scenario.interpreters.find((i) => i.id === id);
  if (!it) return id;
  const ln = (code: string) => state.scenario.languages.find((l) => l.code === code)?.name ?? code;
  return `${it.name}(${ln(it.source)}→${ln(it.target)})`;
}

function routeText(state: HandoverState, t: HandoverTicket, which: 'from' | 'to'): string {
  const r = which === 'from' ? t.fromRoute : t.toRoute;
  if (!r) return '静音（无可用通道）';
  return r.legs.map((l) => legText(state, l.interpreterId)).join(' → ');
}

export default function HandoverConsole({ state, selectedChannelId, onSelectChannel, dispatch }: Props) {
  const channels = [...state.scenario.channels].sort(compareChannels);
  const targetId = selectedChannelId ?? channels[0]?.id;
  const channel = channels.find((c) => c.id === targetId);
  const tickets = activeTickets(state);
  const ticketForTarget = tickets.find((t) => t.channelId === targetId);
  const session = targetId ? openSession(state, targetId) : undefined;

  const canDisconnect = !!session;
  const canLateAck = ticketForTarget?.phase === 'confirming';
  const primaryOfTicket = ticketForTarget ? firstLegId(ticketForTarget.fromRoute) : undefined;
  const canReconnect =
    !!primaryOfTicket &&
    state.scenario.interpreters.some((i) => i.id === primaryOfTicket && !i.online);

  const confirmElapsed =
    ticketForTarget?.phase === 'confirming' && ticketForTarget.switchTick !== undefined
      ? state.tick - ticketForTarget.switchTick
      : 0;

  return (
    <section className="panel console-panel" aria-label="译员交接演练控制台">
      <div className="console-row">
        <div className="tick-box" role="status" aria-live="polite">
          <span className="tick-label">音频片段</span>
          <span className="tick-no">#{state.tick}</span>
          <span className={`run-dot ${state.running ? 'run' : 'pause'}`} aria-hidden="true" />
          <span className="run-text">{state.running ? '自动演练中' : '已暂停'}</span>
        </div>

        <div className="transport" role="group" aria-label="演练控制">
          <button
            className="btn"
            disabled={state.running}
            onClick={() => dispatch({ type: 'advance' })}
            title="推进一个音频片段，所有交接在片段边界结算"
          >
            ⏭ 单步推进
          </button>
          <button
            className={`btn ${state.running ? 'btn-warn' : 'btn-primary'}`}
            onClick={() => dispatch({ type: 'toggleRun' })}
          >
            {state.running ? '⏸ 暂停' : '▶ 自动演练'}
          </button>
          <div className="speed-ctrl" role="group" aria-label="演练速度">
            {(['normal', 'fast'] as const).map((sp) => (
              <button
                key={sp}
                className={`btn btn-seg ${state.speed === sp ? 'seg-on' : ''}`}
                onClick={() => dispatch({ type: 'setSpeed', speed: sp })}
              >
                {sp === 'normal' ? '常速' : '快速'}
              </button>
            ))}
          </div>
          <button
            className="btn"
            disabled={state.past.length === 0}
            onClick={() => dispatch({ type: 'undo' })}
            title="撤销上一步"
          >
            ↶ 撤销
          </button>
          <button
            className="btn"
            disabled={state.future.length === 0}
            onClick={() => dispatch({ type: 'redo' })}
            title="重做"
          >
            ↷ 重做
          </button>
          <button className="btn" onClick={() => dispatch({ type: 'reset' })}>
            ⟲ 重置演练
          </button>
        </div>
      </div>

      <div className="console-row inject-row">
        <label className="inject-ch">
          故障注入频道
          <select value={targetId ?? ''} onChange={(e) => onSelectChannel(e.target.value)} aria-label="选择频道">
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn btn-fault"
          disabled={!canDisconnect}
          onClick={() => dispatch({ type: 'injectDisconnect', channelId: targetId, durationTicks: 2 })}
          title="主译员短暂断线 2 个片段：边界前恢复则整段吸收"
        >
          ⚡ 主译短暂断线
        </button>
        <button
          className="btn btn-fault"
          disabled={!canReconnect}
          onClick={() => dispatch({ type: 'reconnect', channelId: targetId })}
          title="模拟主译员恢复连线（重复点击为重复恢复，幂等不重播）"
        >
          📶 主译重连
        </button>
        <button
          className="btn btn-fault"
          disabled={!canLateAck}
          onClick={() => dispatch({ type: 'injectFail', channelId: targetId, fail: 'late-ack' })}
          title="备援确认迟到：超窗口告警，超截止且旧路可行才回退"
        >
          🕐 迟到确认
        </button>
        <button
          className="btn btn-fault"
          disabled={!canLateAck}
          onClick={() => dispatch({ type: 'injectFail', channelId: targetId, fail: 'drop-ack' })}
          title="备援确认信号丢失：到截止自动回退旧通道"
        >
          ✕ 确认丢失
        </button>
        <button
          className="btn btn-fault"
          disabled={!ticketForTarget || ticketForTarget.phase !== 'preparing'}
          onClick={() => dispatch({ type: 'injectFail', channelId: targetId, fail: 'backup-offline' })}
          title="备援译员离线：边界无法交接则静音等待"
        >
          🚫 备援离线
        </button>
        {channel && (
          <span className="inject-hint">
            当前：{session ? `${legText(state, firstLegId(session.route))} 出声中` : '🔇 静音等待中'}
            {canLateAck && ` · 确认已等待 ${confirmElapsed}/2 片段`}
          </span>
        )}
      </div>

      {tickets.length > 0 && (
        <div className="ticket-list" aria-label="进行中的交接">
          {tickets.map((t) => {
            const meta = PHASE_META[t.phase];
            const chName = state.scenario.channels.find((c) => c.id === t.channelId)?.name ?? t.channelId;
            const elapsed = t.switchTick !== undefined ? state.tick - t.switchTick : 0;
            return (
              <article key={t.id} className={`ticket ${meta.cls}`}>
                <header>
                  <span className={`phase-chip ${meta.cls}`}>
                    {meta.icon} {meta.text}
                  </span>
                  <strong>{chName}</strong>
                  <span className="ticket-route">
                    {routeText(state, t, 'from')} <span className="arrow">⇒</span> {routeText(state, t, 'to')}
                  </span>
                </header>
                <footer>
                  <span className="ticket-meta">
                    发起于片段 #{t.openTick}
                    {t.switchTick !== undefined && ` · 切换于 #${t.switchTick} · 确认 ${elapsed}/2`}
                    {t.fail !== 'none' && <em className="ticket-fail">故障：{failText(t.fail)}</em>}
                  </span>
                  <span className="ticket-actions">
                    {t.phase === 'confirming' && (
                      <button
                        className="btn btn-mini btn-primary"
                        onClick={() => dispatch({ type: 'resolveTicket', ticketId: t.id })}
                      >
                        ✓ 手动确认
                      </button>
                    )}
                    {t.phase === 'preparing' && <span className="wait-note">等待片段边界 …</span>}
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function failText(fail: HandoverTicket['fail']): string {
  switch (fail) {
    case 'blip':
      return '短暂断线';
    case 'late-ack':
      return '确认迟到';
    case 'drop-ack':
      return '确认丢失';
    case 'backup-offline':
      return '备援离线';
    default:
      return fail;
  }
}

export { OUTCOME_TEXT };

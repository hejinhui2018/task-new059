import {
  recentFinishedTickets,
  type HandoverEvent,
  type HandoverState,
  type HandoverTicket,
} from '../engine/handover';
import { compareChannels } from '../engine/routing';

interface Props {
  state: HandoverState;
}

const PHASE_TAG: Record<HandoverEvent['phase'], { text: string; cls: string }> = {
  system: { text: '系统', cls: 'tag-info' },
  preparing: { text: '准备', cls: 'tag-prepare' },
  switching: { text: '切换', cls: 'tag-switch' },
  confirming: { text: '确认', cls: 'tag-confirm' },
};

const OUTCOME_TAG: Record<NonNullable<HandoverTicket['outcome']>, string> = {
  completed: '✓ 完成',
  reverted: '↩ 回退',
  abandoned: '⊘ 吸收',
  silenced: '🔇 静音',
};

/** 某频道在给定片段号上由谁出声（返回译员序列或 null=静音） */
function routeAtSegment(state: HandoverState, channelId: string, seg: number): string[] | null {
  const sess = state.sessions.filter((x) => x.channelId === channelId);
  for (const s of sess) {
    const end = s.endTick ?? Number.POSITIVE_INFINITY;
    if (seg >= s.startTick && seg < end) return s.route.legs.map((l) => l.interpreterId);
  }
  return null;
}

function interpShort(state: HandoverState, id: string): string {
  return state.scenario.interpreters.find((i) => i.id === id)?.name ?? id;
}

const TONE_ICON = { ok: '✓', warn: '⚠', bad: '✕', info: 'ℹ' } as const;

export default function HandoverTimeline({ state }: Props) {
  const channels = [...state.scenario.channels].sort(compareChannels);
  const segs = Array.from({ length: state.tick + 1 }, (_, i) => i); // 已播 + 当前
  const window = segs.slice(-14);
  const finished = recentFinishedTickets(state, 6);

  return (
    <section className="panel timeline-panel" aria-label="交接事件轨迹">
      <h2>交接轨迹 · 片段边界与事件</h2>

      <div className="ribbons" aria-label="各频道按片段的出声带状图（同频道每段至多一个出声者）">
        {channels.map((ch) => {
          const activeTicket = Object.values(state.tickets).find((t) => t.channelId === ch.id && !t.finished);
          return (
            <div key={ch.id} className="ribbon-row">
              <span className="ribbon-name">{ch.name}</span>
              <div className="ribbon">
                {window.map((seg) => {
                  const route = routeAtSegment(state, ch.id, seg);
                  const isCurrent = seg === state.tick;
                  const switchedHere = activeTicket?.switchTick === seg;
                  return (
                    <div
                      key={seg}
                      className={`seg ${route ? 'seg-live' : 'seg-mute'} ${isCurrent ? 'seg-current' : ''}`}
                      title={
                        route
                          ? `片段 #${seg}：${route.map((id) => interpShort(state, id)).join(' → ')}`
                          : `片段 #${seg}：静音`
                      }
                    >
                      <span className="seg-label">
                        {route ? interpShort(state, route[0]).slice(0, 1) : '✕'}
                      </span>
                      {switchedHere && <span className="seg-switch-mark" title="此边界发生切换" />}
                    </div>
                  );
                })}
              </div>
              <span className={`ribbon-phase ${activeTicket ? `phase-${activeTicket.phase}` : ''}`}>
                {activeTicket
                  ? `${PHASE_TAG[activeTicket.phase].text}${activeTicket.phase === 'confirming' ? ` ${state.tick - (activeTicket.switchTick ?? state.tick)}/2` : ''}`
                  : '稳态'}
              </span>
            </div>
          );
        })}
        <p className="ribbon-legend">
          每格为一个音频片段，数字=片段号；✕=静音；粗框=当前片段；彩点=该边界发生过切换。同一频道任意时刻只有一格出声。
        </p>
      </div>

      {finished.length > 0 && (
        <ol className="ticket-history" aria-label="近期交接记录">
          {finished.map((t) => {
            const chName = state.scenario.channels.find((c) => c.id === t.channelId)?.name ?? t.channelId;
            return (
              <li key={t.id} className={`hist-out out-${t.outcome}`}>
                <span className="hist-ch">{chName}</span>
                <span className="hist-seg">
                  #{t.openTick}
                  {t.switchTick !== undefined && `→#${t.switchTick}`}
                </span>
                <span className="hist-out-tag">{t.outcome ? OUTCOME_TAG[t.outcome] : ''}</span>
              </li>
            );
          })}
        </ol>
      )}

      <ul className="log-list trail-list" aria-live="polite">
        {[...state.events].reverse().map((e) => {
          const tag = PHASE_TAG[e.phase];
          const chName = e.channelId
            ? state.scenario.channels.find((c) => c.id === e.channelId)?.name ?? e.channelId
            : null;
          return (
            <li key={e.id} className={`log-${e.tone}`}>
              <time>#{e.tick}</time>
              <span className={`phase-tag ${tag.cls}`}>{tag.text}</span>
              {chName && <span className="ch-tag">{chName}</span>}
              <span className="log-icon">{TONE_ICON[e.tone]}</span>
              <span>{e.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

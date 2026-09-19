import type { Session } from '../engine/handover';
import { activeHandover, desiredRoute, sameRoute } from '../engine/handover';
import { DRILL_SCRIPTS } from '../engine/drills';
import type { Allocation } from '../engine/routing';
import { compareChannels } from '../engine/routing';
import type { Scenario } from '../types';
import { langName, phaseLabel, routeText, traceText, type Ctx } from '../ui/describe';

export interface DrillView {
  scriptId: string | null;
  stepIndex: number;
  autoConfirm: boolean;
  running: boolean;
}

interface Props {
  scenario: Scenario;
  allocation: Allocation;
  session: Session;
  drill: DrillView;
  canUndo: boolean;
  canRedo: boolean;
  onTick: () => void;
  onToggleRun: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onResetDrill: () => void;
  onSelectScript: (id: string | null) => void;
  onToggleAutoConfirm: () => void;
  onInject: (interpreterId: string, online: boolean) => void;
  onConfirm: (handoverId: string) => void;
}

export default function HandoverPanel({
  scenario,
  allocation,
  session,
  drill,
  canUndo,
  canRedo,
  onTick,
  onToggleRun,
  onUndo,
  onRedo,
  onResetDrill,
  onSelectScript,
  onToggleAutoConfirm,
  onInject,
  onConfirm,
}: Props) {
  const ctx: Ctx = { scenario, allocation };
  const channels = [...scenario.channels].sort(compareChannels);
  const script = DRILL_SCRIPTS.find((s) => s.id === drill.scriptId) ?? null;
  const trace = [...session.trace].reverse();

  return (
    <section className="panel drill-panel" aria-label="交接演练台">
      <h2>交接演练台</h2>

      <div className="drill-controls">
        <span className="seg-clock" title="音频片段时钟：在播路由只在片段边界变更">
          ▸ 片段 <strong>#{session.segment}</strong>
        </span>
        <select
          value={drill.scriptId ?? ''}
          aria-label="演练脚本"
          onChange={(e) => onSelectScript(e.target.value || null)}
        >
          <option value="">自由演练（手动注入）</option>
          {DRILL_SCRIPTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          className={`switch ${drill.autoConfirm ? 'on' : 'off'}`}
          role="switch"
          aria-checked={drill.autoConfirm}
          title="开启后，新路由在切换后的下一个边界自动确认；关闭则需手动确认，超时回退"
          onClick={onToggleAutoConfirm}
        >
          <span className="knob" />
          <span className="switch-label">自动确认</span>
        </button>
      </div>

      <div className="drill-buttons">
        <button className="btn btn-primary" onClick={onToggleRun}>
          {drill.running ? '⏸ 暂停' : '▶ 自动演练'}
        </button>
        <button className="btn" onClick={onTick} title="推进一个片段（在片段边界应用待定的交接）">
          ⏭ 单步
        </button>
        <button className="btn" onClick={onUndo} disabled={!canUndo} title="撤销上一步操作">
          ↩ 撤销
        </button>
        <button className="btn" onClick={onRedo} disabled={!canRedo} title="重做被撤销的操作">
          ↪ 重做
        </button>
        <button className="btn" onClick={onResetDrill} title="片段时钟归零，按当前场景重新开播">
          ⟳ 演练归零
        </button>
      </div>

      {script && (
        <p className="drill-progress">
          脚本「{script.name}」：{script.summary} —— 进度 {Math.min(drill.stepIndex, script.steps.length)}/
          {script.steps.length}
        </p>
      )}

      <div className="fault-row" aria-label="故障注入">
        <span className="fault-label">故障注入</span>
        {scenario.interpreters.map((it) => (
          <button
            key={it.id}
            className={`btn fault-btn ${it.online ? '' : 'fault-off'}`}
            title={`${it.name}（${langName(ctx, it.source)}→${langName(ctx, it.target)}）：幂等置位，重复注入会被忽略`}
            onClick={() => onInject(it.id, !it.online)}
          >
            {it.online ? `✂ ${it.name} 断线` : `⚡ ${it.name} 恢复`}
          </button>
        ))}
      </div>

      <div className="ho-list">
        {channels.map((ch) => {
          const live = session.live[ch.id];
          const desired = desiredRoute(allocation, ch.id);
          const h = activeHandover(session, ch.id);
          const p = h ? phaseLabel(h.phase) : null;
          return (
            <div key={ch.id} className={`ho-card ${h ? 'ho-active' : ''}`}>
              <header className="ho-head">
                <strong>{ch.name}</strong>
                {p && (
                  <span className={`chip tone-${p.tone}`}>
                    {p.icon} {p.text}
                  </span>
                )}
              </header>
              <p className="ho-line">
                在播：{routeText(ctx, live?.route ?? null)}
                {live && <span className="ho-since"> · 自片段 #{live.since}</span>}
              </p>
              {h && (
                <p className="ho-line ho-plan">
                  目标：{routeText(ctx, h.to)}
                  {h.phase === 'prepare' && <span className="ho-since"> · 片段 #{h.boundaryAt} 边界生效</span>}
                  {h.phase === 'switch' && h.confirmDeadline !== null && (
                    <span className="ho-since"> · 片段 #{h.confirmDeadline} 前待确认</span>
                  )}
                  {h.phase === 'rollback' && <span className="ho-since"> · 下一边界切回</span>}
                </p>
              )}
              {!h && live && sameRoute(desired, live.route) && <p className="ho-line ho-stable">✓ 在播与目标一致</p>}
              {h?.phase === 'switch' && (
                <button className="btn btn-primary ho-confirm" onClick={() => onConfirm(h.id)}>
                  ✓ 立即确认
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="trace-box">
        <h3>交接事件轨迹</h3>
        {trace.length === 0 ? (
          <p className="trace-empty">尚无交接事件。注入故障或选择脚本开始演练。</p>
        ) : (
          <ul className="trace-list">
            {trace.slice(0, 30).map((e) => (
              <li key={e.id} className={`trace-item trace-${e.kind}`}>
                <span className="trace-seg">#{e.segment}</span>
                <span>{traceText(ctx, e)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

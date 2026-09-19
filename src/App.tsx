import { useEffect, useMemo, useRef, useState } from 'react';
import ChannelBoard from './components/ChannelBoard';
import EventLog, { type LogEntry } from './components/EventLog';
import GraphView from './components/GraphView';
import HandoverPanel from './components/HandoverPanel';
import InterpreterPanel from './components/InterpreterPanel';
import { initialScenario } from './data/scenario';
import { DRILL_SCRIPTS, applyDrillStep, setOnline } from './engine/drills';
import {
  confirmHandover,
  initSession,
  reconcile,
  tick,
  type Session,
  type TraceEvent,
} from './engine/handover';
import { allocateRoutes, type ChannelOutcome } from './engine/routing';
import type { Scenario } from './types';
import { langName, traceText, traceTone, transitionText, type Ctx, type Tone } from './ui/describe';

const STORAGE_KEY = 'relaymap-handover-v1';
const HISTORY_CAP = 100;
const TICK_MS = 1200;

interface DrillState {
  scriptId: string | null;
  stepIndex: number;
  autoConfirm: boolean;
}

/** 可撤销的工作状态：场景 + 交接会话 + 演练进度（日志是审计叙述，不参与撤销） */
interface WorkState {
  scenario: Scenario;
  session: Session;
  drill: DrillState;
}

let logSeq = 0;

function now(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function freshWork(): WorkState {
  const scenario = initialScenario();
  const allocation = allocateRoutes(scenario.floor, scenario.channels, scenario.interpreters);
  return {
    scenario,
    session: initSession(scenario, allocation),
    drill: { scriptId: null, stepIndex: 0, autoConfirm: true },
  };
}

function loadStored(): { work: WorkState; log: LogEntry[] } | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.v !== 1 || !data.work?.scenario || !data.work?.session || !data.work?.drill) return null;
    return { work: data.work as WorkState, log: Array.isArray(data.log) ? data.log : [] };
  } catch {
    return null;
  }
}

export default function App() {
  // 启动时尝试恢复上次会话（刷新恢复）
  const [boot] = useState(() => {
    const stored = loadStored();
    if (stored) logSeq = Math.max(logSeq, ...stored.log.map((l) => l.id), 0);
    return stored;
  });

  const [work, setWork] = useState<WorkState>(() => boot?.work ?? freshWork());
  const [log, setLog] = useState<LogEntry[]>(() => {
    if (boot) {
      const restored: LogEntry = {
        id: ++logSeq,
        time: now(),
        tone: 'info',
        text: '已恢复上次会话（刷新恢复）：场景、交接会话与日志完整还原',
      };
      return [restored, ...boot.log].slice(0, 50);
    }
    return [
      {
        id: ++logSeq,
        time: now(),
        tone: 'info',
        text: '调度台就绪：中文主讲，英语 / 法语 / 日语三频道（法语、日语经英语中继）',
      },
    ];
  });
  const [past, setPast] = useState<WorkState[]>([]);
  const [future, setFuture] = useState<WorkState[]>([]);
  const [running, setRunning] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const customId = useRef(1);

  const { scenario, session, drill } = work;
  const allocation = useMemo(
    () => allocateRoutes(scenario.floor, scenario.channels, scenario.interpreters),
    [scenario],
  );
  const ctx: Ctx = { scenario, allocation };

  // ---- 日志 ----

  const pushLog = (text: string, tone: Tone = 'info') =>
    setLog((prev) => [{ id: ++logSeq, time: now(), tone, text }, ...prev].slice(0, 50));

  /** 交接轨迹事件镜像到调度日志（带片段号） */
  const pushTrace = (sc: Scenario, events: TraceEvent[]) => {
    const c: Ctx = { scenario: sc, allocation };
    events.forEach((e) => pushLog(`#${e.segment} ${traceText(c, e)}`, traceTone(e.kind)));
  };

  // ---- 命令管线：所有状态变更经 commit 进入历史 ----

  const commit = (next: WorkState) => {
    setPast((p) => [...p.slice(-(HISTORY_CAP - 1)), work]);
    setFuture([]);
    setWork(next);
  };

  /** 场景变更后对齐目标分配与实际在播（幂等） */
  const withReconcile = (w: WorkState, nextScenario: Scenario): { w: WorkState; events: TraceEvent[] } => {
    const alloc = allocateRoutes(nextScenario.floor, nextScenario.channels, nextScenario.interpreters);
    const r = reconcile(w.session, alloc);
    return { w: { ...w, scenario: nextScenario, session: r.session }, events: r.events };
  };

  // ---- 持久化（刷新恢复） ----

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, work, log }));
    } catch {
      /* 存储不可用（隐私模式等）时忽略 */
    }
  }, [work, log]);

  // ---- 频道目标状态切换时自动写日志（中断 / 恢复 / 席位不足） ----

  const prevStatus = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const next = new Map<string, string>();
    const fresh: LogEntry[] = [];
    for (const ch of scenario.channels) {
      const o = allocation.byChannel.get(ch.id);
      if (!o) continue;
      next.set(ch.id, o.status);
      const before = prevStatus.current?.get(ch.id);
      if (before && before !== o.status) {
        const tone: Tone = o.status === 'ok' ? 'ok' : o.status === 'blocked' ? 'warn' : 'bad';
        fresh.push({ id: ++logSeq, time: now(), tone, text: transitionText(ctx, ch.name, o) });
      }
    }
    prevStatus.current = next;
    if (fresh.length > 0) setLog((prev) => [...fresh, ...prev].slice(0, 50));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allocation]);

  // ---- 演练推进（单步 / 自动） ----

  const doStep = () => {
    const script = DRILL_SCRIPTS.find((s) => s.id === drill.scriptId) ?? null;
    if (script) {
      const step = script.steps[drill.stepIndex];
      if (!step) {
        setRunning(false);
        pushLog(`演练脚本「${script.name}」已执行完毕`, 'ok');
        return;
      }
      const r = applyDrillStep(
        { scenario, session, autoConfirm: drill.autoConfirm },
        step,
      );
      const nextDrill: DrillState = {
        ...drill,
        autoConfirm: r.work.autoConfirm,
        stepIndex: drill.stepIndex + 1,
      };
      commit({ scenario: r.work.scenario, session: r.work.session, drill: nextDrill });
      pushLog(`演练 ${drill.stepIndex + 1}/${script.steps.length}：${step.note}`, 'info');
      r.notes.forEach((n) => pushLog(n, n.startsWith('重复注入') ? 'info' : 'warn'));
      pushTrace(r.work.scenario, r.events);
      if (drill.stepIndex + 1 >= script.steps.length) {
        setRunning(false);
        pushLog(`演练脚本「${script.name}」已执行完毕`, 'ok');
      }
    } else {
      const r = tick(session, scenario, { autoConfirm: drill.autoConfirm });
      commit({ ...work, session: r.session });
      pushTrace(scenario, r.events);
    }
  };

  // 自动演练计时器（经 ref 始终调用最新的 doStep）
  const stepRef = useRef(doStep);
  stepRef.current = doStep;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => stepRef.current(), TICK_MS);
    return () => clearInterval(t);
  }, [running]);

  // ---- 撤销 / 重做 ----

  const handleUndo = () => {
    const prev = past[past.length - 1];
    if (!prev) return;
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [work, ...f].slice(0, HISTORY_CAP));
    setWork(prev);
    pushLog(`↩ 撤销一步（回到片段 #${prev.session.segment}）`, 'info');
  };

  const handleRedo = () => {
    const next = future[0];
    if (!next) return;
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, work]);
    setWork(next);
    pushLog(`↪ 重做一步（前进到片段 #${next.session.segment}）`, 'info');
  };

  // ---- 故障注入与确认 ----

  const handleInject = (id: string, online: boolean) => {
    const r = setOnline(scenario, id, online);
    if (!r.changed) {
      pushLog(`重复注入：${r.name} 已${online ? '在线' : '离线'}，事件忽略`, 'info');
      return;
    }
    const { w, events } = withReconcile(work, r.scenario);
    commit(w);
    pushLog(`故障注入：${r.name} ${online ? '恢复上线' : '断线离席'}`, online ? 'ok' : 'bad');
    pushTrace(r.scenario, events);
  };

  const handleConfirm = (handoverId: string) => {
    const r = confirmHandover(session, handoverId);
    if (r.events.length === 0) return;
    commit({ ...work, session: r.session });
    pushTrace(scenario, r.events);
  };

  const handleToggleAutoConfirm = () => {
    const nextDrill = { ...drill, autoConfirm: !drill.autoConfirm };
    // 确认策略变化后重新对齐（可能唤醒等待中的交接）
    const alloc = allocateRoutes(scenario.floor, scenario.channels, scenario.interpreters);
    const r = reconcile(session, alloc);
    commit({ ...work, session: r.session, drill: nextDrill });
    pushLog(
      nextDrill.autoConfirm ? '自动确认已开启' : '自动确认已关闭：新路由需手动确认，超时将回退',
      'info',
    );
    pushTrace(scenario, r.events);
  };

  const handleSelectScript = (scriptId: string | null) => {
    const s = DRILL_SCRIPTS.find((x) => x.id === scriptId);
    commit({ ...work, drill: { ...drill, scriptId, stepIndex: 0 } });
    pushLog(s ? `已选择演练脚本「${s.name}」：${s.summary}` : '已切换为自由演练（手动注入故障）', 'info');
  };

  const handleResetDrill = () => {
    const alloc = allocateRoutes(scenario.floor, scenario.channels, scenario.interpreters);
    setPast([]);
    setFuture([]);
    setWork({
      scenario,
      session: initSession(scenario, alloc),
      drill: { scriptId: null, stepIndex: 0, autoConfirm: true },
    });
    setRunning(false);
    pushLog('演练状态已归零：片段时钟回到 #1，各频道按当前场景重新开播', 'info');
  };

  // ---- 译员席位表操作（同样走命令管线，可撤销） ----

  const patchScenario = (next: Scenario, logs: Array<{ text: string; tone: Tone }>) => {
    const { w, events } = withReconcile(work, next);
    commit(w);
    logs.forEach((l) => pushLog(l.text, l.tone));
    pushTrace(next, events);
  };

  const handleToggle = (id: string) => {
    const it = scenario.interpreters.find((i) => i.id === id);
    if (!it) return;
    const dir = `${langName(ctx, it.source)}→${langName(ctx, it.target)}`;
    patchScenario(
      { ...scenario, interpreters: scenario.interpreters.map((i) => (i.id === id ? { ...i, online: !i.online } : i)) },
      [
        {
          text: `${it.name}（${dir}）${it.online ? '离席，已置为离线' : '返岗，已上线'}`,
          tone: it.online ? 'bad' : 'ok',
        },
      ],
    );
  };

  const handleRemove = (id: string) => {
    const it = scenario.interpreters.find((i) => i.id === id);
    if (!it) return;
    patchScenario(
      { ...scenario, interpreters: scenario.interpreters.filter((i) => i.id !== id) },
      [{ text: `译员 ${it.name} 已移除`, tone: 'warn' }],
    );
  };

  const handleCapacity = (id: string, capacity: number) => {
    patchScenario(
      { ...scenario, interpreters: scenario.interpreters.map((i) => (i.id === id ? { ...i, capacity } : i)) },
      [],
    );
  };

  const handleAdd = (draft: { name: string; source: string; target: string; capacity: number }) => {
    const id = `int-custom-${customId.current++}`;
    const dir = `${langName(ctx, draft.source)}→${langName(ctx, draft.target)}`;
    patchScenario(
      { ...scenario, interpreters: [...scenario.interpreters, { id, online: true, ...draft }] },
      [{ text: `译员 ${draft.name}（${dir}，${draft.capacity} 席）已加入`, tone: 'ok' }],
    );
  };

  const handlePriority = (channelId: string, priority: number) => {
    patchScenario(
      { ...scenario, channels: scenario.channels.map((c) => (c.id === channelId ? { ...c, priority } : c)) },
      [],
    );
  };

  const handleReset = () => {
    if (!window.confirm('重置为初始演示场景？当前的译员、优先级与演练状态将丢失。')) return;
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
    setPast([]);
    setFuture([]);
    setWork(freshWork());
    setSelectedChannelId(null);
    setRunning(false);
    pushLog('场景已重置为初始演示场景', 'info');
  };

  // ---- 顶部统计 ----

  const outcomes: ChannelOutcome[] = scenario.channels
    .map((ch) => allocation.byChannel.get(ch.id))
    .filter((o): o is ChannelOutcome => o !== undefined);
  const covered = outcomes.filter((o) => o.status === 'ok').length;
  const total = scenario.channels.length;
  const onlineCount = scenario.interpreters.filter((i) => i.online).length;
  const usedSeats = [...allocation.loads.values()].reduce((a, b) => a + b, 0);
  const totalSeats = scenario.interpreters.filter((i) => i.online).reduce((a, i) => a + i.capacity, 0);
  const coverTone: Tone = covered === total ? 'ok' : covered === 0 ? 'bad' : 'warn';
  const coverIcon = covered === total ? '✓' : covered === 0 ? '✕' : '⚠';
  const activeHandovers = session.active.length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" aria-hidden="true" />
          <h1>同传语言路由台</h1>
          <span className="hall">A 厅 · 中文主讲</span>
        </div>
        <div className="stats">
          <span className={`stat tone-${coverTone}`}>
            {coverIcon} 频道覆盖 {covered}/{total}
          </span>
          <span className="stat tone-info">◉ 译员在线 {onlineCount}/{scenario.interpreters.length}</span>
          <span className="stat tone-info">▦ 席位占用 {usedSeats}/{totalSeats}</span>
          <span className="stat tone-info">▸ 片段 #{session.segment}</span>
          {activeHandovers > 0 && <span className="stat tone-warn">⇄ 交接中 {activeHandovers}</span>}
          <button className="btn" onClick={handleReset}>
            重置场景
          </button>
        </div>
      </header>

      <main className="layout">
        <div className="left">
          <section className="panel graph-panel">
            <h2>语种 · 译员连接图</h2>
            <GraphView
              scenario={scenario}
              allocation={allocation}
              selectedChannelId={selectedChannelId}
              onSelectChannel={setSelectedChannelId}
            />
            <div className="legend" aria-label="图例">
              <span><i className="sw line-live" />在役</span>
              <span><i className="sw line-idle" />空闲</span>
              <span><i className="sw line-full" />⚠ 满员</span>
              <span><i className="sw line-off" />✕ 离线</span>
              <span className="legend-note">状态以图标＋文字＋线型共同标示，不只依赖颜色；点击频道可高亮其路由</span>
            </div>
          </section>
          <HandoverPanel
            scenario={scenario}
            allocation={allocation}
            session={session}
            drill={{ ...drill, running }}
            canUndo={past.length > 0}
            canRedo={future.length > 0}
            onTick={doStep}
            onToggleRun={() => setRunning((r) => !r)}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onResetDrill={handleResetDrill}
            onSelectScript={handleSelectScript}
            onToggleAutoConfirm={handleToggleAutoConfirm}
            onInject={handleInject}
            onConfirm={handleConfirm}
          />
        </div>

        <div className="right">
          <ChannelBoard
            scenario={scenario}
            allocation={allocation}
            session={session}
            selectedChannelId={selectedChannelId}
            onSelect={setSelectedChannelId}
            onPriorityChange={handlePriority}
          />
          <InterpreterPanel
            scenario={scenario}
            allocation={allocation}
            onToggle={handleToggle}
            onRemove={handleRemove}
            onCapacity={handleCapacity}
            onAdd={handleAdd}
          />
          <EventLog entries={log} />
        </div>
      </main>
    </div>
  );
}

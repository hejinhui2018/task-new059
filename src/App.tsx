import { useEffect, useMemo, useRef, useState } from 'react';
import ChannelBoard from './components/ChannelBoard';
import EventLog, { type LogEntry } from './components/EventLog';
import GraphView from './components/GraphView';
import InterpreterPanel from './components/InterpreterPanel';
import { initialScenario } from './data/scenario';
import { allocateRoutes, type ChannelOutcome } from './engine/routing';
import type { Interpreter, Scenario } from './types';
import { langName, transitionText, type Ctx, type Tone } from './ui/describe';

let logSeq = 0;

function now(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

export default function App() {
  const [scenario, setScenario] = useState<Scenario>(initialScenario);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>(() => [
    {
      id: ++logSeq,
      time: now(),
      tone: 'info',
      text: '调度台就绪：中文主讲，英语 / 法语 / 日语三频道（法语、日语经英语中继）',
    },
  ]);
  const customId = useRef(1);

  const allocation = useMemo(
    () => allocateRoutes(scenario.floor, scenario.channels, scenario.interpreters),
    [scenario],
  );
  const ctx: Ctx = { scenario, allocation };

  const pushLog = (text: string, tone: Tone = 'info') =>
    setLog((prev) => [{ id: ++logSeq, time: now(), tone, text }, ...prev].slice(0, 50));

  // 频道状态切换时自动写日志（中断 / 恢复 / 席位不足）
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

  // ---- 操作 ----

  const patchInterpreters = (fn: (list: Interpreter[]) => Interpreter[]) =>
    setScenario((s) => ({ ...s, interpreters: fn(s.interpreters) }));

  const handleToggle = (id: string) => {
    const it = scenario.interpreters.find((i) => i.id === id);
    if (!it) return;
    const dir = `${langName(ctx, it.source)}→${langName(ctx, it.target)}`;
    pushLog(`${it.name}（${dir}）${it.online ? '离席，已置为离线' : '返岗，已上线'}`, it.online ? 'bad' : 'ok');
    patchInterpreters((list) => list.map((i) => (i.id === id ? { ...i, online: !i.online } : i)));
  };

  const handleRemove = (id: string) => {
    const it = scenario.interpreters.find((i) => i.id === id);
    if (!it) return;
    pushLog(`译员 ${it.name} 已移除`, 'warn');
    patchInterpreters((list) => list.filter((i) => i.id !== id));
  };

  const handleCapacity = (id: string, capacity: number) => {
    patchInterpreters((list) => list.map((i) => (i.id === id ? { ...i, capacity } : i)));
  };

  const handleAdd = (draft: { name: string; source: string; target: string; capacity: number }) => {
    const id = `int-custom-${customId.current++}`;
    const dir = `${langName(ctx, draft.source)}→${langName(ctx, draft.target)}`;
    pushLog(`译员 ${draft.name}（${dir}，${draft.capacity} 席）已加入`, 'ok');
    patchInterpreters((list) => [...list, { id, online: true, ...draft }]);
  };

  const handlePriority = (channelId: string, priority: number) => {
    setScenario((s) => ({
      ...s,
      channels: s.channels.map((c) => (c.id === channelId ? { ...c, priority } : c)),
    }));
  };

  const handleReset = () => {
    if (!window.confirm('重置为初始演示场景？当前的译员与优先级修改将丢失。')) return;
    setScenario(initialScenario());
    setSelectedChannelId(null);
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
        </div>

        <div className="right">
          <ChannelBoard
            scenario={scenario}
            allocation={allocation}
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

import { useEffect, useReducer, useState } from 'react';
import ChannelBoard from './components/ChannelBoard';
import GraphView from './components/GraphView';
import HandoverConsole, { AUTO_INTERVAL_MS } from './components/HandoverConsole';
import HandoverTimeline from './components/HandoverTimeline';
import InterpreterPanel from './components/InterpreterPanel';
import { initialScenario } from './data/scenario';
import {
  createHandoverInitialState,
  currentAllocation,
  handoverReducer,
  loadHandover,
  openSession,
  persistHandover,
  clearPersistedHandover,
} from './engine/handover';
import type { Scenario } from './types';

function initState() {
  return loadHandover() ?? createHandoverInitialState(initialScenario());
}

export default function App() {
  const [state, dispatch] = useReducer(handoverReducer, undefined, initState);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  const scenario: Scenario = state.scenario;
  const allocation = currentAllocation(state);

  // 自动演练：按所选速度在片段边界推进；撤销/重做会强制暂停（见 reducer）
  useEffect(() => {
    if (!state.running) return;
    const ms = AUTO_INTERVAL_MS[state.speed];
    const id = window.setInterval(() => dispatch({ type: 'advance' }), ms);
    return () => window.clearInterval(id);
  }, [state.running, state.speed]);

  // 刷新恢复：每个状态变化都落盘（撤销栈不入库，恢复后强制暂停）
  useEffect(() => {
    persistHandover(state);
  }, [state]);

  // ---- 译员 / 频道操作（配置变更只挂“准备”，边界才改派） ----

  const handleToggle = (id: string) => dispatch({ type: 'toggleInterpreter', id });
  const handleRemove = (id: string) => dispatch({ type: 'removeInterpreter', id });
  const handleCapacity = (id: string, capacity: number) =>
    dispatch({ type: 'setCapacity', id, capacity });
  const handleAdd = (draft: { name: string; source: string; target: string; capacity: number }) =>
    dispatch({ type: 'addInterpreter', draft });
  const handlePriority = (channelId: string, priority: number) =>
    dispatch({ type: 'setPriority', channelId, priority });

  const handleResetAll = () => {
    if (!window.confirm('重置为初始演示场景？当前演练进度、译员与优先级修改将丢失。')) return;
    clearPersistedHandover();
    dispatch({ type: 'hydrate', state: createHandoverInitialState(initialScenario()) });
  };

  // ---- 顶部统计 ----

  const outcomes = [...allocation.byChannel.values()];
  const covered = outcomes.filter((o) => o.status === 'ok').length;
  const total = scenario.channels.length;
  const playing = scenario.channels.filter((c) => openSession(state, c.id)).length;
  const onlineCount = scenario.interpreters.filter((i) => i.online).length;
  const usedSeats = [...allocation.loads.values()].reduce((a, b) => a + b, 0);
  const totalSeats = scenario.interpreters.filter((i) => i.online).reduce((a, i) => a + i.capacity, 0);
  const coverTone = covered === total ? 'ok' : covered === 0 ? 'bad' : 'warn';
  const coverIcon = covered === total ? '✓' : covered === 0 ? '✕' : '⚠';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className={`brand-dot ${state.running ? 'dot-run' : ''}`} aria-hidden="true" />
          <h1>同传语言路由台 · 译员交接版</h1>
          <span className="hall">A 厅 · 中文主讲 · 按片段边界交接</span>
        </div>
        <div className="stats">
          <span className={`stat tone-${coverTone}`}>
            {coverIcon} 路由覆盖 {covered}/{total}
          </span>
          <span className={`stat tone-${playing === total ? 'ok' : playing === 0 ? 'bad' : 'warn'}`}>
            🔊 在播频道 {playing}/{total}
          </span>
          <span className="stat tone-info">◉ 译员在线 {onlineCount}/{scenario.interpreters.length}</span>
          <span className="stat tone-info">▦ 席位占用 {usedSeats}/{totalSeats}</span>
          <button className="btn" onClick={handleResetAll}>
            重置场景
          </button>
        </div>
      </header>

      <HandoverConsole
        state={state}
        selectedChannelId={selectedChannelId}
        onSelectChannel={setSelectedChannelId}
        dispatch={dispatch}
      />

      <main className="layout">
        <div className="left">
          <section className="panel graph-panel">
            <h2>语种 · 译员连接图</h2>
            <GraphView
              scenario={scenario}
              allocation={allocation}
              selectedChannelId={selectedChannelId}
              onSelectChannel={setSelectedChannelId}
              handover={state}
            />
            <div className="legend" aria-label="图例">
              <span><i className="sw line-live" />出声中</span>
              <span><i className="sw line-standby" />◔ 热备待接</span>
              <span><i className="sw line-idle" />空闲</span>
              <span><i className="sw line-full" />⚠ 满员</span>
              <span><i className="sw line-off" />✕ 离线</span>
              <span className="legend-note">交接按语言通道 × 音频片段边界生效；点击频道可高亮</span>
            </div>
          </section>
          <InterpreterPanel
            scenario={scenario}
            allocation={allocation}
            onToggle={handleToggle}
            onRemove={handleRemove}
            onCapacity={handleCapacity}
            onAdd={handleAdd}
          />
        </div>

        <div className="right">
          <ChannelBoard
            scenario={scenario}
            allocation={allocation}
            selectedChannelId={selectedChannelId}
            onSelect={setSelectedChannelId}
            onPriorityChange={handlePriority}
            handover={state}
          />
          <HandoverTimeline state={state} />
        </div>
      </main>
    </div>
  );
}

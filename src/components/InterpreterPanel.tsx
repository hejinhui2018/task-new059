import { useState } from 'react';
import type { Allocation } from '../engine/routing';
import type { Scenario } from '../types';
import { langName, type Ctx } from '../ui/describe';

interface Props {
  scenario: Scenario;
  allocation: Allocation;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onCapacity: (id: string, capacity: number) => void;
  onAdd: (draft: { name: string; source: string; target: string; capacity: number }) => void;
}

function clampCapacity(raw: string, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(9, Math.max(1, n));
}

export default function InterpreterPanel({ scenario, allocation, onToggle, onRemove, onCapacity, onAdd }: Props) {
  const ctx: Ctx = { scenario, allocation };
  const [name, setName] = useState('');
  const [source, setSource] = useState('zh');
  const [target, setTarget] = useState('ja');
  const [capacity, setCapacity] = useState(1);
  const [error, setError] = useState('');

  const submit = () => {
    if (source === target) {
      setError('源语种与目标语种不能相同：自环路由不被允许。');
      return;
    }
    onAdd({ name: name.trim() || '新译员', source, target, capacity });
    setName('');
    setError('');
  };

  return (
    <section className="panel" aria-label="译员席位表">
      <h2>译员席位表</h2>
      <table className="roster">
        <thead>
          <tr>
            <th>译员</th>
            <th>方向</th>
            <th>席位占用</th>
            <th>容量</th>
            <th>状态</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {scenario.interpreters.map((it) => {
            const load = allocation.loads.get(it.id) ?? 0;
            const full = it.online && load >= it.capacity;
            const pct = it.capacity > 0 ? Math.min(100, (load / it.capacity) * 100) : 0;
            return (
              <tr key={it.id} className={it.online ? '' : 'row-off'}>
                <td className="cell-name">{it.name}</td>
                <td className="cell-dir">
                  {langName(ctx, it.source)} → {langName(ctx, it.target)}
                </td>
                <td className="cell-seats">
                  <span className="seatbar" role="img" aria-label={`席位 ${load}/${it.capacity}${it.online ? '' : '，离线'}`}>
                    <span className={`seatbar-fill ${full ? 'full' : ''}`} style={{ width: `${it.online ? pct : 0}%` }} />
                    <span className="seatbar-text">
                      {it.online ? `${load}/${it.capacity}${full ? ' 满' : ''}` : '离线'}
                    </span>
                  </span>
                </td>
                <td className="cell-cap">
                  <input
                    type="number"
                    min={1}
                    max={9}
                    value={it.capacity}
                    aria-label={`${it.name}容量`}
                    onChange={(e) => onCapacity(it.id, clampCapacity(e.target.value, it.capacity))}
                  />
                </td>
                <td className="cell-switch">
                  <button
                    className={`switch ${it.online ? 'on' : 'off'}`}
                    role="switch"
                    aria-checked={it.online}
                    onClick={() => onToggle(it.id)}
                  >
                    <span className="knob" />
                    <span className="switch-label">{it.online ? '在线' : '离线'}</span>
                  </button>
                </td>
                <td className="cell-del">
                  <button className="icon-btn" title={`移除 ${it.name}`} onClick={() => onRemove(it.id)}>
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <form
        className="add-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          type="text"
          placeholder="译员姓名"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="译员姓名"
        />
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="源语种">
          {scenario.languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
        <span className="arrow">→</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="目标语种">
          {scenario.languages.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
        <label className="cap-field">
          容量
          <input
            type="number"
            min={1}
            max={9}
            value={capacity}
            onChange={(e) => setCapacity(clampCapacity(e.target.value, capacity))}
            aria-label="容量"
          />
        </label>
        <button type="submit" className="btn btn-primary">
          ＋ 添加译员
        </button>
      </form>
      {error && <p className="form-error">⚠ {error}</p>}
    </section>
  );
}

import { useMemo } from 'react';
import type { Allocation } from '../engine/routing';
import { compareChannels } from '../engine/routing';
import type { Interpreter, Scenario } from '../types';
import { statusLabel, type Ctx } from '../ui/describe';

interface Props {
  scenario: Scenario;
  allocation: Allocation;
  selectedChannelId: string | null;
  onSelectChannel: (id: string | null) => void;
}

const W = 720;
const H = 480;

interface Pt {
  x: number;
  y: number;
}

/** 主讲语言固定在左侧，其余语种沿右侧弧线分布 */
function layoutNodes(scenario: Scenario): Map<string, Pt> {
  const map = new Map<string, Pt>();
  const { languages, floor } = scenario;
  map.set(floor, { x: 92, y: H / 2 });
  const others = languages.filter((l) => l.code !== floor);
  const n = others.length;
  others.forEach((l, i) => {
    const t = n <= 1 ? 0.5 : i / (n - 1);
    const angle = (-66 + 132 * t) * (Math.PI / 180);
    map.set(l.code, { x: 415 + 225 * Math.cos(angle), y: H / 2 + 178 * Math.sin(angle) });
  });
  return map;
}

interface EdgeGeom {
  d: string;
  lx: number;
  ly: number;
}

/** 二次贝塞尔边：端点收缩到节点边缘，offset 控制平行边间距 */
function geom(a: Pt, b: Pt, offset: number): EdgeGeom {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const trim = 54;
  const sx = a.x + ux * trim;
  const sy = a.y + uy * trim;
  const ex = b.x - ux * trim;
  const ey = b.y - uy * trim;
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;
  const cx = mx - uy * offset;
  const cy = my + ux * offset;
  return {
    d: `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`,
    lx: 0.25 * sx + 0.5 * cx + 0.25 * ex,
    ly: 0.25 * sy + 0.5 * cy + 0.25 * ey,
  };
}

/** 估算文本宽度（中文按全宽计），用于芯片底框 */
function estWidth(text: string, fontPx: number): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0xff ? fontPx : fontPx * 0.58;
  return w;
}

interface EdgeItem {
  it: Interpreter;
  d: string;
  lx: number;
  ly: number;
}

export default function GraphView({ scenario, allocation, selectedChannelId, onSelectChannel }: Props) {
  const ctx: Ctx = { scenario, allocation };

  const pos = useMemo(() => layoutNodes(scenario), [scenario]);

  // 同一对语种之间的多名译员画成平行曲线
  const edges = useMemo<EdgeItem[]>(() => {
    const pairs = new Map<string, Interpreter[]>();
    for (const it of scenario.interpreters) {
      if (it.source === it.target) continue; // 自环不绘制（引擎也不会采用）
      const key = [it.source, it.target].sort().join('|');
      const arr = pairs.get(key) ?? [];
      arr.push(it);
      pairs.set(key, arr);
    }
    const items: EdgeItem[] = [];
    for (const group of pairs.values()) {
      const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : 1));
      sorted.forEach((it, k) => {
        const offset = (k - (sorted.length - 1) / 2) * 36;
        const a = pos.get(it.source);
        const b = pos.get(it.target);
        if (!a || !b) return;
        const g = geom(a, b, offset);
        items.push({ it, d: g.d, lx: g.lx, ly: g.ly });
      });
    }
    return items;
  }, [scenario.interpreters, pos]);

  // 选中频道的路由（含 blocked 时的可用路径）用于高亮
  const routeIds = useMemo(() => {
    const set = new Set<string>();
    if (selectedChannelId) {
      const o = allocation.byChannel.get(selectedChannelId);
      if (o && o.status !== 'broken') {
        for (const l of o.route.legs) set.add(l.interpreterId);
      }
    }
    return set;
  }, [allocation, selectedChannelId]);

  const hasSelection = selectedChannelId !== null;
  const sortedChannels = [...scenario.channels].sort(compareChannels);

  return (
    <svg className="graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="语种与译员连接图">
      <defs>
        <pattern id="grid" width="26" height="26" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="#232d3a" />
        </pattern>
        {(['idle', 'live', 'full', 'off', 'active'] as const).map((k) => (
          <marker
            key={k}
            id={`arr-${k}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className={`arr arr-${k}`} />
          </marker>
        ))}
      </defs>
      <rect x="0" y="0" width={W} height={H} fill="url(#grid)" rx="8" />

      {/* 译员边 */}
      {edges.map(({ it, d, lx, ly }) => {
        const load = allocation.loads.get(it.id) ?? 0;
        const full = it.online && load >= it.capacity;
        const inRoute = routeIds.has(it.id);
        const state = !it.online ? 'off' : inRoute ? 'active' : full ? 'full' : load > 0 ? 'live' : 'idle';
        const dim = hasSelection && !inRoute;
        const line1 = it.name;
        const line2 = !it.online
          ? `✕ 离线 · 容量 ${it.capacity}`
          : `${load}/${it.capacity} 席${full ? ' · ⚠ 满' : ''}`;
        const chipW = Math.max(estWidth(line1, 11), estWidth(line2, 11)) + 18;
        return (
          <g key={it.id} className={`edge edge-${state} ${dim ? 'edge-dim' : ''}`}>
            <path d={d} className="edge-line" markerEnd={`url(#arr-${state})`} />
            <g transform={`translate(${lx}, ${ly})`}>
              <rect x={-chipW / 2} y={-16} width={chipW} height={32} rx={7} className="edge-chip" />
              <text y={-4} textAnchor="middle" className="edge-chip-name">
                {line1}
              </text>
              <text y={9} textAnchor="middle" className="edge-chip-seats">
                {line2}
              </text>
            </g>
          </g>
        );
      })}

      {/* 语种节点 */}
      {scenario.languages.map((l) => {
        const p = pos.get(l.code);
        if (!p) return null;
        const isFloor = l.code === scenario.floor;
        const chans = sortedChannels.filter((c) => c.target === l.code);
        return (
          <g key={l.code}>
            {isFloor && (
              <g className="floor-tag">
                <rect x={p.x - 26} y={p.y - 46} width={52} height={18} rx={9} />
                <text x={p.x} y={p.y - 33} textAnchor="middle">
                  主讲
                </text>
              </g>
            )}
            <rect x={p.x - 46} y={p.y - 22} width={92} height={44} rx={10} className={`node ${isFloor ? 'node-floor' : ''}`} />
            <text x={p.x} y={p.y - 2} textAnchor="middle" className="node-name">
              {l.name}
            </text>
            <text x={p.x} y={p.y + 13} textAnchor="middle" className="node-code">
              {l.code.toUpperCase()}
            </text>
            {/* 该语种对应的频道状态芯片 */}
            {chans.map((ch, idx) => {
              const o = allocation.byChannel.get(ch.id);
              if (!o) return null;
              const s = statusLabel(ctx, o);
              const label = `${s.icon} ${ch.name}`;
              const w = estWidth(label, 11) + 18;
              const y = p.y + 34 + idx * 26;
              const selected = selectedChannelId === ch.id;
              return (
                <g
                  key={ch.id}
                  className={`chan-chip tone-${s.tone} ${selected ? 'selected' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectChannel(selected ? null : ch.id);
                  }}
                >
                  <rect x={p.x - w / 2} y={y - 10} width={w} height={20} rx={10} />
                  <text x={p.x} y={y + 4} textAnchor="middle">
                    {label}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

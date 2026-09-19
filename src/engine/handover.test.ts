import { describe, expect, it, beforeEach } from 'vitest';
import { initialScenario } from '../data/scenario';
import {
  assertNoOverlap,
  CONFIRM_TICKS,
  createHandoverInitialState,
  handoverReducer,
  loadHandover,
  openSession,
  openTicket,
  persistHandover,
  type HandoverState,
} from './handover';

/** 测试辅助：连续派发动作并在每步后校验互斥不变量 */
function run(initial: HandoverState, script: Array<Record<string, unknown> | [string, ...unknown[]]>): HandoverState {
  let s = initial;
  for (const step of script) {
    const action = normalize(step);
    s = handoverReducer(s, action as never);
    assertNoOverlap(s.sessions);
  }
  return s;
}

function normalize(step: Record<string, unknown> | [string, ...unknown[]]) {
  if (Array.isArray(step)) {
    const [type, ...rest] = step;
    if (type === 'injectDisconnect') return { type, channelId: rest[0], durationTicks: rest[1] as number };
    if (type === 'reconnect' || type === 'injectFail') return { type, channelId: rest[0], fail: rest[1] };
    return { type, ...(rest[0] as Record<string, unknown>) };
  }
  return step;
}

const advance = { type: 'advance' } as const;
const EN = 'ch-en';
const FR = 'ch-fr';
const JA = 'ch-ja';

function fresh(): HandoverState {
  return createHandoverInitialState(initialScenario());
}

/** 让备援陈上线（主译员王仍在岗，在役粘滞：不应引发交接） */
function backupOnline(s: HandoverState): HandoverState {
  return handoverReducer(s, { type: 'toggleInterpreter', id: 'int-chen' });
}
/** 主译员王离线 */
function primaryOffline(s: HandoverState): HandoverState {
  return handoverReducer(s, { type: 'toggleInterpreter', id: 'int-wang' });
}

function activeId(s: HandoverState, ch: string): string | undefined {
  return openSession(s, ch)?.route.legs[0].interpreterId;
}

describe('初始化与在役粘滞', () => {
  it('初始：三频道开声，英语直译王，法/月经王中继，互斥成立', () => {
    const s = fresh();
    assertNoOverlap(s.sessions);
    expect(activeId(s, EN)).toBe('int-wang');
    expect(openSession(s, FR)?.route.legs.map((l) => l.interpreterId)).toEqual(['int-wang', 'int-li']);
    expect(openSession(s, JA)?.route.legs.map((l) => l.interpreterId)).toEqual(['int-wang', 'int-sato']);
    expect(s.sessions.filter((x) => x.endTick === null)).toHaveLength(3);
  });

  it('备援上线本身不触发交接（在役路由粘滞，不抖动）', () => {
    const s = run(fresh(), [{ type: 'toggleInterpreter', id: 'int-chen' }, advance, advance]);
    expect(activeId(s, EN)).toBe('int-wang');
    expect(Object.values(s.tickets).filter((t) => !t.finished)).toHaveLength(0);
  });

  it('纯推进不产生交接：会话从片段 0 连续在播', () => {
    const s = run(fresh(), [advance, advance, advance]);
    const sess = openSession(s, EN);
    expect(sess?.startTick).toBe(0);
    expect(sess?.endTick === null).toBe(true);
    expect(s.tick).toBe(3);
  });
});

describe('边界生效：准备 → 切换 → 确认', () => {
  it('主译员离线后不在段中改派：当前片段播完，宽限一次，第二边界原子切到备援', () => {
    let s = backupOnline(fresh());
    s = primaryOffline(s); // tick0 挂 preparing
    // 断线当段：英语仍由王播
    expect(activeId(s, EN)).toBe('int-wang');
    expect(openTicket(s, EN)?.phase).toBe('preparing');

    s = handoverReducer(s, advance); // 边界 1：宽限顺延
    assertNoOverlap(s.sessions);
    expect(activeId(s, EN)).toBe('int-wang');
    expect(openTicket(s, EN)?.phase).toBe('preparing');

    s = handoverReducer(s, advance); // 边界 2：原子切换
    assertNoOverlap(s.sessions);
    expect(activeId(s, EN)).toBe('int-chen');
    const t = openTicket(s, EN);
    expect(t?.phase).toBe('confirming');
    expect(t?.switchTick).toBe(2);
    // 旧会话恰在边界关闭，新会话自边界开启：不重叠
    const enSessions = s.sessions.filter((x) => x.channelId === EN);
    expect(enSessions[0].endTick).toBe(2);
    expect(enSessions[enSessions.length - 1].startTick).toBe(2);
  });

  it('确认窗口内自动确认闭环，旧通道不再发声', () => {
    let s = backupOnline(fresh());
    s = primaryOffline(s);
    s = run(s, [advance, advance]); // 到 tick2 已切换
    expect(openTicket(s, EN)?.phase).toBe('confirming');
    s = run(s, [advance]); // tick3：确认中第 1 片段
    expect(openTicket(s, EN)?.phase).toBe('confirming');
    s = run(s, [advance]); // tick4：第 2 片段，窗口满
    expect(openTicket(s, EN)?.phase).toBe('confirming');
    s = run(s, [advance]); // 边界结算 elapsed=2 → 自动确认
    const t = Object.values(s.tickets).find((t) => t.channelId === EN && t.finished);
    expect(t?.outcome).toBe('completed');
    expect(activeId(s, EN)).toBe('int-chen');
  });

  it('中继频道随枢纽联动交接：法/日也在边界切到陈（容量内）', () => {
    let s = backupOnline(fresh());
    s = primaryOffline(s);
    s = run(s, [advance, advance]);
    expect(openSession(s, FR)?.route.legs[0].interpreterId).toBe('int-chen');
    expect(openSession(s, FR)?.route.legs[1].interpreterId).toBe('int-li');
    // 陈容量 2：英、法占满，日语边界静音，而非错误地双发
    expect(openSession(s, JA)).toBeUndefined();
    const jaTicket = Object.values(s.tickets).find((t) => t.channelId === JA && t.finished);
    expect(jaTicket?.outcome).toBe('silenced');
  });
});

describe('短暂断线（重连吸收）', () => {
  it('2 片段短断线在边界前恢复：交接被整段吸收，同一会话连续在播，不切走不双播', () => {
    let s = backupOnline(fresh());
    s = handoverReducer(s, { type: 'injectDisconnect', channelId: EN, durationTicks: 2 });
    const beforeId = openSession(s, EN)?.id;
    expect(activeId(s, EN)).toBe('int-wang'); // 段中不改派
    s = run(s, [advance]); // 边界 1：宽限缓冲
    expect(openSession(s, EN)?.id).toBe(beforeId);
    s = run(s, [advance]); // 边界 2：王已恢复，交接取消
    const t = Object.values(s.tickets).find((t) => t.channelId === EN && t.finished);
    expect(t?.outcome).toBe('abandoned');
    expect(activeId(s, EN)).toBe('int-wang');
    expect(openSession(s, EN)?.id).toBe(beforeId); // 会话从未中断
  });

  it('断线期间手动提前重连：下一边界复核取消交接', () => {
    let s = backupOnline(fresh());
    s = handoverReducer(s, { type: 'injectDisconnect', channelId: EN, durationTicks: 5 });
    s = handoverReducer(s, { type: 'reconnect', channelId: EN }); // tick0 立即恢复
    s = run(s, [advance]); // 边界 1：旧路可行 → 吸收
    expect(activeId(s, EN)).toBe('int-wang');
    const t = Object.values(s.tickets).find((t) => t.channelId === EN && t.finished);
    expect(t?.outcome).toBe('abandoned');
  });

  it('长断线真正切换后旧主恢复：不抢英语通道，必须再走一次完整交接才会切回', () => {
    let s = backupOnline(fresh());
    s = handoverReducer(s, { type: 'injectDisconnect', channelId: EN, durationTicks: 5 });
    s = run(s, [advance, advance]); // tick2 切到陈
    expect(activeId(s, EN)).toBe('int-chen');
    s = handoverReducer(s, { type: 'reconnect', channelId: EN }); // 王恢复
    s = run(s, [advance, advance, advance]);
    // 在役粘滞：英语仍由陈在岗，王回来不会把英语切回（日语可另行恢复，与英语互斥无关）
    expect(activeId(s, EN)).toBe('int-chen');
    expect(openTicket(s, EN)).toBeUndefined();
  });

  it('重复恢复信号幂等：音频会话与生效路由都不变', () => {
    let s = backupOnline(fresh());
    s = handoverReducer(s, { type: 'injectDisconnect', channelId: EN, durationTicks: 5 });
    s = run(s, [advance, advance]); // 已切陈
    s = handoverReducer(s, { type: 'reconnect', channelId: EN });
    const snap = JSON.stringify({ eff: s.effective[EN], sess: openSession(s, EN) });
    s = handoverReducer(s, { type: 'reconnect', channelId: EN }); // 重复恢复
    s = handoverReducer(s, { type: 'reconnect', channelId: EN }); // 再来一次
    expect(JSON.stringify({ eff: s.effective[EN], sess: openSession(s, EN) })).toBe(snap);
    expect(activeId(s, EN)).toBe('int-chen');
  });
});

describe('迟到确认与确认丢失（回退）', () => {
  /** 制造“tick2 已切到陈、确认中”的状态，王在 tick4 自动返岗 */
  function switchedLate(durationTicks: number): HandoverState {
    let s = backupOnline(fresh());
    s = handoverReducer(s, { type: 'injectDisconnect', channelId: EN, durationTicks });
    s = run(s, [advance, advance]); // tick2 切换
    return s;
  }

  it('迟到确认先告警（窗口内音频不受影响），超截止且旧路可行 → 边界回退王', () => {
    let s = switchedLate(4);
    expect(openTicket(s, EN)?.switchTick).toBe(2);
    s = handoverReducer(s, { type: 'injectFail', channelId: EN, fail: 'late-ack' });
    s = run(s, [advance]); // tick3：注入事件已在轨迹中
    expect(activeId(s, EN)).toBe('int-chen'); // 仍由陈出声，没有两条通道
    const warnEvents = s.events.filter((e) => e.text.includes('迟到'));
    expect(warnEvents.length).toBeGreaterThan(0);
    // 切换在 tick2：第 5 次推进时（atTick=6，elapsed=4）到截止并回退，王自片段 7 接管
    s = run(s, [advance, advance, advance, advance]);
    const reverted = Object.values(s.tickets).find((t) => t.channelId === EN && t.outcome === 'reverted');
    expect(reverted).toBeDefined();
    expect(activeId(s, EN)).toBe('int-wang');
    const enTimeline = s.sessions.filter((x) => x.channelId === EN);
    const prev = enTimeline[enTimeline.length - 2];
    const last = enTimeline[enTimeline.length - 1];
    expect(prev.close).toBe('revert');
    // 回退新会话恰在回退边界开启，与陈的会话边界相接
    expect(last.startTick).toBe(prev.endTick);
  });

  it('确认丢失但旧主仍离线：到截止不盲目回退，维持备援出声', () => {
    let s = switchedLate(9); // 王长期离线
    s = handoverReducer(s, { type: 'injectFail', channelId: EN, fail: 'drop-ack' });
    // 越过截止
    s = run(s, Array.from({ length: CONFIRM_TICKS + 4 }, () => advance));
    expect(activeId(s, EN)).toBe('int-chen'); // 没有切回离线的王
    const t = Object.values(s.tickets).find((t) => t.channelId === EN && t.finished);
    expect(t?.outcome).toBe('completed'); // 带告警闭环
  });

  it('手动确认：窗口内闭环；窗口外只登记迟到，不动音频', () => {
    let s = switchedLate(9);
    const confirmingId = Object.values(s.tickets).find((t) => t.channelId === EN && !t.finished)!.id;
    s = handoverReducer(s, { type: 'injectFail', channelId: EN, fail: 'late-ack' });
    s = run(s, [advance, advance, advance]); // 已过 2 片段窗口但未到回退截止
    const before = activeId(s, EN);
    s = handoverReducer(s, { type: 'resolveTicket', ticketId: confirmingId });
    expect(activeId(s, EN)).toBe(before);
    const t = s.tickets[confirmingId];
    expect(t.finished).toBe(false);
    expect(t.fail).toBe('late-ack');
  });
});

describe('备援不可达与静音恢复', () => {
  it('主译员离线且备援也离线：宽限后边界静音，不虚构路由、不双发', () => {
    let s = primaryOffline(fresh()); // 陈初始离线
    s = run(s, [advance, advance]);
    expect(openSession(s, EN)).toBeUndefined();
    expect(openSession(s, FR)).toBeUndefined();
    const t = Object.values(s.tickets).find((t) => t.channelId === EN && t.finished);
    expect(t?.outcome).toBe('silenced');
  });

  it('准备阶段备援被注入离线：边界静音；备援恢复后下一边界重新开声', () => {
    let s = backupOnline(fresh());
    s = primaryOffline(s);
    s = handoverReducer(s, { type: 'injectFail', channelId: EN, fail: 'backup-offline' });
    s = run(s, [advance, advance]); // 静音
    expect(openSession(s, EN)).toBeUndefined();
    s = backupOnline(s); // 陈恢复
    expect(openSession(s, EN)).toBeUndefined(); // 段中不开声
    s = run(s, [advance]); // 边界恢复
    expect(activeId(s, EN)).toBe('int-chen');
  });
});

describe('撤销 / 重做', () => {
  it('撤销逐步回到切换前：王重新在播、票据回到准备态；重做可重现切换', () => {
    let s = backupOnline(fresh());
    s = primaryOffline(s);
    s = run(s, [advance, advance]); // 已切陈（历史含：备援上线、主译离线、两次推进）
    expect(activeId(s, EN)).toBe('int-chen');
    s = handoverReducer(s, { type: 'undo' }); // 撤销第二次推进
    s = handoverReducer(s, { type: 'undo' }); // 撤销第一次推进
    expect(s.tick).toBe(0);
    expect(activeId(s, EN)).toBe('int-wang');
    s = handoverReducer(s, { type: 'redo' });
    s = handoverReducer(s, { type: 'redo' });
    expect(activeId(s, EN)).toBe('int-chen');
  });

  it('撤销后自动演练停止（暂停态）', () => {
    let s = backupOnline(fresh());
    s = primaryOffline(s);
    s = run(s, [advance]);
    s = handoverReducer(s, { type: 'toggleRun' });
    expect(s.running).toBe(true);
    s = handoverReducer(s, { type: 'undo' });
    expect(s.running).toBe(false);
  });
});

describe('重复演练确定性', () => {
  it('同一脚本演练两遍：会话台账与事件轨迹（片段号+文案）完全一致', () => {
    const script = [
      { type: 'toggleInterpreter', id: 'int-chen' },
      { type: 'injectDisconnect', channelId: EN, durationTicks: 4 },
      advance,
      advance,
      { type: 'reconnect', channelId: EN },
      advance,
      { type: 'injectFail', channelId: FR, fail: 'late-ack' },
      advance,
      advance,
      advance,
      advance,
    ];
    const a = run(fresh(), script);
    const b = run(fresh(), script);
    const shape = (s: HandoverState) => ({
      tick: s.tick,
      sessions: s.sessions.map((x) => ({
        ch: x.channelId,
        route: x.route.legs.map((l) => l.interpreterId).join('>'),
        start: x.startTick,
        end: x.endTick,
        close: x.close ?? null,
      })),
      events: s.events.map((e) => ({ tick: e.tick, ch: e.channelId, text: e.text })),
      tickets: Object.values(s.tickets).map((t) => ({
        ch: t.channelId,
        phase: t.phase,
        open: t.openTick,
        sw: t.switchTick ?? null,
        out: t.outcome ?? null,
      })),
    });
    expect(shape(b)).toEqual(shape(a));
  });
});

describe('刷新恢复（持久化）', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    } as Storage;
  });

  it('交接中途刷新：片段号、生效路由、会话台账与轨迹恢复，且强制暂停', () => {
    let s = backupOnline(fresh());
    s = primaryOffline(s);
    s = run(s, [advance, advance]); // tick2，陈在播
    s = handoverReducer(s, { type: 'toggleRun' });
    persistHandover(s);
    const loaded = loadHandover();
    expect(loaded).not.toBeNull();
    expect(loaded!.tick).toBe(2);
    expect(loaded!.running).toBe(false);
    expect(loaded!.effective[EN].legs[0].interpreterId).toBe('int-chen');
    expect(loaded!.sessions.some((x) => x.channelId === EN && x.endTick === null)).toBe(true);
    // 恢复后可以继续推进
    const cont = run(loaded!, [advance, advance]);
    expect(activeId(cont, EN)).toBe('int-chen');
  });
});

describe('全程互斥不变量（复杂混合脚本）', () => {
  it('断线/重连/迟到/回退/静音恢复/撤销重做交错，任意频道永无两条会话重叠', () => {
    let s = backupOnline(fresh());
    const steps: Array<Record<string, unknown>> = [
      { type: 'injectDisconnect', channelId: EN, durationTicks: 5 },
      advance,
      advance, // 切陈
      { type: 'injectFail', channelId: EN, fail: 'late-ack' },
      { type: 'reconnect', channelId: EN }, // 王回来
      { type: 'reconnect', channelId: EN }, // 重复
      advance,
      advance,
      advance,
      advance, // 到回退截止
      { type: 'injectDisconnect', channelId: FR, durationTicks: 2 },
      advance,
      advance, // 短断线吸收
      { type: 'undo' },
      { type: 'undo' },
      advance,
      { type: 'redo' },
    ];
    for (const action of steps) {
      s = handoverReducer(s, action as never);
      assertNoOverlap(s.sessions); // 每一步后都必须成立
    }
    expect(s.tick).toBeGreaterThan(0);
  });
});

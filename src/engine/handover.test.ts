import { describe, expect, it } from 'vitest';
import {
  CONFIRM_WINDOW,
  activeHandover,
  confirmHandover,
  dispatchAt,
  initSession,
  reconcile,
  routeKeyOf,
  tick,
  type Session,
} from './handover';
import { allocateRoutes } from './routing';
import { initialScenario } from '../data/scenario';
import type { Scenario } from '../types';

const allocOf = (s: Scenario) => allocateRoutes(s.floor, s.channels, s.interpreters);

const setOnline = (s: Scenario, id: string, online: boolean): Scenario => ({
  ...s,
  interpreters: s.interpreters.map((i) => (i.id === id ? { ...i, online } : i)),
});

/** 主力断线、备援上岗（经典交接注入） */
const swapToBackup = (s: Scenario) => setOnline(setOnline(s, 'int-wang', false), 'int-chen', true);
/** 主力返岗、备援撤下 */
const swapBack = (s: Scenario) => setOnline(setOnline(s, 'int-wang', true), 'int-chen', false);

const liveKey = (s: Session, ch: string) => routeKeyOf(s.live[ch]?.route ?? null);

/** 不变量：每频道每片段恰有一条派发记录（永不双通道同播） */
function expectSingleDispatchPerSegment(session: Session) {
  const seen = new Map<string, number>();
  for (const d of session.dispatch) {
    const key = `${d.channelId}@${d.segment}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, n] of seen) {
    expect(n, `派发记录 ${key} 应恰有一条`).toBe(1);
  }
  for (const ch of Object.keys(session.live)) {
    for (let seg = 1; seg <= session.segment; seg++) {
      expect(dispatchAt(session, ch, seg), `${ch} 片段 #${seg} 应有派发记录`).not.toBeUndefined();
    }
  }
}

describe('片段边界', () => {
  it('片段中途的故障不改变当片段派发，交接在边界生效', () => {
    const sc0 = initialScenario();
    let session = initSession(sc0, allocOf(sc0));
    expect(liveKey(session, 'ch-en')).toBe('int-wang');

    // 片段 1 中途：主力断线、备援上岗
    const sc1 = swapToBackup(sc0);
    const r = reconcile(session, allocOf(sc1));
    session = r.session;

    // 在播仍是王，交接处于准备阶段，等待边界
    expect(liveKey(session, 'ch-en')).toBe('int-wang');
    expect(activeHandover(session, 'ch-en')?.phase).toBe('prepare');
    expect(dispatchAt(session, 'ch-en', 1)).toBe('int-wang');

    // 推进到边界：切换生效，片段 2 起由陈接播
    session = tick(session, sc1, { autoConfirm: true }).session;
    expect(session.segment).toBe(2);
    expect(liveKey(session, 'ch-en')).toBe('int-chen');
    expect(dispatchAt(session, 'ch-en', 2)).toBe('int-chen');
    expectSingleDispatchPerSegment(session);
  });

  it('确认窗口内自动确认：切换后的下一个边界完成交接', () => {
    const sc0 = initialScenario();
    const sc1 = swapToBackup(sc0);
    let session = reconcile(initSession(sc0, allocOf(sc0)), allocOf(sc1)).session;
    session = tick(session, sc1, { autoConfirm: true }).session; // 切换
    expect(activeHandover(session, 'ch-en')?.phase).toBe('switch');
    session = tick(session, sc1, { autoConfirm: true }).session; // 确认
    expect(activeHandover(session, 'ch-en')).toBeUndefined();
    const kinds = session.trace.filter((e) => e.channelId === 'ch-en').map((e) => e.kind);
    expect(kinds).toEqual(['prepare', 'switch', 'confirm']);
  });

  it('目标为静默（断路）的交接在边界生效且无需确认', () => {
    const sc0 = initialScenario();
    const sc1 = setOnline(sc0, 'int-wang', false); // 无备援：全部断路
    let session = reconcile(initSession(sc0, allocOf(sc0)), allocOf(sc1)).session;
    expect(activeHandover(session, 'ch-en')?.to).toBeNull();
    session = tick(session, sc1, { autoConfirm: true }).session;
    expect(liveKey(session, 'ch-en')).toBeNull();
    expect(dispatchAt(session, 'ch-en', 2)).toBeNull();
    expect(activeHandover(session, 'ch-en')).toBeUndefined(); // 直接完成
    expectSingleDispatchPerSegment(session);
  });
});

describe('断线重连', () => {
  it('边界前恢复的短暂断线：交接取消，在播从未离开原路由', () => {
    const sc0 = initialScenario();
    let session = initSession(sc0, allocOf(sc0));

    // 王短暂断线（无备援），又在同一片段内恢复
    const scOff = setOnline(sc0, 'int-wang', false);
    session = reconcile(session, allocOf(scOff)).session;
    expect(activeHandover(session, 'ch-en')?.phase).toBe('prepare');
    session = reconcile(session, allocOf(sc0)).session; // 恢复

    expect(activeHandover(session, 'ch-en')).toBeUndefined();
    expect(session.trace.some((e) => e.kind === 'cancel')).toBe(true);

    session = tick(session, sc0, { autoConfirm: true }).session;
    expect(liveKey(session, 'ch-en')).toBe('int-wang');
    expect(dispatchAt(session, 'ch-en', 2)).toBe('int-wang');
    // 全程没有发生切换
    expect(session.trace.some((e) => e.kind === 'switch')).toBe(false);
    expectSingleDispatchPerSegment(session);
  });

  it('跨越边界的断线：切换到备援；主力快速返岗则回退，备援只服务其间片段', () => {
    const sc0 = initialScenario();
    let session = initSession(sc0, allocOf(sc0));

    const sc1 = swapToBackup(sc0);
    session = reconcile(session, allocOf(sc1)).session;
    session = tick(session, sc1, { autoConfirm: false }).session; // 片段 2：切到陈（未确认）
    expect(liveKey(session, 'ch-en')).toBe('int-chen');

    // 主力迅速返岗、备援撤下：目标恢复为交接前路由 → 安排回退
    const sc2 = swapBack(sc1);
    const r = reconcile(session, allocOf(sc2));
    session = r.session;
    expect(r.events.some((e) => e.kind === 'rollback-plan')).toBe(true);
    expect(activeHandover(session, 'ch-en')?.phase).toBe('rollback');

    session = tick(session, sc2, { autoConfirm: false }).session; // 片段 3：回退生效
    expect(liveKey(session, 'ch-en')).toBe('int-wang');

    // 派发轨迹：1=王，2=陈，3=王 —— 每片段恰一条，从未双播
    expect(dispatchAt(session, 'ch-en', 1)).toBe('int-wang');
    expect(dispatchAt(session, 'ch-en', 2)).toBe('int-chen');
    expect(dispatchAt(session, 'ch-en', 3)).toBe('int-wang');
    expect(session.trace.some((e) => e.kind === 'rollback')).toBe(true);
    expectSingleDispatchPerSegment(session);
  });

  it('回退后迟到的确认被记录并忽略，不改变在播', () => {
    const sc0 = initialScenario();
    let session = initSession(sc0, allocOf(sc0));
    const sc1 = swapToBackup(sc0);
    session = reconcile(session, allocOf(sc1)).session;
    session = tick(session, sc1, { autoConfirm: false }).session; // 切到陈
    const hoId = activeHandover(session, 'ch-en')!.id;

    const sc2 = swapBack(sc1);
    session = reconcile(session, allocOf(sc2)).session; // 安排回退
    session = tick(session, sc2, { autoConfirm: false }).session; // 回退生效

    // 陈的确认姗姗来迟
    const late = confirmHandover(session, hoId);
    session = late.session;
    expect(late.events).toHaveLength(1);
    expect(late.events[0].kind).toBe('late-confirm');
    expect(liveKey(session, 'ch-en')).toBe('int-wang');
    expect(activeHandover(session, 'ch-en')).toBeUndefined();
    expectSingleDispatchPerSegment(session);
  });

  it('交接确认完成后主力才返岗：发起新的交接切回，而非直接改在播', () => {
    const sc0 = initialScenario();
    let session = initSession(sc0, allocOf(sc0));
    const sc1 = swapToBackup(sc0);
    session = reconcile(session, allocOf(sc1)).session;
    session = tick(session, sc1, { autoConfirm: true }).session; // 切到陈
    session = tick(session, sc1, { autoConfirm: true }).session; // 确认
    expect(activeHandover(session, 'ch-en')).toBeUndefined();

    const sc2 = swapBack(sc1);
    session = reconcile(session, allocOf(sc2)).session;
    const h = activeHandover(session, 'ch-en');
    expect(h?.phase).toBe('prepare');
    expect(routeKeyOf(h?.from ?? null)).toBe('int-chen');
    expect(routeKeyOf(h?.to ?? null)).toBe('int-wang');
    expect(liveKey(session, 'ch-en')).toBe('int-chen'); // 边界前仍在播陈

    session = tick(session, sc2, { autoConfirm: true }).session;
    expect(liveKey(session, 'ch-en')).toBe('int-wang');
    expectSingleDispatchPerSegment(session);
  });
});

describe('重复事件', () => {
  it('重复对齐（同一分配重放）是幂等的，不产生新交接或轨迹', () => {
    const sc0 = initialScenario();
    let session = initSession(sc0, allocOf(sc0));
    const sc1 = swapToBackup(sc0);
    const first = reconcile(session, allocOf(sc1));
    session = first.session;
    expect(first.events.length).toBeGreaterThan(0);

    const again = reconcile(session, allocOf(sc1));
    expect(again.events).toHaveLength(0);
    expect(again.session.trace).toHaveLength(session.trace.length);
    expect(again.session.active).toHaveLength(session.active.length);
  });

  it('重复恢复注入：第二次恢复是 no-op，交接只发起一次', () => {
    const sc0 = initialScenario();
    let session = initSession(sc0, allocOf(sc0));
    const sc1 = swapToBackup(sc0);
    session = reconcile(session, allocOf(sc1)).session;
    session = tick(session, sc1, { autoConfirm: true }).session;
    session = tick(session, sc1, { autoConfirm: true }).session; // 确认完成

    const sc2 = swapBack(sc1);
    session = reconcile(session, allocOf(sc2)).session; // 第一次恢复：发起切回
    const activeCount = session.active.length;
    const traceCount = session.trace.length;

    session = reconcile(session, allocOf(sc2)).session; // 重复恢复：幂等
    expect(session.active).toHaveLength(activeCount);
    expect(session.trace).toHaveLength(traceCount);
    expectSingleDispatchPerSegment(session);
  });

  it('重复确认：第二次确认被忽略', () => {
    const sc0 = initialScenario();
    let session = initSession(sc0, allocOf(sc0));
    const sc1 = swapToBackup(sc0);
    session = reconcile(session, allocOf(sc1)).session;
    session = tick(session, sc1, { autoConfirm: false }).session; // 切到陈，待确认
    const hoId = activeHandover(session, 'ch-en')!.id;

    const c1 = confirmHandover(session, hoId);
    session = c1.session;
    expect(c1.events[0].kind).toBe('confirm');

    const c2 = confirmHandover(session, hoId);
    session = c2.session;
    expect(c2.events).toHaveLength(1);
    expect(c2.events[0].kind).toBe('late-confirm'); // 已终结，按迟到处理
    expect(liveKey(session, 'ch-en')).toBe('int-chen');
    expectSingleDispatchPerSegment(session);
  });

  it('确定性：同一操作序列执行两遍，会话完全一致', () => {
    const run = () => {
      const sc0 = initialScenario();
      let s = initSession(sc0, allocOf(sc0));
      const sc1 = swapToBackup(sc0);
      s = reconcile(s, allocOf(sc1)).session;
      s = tick(s, sc1, { autoConfirm: false }).session;
      const sc2 = swapBack(sc1);
      s = reconcile(s, allocOf(sc2)).session;
      s = tick(s, sc2, { autoConfirm: true }).session;
      return s;
    };
    expect(run()).toEqual(run());
  });
});

describe('确认超时与回退', () => {
  it(`切换后 ${CONFIRM_WINDOW} 个片段未确认：超时回退；旧路由不可用则静默`, () => {
    const sc0 = initialScenario();
    let session = initSession(sc0, allocOf(sc0));
    const sc1 = swapToBackup(sc0); // 王离线、陈上岗
    session = reconcile(session, allocOf(sc1)).session;
    session = tick(session, sc1, { autoConfirm: false }).session; // 片段 2：切到陈
    expect(liveKey(session, 'ch-en')).toBe('int-chen');

    session = tick(session, sc1, { autoConfirm: false }).session; // 片段 3：确认超时
    // 旧路由（王）仍离线 → 回退落空，频道静默
    expect(liveKey(session, 'ch-en')).toBeNull();
    expect(dispatchAt(session, 'ch-en', 3)).toBeNull();
    const rb = session.trace.find((e) => e.kind === 'rollback');
    expect(rb?.note).toContain('确认超时');
    expectSingleDispatchPerSegment(session);
  });

  it('超时静默后主力恢复：重新发起交接并恢复收听', () => {
    const sc0 = initialScenario();
    let session = initSession(sc0, allocOf(sc0));
    const sc1 = swapToBackup(sc0);
    session = reconcile(session, allocOf(sc1)).session;
    session = tick(session, sc1, { autoConfirm: false }).session; // 切到陈
    session = tick(session, sc1, { autoConfirm: false }).session; // 超时 → 静默
    expect(liveKey(session, 'ch-en')).toBeNull();

    const sc2 = swapBack(sc1);
    session = reconcile(session, allocOf(sc2)).session; // 王返岗 → 新交接
    expect(activeHandover(session, 'ch-en')?.phase).toBe('prepare');
    session = tick(session, sc2, { autoConfirm: true }).session; // 切换
    expect(liveKey(session, 'ch-en')).toBe('int-wang');
    session = tick(session, sc2, { autoConfirm: true }).session; // 确认
    expect(activeHandover(session, 'ch-en')).toBeUndefined();
    expectSingleDispatchPerSegment(session);
  });

  it('自动确认开启时，目标在确认前离线：不确认，按超时回退', () => {
    const sc0 = initialScenario();
    let session = initSession(sc0, allocOf(sc0));
    const sc1 = swapToBackup(sc0);
    session = reconcile(session, allocOf(sc1)).session;
    session = tick(session, sc1, { autoConfirm: true }).session; // 切到陈
    // 陈在确认窗口内也离线
    const sc2 = setOnline(sc1, 'int-chen', false);
    session = reconcile(session, allocOf(sc2)).session; // 目标变为静默 → 取代原交接
    session = tick(session, sc2, { autoConfirm: true }).session;
    // 没有任何交接被确认；最终落静默
    expect(session.trace.some((e) => e.kind === 'confirm')).toBe(false);
    expect(liveKey(session, 'ch-en')).toBeNull();
    expectSingleDispatchPerSegment(session);
  });
});

describe('目标变更与取代', () => {
  it('准备阶段目标变为第三条路由：原交接被取代，从当前在播重新发起', () => {
    const sc0 = initialScenario();
    let session = initSession(sc0, allocOf(sc0));
    const sc1 = swapToBackup(sc0);
    session = reconcile(session, allocOf(sc1)).session; // 王→陈 准备中
    expect(routeKeyOf(activeHandover(session, 'ch-en')!.to)).toBe('int-chen');

    // 陈也离线，同时来了一位新直译译员
    const sc2: Scenario = {
      ...setOnline(sc1, 'int-chen', false),
      interpreters: [
        ...setOnline(sc1, 'int-chen', false).interpreters,
        { id: 'int-new', name: '新', source: 'zh', target: 'en', capacity: 2, online: true },
      ],
    };
    const r = reconcile(session, allocOf(sc2));
    session = r.session;
    expect(r.events.some((e) => e.kind === 'replace')).toBe(true);
    const h = activeHandover(session, 'ch-en')!;
    expect(routeKeyOf(h.from)).toBe('int-wang'); // 从当前在播（王）发起
    expect(routeKeyOf(h.to)).toBe('int-new');
    expect(session.active.filter((x) => x.channelId === 'ch-en')).toHaveLength(1);
  });

  it('初始即断路的场景：在播为静默，无交接', () => {
    const sc = setOnline(initialScenario(), 'int-wang', false);
    const session = initSession(sc, allocOf(sc));
    expect(liveKey(session, 'ch-en')).toBeNull();
    expect(session.active).toHaveLength(0);
    expect(dispatchAt(session, 'ch-en', 1)).toBeNull();
  });
});

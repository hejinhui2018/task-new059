import { describe, expect, it } from 'vitest';
import { DRILL_SCRIPTS, applyDrillStep, type DrillScript, type DrillWork } from './drills';
import { dispatchAt, initSession, routeKeyOf, type Session } from './handover';
import { allocateRoutes } from './routing';
import { initialScenario } from '../data/scenario';

function freshWork(): DrillWork {
  const scenario = initialScenario();
  const alloc = allocateRoutes(scenario.floor, scenario.channels, scenario.interpreters);
  return { scenario, session: initSession(scenario, alloc), autoConfirm: true };
}

function runScript(script: DrillScript): DrillWork {
  let work = freshWork();
  for (const step of script.steps) {
    work = applyDrillStep(work, step).work;
  }
  return work;
}

/** 不变量：每频道每片段恰有一条派发记录（任何时刻不会双通道同播） */
function expectSingleDispatch(session: Session) {
  const seen = new Set<string>();
  for (const d of session.dispatch) {
    const key = `${d.channelId}@${d.segment}`;
    expect(seen.has(key), `片段 ${key} 出现重复派发`).toBe(false);
    seen.add(key);
  }
}

const scriptOf = (id: string) => {
  const s = DRILL_SCRIPTS.find((x) => x.id === id);
  if (!s) throw new Error(`missing script ${id}`);
  return s;
};

describe('演练脚本', () => {
  it('「主力瞬断与恢复」：备援跨边界接手又切回，重复恢复被忽略', () => {
    const { session } = runScript(scriptOf('blip-recover'));
    const en = (seg: number) => dispatchAt(session, 'ch-en', seg);

    // 片段轨迹：1-2 王 → 3-5 陈（片段 2 中途注入，边界 3 才切换）→ 6-8 王
    expect(en(1)).toBe('int-wang');
    expect(en(2)).toBe('int-wang');
    expect(en(3)).toBe('int-chen');
    expect(en(5)).toBe('int-chen');
    expect(en(6)).toBe('int-wang');
    expect(en(8)).toBe('int-wang');

    // 英语频道恰有两次完整交接（去、回），重复注入没有产生第三次
    const enHandovers = new Set(
      session.trace.filter((e) => e.channelId === 'ch-en' && e.kind === 'prepare').map((e) => e.handoverId),
    );
    expect(enHandovers.size).toBe(2);
    // 日语频道在备援期间席位不足转静默，主力返岗后恢复
    expect(dispatchAt(session, 'ch-ja', 3)).toBeNull();
    expect(dispatchAt(session, 'ch-ja', 8)).toBe('int-wang>int-sato');
    expectSingleDispatch(session);
  });

  it('「快速返岗回退与迟到确认」：回退生效，迟到确认被忽略', () => {
    const { session } = runScript(scriptOf('early-return-late-ack'));
    const kinds = session.trace.filter((e) => e.channelId === 'ch-en').map((e) => e.kind);

    expect(kinds).toContain('rollback-plan');
    expect(kinds).toContain('rollback');
    expect(kinds).toContain('late-confirm');
    // 从未确认过备援路由
    expect(kinds).not.toContain('confirm');
    // 陈只服务了切换后的那一个片段
    const chenSegments = session.dispatch.filter(
      (d) => d.channelId === 'ch-en' && d.routeKey === 'int-chen',
    );
    expect(chenSegments).toHaveLength(1);
    // 最终在播王
    expect(routeKeyOf(session.live['ch-en'].route)).toBe('int-wang');
    expectSingleDispatch(session);
  });

  it('「确认超时回退与恢复」：超时转静默，主力恢复后重新交接确认', () => {
    const { session } = runScript(scriptOf('ack-timeout'));
    const kinds = session.trace.filter((e) => e.channelId === 'ch-en').map((e) => e.kind);

    expect(kinds).toContain('rollback');
    const timeoutEvent = session.trace.find((e) => e.kind === 'rollback' && e.note?.includes('确认超时'));
    expect(timeoutEvent).toBeDefined();
    // 静默片段存在（回退落空）
    const nullSegments = session.dispatch.filter((d) => d.channelId === 'ch-en' && d.routeKey === null);
    expect(nullSegments.length).toBeGreaterThan(0);
    // 最终恢复：在播王，且最后一次交接被确认
    expect(routeKeyOf(session.live['ch-en'].route)).toBe('int-wang');
    expect(kinds).toContain('confirm');
    expectSingleDispatch(session);
  });

  it('重复演练：同一脚本从同一起点执行两遍，轨迹与派发完全一致', () => {
    for (const script of DRILL_SCRIPTS) {
      const a = runScript(script);
      const b = runScript(script);
      expect(b.session.trace, `${script.id} 轨迹应确定`).toEqual(a.session.trace);
      expect(b.session.dispatch, `${script.id} 派发应确定`).toEqual(a.session.dispatch);
      expect(b.session.completed, `${script.id} 交接终态应确定`).toEqual(a.session.completed);
    }
  });

  it('刷新恢复：演练中途序列化存档，恢复后继续执行与一气呵成一致', () => {
    for (const script of DRILL_SCRIPTS) {
      const full = runScript(script);
      // 执行前两步后"刷新"：工作状态 JSON 存档再恢复
      let work = freshWork();
      for (const step of script.steps.slice(0, 2)) work = applyDrillStep(work, step).work;
      let revived: DrillWork = JSON.parse(JSON.stringify(work));
      for (const step of script.steps.slice(2)) revived = applyDrillStep(revived, step).work;
      expect(revived.session, `${script.id} 恢复后会话应一致`).toEqual(full.session);
      expect(revived.scenario, `${script.id} 恢复后场景应一致`).toEqual(full.scenario);
    }
  });

  it('所有脚本结束后：无进行中交接，在播与目标一致', () => {
    for (const script of DRILL_SCRIPTS) {
      const { scenario, session } = runScript(script);
      expect(session.active, `${script.id} 不应残留进行中交接`).toHaveLength(0);
      const alloc = allocateRoutes(scenario.floor, scenario.channels, scenario.interpreters);
      for (const ch of scenario.channels) {
        const o = alloc.byChannel.get(ch.id);
        const desired = o && o.status === 'ok' ? routeKeyOf(o.route) : null;
        expect(routeKeyOf(session.live[ch.id].route), `${script.id} ${ch.id} 在播应等于目标`).toBe(desired);
      }
    }
  });
});

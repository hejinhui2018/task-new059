import { describe, expect, it } from 'vitest';
import { allocateRoutes, diagnoseGaps, findCandidateRoutes } from './routing';
import { initialScenario } from '../data/scenario';
import type { Channel, Interpreter } from '../types';

const I = (id: string, source: string, target: string, capacity = 1, online = true): Interpreter => ({
  id,
  name: id,
  source,
  target,
  capacity,
  online,
});

const C = (id: string, target: string, priority: number): Channel => ({
  id,
  name: id,
  target,
  priority,
});

describe('路径选择', () => {
  it('直译优先于中继', () => {
    const interpreters = [I('i-direct', 'zh', 'en'), I('i-a', 'zh', 'fr'), I('i-b', 'fr', 'en')];
    const routes = findCandidateRoutes('zh', 'en', interpreters);
    expect(routes).toHaveLength(2);
    expect(routes[0].legs.map((l) => l.interpreterId)).toEqual(['i-direct']);
    expect(routes[0].relay).toBeNull();
    expect(routes[1].relay).toBe('fr');
  });

  it('没有直译时选择中继路由，并记录中继语言', () => {
    const routes = findCandidateRoutes('zh', 'en', [I('i-a', 'zh', 'fr'), I('i-b', 'fr', 'en')]);
    expect(routes).toHaveLength(1);
    expect(routes[0].legs.map((l) => l.interpreterId)).toEqual(['i-a', 'i-b']);
    expect(routes[0].relay).toBe('fr');
  });

  it('同等候选按译员编号确定排序（结果可复现）', () => {
    const routes = findCandidateRoutes('zh', 'en', [I('i-b', 'zh', 'en'), I('i-a', 'zh', 'en')]);
    expect(routes.map((r) => r.legs[0].interpreterId)).toEqual(['i-a', 'i-b']);
  });

  it('离线译员不参与路由', () => {
    const routes = findCandidateRoutes('zh', 'en', [I('i-a', 'zh', 'en', 1, false)]);
    expect(routes).toHaveLength(0);
  });

  it('最多两跳：三段链不可达', () => {
    const chain = [I('i1', 'zh', 'en'), I('i2', 'en', 'fr'), I('i3', 'fr', 'ja')];
    expect(findCandidateRoutes('zh', 'ja', chain)).toHaveLength(0);
    const alloc = allocateRoutes('zh', [C('c', 'ja', 1)], chain);
    expect(alloc.byChannel.get('c')?.status).toBe('broken');
  });
});

describe('容量竞争', () => {
  it('容量为 1 的中继枢纽只能服务一个频道，其余频道报告席位不足并指出瓶颈译员', () => {
    const interpreters = [I('i-hub', 'zh', 'en', 1), I('i-fr', 'en', 'fr')];
    const channels = [C('en', 'en', 1), C('fr', 'fr', 2)];
    const a = allocateRoutes('zh', channels, interpreters);
    expect(a.byChannel.get('en')?.status).toBe('ok');
    const fr = a.byChannel.get('fr');
    expect(fr?.status).toBe('blocked');
    if (fr?.status === 'blocked') {
      expect(fr.fullInterpreters).toEqual(['i-hub']);
      expect(fr.route.legs.map((l) => l.interpreterId)).toEqual(['i-hub', 'i-fr']);
    }
  });

  it('中继路由同时占用两段译员各 1 席', () => {
    const interpreters = [I('i1', 'zh', 'en', 2), I('i2', 'en', 'fr', 2)];
    const a = allocateRoutes('zh', [C('fr', 'fr', 1)], interpreters);
    expect(a.byChannel.get('fr')?.status).toBe('ok');
    expect(a.loads.get('i1')).toBe(1);
    expect(a.loads.get('i2')).toBe(1);
  });

  it('容量 2 的译员可承载两个频道，第三个被挡下', () => {
    const interpreters = [I('i-hub', 'zh', 'en', 2), I('i-fr', 'en', 'fr'), I('i-ja', 'en', 'ja')];
    const channels = [C('en', 'en', 1), C('fr', 'fr', 2), C('ja', 'ja', 3)];
    const a = allocateRoutes('zh', channels, interpreters);
    expect(a.byChannel.get('en')?.status).toBe('ok');
    expect(a.byChannel.get('fr')?.status).toBe('ok');
    expect(a.byChannel.get('ja')?.status).toBe('blocked');
    expect(a.loads.get('i-hub')).toBe(2);
  });

  it('blocked 时报告的路由是确定性最优候选', () => {
    const interpreters = [I('int-a', 'zh', 'en', 1), I('int-b', 'zh', 'en', 1)];
    const channels = [C('c1', 'en', 1), C('c2', 'en', 2), C('c3', 'en', 3)];
    const a = allocateRoutes('zh', channels, interpreters);
    const c3 = a.byChannel.get('c3');
    expect(c3?.status).toBe('blocked');
    if (c3?.status === 'blocked') {
      expect(c3.route.legs[0].interpreterId).toBe('int-a');
      expect(c3.fullInterpreters).toEqual(['int-a']);
    }
  });
});

describe('优先级', () => {
  const interpreters = [I('i-hub', 'zh', 'en', 1), I('i-fr', 'en', 'fr')];

  it('优先级高的频道先拿到席位，低优先级频道让位', () => {
    const a = allocateRoutes('zh', [C('en', 'en', 2), C('fr', 'fr', 1)], interpreters);
    expect(a.byChannel.get('fr')?.status).toBe('ok');
    expect(a.byChannel.get('en')?.status).toBe('blocked');
  });

  it('交换优先级后，席位归属随之确定性地交换', () => {
    const a = allocateRoutes('zh', [C('en', 'en', 1), C('fr', 'fr', 2)], interpreters);
    expect(a.byChannel.get('en')?.status).toBe('ok');
    expect(a.byChannel.get('fr')?.status).toBe('blocked');
  });

  it('优先级并列时按频道编号确定顺序', () => {
    const a = allocateRoutes('zh', [C('ch-b', 'en', 1), C('ch-a', 'en', 1)], [I('i1', 'zh', 'en', 1)]);
    expect(a.byChannel.get('ch-a')?.status).toBe('ok');
    expect(a.byChannel.get('ch-b')?.status).toBe('blocked');
  });
});

describe('循环拒绝', () => {
  it('自环译员（源=目标）永不被采用', () => {
    const interpreters = [I('i-loop', 'zh', 'zh'), I('i1', 'zh', 'en')];
    const used = findCandidateRoutes('zh', 'en', interpreters).flatMap((r) => r.legs.map((l) => l.interpreterId));
    expect(used).not.toContain('i-loop');
    expect(used).toEqual(['i1']);
  });

  it('路由不会回到主讲语言（图中的环被忽略）', () => {
    const cyc = [I('i1', 'zh', 'en'), I('i2', 'en', 'fr'), I('i3', 'fr', 'zh')];
    const routes = findCandidateRoutes('zh', 'fr', cyc);
    expect(routes).toHaveLength(1);
    expect(routes[0].legs.map((l) => l.interpreterId)).toEqual(['i1', 'i2']);
  });

  it('任何候选路由上的语种节点都不重复', () => {
    const cyc = [I('i1', 'zh', 'en'), I('i2', 'en', 'fr'), I('i3', 'fr', 'zh'), I('i4', 'fr', 'en')];
    for (const target of ['en', 'fr']) {
      for (const r of findCandidateRoutes('zh', target, cyc)) {
        const nodes = [r.legs[0].source, ...r.legs.map((l) => l.target)];
        expect(new Set(nodes).size).toBe(nodes.length);
      }
    }
  });

  it('目标等于主讲语言时不产生路由', () => {
    const cyc = [I('i1', 'zh', 'en'), I('i2', 'en', 'zh')];
    expect(findCandidateRoutes('zh', 'zh', cyc)).toHaveLength(0);
  });

  it('往返译员不会拼出回到起点的伪路由', () => {
    const pingpong = [I('i1', 'zh', 'en'), I('i2', 'en', 'zh')];
    const routes = findCandidateRoutes('zh', 'en', pingpong);
    expect(routes).toHaveLength(1); // 仅直译，没有 zh→en→zh→… 的循环
  });
});

describe('断路诊断', () => {
  it('直译译员离线时，缺口指向该段并列出可恢复的译员', () => {
    const interpreters = [I('i-a', 'zh', 'en', 1, false)];
    const gaps = diagnoseGaps('zh', 'en', interpreters);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].role).toBe('direct');
    expect(gaps[0].offlineInterpreterIds).toEqual(['i-a']);
  });

  it('中继前段断开时，缺口标出中继语言与缺失段', () => {
    // zh→en 离线，en→fr 在线：fr 频道的中继缺口是 zh→en
    const interpreters = [I('i-a', 'zh', 'en', 1, false), I('i-b', 'en', 'fr')];
    const gaps = diagnoseGaps('zh', 'fr', interpreters);
    const relayGap = gaps.find((g) => g.role === 'relay-first');
    expect(relayGap?.via).toBe('en');
    expect(relayGap?.source).toBe('zh');
    expect(relayGap?.target).toBe('en');
    expect(relayGap?.offlineInterpreterIds).toEqual(['i-a']);
  });

  it('中继后段断开时，缺口指向后段', () => {
    const interpreters = [I('i-a', 'zh', 'en'), I('i-b', 'en', 'fr', 1, false)];
    const gaps = diagnoseGaps('zh', 'fr', interpreters);
    const relayGap = gaps.find((g) => g.role === 'relay-second');
    expect(relayGap?.source).toBe('en');
    expect(relayGap?.target).toBe('fr');
    expect(relayGap?.offlineInterpreterIds).toEqual(['i-b']);
  });
});

describe('故障与重路由（内置演示场景）', () => {
  it('初始场景：三频道全覆盖，法语/日语经英语中继，主力译员满载 3/3', () => {
    const s = initialScenario();
    const a = allocateRoutes(s.floor, s.channels, s.interpreters);
    for (const ch of s.channels) {
      expect(a.byChannel.get(ch.id)?.status).toBe('ok');
    }
    expect(a.loads.get('int-wang')).toBe(3);
    const fr = a.byChannel.get('ch-fr');
    if (fr?.status === 'ok') expect(fr.route.relay).toBe('en');
    const ja = a.byChannel.get('ch-ja');
    if (ja?.status === 'ok') expect(ja.route.relay).toBe('en');
    const en = a.byChannel.get('ch-en');
    if (en?.status === 'ok') expect(en.route.relay).toBeNull();
  });

  it('关闭主力中英译员：三频道全部断路，缺口指向中→英并列出可恢复译员', () => {
    const s = initialScenario();
    const interpreters = s.interpreters.map((i) => (i.id === 'int-wang' ? { ...i, online: false } : i));
    const a = allocateRoutes(s.floor, s.channels, interpreters);
    for (const ch of s.channels) {
      expect(a.byChannel.get(ch.id)?.status).toBe('broken');
    }
    const en = a.byChannel.get('ch-en');
    if (en?.status === 'broken') {
      const gap = en.gaps.find((g) => g.source === 'zh' && g.target === 'en');
      expect(gap?.offlineInterpreterIds).toContain('int-wang');
      expect(gap?.offlineInterpreterIds).toContain('int-chen');
    } else {
      expect.unreachable();
    }
    const fr = a.byChannel.get('ch-fr');
    if (fr?.status === 'broken') {
      expect(fr.gaps.some((g) => g.role === 'relay-first' && g.via === 'en')).toBe(true);
    } else {
      expect.unreachable();
    }
  });

  it('启用容量 2 的备援译员：按优先级确定性保住英语、法语，日语席位不足', () => {
    const s = initialScenario();
    const interpreters = s.interpreters.map((i) =>
      i.id === 'int-wang' ? { ...i, online: false } : i.id === 'int-chen' ? { ...i, online: true } : i,
    );
    const a = allocateRoutes(s.floor, s.channels, interpreters);
    expect(a.byChannel.get('ch-en')?.status).toBe('ok');
    expect(a.byChannel.get('ch-fr')?.status).toBe('ok');
    const ja = a.byChannel.get('ch-ja');
    expect(ja?.status).toBe('blocked');
    if (ja?.status === 'blocked') {
      expect(ja.fullInterpreters).toEqual(['int-chen']);
    }
    expect(a.loads.get('int-chen')).toBe(2);
  });

  it('再增加一条中→日直译：恢复全部覆盖', () => {
    const s = initialScenario();
    const interpreters: Interpreter[] = [
      ...s.interpreters.map((i) =>
        i.id === 'int-wang' ? { ...i, online: false } : i.id === 'int-chen' ? { ...i, online: true } : i,
      ),
      { id: 'int-new', name: '新', source: 'zh', target: 'ja', capacity: 1, online: true },
    ];
    const a = allocateRoutes(s.floor, s.channels, interpreters);
    for (const ch of s.channels) {
      expect(a.byChannel.get(ch.id)?.status).toBe('ok');
    }
    const ja = a.byChannel.get('ch-ja');
    if (ja?.status === 'ok') {
      expect(ja.route.relay).toBeNull();
      expect(ja.route.legs[0].interpreterId).toBe('int-new');
    }
  });

  it('译员离线后，频道确定性地切换到剩余译员', () => {
    const interpreters = [I('int-a', 'zh', 'en', 1), I('int-b', 'zh', 'en', 1)];
    const channels = [C('ch', 'en', 1)];
    const first = allocateRoutes('zh', channels, interpreters);
    const firstOut = first.byChannel.get('ch');
    if (firstOut?.status === 'ok') {
      expect(firstOut.route.legs[0].interpreterId).toBe('int-a');
    } else {
      expect.unreachable();
    }
    const second = allocateRoutes(
      'zh',
      channels,
      interpreters.map((i) => (i.id === 'int-a' ? { ...i, online: false } : i)),
    );
    const secondOut = second.byChannel.get('ch');
    if (secondOut?.status === 'ok') {
      expect(secondOut.route.legs[0].interpreterId).toBe('int-b');
    } else {
      expect.unreachable();
    }
  });
});

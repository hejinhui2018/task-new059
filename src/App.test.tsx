import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import App from './App';

describe('App 冒烟', () => {
  it('完整渲染交接台：顶栏、控制台、连接图、频道板、译员表、轨迹', () => {
    // renderToString 会在相邻文本节点间插入 <!-- -->，先清理再断言
    const html = renderToString(<App />).replace(/<!-- -->/g, '');
    // 顶栏与统计
    expect(html).toContain('译员交接版');
    expect(html).toContain('路由覆盖 3/3');
    expect(html).toContain('在播频道 3/3');
    // 演练控制台
    expect(html).toContain('单步推进');
    expect(html).toContain('自动演练');
    expect(html).toContain('主译短暂断线');
    expect(html).toContain('撤销');
    expect(html).toContain('重做');
    expect(html).toContain('音频片段');
    // 连接图节点与译员边
    expect(html).toContain('中文');
    expect(html).toContain('王（主力）');
    expect(html).toContain('陈（备援）');
    // 三个频道与播放态
    expect(html).toContain('英语频道');
    expect(html).toContain('法语频道');
    expect(html).toContain('日语频道');
    expect(html).toContain('播放中');
    // 事件轨迹与就绪事件
    expect(html).toContain('交接台就绪');
    expect(html).toContain('片段边界');
  });
});

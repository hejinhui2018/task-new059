import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import App from './App';

describe('App 冒烟', () => {
  it('完整渲染调度台：顶栏、连接图、频道板、译员表、日志', () => {
    // renderToString 会在相邻文本节点间插入 <!-- -->，先清理再断言
    const html = renderToString(<App />).replace(/<!-- -->/g, '');
    // 顶栏与统计
    expect(html).toContain('同传语言路由台');
    expect(html).toContain('频道覆盖 3/3');
    // 连接图节点与译员边
    expect(html).toContain('中文');
    expect(html).toContain('王（主力）');
    expect(html).toContain('陈（备援）');
    // 三个频道均为正常状态（✓ 图标 + 文字，不只靠颜色）
    expect(html).toContain('英语频道');
    expect(html).toContain('法语频道');
    expect(html).toContain('日语频道');
    expect(html).toContain('正常 · 直译');
    expect(html).toContain('正常 · 经英语中继');
    // 席位占用信息
    expect(html).toContain('3/3');
    // 调度日志就绪
    expect(html).toContain('调度台就绪');
  });
});

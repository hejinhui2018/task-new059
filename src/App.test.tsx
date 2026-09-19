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

  it('渲染交接演练台：片段时钟、演练控制、故障注入、在播路由与空轨迹', () => {
    const html = renderToString(<App />).replace(/<!-- -->/g, '');
    // 演练台骨架
    expect(html).toContain('交接演练台');
    expect(html).toContain('片段');
    expect(html).toContain('#1');
    // 控制按钮：单步 / 自动演练 / 撤销 / 重做 / 归零
    expect(html).toContain('单步');
    expect(html).toContain('自动演练');
    expect(html).toContain('撤销');
    expect(html).toContain('重做');
    expect(html).toContain('演练归零');
    // 脚本选择与自动确认开关
    expect(html).toContain('自由演练');
    expect(html).toContain('主力瞬断与恢复');
    expect(html).toContain('自动确认');
    // 故障注入按钮（断线/恢复）
    expect(html).toContain('故障注入');
    expect(html).toContain('断线');
    // 频道在播路由（初始在播 = 目标路由）
    expect(html).toContain('在播');
    expect(html).toContain('自片段 #1');
    // 交接轨迹初始为空
    expect(html).toContain('尚无交接事件');
  });
});

import type { Scenario } from '../types';

/**
 * 内置演示场景：中文主讲，需要英语 / 法语 / 日语三个频道。
 * 法语、日语没有直译译员，依赖英语中继（中→英→法 / 中→英→日）。
 * 王（主力）容量 3，一人扛起全部三个频道的中→英段；
 * 陈（备援）容量 2，初始离线 —— 演示故障切换用。
 */
export function initialScenario(): Scenario {
  return {
    floor: 'zh',
    languages: [
      { code: 'zh', name: '中文' },
      { code: 'en', name: '英语' },
      { code: 'fr', name: '法语' },
      { code: 'ja', name: '日语' },
    ],
    interpreters: [
      { id: 'int-wang', name: '王（主力）', source: 'zh', target: 'en', capacity: 3, online: true },
      { id: 'int-li', name: '李', source: 'en', target: 'fr', capacity: 1, online: true },
      { id: 'int-sato', name: '佐藤', source: 'en', target: 'ja', capacity: 1, online: true },
      { id: 'int-chen', name: '陈（备援）', source: 'zh', target: 'en', capacity: 2, online: false },
    ],
    channels: [
      { id: 'ch-en', name: '英语频道', target: 'en', priority: 1 },
      { id: 'ch-fr', name: '法语频道', target: 'fr', priority: 2 },
      { id: 'ch-ja', name: '日语频道', target: 'ja', priority: 3 },
    ],
  };
}

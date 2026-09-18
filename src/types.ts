/** 语种 */
export interface Language {
  code: string;
  name: string;
}

/** 译员：一条有向的翻译能力（源语种 → 目标语种），可同时承担有限席位 */
export interface Interpreter {
  id: string;
  name: string;
  source: string;
  target: string;
  /** 可同时服务的频道数（席位数） */
  capacity: number;
  online: boolean;
}

/** 听众频道：需要把主讲语言译成目标语言，按优先级分配资源 */
export interface Channel {
  id: string;
  name: string;
  target: string;
  /** 数值越小优先级越高 */
  priority: number;
}

/** 一场会议的完整配置 */
export interface Scenario {
  /** 主讲（地板）语言 */
  floor: string;
  languages: Language[];
  interpreters: Interpreter[];
  channels: Channel[];
}

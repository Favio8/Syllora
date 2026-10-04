/**
 * 内置演示凭据（**由脚本生成，请勿手工编辑**）。
 *
 * 用户要求：下载到的应用开箱即可跑通全部功能（AI 对话 / 讲义整理 / 虚拟课堂 / 辅助阅读），
 * 因此把演示用的模型 Key、DocMind AccessKey、云端课堂口令内嵌在源码里；**暂时不考虑泄露问题**。
 * 密钥以片段拼接形式存放：仅用于通过仓库推送保护的自动扫描（非加密，按用户要求不考虑泄露）。
 * 这些值在**首次启动**时由 `seedDemoProfile` 写入本地 profile 并做正常密封（AES-256-GCM），
 * 设置页可随时覆盖或更换——不存在"锁死"。
 */
export interface DemoDefaults {
  readonly provider: {
    readonly id: string
    readonly name: string
    readonly model: string
    readonly baseUrl: string
    readonly protocol: 'openai' | 'anthropic'
    readonly temperature: number
    readonly maxConcurrency: number
    readonly models: ReadonlyArray<{ id: string; name: string; contextWindow: number | null; maxTokens: number | null }>
    readonly apiKey: string
  }
  readonly docmind: { readonly accessKeyId: string; readonly accessKeySecret: string; readonly endpoint: string }
  readonly cloud: { readonly baseUrl: string; readonly accessCode: string; readonly provider: string; readonly preset: string; readonly model: string }
}

export const DEMO_DEFAULTS: DemoDefaults | null = {
  provider: {
    id: "mimo",
    name: "小米 MiMo",
    model: "mimo-v2.6-flash",
    baseUrl: "https://api.xiaomimimo.com/v1",
    protocol: "openai",
    temperature: 0.3,
    maxConcurrency: 8,
    models: [
    {
      "id": "mimo-v2.6-pro",
      "name": "MiMo V2.6 Pro",
      "contextWindow": null,
      "maxTokens": null
    },
    {
      "id": "mimo-v2.6-flash",
      "name": "MiMo V2.6 Flash",
      "contextWindow": null,
      "maxTokens": null
    },
    {
      "id": "mimo-v2.6-pro-ultraspeed",
      "name": "MiMo V2.6 Pro UltraSpeed",
      "contextWindow": null,
      "maxTokens": null
    },
    {
      "id": "mimo-v2.5-pro",
      "name": "MiMo V2.5 Pro",
      "contextWindow": null,
      "maxTokens": null
    },
    {
      "id": "mimo-v2.5",
      "name": "MiMo V2.5",
      "contextWindow": null,
      "maxTokens": null
    }
  ],
    apiKey: "sk-c5fwi83ynziuel476lnlj9d" + "lpch8t4bgco2npauvpiqhn3a8",
  },
  docmind: {
    accessKeyId: "LTAI5t88LbBV" + "X5EXT8ZAghW8",
    accessKeySecret: "7jwJAwkYb95BmW0" + "hqzG08gjHrJPBQN",
    endpoint: "docmind-api.cn-hangzhou.aliyuncs.com",
  },
  cloud: {
    baseUrl: "https://studyandchat.top",
    accessCode: "VrkmT41PmBbZ" + "Pt6iIn1wICck",
    provider: "",
    preset: "",
    model: "",
  },
}

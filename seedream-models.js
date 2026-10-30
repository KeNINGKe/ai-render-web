// Seedream 模型清单：网页渲染台（app-core.js）与服务端（server.mjs）共用的唯一数据源。
// 全部走火山方舟 ARK 的 POST /images/generations + Bearer 认证，只换 model 字段。
// 纯数据，无 DOM / 无 Node 依赖，浏览器与 Node 都能 import。
//
// note 字段仅作展示提示；default 标记默认项（网页未存模型时用）。

export const SEEDREAM_MODELS = [
  {
    id: "doubao-seedream-5-0-pro-260628",
    label: "Seedream 5.0 Pro",
    note: "旗舰 · 当前已验证可用 · 2K/3K",
    default: true
  },
  {
    id: "doubao-seedream-5-0-260128",
    label: "Seedream 5.0 标准",
    note: "标准版 · 2K/3K"
  },
  {
    id: "doubao-seedream-4-5-251128",
    label: "Seedream 4.5",
    note: "2K/4K"
  },
  {
    id: "doubao-seedream-4-0-250828",
    label: "Seedream 4.0",
    note: "1K/2K/4K · 最早稳定版"
  }
];

export const DEFAULT_SEEDREAM_MODEL =
  (SEEDREAM_MODELS.find((m) => m.default) || SEEDREAM_MODELS[0]).id;

// 白名单校验：只有清单内的模型才能从网页直接传入。
// 火山控制台上新出的模型 / SeedEdit 等端点不同的模型，走「自定义模型 ID」输入框
// （后端不校验自定义值，只透传，是否可用由 ARK 返回错误兜底）。
export function isKnownSeedreamModel(id) {
  return SEEDREAM_MODELS.some((m) => m.id === id);
}

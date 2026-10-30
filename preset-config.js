// 渲染档位：草稿用于快速迭代，标准是日常甜点，成图保留最大质量。
// 步数为经验起点（dpmpp_2m + karras），待真实案例图到位后再校准。
// 切换档位时前端会把最大长边同步到 defaultLongEdge，兼顾步数与分辨率两档提速。
export const QUALITY_MODES = {
  draft: { id: "draft", label: "草稿·快", steps: 14, defaultLongEdge: 1024 },
  standard: { id: "standard", label: "标准", steps: 24, defaultLongEdge: 1216 },
  final: { id: "final", label: "成图·精", steps: 30, defaultLongEdge: 1216 }
};

export const PRESET_PARAMETERS = {
  "model-render": {
    cannyStrength: 0.90,
    depthStrength: 0.85,
    defaultMode: "standard",
    denoise: { min: 0.5, max: 0.85, base: 0.35, scale: 0.6 }
  },
  "cmf-edit": {
    cannyStrength: 0.9,
    depthStrength: 0.9,
    defaultMode: "standard",
    denoise: { min: 0.35, max: 0.55, base: 0.35, scale: 0.2 }
  }
};

export function computeSteps(taskKey, modeId) {
  const config = PRESET_PARAMETERS[taskKey] || PRESET_PARAMETERS["model-render"];
  const mode = QUALITY_MODES[modeId] || QUALITY_MODES[config.defaultMode];
  return mode.steps;
}

export function computeDenoise(taskKey, creativity) {
  const config = PRESET_PARAMETERS[taskKey] || PRESET_PARAMETERS["model-render"];
  const value = config.denoise.base + (Number(creativity) / 100) * config.denoise.scale;
  return Math.min(config.denoise.max, Math.max(config.denoise.min, value));
}

// Seedream 档位：不再有 SDXL 的步数/去噪，质量由输出长边决定（显式 WxH）。
// Seedream 5.0 Pro 支持 2K/3K 或显式 WxH（1K/4K 会被拒），草稿用 1536 长边代替 1K。
// 网页渲染台的档位按钮由这份定义生成（app-core.js），保持唯一数据源。
export const SEEDREAM_QUALITY_MODES = {
  draft: { id: "draft", label: "草稿", longEdge: 1536 },
  standard: { id: "standard", label: "标准", longEdge: 2048 },
  final: { id: "final", label: "高清", longEdge: 3072 }
};

export function computeSeedreamLongEdge(modeId) {
  const mode = SEEDREAM_QUALITY_MODES[modeId] || SEEDREAM_QUALITY_MODES.standard;
  return mode.longEdge;
}

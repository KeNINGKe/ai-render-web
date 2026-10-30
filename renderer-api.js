import { RUNTIME_CONFIG } from "./runtime-config.js";

export async function createRendererApi(config = RUNTIME_CONFIG, deps = {}) {
  const mode = config?.mode ?? "server";
  if (mode === "server") {
    const { createServerRendererApi } = await import("./server-renderer-api.js");
    return createServerRendererApi(config, deps);
  }
  if (mode === "direct") {
    const { createDirectRendererApi } = await import("./direct-renderer-api.js");
    return createDirectRendererApi(config, deps);
  }
  throw new Error(`不支持的渲染模式：${mode}`);
}

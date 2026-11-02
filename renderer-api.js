import { RUNTIME_CONFIG } from "./runtime-config.js";
import { createSharedRendererApi } from "./shared-renderer-api.js";

export async function createRendererApi(config = RUNTIME_CONFIG, deps = {}) {
  const mode = config?.mode ?? "server";
  if (mode === "server") {
    const { createServerRendererApi } = await import("./server-renderer-api.js");
    return createSharedRendererApi(createServerRendererApi(config, deps), deps);
  }
  if (mode === "direct") {
    const { createDirectRendererApi } = await import("./direct-renderer-api.js");
    return createSharedRendererApi(createDirectRendererApi(config, deps), deps);
  }
  throw new Error(`不支持的渲染模式：${mode}`);
}

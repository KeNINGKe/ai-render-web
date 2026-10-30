import { createBrowserRenderStore } from "./browser-render-store.js";
import { DEFAULT_SEEDREAM_MODEL, SEEDREAM_MODELS, isKnownSeedreamModel } from "./seedream-models.js";

const ARK_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const STORAGE_WARNING = "浏览器存储不可用；历史和参考图无法持久保存，每日次数限制仅在当前会话生效。";
const POSSIBLY_BILLED = "本次请求可能已经计费，请先核对火山方舟记录，不要直接重复生成。";

function apiError(message, status = 0, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function httpsUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function validImageDataUrl(value) {
  if (typeof value !== "string") return false;
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) return false;
  const encoded = match[1];
  return encoded.length % 4 !== 1 && (!encoded.includes("=") || encoded.length % 4 === 0);
}

function validatePayload(payload) {
  const text = (value) => typeof value === "string" ? value.trim() : "";
  const apiKey = text(payload?.apiKey);
  if (!apiKey || /\s|[\x00-\x1f\x7f]/.test(apiKey)) throw apiError("请填写有效的自有 API Key", 400);
  const prompt = text(payload?.prompt);
  if (!prompt) throw apiError("缺少 prompt", 400);
  const size = text(payload?.size);
  const dimensions = /^(\d{1,5})x(\d{1,5})$/.exec(size);
  if (!/^[1-4]K$/.test(size) && !(dimensions && Number(dimensions[1]) > 0 && Number(dimensions[2]) > 0)) {
    throw apiError("输出 size 必须为有效的 WxH 或 1K/2K/3K/4K", 400);
  }
  const refs = typeof payload.referenceImages === "string" ? [payload.referenceImages] : payload.referenceImages;
  if (!Array.isArray(refs) || !refs.length || refs.some((ref) => !validImageDataUrl(ref) && !httpsUrl(ref))) {
    throw apiError("缺少有效参考图（PNG/JPEG/WebP data URL 或 HTTPS URL）", 400);
  }
  const customModel = text(payload.customModel);
  const model = customModel || text(payload.model) || DEFAULT_SEEDREAM_MODEL;
  if (/\s|[\x00-\x1f\x7f]/.test(model) || (!customModel && !isKnownSeedreamModel(model))) {
    throw apiError("不支持的模型，请选择已有模型或填写自定义模型 ID", 400);
  }
  return { apiKey, prompt, size, refs: [...refs], model };
}

function base64Blob(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error("无效的 base64 图片");
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (!bytes.length) throw new Error("图片为空");
  const mime = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? "image/png"
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
    : String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP" ? "image/webp" : "";
  if (!mime) throw new Error("图片格式无效");
  return new Blob([bytes], { type: mime });
}

async function blobDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

// One controller covers POST, response parsing, and the independent result download.
function requestLifetime(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("渲染超时", "TimeoutError")), timeoutMs);
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  };
}

export function createDirectRendererApi(config = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const dailyLimit = config.dailyLimit ?? 50;
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1) throw apiError("每日次数配置无效", 400);
  const timeoutMs = deps.timeoutMs ?? config.renderTimeoutMs ?? 5 * 60 * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw apiError("渲染超时配置无效", 400);
  let storePromise;
  let sessionDate = "";
  let sessionUsed = 0;
  let sessionOnly = false;
  const getStore = () => storePromise ??= Promise.resolve().then(() => deps.store ?? createBrowserRenderStore());

  async function reserve() {
    const date = new Date(now());
    const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    if (day !== sessionDate) { sessionDate = day; sessionUsed = 0; }
    if (!sessionOnly) {
      try {
        const reservation = await (await getStore()).reserveAttempt(dailyLimit);
        sessionUsed = Math.max(sessionUsed + 1, Number(reservation?.used) || 0);
        return "";
      } catch (error) {
        if (error.status === 429) { error.pauseQueue = true; throw error; }
        sessionOnly = true;
      }
    }
    if (sessionUsed >= dailyLimit) {
      const reset = new Date(date);
      reset.setHours(24, 0, 0, 0);
      throw apiError(`今日渲染次数已达上限（${dailyLimit} 次）`, 429, {
        pauseQueue: true, retryAfter: Math.max(1, Math.ceil((reset - date) / 1000))
      });
    }
    sessionUsed += 1;
    return STORAGE_WARNING;
  }

  async function storeCall(method, ...args) {
    try { return await (await getStore())[method](...args); }
    catch (error) {
      throw apiError("浏览器历史/图库操作失败，请检查存储权限或删除旧图片释放空间。", error.status || 503);
    }
  }

  async function list(method, ...args) {
    try { return await (await getStore())[method](...args); }
    catch { return { ok: true, enabled: false, entries: [], warning: STORAGE_WARNING }; }
  }

  async function render(payload, { signal } = {}) {
    const { apiKey, prompt, size, refs, model } = validatePayload(payload);
    signal?.throwIfAborted();
    const warning = await reserve();
    signal?.throwIfAborted();
    const lifetime = requestLifetime(signal, timeoutMs);
    let response;
    let resultBlob;
    let resultUrl;
    let imageDataUrl;
    try {
      try {
        response = await fetchImpl(ARK_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          credentials: "omit",
          redirect: "error",
          signal: lifetime.signal,
          body: JSON.stringify({
            model, prompt, size,
            image: refs.length === 1 ? refs[0] : refs,
            response_format: "url", stream: false, watermark: true
          })
        });
      } catch {
        throw apiError(`生成请求${lifetime.signal.aborted ? "已取消或超时" : "网络中断或受 CORS 限制"}。${POSSIBLY_BILLED}`, 0, { pauseQueue: true });
      }
      let result;
      try { result = await response.json(); }
      catch {
        const message = response.status === 401 ? "API Key 无效或已过期，请检查设置中的自有 Key。"
          : response.status === 429 ? "火山方舟请求限流或额度不足，请检查账户并稍后手动重试。"
          : `火山方舟响应无法解析为 JSON。${POSSIBLY_BILLED}`;
        throw apiError(message, response.status, {
          pauseQueue: true,
          ...(Number(response.headers.get("retry-after")) > 0 ? { retryAfter: Number(response.headers.get("retry-after")) } : {})
        });
      }
      if (!response.ok) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const message = response.status === 401 ? "API Key 无效或已过期，请检查设置中的自有 Key。"
          : response.status === 429 ? "火山方舟请求限流或额度不足，请检查账户并稍后手动重试。"
          : `火山方舟生成请求失败（${response.status}）。`;
        throw apiError(message + (response.status >= 500 ? POSSIBLY_BILLED : ""), response.status, {
          ...(response.status === 401 || response.status === 429 || response.status >= 500 ? { pauseQueue: true } : {}),
          ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {})
        });
      }
      const first = result?.data?.[0];
      if (result?.error || first?.error) {
        throw apiError("火山方舟明确返回生成失败，请检查图片、提示词与模型配置。", 502);
      }
      resultUrl = httpsUrl(first?.url);
      try {
        if (first?.b64_json) resultBlob = base64Blob(first.b64_json);
        else if (first?.url) {
          if (!resultUrl) throw new Error("结果地址不安全");
          const imageResponse = await fetchImpl(resultUrl, {
            credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: lifetime.signal
          });
          if (!imageResponse.ok) throw new Error("结果下载失败");
          const mime = (imageResponse.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
          if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new Error("结果不是支持的图片类型");
          const blob = await imageResponse.blob();
          if (!blob.size) throw new Error("结果为空");
          resultBlob = new Blob([blob], { type: mime });
        } else throw new Error("响应没有图片");
        imageDataUrl = await blobDataUrl(resultBlob);
      } catch {
        throw apiError(`生成结果无法读取（下载、CORS 或图片格式错误）。${POSSIBLY_BILLED}${resultUrl ? "可打开结果链接手动保存。" : ""}`, 502, {
          pauseQueue: true, ...(resultUrl ? { resultUrl } : {})
        });
      }
    } finally { lifetime.dispose(); }

    const data = { ok: true, imageDataUrl, size, model, keySource: "own", ...(warning ? { warning } : {}) };
    if (payload.saveHistory !== false) {
      try {
        const saved = await storeCall("saveHistory", {
          imageDataUrl, prompt, model, size, referenceCount: refs.length,
          ...(typeof payload.thumbnail === "string" ? { thumbnail: payload.thumbnail } : {}),
          username: "", keySource: "own"
        });
        if (saved?.ok === false || !saved?.id) throw new Error("历史未保存");
        data.historyId = saved.id;
      } catch {
        data.warning = [warning, "渲染已完成，但历史保存失败；请立即下载结果，或删除旧历史释放空间。"].filter(Boolean).join(" ");
      }
    }
    return data;
  }

  return {
    getAuth: async () => ({ ok: false }),
    logout: async () => ({ ok: true }),
    getStatus: async () => ({ ok: true, configured: false, model: DEFAULT_SEEDREAM_MODEL, models: SEEDREAM_MODELS }),
    render,
    listHistory: () => list("listHistory"),
    getHistoryImage: (id, kind = "result") => storeCall("getHistoryImage", id, kind),
    deleteHistory: (id) => storeCall("deleteHistory", id),
    saveComposite: (payload) => storeCall("saveHistory", {
      imageDataUrl: payload.imageDataUrl, prompt: payload.prompt, model: payload.model, size: payload.size,
      ...(typeof payload.thumbnail === "string" ? { thumbnail: payload.thumbnail } : {}),
      username: "", keySource: ""
    }),
    listRefs: (collection) => list("listRefs", collection),
    getRefImage: (collection, id, kind = "full") => storeCall("getRefImage", collection, id, kind),
    addRef: (collection, payload) => storeCall("addRef", collection, payload),
    deleteRef: (collection, id) => storeCall("deleteRef", collection, id)
  };
}

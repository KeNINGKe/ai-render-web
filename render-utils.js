export function computeRenderDimensions(naturalWidth, naturalHeight, maxLongEdge) {
  const edge = Number(maxLongEdge);
  if (!Number.isFinite(edge) || edge < 64) {
    throw new Error("输出长边设置无效");
  }
  if (!naturalWidth || !naturalHeight) {
    return { width: edge, height: edge };
  }

  const inputRatio = naturalWidth / naturalHeight;
  let width = inputRatio >= 1 ? edge : Math.round(edge * inputRatio);
  let height = inputRatio >= 1 ? Math.round(edge / inputRatio) : edge;
  width = Math.max(64, Math.floor(width / 8) * 8);
  height = Math.max(64, Math.floor(height / 8) * 8);
  return { width, height };
}

// Seedream 输出尺寸：按输入图宽高比算显式 "WxH"（长边对齐档位），解决在线平台的横向压缩。
// 宽高取 16 的倍数；返回 Seedream size 字段需要的字符串。
// Seedream 5.0 Pro 对输出面积有硬上限（约 462 万像素，即 2K 级），超出会报 400。
export const SEEDREAM_MAX_AREA = 4_624_220;
// Seedream 参考图也有像素上限（3600 万），超出会报 400；前端据此做最小化缩放。
export const SEEDREAM_MAX_IMAGE_PIXELS = 36_000_000;

export function computeSeedreamSize(naturalWidth, naturalHeight, longEdge) {
  const edge = Number(longEdge);
  if (!Number.isFinite(edge) || edge < 256) {
    throw new Error("输出长边设置无效");
  }
  if (!naturalWidth || !naturalHeight) {
    return `${edge}x${edge}`;
  }
  const ratio = naturalWidth / naturalHeight;
  let width;
  let height;
  if (ratio >= 1) {
    width = edge;
    height = Math.round(edge / ratio);
  } else {
    height = edge;
    width = Math.round(edge * ratio);
  }
  const round16 = (n) => Math.max(256, Math.round(n / 16) * 16);
  width = round16(width);
  height = round16(height);

  // 面积超限时等比缩到上限以内（保持宽高比，向下取 16 的倍数确保不超）
  if (width * height > SEEDREAM_MAX_AREA) {
    const scale = Math.sqrt(SEEDREAM_MAX_AREA / (width * height));
    const floor16 = (n) => Math.max(256, Math.floor(n / 16) * 16);
    width = floor16(width * scale);
    height = floor16(height * scale);
  }

  return `${width}x${height}`;
}

export function getExecutionError(entry) {
  const status = entry?.status;
  const messages = Array.isArray(status?.messages) ? status.messages : [];
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== "execution_error") continue;
    const detail = message[1] || {};
    return detail.exception_message
      || detail.exception_type
      || `节点 ${detail.node_type || detail.node_id || "未知"} 执行失败`;
  }
  if (status?.status_str === "error") return "ComfyUI 工作流执行失败";
  return "";
}

export function collectOutputImages(entry) {
  const images = [];
  for (const output of Object.values(entry?.outputs || {})) {
    for (const image of output.images || []) {
      if (image?.filename) images.push(image);
    }
  }
  return images;
}

export function formatComfyError(data, fallbackMessage) {
  const messages = [];
  if (data?.error?.message) messages.push(data.error.message);
  else if (typeof data?.error === "string") messages.push(data.error);
  if (data?.message) messages.push(data.message);

  for (const [nodeId, detail] of Object.entries(data?.node_errors || {})) {
    const nodeMessages = (detail?.errors || [])
      .map((error) => error?.message || error?.details)
      .filter(Boolean);
    const classType = detail?.class_type ? ` ${detail.class_type}` : "";
    if (nodeMessages.length) {
      messages.push(`节点 ${nodeId}${classType}：${nodeMessages.join("；")}`);
    }
  }

  return [...new Set(messages)].join("；") || fallbackMessage;
}

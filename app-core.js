import { computeSeedreamSize, SEEDREAM_MAX_IMAGE_PIXELS } from "./render-utils.js";
import { buildSeedreamRenderPrompt, buildInpaintPrompt } from "./seedream-prompts.js";
import { SEEDREAM_QUALITY_MODES } from "./preset-config.js";
import { SEEDREAM_MODELS, DEFAULT_SEEDREAM_MODEL } from "./seedream-models.js";
import { createMaskController } from "./mask-tools.js";

import { RUNTIME_CONFIG } from "./runtime-config.js";
import { createRendererApi } from "./renderer-api.js";
import { unlockStaticPage } from "./static-access.js";

const DIRECT_MODE = RUNTIME_CONFIG.mode === "direct";
if (DIRECT_MODE) {
  document.querySelector("#workspace").hidden = true;
  await unlockStaticPage(RUNTIME_CONFIG);
}
const api = await createRendererApi(RUNTIME_CONFIG);
const STORAGE_PREFIX = DIRECT_MODE ? "ai_render_web_" : "";
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_LONG_EDGE = SEEDREAM_QUALITY_MODES.standard.longEdge;

// 网页 API Key / 模型：只存本浏览器 localStorage，渲染时随请求发给本机后端；
// 不写入服务器，也不会上传到其他服务。留空则由后端回落 .env 的默认配置。
const LS_API_KEY = STORAGE_PREFIX + "seedream_api_key";
const LS_MODEL = STORAGE_PREFIX + "seedream_model";
const LS_CUSTOM_MODEL = STORAGE_PREFIX + "seedream_custom_model";
const LS_REMEMBER_KEY = STORAGE_PREFIX + "remember_key";
const LS_HISTORY_AUTOSAVE = STORAGE_PREFIX + "seedream_history_autosave";
const LS_MAIN_CLEARED = STORAGE_PREFIX + "main_image_cleared";

// 附加参考图上限：主图之外最多再传 3 张（材质样板 / 涂装 / 场景）
const MAX_EXTRA_REFS = 3;

const state = {
  imageFile: null,
  imageNaturalWidth: 0,
  imageNaturalHeight: 0,
  imageObjectUrl: "",
  longEdge: DEFAULT_LONG_EDGE,
  submitting: false,
  backendReady: false,
  // 登录态：页面能加载就说明已登录（未登录会被服务端 302 到 /login），
  // 这里只存身份用于徽标显示与角色感知文案；会话过期后任何接口 401 都会跳登录页。
  auth: { username: "", role: "" },
  resultDataUrl: "",
  // 对比视图：最近一次渲染用的参考图（仅存本会话内存，用于检查几何漂移）
  lastReferenceDataUrl: "",
  compareMode: "single",
  // 附加参考图（材质 / 涂装 / 场景气质）：{ id, file, objectUrl, dataUrl(处理后缓存) }
  extraRefs: [],
  // 多变体队列：入队时固化图片快照与参数，之后改提示词 / 换图不影响已入队项
  queue: [],
  queueRunning: false,
  // 渲染历史（落盘在本机 data/renders，可关）
  historyAutosave: readLs(LS_HISTORY_AUTOSAVE) !== "off",
  historyEntries: [],
  historyLoading: false,
  historyObjectUrl: "",
  // 局部重绘：蒙版模式状态（整图重绘走云端，蒙版外像素由前端合成回贴）
  inpaint: {
    active: false,
    running: false,
    baseDataUrl: "",
    baseWidth: 0,
    baseHeight: 0,
    controller: null,
    lastPrompt: "",
    // 底图显示倍率：1 = 适应窗口（与不缩放时一致），放大只改显示、不改蒙版数据
    zoom: 1
  }
};

const settings = {
  apiKey: !DIRECT_MODE || readLs(LS_REMEMBER_KEY) === "yes" ? readLs(LS_API_KEY) : "",
  model: readLs(LS_MODEL) || DEFAULT_SEEDREAM_MODEL,
  customModel: readLs(LS_CUSTOM_MODEL)
};

function readLs(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeLs(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可（每次刷新后回落 .env）
  }
}

function modelLabel(id) {
  const known = SEEDREAM_MODELS.find((m) => m.id === id);
  return known ? known.label : (id || "默认");
}

const $ = (selector) => document.querySelector(selector);
const historyThumbUrls = new Set();
const galleryThumbUrls = new Set();

function releaseImageUrls(urls) {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
}

async function setBlobImage(image, read, urls) {
  try {
    const blob = await read();
    if (!image.isConnected) return;
    const url = URL.createObjectURL(blob);
    urls.add(url);
    image.src = url;
  } catch {
    image.alt = "图片读取失败";
  }
}

function showRecoveryLink(resultUrl) {
  document.querySelectorAll(".result-recovery").forEach((link) => link.remove());
  try {
    const url = new URL(resultUrl);
    if (url.protocol !== "https:" || url.username || url.password) return;
    const link = document.createElement("a");
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "result-recovery";
    link.textContent = "打开已生成的图片并手动保存（链接可能过期）";
    $("#inputMessage").after(link);
  } catch { /* 无效结果地址不显示 */ }
}

function showRenderError(error) {
  showResultMessage(error.message, { error: true });
  if (error.resultUrl) showRecoveryLink(error.resultUrl);
}

function showModeInfo() {
  if (!DIRECT_MODE) return;
  $("#rememberKeyRow").hidden = false;
  $("#historyStorageLabel").textContent = "自动保存到当前浏览器";
  document.querySelector("#customModelInput + .settings-note").textContent = "填写兼容图生图接口的模型 ID 或推理接入点，覆盖下拉选择。";
  // 不显示用户徽标/退出按钮：解锁与未记住的 Key 都只活在当前页面，关页即退出
  $("#rememberKey").addEventListener("change", () => {
    if (!$("#rememberKey").checked) {
      writeLs(LS_API_KEY, "");
      writeLs(LS_REMEMBER_KEY, "");
    }
  });
  document.querySelector(".ref-gallery-title span").textContent = "点击调入为主图 · 当前浏览器保留 8 张";
  applyRoleToSettings();
}

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  releaseImageUrls(historyThumbUrls);
  releaseImageUrls(galleryThumbUrls);
});

function setStatus(ok, text) {
  $("#statusDot").classList.toggle("ok", ok);
  $("#statusDot").classList.toggle("warn", !ok);
  $("#statusText").textContent = text;
}

function setInputMessage(text) {
  const el = $("#inputMessage");
  el.hidden = !text;
  el.textContent = text || "";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

// 只在超过 Seedream 参考图像素上限（3600 万）时才等比缩小，正常图原样返回 null。
function downscaleToLimit(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (w * h <= SEEDREAM_MAX_IMAGE_PIXELS) return null;
  const scale = Math.sqrt((SEEDREAM_MAX_IMAGE_PIXELS * 0.98) / (w * h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(w * scale));
  canvas.height = Math.max(1, Math.floor(h * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.92);
}

// 当前参考图的 dataURL：超像素上限时用缩小版，否则读原文件。
async function currentReferenceDataUrl() {
  return downscaleToLimit($("#previewImage")) || await readFileAsDataUrl(state.imageFile);
}

// 历史列表用的小缩略图（最长边约 320px）。失败返回空串，不影响渲染本身。
async function makeThumbnail(dataUrl, maxEdge = 320) {
  try {
    const img = document.createElement("img");
    img.src = dataUrl;
    await img.decode();
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return "";
  }
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = document.createElement("img");
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片无法解码"));
    img.src = src;
  });
}

// 启动探测登录身份：401 兜底跳登录（正常情况下页面能加载就已是登录态）；
// 成功则显示用户徽标并按角色调整设置面板文案。
async function initAuth() {
  try {
    const data = await api.getAuth();
    if (data?.username) {
      state.auth = { username: data.username, role: data.role || "user" };
      $("#userName").textContent = state.auth.role === "admin"
        ? `${state.auth.username} · 管理员`
        : state.auth.username;
      $("#userBadge").hidden = false;
      applyRoleToSettings();
      checkBackend();
    }
  } catch {
    // 探测失败不打断页面（可能是单人本机模式，服务端未启用认证）
  }
}

function applyRoleToSettings() {
  if (DIRECT_MODE) {
    $("#settingsHint").textContent = "填写自己的火山方舟 API Key；默认仅当前页面使用";
    $("#apiKeyInput").placeholder = "必填自己的 API Key";
    return;
  }
  if (!state.auth.role) return;
  const hint = $("#settingsHint");
  const keyInput = $("#apiKeyInput");
  if (state.auth.role === "admin") {
    hint.textContent = "管理员：Key 留空则使用服务器共享配置（计入共享账单）";
    keyInput.placeholder = "可填自己的 Key 优先使用；留空用服务器共享 Key";
  } else {
    hint.textContent = "普通账号：渲染必须填写你自己的 API Key（不使用共享 Key）";
    keyInput.placeholder = "必填你自己的 API Key，留空无法渲染";
  }
}

async function logout() {
  try {
    await api.logout();
  } catch {
    // 即使请求失败也跳登录页
  }
  if (DIRECT_MODE) {
    settings.apiKey = "";
    $("#apiKeyInput").value = "";
    window.location.reload();
  }
}

// 服务端图库 / 历史取回的 blob 统一转 File：按 MIME 定扩展名。
function fileFromBlob(blob, name) {
  const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
  return new File([blob], `${name}.${ext}`, { type: blob.type || "image/jpeg" });
}

// 处理附加参考图：超 Seedream 像素上限时等比缩小，否则读原文件；结果缓存在条目上。
async function processedExtraRef(entry) {
  if (entry.dataUrl) return entry.dataUrl;
  const img = await loadImageElement(entry.objectUrl);
  entry.width = img.naturalWidth;
  entry.height = img.naturalHeight;
  entry.dataUrl = downscaleToLimit(img) || await readFileAsDataUrl(entry.file);
  return entry.dataUrl;
}

function updateRenderButton() {
  const button = $("#renderButton");
  const label = $("#renderLabel");
  if (state.submitting || state.queueRunning) {
    button.disabled = true;
    label.textContent = state.queueRunning ? "队列渲染中…" : "渲染中…";
  } else if (!state.imageFile) {
    button.disabled = true;
    label.textContent = "请先上传模型图";
  } else {
    button.disabled = false;
    label.textContent = "开始渲染";
  }
}

function updateTelemetry() {
  const el = $("#telemetry");
  if (!state.imageFile) {
    el.textContent = "上传模型图后，按原图比例自动计算输出尺寸";
    return;
  }
  const size = computeSeedreamSize(
    state.imageNaturalWidth,
    state.imageNaturalHeight,
    state.longEdge
  );
  el.textContent =
    `输入 ${state.imageNaturalWidth} × ${state.imageNaturalHeight}   →   输出 ${size}   ·   比例锁定`;
}

function showResult(dataUrl) {
  state.resultDataUrl = dataUrl;
  renderResultArea();
  $("#downloadButton").hidden = false;
  $("#useAsMainButton").hidden = false;
  // 有参考图快照才提供对比（历史条目没有原图，不启用）
  $("#compareBar").hidden = !state.lastReferenceDataUrl;
}

// 按当前对比模式重画结果区：单图 / 滑块 / 并排。
function renderResultArea() {
  const area = $("#resultArea");
  if (state.lastReferenceDataUrl && state.compareMode === "slider") {
    area.replaceChildren(buildCompareSlider());
    return;
  }
  if (state.lastReferenceDataUrl && state.compareMode === "side") {
    area.replaceChildren(buildCompareSide());
    return;
  }
  const img = document.createElement("img");
  img.className = "result-image";
  img.src = state.resultDataUrl;
  img.alt = "渲染结果";
  img.title = "点击查看大图";
  img.addEventListener("click", () => openLightbox(state.resultDataUrl));
  area.replaceChildren(img);
}

function setCompareMode(mode) {
  state.compareMode = mode;
  document.querySelectorAll("#compareBar button").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
  if (state.resultDataUrl && state.lastReferenceDataUrl) renderResultArea();
}

// 滑块对比：底层渲染结果，上层原图按百分比裁开，拖动分割线逐像素核对轮廓。
function buildCompareSlider() {
  const stage = document.createElement("div");
  stage.className = "compare-slider";

  const base = document.createElement("img");
  base.className = "compare-base";
  base.src = state.resultDataUrl;
  base.alt = "渲染结果";
  base.draggable = false;

  const overlayWrap = document.createElement("div");
  overlayWrap.className = "compare-overlay";
  const overlay = document.createElement("img");
  overlay.src = state.lastReferenceDataUrl;
  overlay.alt = "原始模型图";
  overlay.draggable = false;
  overlayWrap.append(overlay);

  const handle = document.createElement("div");
  handle.className = "compare-handle";
  const grip = document.createElement("span");
  grip.className = "compare-grip";
  grip.textContent = "⇔";
  handle.append(grip);

  const tagOriginal = document.createElement("span");
  tagOriginal.className = "compare-tag left";
  tagOriginal.textContent = "原图";
  const tagResult = document.createElement("span");
  tagResult.className = "compare-tag right";
  tagResult.textContent = "结果";

  stage.append(base, overlayWrap, handle, tagOriginal, tagResult);

  let percent = 50;
  const apply = () => {
    overlayWrap.style.width = `${percent}%`;
    handle.style.left = `${percent}%`;
    // 裁剪窗口里的原图要按舞台实际宽度铺回，才能与底层像素对齐
    overlay.style.width = `${stage.clientWidth}px`;
  };
  new ResizeObserver(apply).observe(stage);
  stage.addEventListener("pointerdown", (event) => {
    stage.setPointerCapture(event.pointerId);
    moveTo(event);
  });
  stage.addEventListener("pointermove", (event) => {
    if (stage.hasPointerCapture?.(event.pointerId)) moveTo(event);
  });

  function moveTo(event) {
    const rect = stage.getBoundingClientRect();
    percent = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
    apply();
  }
  return stage;
}

// 并排对比：左右两图同屏，各自可点开大图。
function buildCompareSide() {
  const wrap = document.createElement("div");
  wrap.className = "compare-side";
  wrap.append(
    compareFigure(state.lastReferenceDataUrl, "原始模型图"),
    compareFigure(state.resultDataUrl, "渲染结果")
  );
  return wrap;
}

function compareFigure(src, label) {
  const fig = document.createElement("figure");
  fig.className = "compare-figure";
  const img = document.createElement("img");
  img.src = src;
  img.alt = label;
  img.draggable = false;
  img.addEventListener("click", () => openLightbox(src));
  const caption = document.createElement("figcaption");
  caption.textContent = label;
  fig.append(img, caption);
  return fig;
}

function openLightbox(dataUrl) {
  $("#lightboxImage").src = dataUrl;
  $("#lightbox").classList.add("open");
}

function closeLightbox() {
  $("#lightbox").classList.remove("open");
  const src = $("#lightboxImage").src;
  $("#lightboxImage").src = "";
  if (src.startsWith("blob:")) {
    URL.revokeObjectURL(src);
    if (state.historyObjectUrl === src) state.historyObjectUrl = "";
  }
}

function downloadResult() {
  if (!state.resultDataUrl) return;
  const link = document.createElement("a");
  link.href = state.resultDataUrl;
  link.download = `energy-render-${Date.now()}.jpg`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// 结果区占位状态（初始与出错/加载中共用同一结构）。
function showEmptyResult() {
  const box = document.createElement("div");
  box.className = "empty-state";
  const glyph = document.createElement("span");
  glyph.className = "empty-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "◫";
  const title = document.createElement("p");
  title.textContent = "结果会显示在这里";
  const detail = document.createElement("span");
  detail.textContent = "上传模型图，写好提示词，点「开始渲染」；或直接对上传图做局部重绘。";
  box.append(glyph, title, detail);
  $("#resultArea").replaceChildren(box);
}

function showResultMessage(message, { error = false } = {}) {
  const box = document.createElement("div");
  box.className = `empty-state${error ? " empty-state-error" : ""}`;
  const title = document.createElement("p");
  title.textContent = error ? "出错了" : "正在渲染";
  const detail = document.createElement("span");
  detail.textContent = message;
  box.append(title, detail);
  $("#resultArea").replaceChildren(box);
  $("#downloadButton").hidden = true;
  $("#useAsMainButton").hidden = true;
}

async function checkBackend() {
  try {
    const data = await api.getStatus();
    // 服务端对普通账号强制 configured=false（即便 .env 有共享 Key），
    // 所以「就绪」判断对普通账号自动收窄为"必须自己填 Key"。
    const envConfigured = Boolean(data.configured);
    state.backendReady = Boolean(settings.apiKey) || envConfigured;
    let text;
    if (settings.apiKey) {
      text = `网页 Key · ${modelLabel(settings.customModel || settings.model)}`;
    } else if (envConfigured) {
      text = `共享 Key · ${modelLabel(data.model)}`;
    } else if (state.auth.role === "user") {
      text = "未配置 API Key（请在设置里填你自己的）";
    } else {
      text = "未配置 API Key";
    }
    setStatus(state.backendReady, text);
  } catch {
    state.backendReady = false;
    setStatus(false, DIRECT_MODE ? "服务状态读取失败" : "后端服务未启动");
  }
}

// Seedream 渲染请求的公共字段：网页设置的 key / 模型随请求发给本机后端，留空则回落 .env；
// 历史自动保存关闭时显式告知后端不落盘。单张渲染与局部重绘共用。
function buildSeedreamPayload({ prompt, size, referenceImages }) {
  return {
    prompt,
    size,
    referenceImages,
    model: settings.model,
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
    ...(settings.customModel ? { customModel: settings.customModel } : {}),
    ...(state.historyAutosave ? {} : { saveHistory: false })
  };
}

// 单次渲染的核心调用：网页单张与多变体队列共用同一实现。
// referenceImages[0] 是主图（几何权威），其后是附加材质 / 涂装参考。
async function renderOnce({
  referenceImages,
  naturalWidth,
  naturalHeight,
  userPrompt,
  avoidNotes,
  longEdge
}) {
  // 提示词统一走 prompt-builder：几何锁定 + 用户自由文本。
  // 产品档案（product-catalog）只服务于命令行脚本；网页保持无型号的极简流程，
  // 因为实际产品不限于目录内型号、尺寸不固定。
  const payload = buildSeedreamPayload({
    prompt: buildSeedreamRenderPrompt({ userNotes: userPrompt, avoidNotes }),
    size: computeSeedreamSize(naturalWidth, naturalHeight, longEdge),
    referenceImages
  });
  if (state.historyAutosave) {
    const thumbnail = await makeThumbnail(referenceImages[0]);
    if (thumbnail) payload.thumbnail = thumbnail;
  }
  document.querySelectorAll(".result-recovery").forEach((link) => link.remove());
  const data = await api.render(payload, { signal: AbortSignal.timeout(RENDER_TIMEOUT_MS) });
  if (data.warning) setInputMessage(data.warning);
  if (!data.imageDataUrl) throw new Error("渲染服务没有返回图片");
  return data;
}

// 当前生效的附加参考图快照（处理成可提交的 dataURL 列表）。
async function currentExtraRefDataUrls() {
  const urls = [];
  for (const entry of state.extraRefs) {
    urls.push(await processedExtraRef(entry));
  }
  return urls;
}

async function submitRender() {
  if (state.submitting || state.queueRunning) return;
  try {
    if (!state.imageFile) throw new Error("请先上传模型图");
    if (!state.backendReady) throw new Error("未配置 API Key：请点击右上角齿轮填写自己的 Key");
    state.submitting = true;
    updateRenderButton();
    $("#jobState").textContent = "渲染中";
    showResultMessage("单张约 90 秒，请稍候…");

    const referenceDataUrl = await currentReferenceDataUrl();
    const referenceImages = [referenceDataUrl, ...await currentExtraRefDataUrls()];
    const data = await renderOnce({
      referenceImages,
      naturalWidth: state.imageNaturalWidth,
      naturalHeight: state.imageNaturalHeight,
      userPrompt: $("#prompt").value.trim(),
      avoidNotes: $("#avoidPrompt").value.trim(),
      longEdge: state.longEdge
    });

    state.lastReferenceDataUrl = referenceDataUrl;
    setCompareMode("single");
    showResult(data.imageDataUrl);
    $("#jobState").textContent = "完成";
    refreshHistoryIfOpen();
  } catch (error) {
    $("#jobState").textContent = "出错";
    showRenderError(error);
  } finally {
    state.submitting = false;
    updateRenderButton();
    updateQueueButtons();
  }
}

// ---- 多变体队列：同一张模型图串行跑多组提示词 / 档位（一图多案）----

const MAX_QUEUE_ITEMS = 12;

async function addToQueue() {
  if (!state.imageFile || state.submitting || state.queueRunning || addToQueue.pending) return;
  if (state.queue.length >= MAX_QUEUE_ITEMS) {
    setInputMessage(`队列最多 ${MAX_QUEUE_ITEMS} 个变体`);
    return;
  }
  addToQueue.pending = true;
  try {
    // 入队即固化当前图片（含附加参考）与参数；之后换图、改词都不影响已入队项
    const mainDataUrl = await currentReferenceDataUrl();
    const referenceImages = [mainDataUrl, ...await currentExtraRefDataUrls()];
    state.queue.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      userPrompt: $("#prompt").value.trim(),
      avoidNotes: $("#avoidPrompt").value.trim(),
      longEdge: state.longEdge,
      mainDataUrl,
      referenceImages,
      naturalWidth: state.imageNaturalWidth,
      naturalHeight: state.imageNaturalHeight
    });
    setInputMessage("");
    updateQueueStrip();
  } catch {
    setInputMessage("读取图片失败，无法加入队列");
  } finally {
    addToQueue.pending = false;
  }
}

function updateQueueButtons() {
  const add = $("#queueAddButton");
  const run = $("#queueRunButton");
  const clear = $("#queueClearButton");
  const busy = state.submitting || state.queueRunning;
  add.disabled = !state.imageFile || busy || state.queue.length >= MAX_QUEUE_ITEMS;
  run.disabled = busy || state.queue.length === 0;
  clear.disabled = busy || state.queue.length === 0;
  run.textContent = `渲染队列（${state.queue.length}）`;
}

function updateQueueStrip() {
  const strip = $("#queueStrip");
  strip.hidden = state.queue.length === 0;
  const chips = state.queue.map((item, index) => {
    const chip = document.createElement("span");
    chip.className = "queue-chip";
    const num = document.createElement("b");
    num.textContent = `#${index + 1}`;
    const text = document.createElement("i");
    text.textContent = item.userPrompt ? item.userPrompt.slice(0, 24) : "默认提示词";
    text.title = item.userPrompt || "留空则使用默认几何锁定提示词";
    const edge = document.createElement("em");
    edge.textContent = `${item.longEdge}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `移除变体 ${index + 1}`);
    remove.addEventListener("click", () => {
      if (state.queueRunning) return;
      state.queue = state.queue.filter((q) => q.id !== item.id);
      updateQueueStrip();
    });
    chip.append(num, text, edge, remove);
    return chip;
  });
  $("#queueItems").replaceChildren(...chips);
  updateQueueButtons();
}

async function runQueue() {
  if (state.queueRunning || state.submitting || state.queue.length === 0) return;
  if (!state.backendReady) {
    setInputMessage("未配置 API Key：请点击右上角齿轮填写自己的 Key");
    return;
  }
  state.queueRunning = true;
  updateQueueStrip();
  updateRenderButton();

  const items = [...state.queue];
  const failures = [];
  const warnings = [];
  let lastResult = null;

  for (let done = 1; done <= items.length; done += 1) {
    const item = items[done - 1];
    $("#jobState").textContent = `队列 ${done}/${items.length}`;
    showResultMessage(`多变体队列渲染中：第 ${done}/${items.length} 张…`);
    updateRenderButton();
    try {
      const data = await renderOnce({
        referenceImages: item.referenceImages,
        naturalWidth: item.naturalWidth,
        naturalHeight: item.naturalHeight,
        userPrompt: item.userPrompt,
        avoidNotes: item.avoidNotes,
        longEdge: item.longEdge
      });
      lastResult = { dataUrl: data.imageDataUrl, reference: item.mainDataUrl };
      // 成功一个移一个；失败项保留在队列里便于补渲或删除
      state.queue = state.queue.filter((q) => q.id !== item.id);
      updateQueueStrip();
      if (DIRECT_MODE && data.warning) {
        warnings.push(`队列已暂停，请先下载当前结果。${data.warning}`);
        break;
      }
    } catch (error) {
      failures.push(`#${done} ${error.message}`);
      if (error.resultUrl) showRecoveryLink(error.resultUrl);
      if (DIRECT_MODE && error.pauseQueue) break;
    }
  }

  if (lastResult) {
    state.lastReferenceDataUrl = lastResult.reference;
    setCompareMode("single");
    showResult(lastResult.dataUrl);
  } else {
    showResultMessage(failures[0] || "队列渲染失败", { error: true });
  }
  state.queueRunning = false;
  updateQueueStrip();
  updateRenderButton();
  $("#jobState").textContent =
    failures.length === 0 ? "完成" : lastResult ? `完成 · ${failures.length} 张失败` : "出错";
  setInputMessage([failures.length ? `失败的变体：${failures.join("；")}` : "", ...warnings].filter(Boolean).join("；"));
  refreshHistoryIfOpen();
}

// ---- 渲染历史：本机 data/renders 落盘记录的回看 / 下载 / 复制提示词 / 删除 ----

function refreshHistoryIfOpen() {
  if (!$("#historyPanel").hidden) void loadHistory();
}

function showHistoryMessage(text, isError = false) {
  const el = $("#historyMessage");
  el.textContent = text || "";
  el.hidden = !text;
  el.classList.toggle("error", Boolean(isError));
}

async function loadHistory() {
  if (state.historyLoading) return;
  state.historyLoading = true;
  try {
    const data = await api.listHistory();
    state.historyEntries = data.entries || [];
    renderHistoryList();
    showHistoryMessage(data.warning || "");
  } catch (error) {
    showHistoryMessage(error.message, true);
  } finally {
    state.historyLoading = false;
  }
}

function formatHistoryTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderHistoryList() {
  $("#historyCount").textContent = state.historyEntries.length
    ? String(state.historyEntries.length)
    : "";
  const list = $("#historyList");
  releaseImageUrls(historyThumbUrls);
  if (state.historyEntries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "还没有历史。每次渲染成功后会自动保存到这里。";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...state.historyEntries.map(historyCard));
}

function historyCard(entry) {
  const card = document.createElement("div");
  card.className = "history-item";

  const thumb = document.createElement("img");
  thumb.className = "history-thumb";
  thumb.loading = "lazy";
  thumb.alt = "历史渲染缩略图";
  void setBlobImage(thumb, () => api.getHistoryImage(entry.id, entry.hasThumb ? "thumb" : "result"), historyThumbUrls);
  thumb.addEventListener("click", () => void viewHistoryEntry(entry));

  const meta = document.createElement("div");
  meta.className = "history-meta";

  const title = document.createElement("p");
  title.className = "history-title";
  title.textContent = `${formatHistoryTime(entry.createdAt)} · ${modelLabel(entry.model)} · ${entry.size}`;

  // 归属标注：渲染人 + Key 来源（认证上线前的旧记录两者皆空，不显示）。
  if (entry.username || entry.keySource) {
    const badge = document.createElement("span");
    badge.className = "history-owner";
    badge.textContent = [
      entry.username ? `渲染人 ${entry.username}` : "",
      entry.keySource === "shared" ? "共享 Key" : entry.keySource === "own" ? "自有 Key" : ""
    ].filter(Boolean).join(" · ");
    title.append(document.createElement("br"), badge);
  }

  const promptLine = document.createElement("p");
  promptLine.className = "history-prompt";
  promptLine.textContent = entry.prompt.length > 72 ? `${entry.prompt.slice(0, 72)}…` : entry.prompt;
  promptLine.title = entry.prompt;

  const actions = document.createElement("div");
  actions.className = "history-actions";
  [
    ["查看大图", () => void viewHistoryEntry(entry)],
    ["下载", () => void downloadHistoryEntry(entry)],
    ["复制提示词", (button) => void copyHistoryPrompt(entry, button)],
    ["删除", () => void removeHistoryEntry(entry)]
  ].forEach(([label, handler]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", (event) => handler(event.currentTarget));
    actions.append(button);
  });

  meta.append(title, promptLine, actions);
  card.append(thumb, meta);
  return card;
}

// 历史图片统一取成 blob URL 再用；同屏只保留最近一张，避免内存堆积。
async function fetchHistoryBlobUrl(id, kind) {
  const blob = await api.getHistoryImage(id, kind);
  if (state.historyObjectUrl && $("#lightboxImage").src !== state.historyObjectUrl) URL.revokeObjectURL(state.historyObjectUrl);
  state.historyObjectUrl = URL.createObjectURL(blob);
  return state.historyObjectUrl;
}

async function viewHistoryEntry(entry) {
  try {
    openLightbox(await fetchHistoryBlobUrl(entry.id, "result"));
  } catch (error) {
    showHistoryMessage(error.message, true);
  }
}

async function downloadHistoryEntry(entry) {
  try {
    const objectUrl = await fetchHistoryBlobUrl(entry.id, "result");
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `energy-render-${entry.id.replace(/\//g, "-")}.jpg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (error) {
    showHistoryMessage(error.message, true);
  }
}

// 剪贴板写入：navigator.clipboard 仅在 HTTPS / localhost 可用，同事经内网
// IP 的 HTTP 访问不是安全上下文，需降级到隐藏文本框 + execCommand。
function writeClipboard(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    helper.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    helper.remove();
    if (ok) resolve(); else reject(new Error("execCommand copy failed"));
  });
}

async function copyHistoryPrompt(entry, button) {
  try {
    await writeClipboard(entry.prompt);
    const original = button.textContent;
    button.textContent = "已复制";
    setTimeout(() => { button.textContent = original; }, 1500);
  } catch {
    showHistoryMessage("复制失败：浏览器未授权剪贴板，可从「查看大图」所在条目手动复制", true);
  }
}

async function removeHistoryEntry(entry) {
  if (!confirm(`删除这条渲染历史？\n${formatHistoryTime(entry.createdAt)} · ${entry.size}`)) return;
  try {
    await api.deleteHistory(entry.id);
    state.historyEntries = state.historyEntries.filter((e) => e.id !== entry.id);
    renderHistoryList();
  } catch (error) {
    showHistoryMessage(error.message, true);
  }
}

// ---- 附加参考图：主图之外的材质 / 涂装 / 场景参考（可选，最多 3 张）----

function renderExtraRefs() {
  const list = $("#extraRefsList");
  list.hidden = state.extraRefs.length === 0;
  $("#extraRefsClear").hidden = state.extraRefs.length === 0;
  // 加满后收起添加区，移除一张再回来
  $("#extraRefDropzone").hidden = state.extraRefs.length >= MAX_EXTRA_REFS;
  const items = state.extraRefs.map((entry) => {
    const wrap = document.createElement("div");
    wrap.className = "extra-ref-item";
    const img = document.createElement("img");
    img.src = entry.objectUrl;
    img.alt = "附加参考图";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "移除这张参考图");
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(entry.objectUrl);
      // 同步删服务端文件，刷新后才不会「复活」
      if (entry.serverId) void deleteExtraRefOnServer(entry.serverId);
      state.extraRefs = state.extraRefs.filter((e) => e.id !== entry.id);
      renderExtraRefs();
    });
    wrap.append(img, remove);
    return wrap;
  });
  list.replaceChildren(...items);
}

async function addExtraRefFiles(files) {
  for (const file of [...files]) {
    if (state.extraRefs.length >= MAX_EXTRA_REFS) {
      setInputMessage(`附加参考图最多 ${MAX_EXTRA_REFS} 张`);
      break;
    }
    if (!file.type.startsWith("image/")) {
      setInputMessage("附加参考仅支持 PNG、JPG 或 WebP 图片");
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setInputMessage("附加参考图不能超过 50 MB");
      continue;
    }
    try {
      const objectUrl = URL.createObjectURL(file);
      const img = await loadImageElement(objectUrl); // 先解码验证，坏图不进列表
      const entry = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        file,
        objectUrl,
        dataUrl: "",
        serverId: ""
      };
      state.extraRefs.push(entry);
      void saveExtraRefOnServer(entry, img.naturalWidth, img.naturalHeight);
      setInputMessage("");
    } catch {
      setInputMessage("有图片无法解码，已跳过");
    }
  }
  renderExtraRefs();
}

// 附加参考图落盘（best-effort）：上传成功记下 serverId，移除时才能同步删服务端文件，
// 刷新后由 restoreExtraRefs 回填。任何失败都静默——本次渲染不受影响，只是不跨会话。
async function saveExtraRefOnServer(entry, width, height) {
  try {
    const imageDataUrl = await readFileAsDataUrl(entry.file);
    const data = await api.addRef("extraRefs", { imageDataUrl, width, height });
    if (data?.ok) {
      if (state.extraRefs.includes(entry)) entry.serverId = data.id;
      else await api.deleteRef("extraRefs", data.id);
    }
  } catch (error) {
    if (DIRECT_MODE) setInputMessage(`参考图未保存：${error.message}`);
    // 静默：跨会话保留是附带能力
  }
}

async function deleteExtraRefOnServer(id) {
  try {
    await api.deleteRef("extraRefs", id);
  } catch {
    // 静默：删除失败只会在本机留下孤儿文件，存储上限会自然淘汰
  }
}

// 刷新后自动回填上次的附加参考图。服务端按 MRU 头插落盘，倒序取回即恢复添加顺序；
// 与主图恢复同一口径：best-effort，失败静默，不占任何上传入口。
async function restoreExtraRefs() {
  if (state.extraRefs.length > 0) return;
  let entries = [];
  try {
    const data = await api.listRefs("extraRefs");
    if (data.warning) setInputMessage(data.warning);
    if (data?.ok && data.enabled !== false && Array.isArray(data.entries)) {
      entries = data.entries;
    }
  } catch {
    return; // 服务未起 / 网络异常：参考图区保持空状态，不影响主流程
  }
  for (const saved of entries.slice().reverse().slice(0, MAX_EXTRA_REFS)) {
    try {
      const blob = await api.getRefImage("extraRefs", saved.id, "full");
      if (!blob.type.startsWith("image/")) continue;
      const file = fileFromBlob(blob, "上次参考图");
      const objectUrl = URL.createObjectURL(file);
      await loadImageElement(objectUrl); // 坏图不回填
      if (state.extraRefs.length >= MAX_EXTRA_REFS) {
        URL.revokeObjectURL(objectUrl);
        break;
      }
      state.extraRefs.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        file,
        objectUrl,
        dataUrl: "",
        serverId: saved.id
      });
    } catch {
      // 单张拉取失败跳过，不影响其余回填
    }
  }
  if (state.extraRefs.length > 0) renderExtraRefs();
}

function initExtraRefs() {
  // 与主上传区同一套交互：点击 / Enter·Space / 拖入，dragover 高亮
  const zone = $("#extraRefDropzone");
  const input = $("#extraRefsInput");

  zone.addEventListener("click", (event) => {
    if (event.target === input) return; // input.click() 冒泡回来自触发
    input.click();
  });

  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });

  ["dragenter", "dragover"].forEach((type) => {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((type) => {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.remove("dragover");
    });
  });

  zone.addEventListener("drop", (event) => {
    void addExtraRefFiles(event.dataTransfer?.files);
  });

  input.addEventListener("change", (event) => {
    void addExtraRefFiles(event.target.files);
    event.target.value = ""; // 清空以允许重复选择同一文件
  });

  $("#extraRefsClear").addEventListener("click", () => {
    state.extraRefs.forEach((entry) => {
      URL.revokeObjectURL(entry.objectUrl);
      if (entry.serverId) void deleteExtraRefOnServer(entry.serverId);
    });
    state.extraRefs = [];
    renderExtraRefs();
  });
}

// ---- 最近使用图库：主图自动入库（本机 data/ref-gallery），跨会话一键调回 ----

let galleryEntries = [];

async function loadGallery() {
  try {
    const data = await api.listRefs("gallery");
    if (data.warning) setInputMessage(data.warning);
    galleryEntries = data?.ok && data.enabled !== false && Array.isArray(data.entries)
      ? data.entries
      : [];
  } catch {
    galleryEntries = []; // 服务未起 / 网络异常：图库条静默隐藏，不影响任何主流程
  }
  renderGallery();
}

function renderGallery() {
  releaseImageUrls(galleryThumbUrls);
  $("#galleryStrip").hidden = galleryEntries.length === 0;
  $("#galleryList").replaceChildren(...galleryEntries.map((entry) => {
    const item = document.createElement("div");
    item.className = "ref-gallery-item";

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "ref-gallery-pick";
    pick.title = entry.width ? `调入为主图（${entry.width}×${entry.height}）` : "调入为主图";
    const img = document.createElement("img");
    void setBlobImage(img, () => api.getRefImage("gallery", entry.id, "thumb"), galleryThumbUrls);
    img.alt = "最近使用的模型图";
    img.loading = "lazy";
    pick.append(img);
    pick.addEventListener("click", () => void useGalleryImage(entry));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ref-gallery-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "从图库移除这张图");
    remove.addEventListener("click", () => void removeFromGallery(entry.id));

    item.append(pick, remove);
    return item;
  }));
}

// 图库调入：拉原图字节转 File，走 acceptFile 的既有校验与预览链路。
// 调入会再次触发入库，服务端按内容 hash 去重并刷新到队首，正好维持 MRU 顺序。
async function useGalleryImage(entry) {
  try {
    const blob = await api.getRefImage("gallery", entry.id, "full");
    if (!blob.type.startsWith("image/")) throw new Error("图库条目不是有效图片");
    acceptFile(fileFromBlob(blob, "图库调入"), "已从图库调入为主图");
  } catch (error) {
    setInputMessage(error.message);
  }
}

async function removeFromGallery(id) {
  try {
    await api.deleteRef("gallery", id);
  } catch {
    // 删除请求失败不弹提示，随后的列表刷新会反映真实状态
  }
  await loadGallery();
}

// 主图入库（best-effort）：上传 / 拖入 / 渲染结果设为主图都会走到这里。
// 任何失败（服务关闭、超 22MB、磁盘错误）都静默，绝不打断上传与渲染。
async function addMainImageToGallery(file) {
  try {
    const imageDataUrl = await readFileAsDataUrl(file);
    const thumbnail = await makeThumbnail(imageDataUrl);
    await api.addRef("gallery", {
      imageDataUrl,
      ...(thumbnail ? { thumbnail } : {}),
      width: state.imageNaturalWidth,
      height: state.imageNaturalHeight
    });
    await loadGallery();
  } catch (error) {
    if (DIRECT_MODE) setInputMessage(`图库未保存，当前图片仍可渲染：${error.message}`);
    // 图库失败不打断渲染
  }
}

// 刷新后自动恢复最近一张主图（图库队首即最近使用）：与渲染历史同口径，
// 工作区不因刷新清零。用户在恢复完成前已自行上传的话，让位不打扰；
// 刚点过「移除」的同样让位，避免清掉的图刷新后又回来（标记由下次上传解除）。
// 恢复走 acceptFile 会再次入库，服务端按内容 hash 去重，只刷新 MRU 顺序。
async function restoreLastMainImage() {
  if (state.imageFile || galleryEntries.length === 0) return;
  if (readLs(LS_MAIN_CLEARED)) return;
  const latest = galleryEntries[0];
  try {
    const blob = await api.getRefImage("gallery", latest.id, "full");
    if (!blob.type.startsWith("image/")) return;
    if (state.imageFile) return; // 双检：恢复期间用户可能已手动上传
    acceptFile(fileFromBlob(blob, "上次模型图"), "已自动恢复上次的模型图，可从图库条换用其他参考图");
  } catch {
    // 静默：恢复失败保持空上传区，不影响任何主流程
  }
}

// ---- 负面提示词（避免出现）：Seedream 无负向词通道，内容并入正向回避指令 ----

function initAvoid() {
  const toggle = $("#avoidToggle");
  const panel = $("#avoidPanel");

  toggle.addEventListener("click", () => {
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    toggle.setAttribute("aria-expanded", String(willOpen));
    toggle.classList.toggle("open", willOpen);
  });
}

// ---- 局部重绘：蒙版涂抹 → 整图云端重绘 → 前端合成回贴（mask 外像素不变）----

const INPAINT_FEATHER_RATIO = 0.004; // 蒙版边缘羽化比例，按短边百分比取 3~24px

function setInpaintState(text, isError = false) {
  const el = $("#inpaintState");
  el.textContent = text || "";
  el.classList.toggle("error", isError);
}

function updateInpaintButtons() {
  const busy = state.inpaint.running;
  $("#inpaintRunButton").disabled = busy || !state.inpaint.active;
  $("#inpaintExitButton").disabled = busy;
  $("#inpaintUndo").disabled = busy;
  $("#inpaintClear").disabled = busy;
}

// ---- 底图缩放：只改显示尺寸，蒙版画布坐标恒为原图像素（mask-tools 自行换算） ----

const INPAINT_ZOOM_STEP = 1.25;
const INPAINT_ZOOM_MAX = 4;

function setInpaintZoom(zoom) {
  state.inpaint.zoom = Math.min(INPAINT_ZOOM_MAX, Math.max(1, zoom));
  applyInpaintZoom();
}

function applyInpaintZoom() {
  const ctx = state.inpaint;
  if (!ctx.active || !ctx.baseWidth || !ctx.controller) return;
  const stage = $("#inpaintStage");
  const wrap = $("#inpaintWrap");
  // 适应比例：与旧版 CSS max-width/max-height 行为一致——只缩不放
  const availableWidth = Math.max(0, stage.clientWidth - 24);
  const availableHeight = Math.max(200, window.innerHeight * 0.52);
  const fit = Math.min(availableWidth / ctx.baseWidth, availableHeight / ctx.baseHeight, 1);
  const scale = fit * ctx.zoom;
  wrap.style.width = `${Math.max(1, Math.round(ctx.baseWidth * scale))}px`;
  wrap.style.height = `${Math.max(1, Math.round(ctx.baseHeight * scale))}px`;
  // 标签显示相对原图真实像素的百分比，点按复位回「适应」
  $("#inpaintZoomReset").textContent = ctx.zoom === 1 ? "适应" : `${Math.round(scale * 100)}%`;
  $("#inpaintZoomIn").disabled = ctx.zoom >= INPAINT_ZOOM_MAX;
  $("#inpaintZoomOut").disabled = ctx.zoom <= 1;
  ctx.controller.syncDisplay();
}

async function enterInpaint() {
  if (state.inpaint.running || state.inpaint.active) return;
  // 底图优先用最近一次渲染结果；还没有结果时，直接用当前上传的模型图
  let baseDataUrl = "";
  try {
    baseDataUrl = state.resultDataUrl || (state.imageFile ? await currentReferenceDataUrl() : "");
  } catch {
    baseDataUrl = "";
  }
  if (!baseDataUrl) {
    setInputMessage("请先上传模型图（或渲染出一张结果），再使用局部重绘");
    return;
  }

  const panel = $("#inpaintPanel");
  const img = $("#inpaintBaseImage");
  state.inpaint.active = true;
  state.inpaint.zoom = 1; // 每次进入重绘都回到适应窗口
  state.inpaint.baseDataUrl = baseDataUrl;
  panel.hidden = false;
  $("#resultArea").hidden = true;
  $("#compareBar").hidden = true;
  $("#downloadButton").hidden = true;
  $("#useAsMainButton").hidden = true;
  $("#inpaintButton").disabled = true;
  updateInpaintButtons();

  try {
    img.src = baseDataUrl;
    await new Promise((resolve, reject) => {
      if (img.complete && img.naturalWidth) return resolve();
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("底图无法解码"));
    });
    state.inpaint.baseWidth = img.naturalWidth;
    state.inpaint.baseHeight = img.naturalHeight;
    if (!state.inpaint.controller) {
      state.inpaint.controller = createMaskController({
        canvas: $("#inpaintCanvas"),
        preview: img,
        brushInput: $("#inpaintBrush")
      });
    }
    state.inpaint.controller.setSourceDimensions(img.naturalWidth, img.naturalHeight);
    applyInpaintZoom(); // 面板刚展开时 stage 才有宽度，这里做首次布局
    setInpaintState("");
  } catch (error) {
    setInpaintState(error.message, true);
    if (error.resultUrl) showRecoveryLink(error.resultUrl);
  }
}

function exitInpaint() {
  if (state.inpaint.running) return;
  state.inpaint.active = false;
  $("#inpaintPanel").hidden = true;
  $("#resultArea").hidden = false;
  if (state.resultDataUrl) renderResultArea();
  else showEmptyResult(); // 从上传图进入又退出、还没有任何结果时，恢复占位状态
  $("#compareBar").hidden = !state.lastReferenceDataUrl;
  $("#downloadButton").hidden = !state.resultDataUrl;
  $("#useAsMainButton").hidden = !state.resultDataUrl;
  $("#inpaintButton").disabled = false;
}

async function blobToImageElement(blob) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await loadImageElement(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl); // 已解码的位图不受 revoke 影响
  }
}

// 蒙版合成回贴：黑白蒙版亮度转 alpha 并羽化 → 新图层裁剪进蒙版 → 叠回底图。
// 未涂抹区域直接保留底图原始像素，这是「局部」重绘的硬承诺。
async function compositeInpaint(baseDataUrl, newDataUrl, maskBlob, width, height) {
  const [baseImg, newImg] = await Promise.all([
    loadImageElement(baseDataUrl),
    loadImageElement(newDataUrl)
  ]);

  const featherPx = Math.min(24, Math.max(3, Math.round(Math.min(width, height) * INPAINT_FEATHER_RATIO)));
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const mctx = maskCanvas.getContext("2d");
  mctx.filter = `blur(${featherPx}px)`;
  mctx.drawImage(await blobToImageElement(maskBlob), 0, 0, width, height);
  mctx.filter = "none";
  const maskData = mctx.getImageData(0, 0, width, height);
  const px = maskData.data;
  for (let i = 0; i < px.length; i += 4) {
    // 亮度即遮罩强度：白=完全重绘，黑=完全保留，灰阶=过渡带；
    // 同时兼容白笔刷黑底与白笔刷透明底两种蒙版来源
    const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) * (px[i + 3] / 255);
    px[i] = 255;
    px[i + 1] = 255;
    px[i + 2] = 255;
    px[i + 3] = Math.round(lum);
  }
  mctx.putImageData(maskData, 0, 0);

  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const lctx = layer.getContext("2d");
  lctx.drawImage(newImg, 0, 0, width, height);
  lctx.globalCompositeOperation = "destination-in";
  lctx.drawImage(maskCanvas, 0, 0);

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const octx = out.getContext("2d");
  octx.drawImage(baseImg, 0, 0, width, height);
  octx.drawImage(layer, 0, 0);
  return out.toDataURL("image/jpeg", 0.95);
}

async function runInpaint() {
  const ctx = state.inpaint;
  if (!ctx.active || ctx.running) return;
  try {
    if (!state.backendReady) throw new Error("未配置 API Key：请点击右上角齿轮填写自己的 Key");
    const maskBlob = await ctx.controller.getBlob();
    if (!maskBlob) throw new Error("请先在图上涂抹要重做的区域（或导入蒙版）");
    const instruction = $("#inpaintInstruction").value.trim();
    if (!instruction) throw new Error("请填写编辑指令：这块区域要改成什么");

    ctx.running = true;
    updateInpaintButtons();
    setInpaintState("正在整图重绘（约 90 秒），完成后自动回贴蒙版外像素…");

    const payload = buildSeedreamPayload({
      prompt: buildInpaintPrompt({ instruction }),
      size: computeSeedreamSize(ctx.baseWidth, ctx.baseHeight, Math.max(ctx.baseWidth, ctx.baseHeight)),
      referenceImages: [ctx.baseDataUrl]
    });
    if (state.historyAutosave) {
      const thumbnail = await makeThumbnail(ctx.baseDataUrl);
      if (thumbnail) payload.thumbnail = thumbnail;
    }
    document.querySelectorAll(".result-recovery").forEach((link) => link.remove());
    const data = await api.render(payload, { signal: AbortSignal.timeout(RENDER_TIMEOUT_MS) });
    if (data.warning) setInputMessage(data.warning);
    if (!data.imageDataUrl) throw new Error("渲染服务没有返回图片");

    setInpaintState("模型已返回，正在合成回贴蒙版外像素…");
    const composited = await compositeInpaint(
      ctx.baseDataUrl,
      data.imageDataUrl,
      maskBlob,
      ctx.baseWidth,
      ctx.baseHeight
    );

    // 合成结果同时成为新的主结果与新的底图：可继续涂抹迭代，也可返回下载
    ctx.lastPrompt = payload.prompt;
    state.resultDataUrl = composited;
    ctx.baseDataUrl = composited;
    $("#inpaintBaseImage").src = composited;
    await new Promise((resolve) => {
      const img = $("#inpaintBaseImage");
      if (img.complete && img.naturalWidth) return resolve();
      img.onload = () => resolve();
    });
    ctx.controller.setSourceDimensions(ctx.baseWidth, ctx.baseHeight); // 尺寸不变，仅清空笔画
    applyInpaintZoom();
    $("#inpaintSaveButton").hidden = false;
    refreshHistoryIfOpen();
    setInpaintState("完成：蒙版外像素已回贴。可继续涂抹迭代，或将合成结果存入历史。");
  } catch (error) {
    setInpaintState(error.message, true);
    if (error.resultUrl) showRecoveryLink(error.resultUrl);
  } finally {
    ctx.running = false;
    updateInpaintButtons();
  }
}

async function saveInpaintComposite() {
  const ctx = state.inpaint;
  if (!ctx.active || !state.resultDataUrl) return;
  try {
    setInpaintState("正在保存合成结果…");
    const thumbnail = await makeThumbnail(state.resultDataUrl);
    const data = await api.saveComposite({
      imageDataUrl: state.resultDataUrl,
      prompt: ctx.lastPrompt
        ? `${ctx.lastPrompt} [前端蒙版合成：未涂区域为上一版原图像素]`
        : "",
      model: settings.customModel || settings.model,
      size: `${ctx.baseWidth}x${ctx.baseHeight}`,
      ...(thumbnail ? { thumbnail } : {})
    });
    if (!data?.ok) throw new Error(data?.message || "保存失败");
    setInpaintState(`已存入历史：${data.id}`);
    refreshHistoryIfOpen();
  } catch (error) {
    setInpaintState(error.message, true);
  }
}

// CMF 预设（cmf-presets.js）不再进网页 UI：用户拍板移除全部预设提示词 chips，
// 换装指令直接手写进编辑指令框。预设库本身保留，供 CLI / 未来本地路线使用。
function initInpaint() {
  $("#inpaintButton").addEventListener("click", () => void enterInpaint());
  $("#inpaintExitButton").addEventListener("click", exitInpaint);
  $("#inpaintUndo").addEventListener("click", () => state.inpaint.controller?.undo());
  $("#inpaintClear").addEventListener("click", () => state.inpaint.controller?.reset());

  // 底图缩放：按钮步进；Ctrl + 滚轮在舞台上直接缩放（普通滚轮保留原生滚动）
  $("#inpaintZoomIn").addEventListener("click", () => setInpaintZoom(state.inpaint.zoom * INPAINT_ZOOM_STEP));
  $("#inpaintZoomOut").addEventListener("click", () => setInpaintZoom(state.inpaint.zoom / INPAINT_ZOOM_STEP));
  $("#inpaintZoomReset").addEventListener("click", () => setInpaintZoom(1));
  $("#inpaintStage").addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey || !state.inpaint.active) return;
      event.preventDefault();
      const direction = event.deltaY < 0 ? INPAINT_ZOOM_STEP : 1 / INPAINT_ZOOM_STEP;
      setInpaintZoom(state.inpaint.zoom * direction);
    },
    { passive: false }
  );
  window.addEventListener("resize", applyInpaintZoom);
  $("#inpaintImport").addEventListener("click", () => $("#inpaintImportInput").click());

  $("#inpaintImportInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !state.inpaint.controller) return;
    try {
      await state.inpaint.controller.loadFile(file, state.inpaint.baseWidth, state.inpaint.baseHeight);
      setInpaintState("");
    } catch (error) {
      setInpaintState(error.message, true);
    }
  });

  $("#inpaintRunButton").addEventListener("click", () => void runInpaint());
  $("#inpaintSaveButton").addEventListener("click", () => void saveInpaintComposite());
}

function initHistory() {
  const panel = $("#historyPanel");
  const toggle = $("#historyToggle");

  toggle.addEventListener("click", () => {
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    toggle.setAttribute("aria-expanded", String(willOpen));
    toggle.classList.toggle("open", willOpen);
    // 首次展开时才拉取，避免每次进页面都读磁盘
    if (willOpen && state.historyEntries.length === 0) void loadHistory();
  });

  $("#historyRefresh").addEventListener("click", () => void loadHistory());

  const autosave = $("#historyAutosave");
  autosave.checked = state.historyAutosave;
  autosave.addEventListener("change", () => {
    state.historyAutosave = autosave.checked;
    writeLs(LS_HISTORY_AUTOSAVE, autosave.checked ? "on" : "off");
  });
}

function initCompare() {
  document.querySelectorAll("#compareBar button").forEach((button) => {
    button.addEventListener("click", () => setCompareMode(button.dataset.mode));
  });
}

function acceptFile(file, notice = "") {
  if (!file) return false;
  if (!file.type.startsWith("image/")) {
    setInputMessage("请选择 PNG、JPG 或 WebP 图片");
    return false;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    setInputMessage("图片不能超过 50 MB");
    return false;
  }

  setInputMessage("");
  state.imageFile = null;
  state.imageNaturalWidth = 0;
  state.imageNaturalHeight = 0;
  updateRenderButton();

  if (state.imageObjectUrl) URL.revokeObjectURL(state.imageObjectUrl);
  state.imageObjectUrl = URL.createObjectURL(file);
  const preview = $("#previewImage");

  preview.onload = () => {
    state.imageFile = file;
    state.imageNaturalWidth = preview.naturalWidth;
    state.imageNaturalHeight = preview.naturalHeight;
    preview.hidden = false;
    $("#dropzoneEmpty").hidden = true;
    $("#dropzoneActions").hidden = false;
    writeLs(LS_MAIN_CLEARED, ""); // 新上传即解除「手动清空」标记，刷新恢复恢复正常
    setInputMessage(notice);
    updateRenderButton();
    updateTelemetry();
    // 主图变更即入库（去重维持 MRU）：图库坏不影响上传，这里不 await
    void addMainImageToGallery(file);
  };

  preview.onerror = () => {
    state.imageFile = null;
    preview.hidden = true;
    $("#dropzoneEmpty").hidden = false;
    $("#dropzoneActions").hidden = true;
    setInputMessage("图片无法解码，请改用有效的 PNG、JPG 或 WebP 文件");
    updateRenderButton();
    updateTelemetry();
  };

  preview.src = state.imageObjectUrl;
  return true;
}

// 移除当前主图：上传区回到空态，并记「手动清空」标记——刷新恢复据此让路，
// 图库队首不再被塞回来，下次上传自动解除。只清工作区，图库条目不受影响。
function clearMainImage() {
  if (state.imageObjectUrl) {
    URL.revokeObjectURL(state.imageObjectUrl);
    state.imageObjectUrl = "";
  }
  state.imageFile = null;
  state.imageNaturalWidth = 0;
  state.imageNaturalHeight = 0;
  const preview = $("#previewImage");
  preview.removeAttribute("src");
  preview.hidden = true;
  $("#dropzoneEmpty").hidden = false;
  $("#dropzoneActions").hidden = true;
  writeLs(LS_MAIN_CLEARED, "1");
  setInputMessage("已移除模型图；可重新上传，或从「最近使用」点选调入");
  updateRenderButton();
  updateTelemetry();
}

// R1 迭代闭环：当前渲染结果一键送回输入区当新主图（换场景 / 换光照再渲），
// 与局部重绘互补，形成「渲染 → 微调 → 再渲染」。提示词与附加参考图保留不动。
async function useResultAsMainImage() {
  if (!state.resultDataUrl || state.submitting || state.queueRunning || state.inpaint.active) return;
  try {
    const blob = await (await fetch(state.resultDataUrl)).blob();
    const applied = acceptFile(fileFromBlob(blob, "渲染结果"), "已将渲染结果设为主图，可调整提示词后再次渲染");
    if (applied) window.scrollTo({ top: 0, behavior: "smooth" });
  } catch {
    setInputMessage("设为主图失败，请下载图片后手动重新上传");
  }
}

function bindDropzone() {
  const dropzone = $("#dropzone");
  const input = $("#imageInput");

  dropzone.addEventListener("click", (event) => {
    if (event.target === input) return;
    input.click();
  });

  dropzone.addEventListener("keydown", (event) => {
    if (event.target !== dropzone) return; // 焦点在更换/移除按钮上时交给按钮原生行为
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });

  // 图片在框内时的常驻操作条：阻断冒泡，不让点击落到「整框点击选择」上
  $("#dropzoneActions").addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target.id === "replaceImage") input.click();
    if (event.target.id === "removeImage") clearMainImage();
  });

  ["dragenter", "dragover"].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });

  dropzone.addEventListener("drop", (event) => {
    acceptFile(event.dataTransfer?.files?.[0]);
  });

  input.addEventListener("change", (event) => {
    acceptFile(event.target.files?.[0]);
  });
}

function fillSettingsForm() {
  $("#apiKeyInput").value = settings.apiKey;
  $("#customModelInput").value = settings.customModel;
  $("#rememberKey").checked = DIRECT_MODE && readLs(LS_REMEMBER_KEY) === "yes";
  if (SEEDREAM_MODELS.some((m) => m.id === settings.model)) {
    $("#modelSelect").value = settings.model;
  }
}

function setSettingsMessage(text, { error = false } = {}) {
  const el = $("#settingsMessage");
  el.textContent = text || "";
  el.classList.toggle("error", Boolean(error));
}

function saveSettings() {
  const apiKey = $("#apiKeyInput").value.trim();
  const customModel = $("#customModelInput").value.trim();
  const model = $("#modelSelect").value || "";

  settings.apiKey = apiKey;
  settings.customModel = customModel;
  settings.model = customModel ? "" : model;

  const remember = !DIRECT_MODE || $("#rememberKey").checked;
  writeLs(LS_API_KEY, remember ? apiKey : "");
  if (DIRECT_MODE) writeLs(LS_REMEMBER_KEY, remember ? "yes" : "");
  writeLs(LS_CUSTOM_MODEL, customModel);
  writeLs(LS_MODEL, settings.model);

  if (DIRECT_MODE) {
    setSettingsMessage(apiKey ? (remember ? "已记住 Key，可用清除按钮移除" : "Key 仅本次页面使用，刷新后需重新填写") : "渲染前请填写自己的 Key");
    void checkBackend();
    return;
  }
  setSettingsMessage(customModel
    ? "已保存：使用自定义模型 ID"
    : apiKey
      ? "已保存到本浏览器，渲染将用此 Key"
      : state.auth.role === "user"
        ? "已保存：普通账号渲染前必须填自己的 Key"
        : "已保存：回落到项目 .env 默认配置");
  checkBackend();
}

function clearSettings() {
  settings.apiKey = "";
  settings.customModel = "";
  settings.model = DEFAULT_SEEDREAM_MODEL;
  [LS_API_KEY, LS_CUSTOM_MODEL, LS_MODEL, LS_REMEMBER_KEY].forEach((key) => writeLs(key, ""));
  fillSettingsForm();
  setSettingsMessage(DIRECT_MODE ? "已清除 Key，渲染前请重新填写" : state.auth.role === "user"
    ? "已清除：普通账号渲染前必须再填自己的 Key"
    : "已清除，回落到项目 .env 默认配置");
  checkBackend();
}

function initSettings() {
  const panel = $("#settingsPanel");
  const button = $("#settingsButton");

  // 模型下拉由 SEEDREAM_MODELS 渲染（与服务端 status 同源）。
  const options = SEEDREAM_MODELS.map((m) => {
    const option = document.createElement("option");
    option.value = m.id;
    option.textContent = `${m.label} · ${m.note}`;
    return option;
  });
  $("#modelSelect").replaceChildren(...options);

  button.addEventListener("click", () => {
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    button.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) {
      fillSettingsForm();
      applyRoleToSettings();
    }
  });

  $("#keyToggle").addEventListener("click", () => {
    const input = $("#apiKeyInput");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("#keyToggle").textContent = show ? "隐藏" : "显示";
    $("#keyToggle").setAttribute("aria-pressed", String(show));
  });

  $("#saveSettings").addEventListener("click", saveSettings);
  $("#clearSettings").addEventListener("click", clearSettings);
}

function initQuality() {
  const wrap = $("#quality");
  const buttons = Object.values(SEEDREAM_QUALITY_MODES).map((mode) => {
    const button = document.createElement("button");
    button.type = "button";
    // 档位按钮直接标注输出长边像素：信息本身就是工业规格
    button.innerHTML = `${mode.label} <em>${mode.longEdge}</em>`;
    button.dataset.edge = String(mode.longEdge);
    button.setAttribute("role", "radio");
    if (mode.longEdge === DEFAULT_LONG_EDGE) {
      button.classList.add("active");
      button.setAttribute("aria-checked", "true");
    } else {
      button.setAttribute("aria-checked", "false");
    }
    return button;
  });
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      state.longEdge = Number(button.dataset.edge);
      buttons.forEach((b) => {
        b.classList.toggle("active", b === button);
        b.setAttribute("aria-checked", b === button ? "true" : "false");
      });
      updateTelemetry();
    });
  });
  wrap.replaceChildren(...buttons);
}

showModeInfo();
bindDropzone();
initSettings();
initQuality();
initExtraRefs();
initAvoid();
initInpaint();
initHistory();
initCompare();
if (!DIRECT_MODE) void initAuth(); // 登录探测：拿身份显示徽标 + 角色感知文案；未登录兜底跳登录页
$("#logoutButton").addEventListener("click", () => void logout());
// 启动恢复：主图取图库队首（须先 loadGallery 拿到列表），附加参考图并行恢复
void (async () => {
  await loadGallery();
  const extraRefsRestored = restoreExtraRefs();
  await restoreLastMainImage();
  await extraRefsRestored;
})();
$("#renderButton").addEventListener("click", submitRender);
$("#queueAddButton").addEventListener("click", () => void addToQueue());
$("#queueRunButton").addEventListener("click", () => void runQueue());
$("#queueClearButton").addEventListener("click", () => {
  if (state.queueRunning) return;
  state.queue = [];
  updateQueueStrip();
});
$("#downloadButton").addEventListener("click", downloadResult);
$("#useAsMainButton").addEventListener("click", () => void useResultAsMainImage());
$("#lightbox").addEventListener("click", closeLightbox);
$("#lightboxImage").addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeLightbox();
});
updateRenderButton();
updateQueueButtons();
updateTelemetry();
await checkBackend();

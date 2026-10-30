// 浏览器直连模式的本地持久化：渲染历史、主图库/附加参考图、每日渲染计数。
// 图片一律以 Blob 存进 IndexedDB（不进 localStorage、不落 Key——本模块不接收
// 也不保存任何 API Key）；列表只投影元数据字段，Blob 单独放在 *Blobs store，
// 避免列表读取时把图片字节一起拖出来。
//
// 事务纪律（对齐 plan 第 4 节）：
// - data URL 解码与 SHA-256 摘要在打开事务之前完成，事务里只做同步读写，
//   避免异步等待期间事务自动提交；
// - 历史保存 = meta + Blob 同一事务；图库去重刷新/新增/淘汰/删除也在同一
//   readwrite 事务内提交，多标签页并发不产生半条记录或孤儿 Blob；
// - 所有写操作 await 事务 commit 后才报告成功。
//
// 淘汰策略：历史只取最新 60 条展示，但从不删除旧历史；图库每库最多 8 条，
// 同字节（SHA-256）去重后仅做 MRU 刷新，超限淘汰最旧并连带删 Blob。
// 每日计数单独放 counters store，按本地日历日分桶，跨标签页靠 IndexedDB
// readwrite 事务串行化保证原子。
//
// 错误契约：方法只在成功时 resolve 约定信封；其余一律 reject，错误带
// reason + status 供适配层精确提示——
//   store-disabled 503（IndexedDB 不可用，适配层回落会话计数/警告）
//   invalid-image 400 / invalid-id 400（校验失败，不入库）
//   not-found 404（get* 目标不存在，避免上层 createObjectURL(null)）
//   quota（QuotaExceededError）/ duplicate（ConstraintError）/ blocked /
//   closed / aborted / open-failed（存储层故障，cause 挂原始 DOMException）
// 例外：delete* 对不存在的 id 幂等返回 { ok:true, removed:false }。

const DB_VERSION = 1;
const REF_COLLECTIONS = ["gallery", "extraRefs"];
const DEFAULT_HISTORY_DISPLAY_LIMIT = 60;
const DEFAULT_REF_MAX_ENTRIES = 8;
const DEFAULT_ATTEMPT_LIMIT = 50;
const ATTEMPTS_KEY = "attempts";

// data URL 大小上限，与 render-history.js 落盘口径一致。
const THUMB_MAX_CHARS = 300_000;
const FULL_IMAGE_MAX_CHARS = 30_000_000;

function refMetaStore(collection) {
  return `refs:${collection}`;
}

function refBlobsStore(collection) {
  return `refsBlobs:${collection}`;
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// 校验并解码 data URL 图片，返回 { contentType, bytes }；null 表示格式不合法
// 或超出大小上限。浏览器与 Node 18+ 都有 atob / Blob，无需任何 import。
function decodeDataUrlImage(dataUrl, maxChars) {
  if (typeof dataUrl !== "string" || dataUrl.length === 0 || dataUrl.length > maxChars) return null;
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) return null;
  const contentType = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  let binary;
  try {
    binary = atob(match[2].replace(/[\r\n]/g, ""));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (!bytes.length) return null;
  return { contentType, bytes };
}

function projectHistory(value) {
  return {
    id: String(value.id),
    createdAt: String(value.createdAt || ""),
    model: String(value.model || ""),
    prompt: String(value.prompt || ""),
    size: String(value.size || ""),
    referenceCount: Number(value.referenceCount) || 1,
    hasThumb: Boolean(value.hasThumb),
    username: String(value.username || ""),
    keySource: ["shared", "own"].includes(value.keySource) ? value.keySource : ""
  };
}

function projectRef(value) {
  return {
    id: String(value.id),
    width: Number(value.width) || 0,
    height: Number(value.height) || 0,
    addedAt: String(value.addedAt || ""),
    hasThumb: Boolean(value.hasThumb)
  };
}

// 存储层错误统一带 reason 标签（quota/duplicate/closed/blocked/aborted/open-failed），
// 原始 DOMException 挂在 cause 上、名字记进 originalName，调用方能精确提示。
function tagError(original, reason, message) {
  const name = original?.name || "";
  const tagged = new Error(message || `IndexedDB 操作失败（${reason}）。`, { cause: original || undefined });
  tagged.reason = name === "QuotaExceededError" ? "quota"
    : name === "ConstraintError" ? "duplicate"
    : name === "InvalidStateError" ? "closed"
    : reason;
  if (name) tagged.originalName = name;
  return tagged;
}

export function createBrowserRenderStore(options = {}) {
  // 显式传 indexedDB: null/undefined 表示强制禁用；未传才回落全局（浏览器有、纯 Node 无）。
  const indexedDB = Object.prototype.hasOwnProperty.call(options, "indexedDB")
    ? options.indexedDB
    : globalThis.indexedDB;
  const cryptoObj = Object.prototype.hasOwnProperty.call(options, "crypto")
    ? options.crypto
    : globalThis.crypto;
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();
  const dbName = typeof options.dbName === "string" && options.dbName ? options.dbName : "industrial-ai-renderer";
  const dbVersion = Number.isInteger(options.dbVersion) && options.dbVersion >= 1 ? options.dbVersion : DB_VERSION;
  const historyDisplayLimit = Number.isInteger(options.historyDisplayLimit) && options.historyDisplayLimit > 0
    ? options.historyDisplayLimit
    : DEFAULT_HISTORY_DISPLAY_LIMIT;
  const refMaxEntries = Number.isInteger(options.refMaxEntries) && options.refMaxEntries > 0
    ? options.refMaxEntries
    : DEFAULT_REF_MAX_ENTRIES;
  const defaultAttemptLimit = Number.isInteger(options.defaultAttemptLimit) && options.defaultAttemptLimit > 0
    ? options.defaultAttemptLimit
    : DEFAULT_ATTEMPT_LIMIT;

  const enabled = Boolean(indexedDB && typeof indexedDB.open === "function");

  let database = null;
  let openPromise = null;
  let openVersion = dbVersion; // versionchange 升级后抬高，重开不再低于现有版本

  // ID：优先 crypto.randomUUID，缺了用 getRandomValues 拼 UUIDv4，再缺了退到
  // 时间戳+随机串。键只会以主键形式存取，不参与范围查询，格式宽松无妨。
  function randomId() {
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
      try {
        return cryptoObj.randomUUID();
      } catch {
        // 某些环境的 randomUUID 依赖非安全上下文，失败则走下面的兜底。
      }
    }
    if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
      const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  async function sha256Hex(bytes) {
    const subtle = cryptoObj?.subtle;
    if (!subtle || typeof subtle.digest !== "function") {
      throw new Error("crypto.subtle 不可用，无法计算图片指纹。");
    }
    const digestBuffer = await subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digestBuffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function assertCollection(collection) {
    if (!REF_COLLECTIONS.includes(collection)) {
      throw new TypeError(`collection 仅支持 ${REF_COLLECTIONS.join(" / ")}，收到：${String(collection)}`);
    }
  }

  function disabledError() {
    return Object.assign(
      new Error("IndexedDB 不可用，浏览器本地存储被禁用或环境不支持。"),
      { reason: "store-disabled", status: 503 }
    );
  }

  function invalidImageError() {
    return Object.assign(
      new Error("图片 data URL 非法、为空或超出大小上限。"),
      { reason: "invalid-image", status: 400 }
    );
  }

  function notFoundError(message) {
    return Object.assign(new Error(message), { reason: "not-found", status: 404 });
  }

  function createSchema(db) {
    if (!db.objectStoreNames.contains("history")) {
      const store = db.createObjectStore("history", { keyPath: "id" });
      store.createIndex("order", ["createdAt", "id"]);
    }
    if (!db.objectStoreNames.contains("historyBlobs")) {
      db.createObjectStore("historyBlobs", { keyPath: "id" });
    }
    for (const collection of REF_COLLECTIONS) {
      if (!db.objectStoreNames.contains(refMetaStore(collection))) {
        const store = db.createObjectStore(refMetaStore(collection), { keyPath: "id" });
        store.createIndex("order", ["addedAt", "id"]);
        // 唯一 hash 索引是并发去重的兜底：两个标签页同字节同时入库，
        // 后提交的 put 直接撞 ConstraintError、整事务回滚后走 MRU 重试。
        store.createIndex("hash", "hash", { unique: true });
      }
      if (!db.objectStoreNames.contains(refBlobsStore(collection))) {
        db.createObjectStore(refBlobsStore(collection), { keyPath: "id" });
      }
    }
    if (!db.objectStoreNames.contains("counters")) {
      db.createObjectStore("counters"); // 计数用线外键（"attempts"），值 { date, count }
    }
  }

  function openDbAttempt() {
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = openVersion === undefined ? indexedDB.open(dbName) : indexedDB.open(dbName, openVersion);
      } catch (error) {
        reject(tagError(error, "open-failed", "IndexedDB 打开失败（可能在隐私模式或存储被禁用）。"));
        return;
      }
      let abandoned = false;
      request.onupgradeneeded = () => {
        try {
          createSchema(request.result);
        } catch (error) {
          try { request.transaction?.abort(); } catch {}
          reject(tagError(error, "open-failed", "IndexedDB 建库失败。"));
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (abandoned) {
          // blocked 时已放弃这次打开；升级最终完成也不能留着旧连接挡道。
          try { db.close(); } catch {}
          return;
        }
        // 本连接主动让路版本升级：记下新版本并丢弃缓存，下次操作按新版本重开，
        // 避免自己 blocked 别人、也避免拿着旧版本号重开撞 VersionError。
        db.onversionchange = (event) => {
          try { db.close(); } catch {}
          if (event?.newVersion) openVersion = event.newVersion;
          if (database === db) {
            database = null;
            openPromise = null;
          }
        };
        database = db;
        resolve(db);
      };
      request.onerror = () => {
        reject(tagError(request.error, "open-failed", "IndexedDB 打开失败，请检查浏览器存储权限。"));
      };
      request.onblocked = () => {
        abandoned = true;
        reject(tagError(null, "blocked", "IndexedDB 升级被其他打开的本站页面阻塞，请关闭其他标签页后重试。"));
      };
    });
  }

  function openDb() {
    if (database) return Promise.resolve(database);
    if (!enabled) return Promise.reject(tagError(null, "store-disabled", "IndexedDB 不可用。"));
    if (openPromise) return openPromise;
    const promise = openDbAttempt().catch((error) => {
      // 库已被其他页面升到更高版本：不带版本号按现有版本重开一次（仅库已存在时发生）。
      if (error?.originalName === "VersionError") {
        openVersion = undefined;
        return openDbAttempt();
      }
      throw error;
    });
    // 打开失败不缓存：下次调用自动重试（例如另一标签页关闭后 blocked 恢复）。
    promise.catch(() => {
      if (openPromise === promise) openPromise = null;
    });
    openPromise = promise;
    return promise;
  }

  // execute(tx, fail) 同步发起所有请求；返回值若是函数，则在 tx.oncomplete 时
  // 调用并作为最终结果（请求回调里才能确定取值）。fail(error) + tx.abort() 用
  // 来在业务判断（如配额超限）时以指定错误中止事务。
  function runTransaction(storeNames, mode, execute) {
    const attempt = () => openDb().then((db) => new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(storeNames, mode);
      } catch (error) {
        reject(tagError(error, "closed", "IndexedDB 连接已关闭，正在重开。"));
        return;
      }
      let logicError = null;
      let result;
      try {
        result = execute(tx, (error) => { logicError = error; });
      } catch (error) {
        try { tx.abort(); } catch {}
        reject(tagError(error, "aborted", "IndexedDB 事务准备失败。"));
        return;
      }
      tx.onerror = () => {}; // 记录空处理器避免控制台未捕获报错；事务仍会 abort
      tx.onabort = () => {
        reject(logicError ?? tagError(tx.error, "aborted", "IndexedDB 事务中止。"));
      };
      tx.oncomplete = () => {
        resolve(typeof result === "function" ? result() : result);
      };
    }));
    return attempt().catch((error) => {
      // 连接被版本升级或浏览器回收关闭：丢弃缓存连接重开重试一次。
      if (error?.reason === "closed" || error?.originalName === "InvalidStateError") {
        database = null;
        openPromise = null;
        return attempt();
      }
      throw error;
    });
  }

  async function saveHistory(entry = {}) {
    if (!enabled) throw disabledError();
    // 解码放在事务外：非法图片直接拒绝，不碰存储。
    const image = decodeDataUrlImage(entry.imageDataUrl, FULL_IMAGE_MAX_CHARS);
    if (!image) throw invalidImageError();
    const thumbnail = decodeDataUrlImage(entry.thumbnail, THUMB_MAX_CHARS); // 非法缩略图静默丢弃，thumb 回落原图
    const meta = {
      id: randomId(),
      createdAt: new Date(nowFn()).toISOString(),
      model: String(entry.model ?? ""),
      prompt: String(entry.prompt ?? ""),
      size: String(entry.size ?? ""),
      referenceCount: Number.isInteger(entry.referenceCount) && entry.referenceCount > 0 ? entry.referenceCount : 1,
      hasThumb: Boolean(thumbnail),
      username: String(entry.username ?? ""),
      // 直连模式显式传 ""（合成保存）；未传默认 "own"；其他值按旧口径留空。
      keySource: entry.keySource == null ? "own" : (["shared", "own"].includes(entry.keySource) ? entry.keySource : "")
    };
    const blobs = {
      id: meta.id,
      result: new Blob([image.bytes], { type: image.contentType }),
      thumb: thumbnail ? new Blob([thumbnail.bytes], { type: thumbnail.contentType }) : null
    };
    await runTransaction(["history", "historyBlobs"], "readwrite", (tx) => {
      tx.objectStore("history").put(meta);
      tx.objectStore("historyBlobs").put(blobs);
    });
    return { ok: true, id: meta.id };
  }

  function listHistory() {
    if (!enabled) return Promise.reject(disabledError());
    return runTransaction(["history"], "readonly", (tx) => {
      const entries = [];
      // 只展示最新 limit 条；历史本身从不淘汰，旧记录一直留在库里。
      const request = tx.objectStore("history").index("order").openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || entries.length >= historyDisplayLimit) return;
        entries.push(projectHistory(cursor.value));
        cursor.continue();
      };
      return () => entries;
    }).then((entries) => ({ ok: true, enabled: true, entries }));
  }

  async function getHistoryImage(id, kind = "result") {
    if (!enabled) throw disabledError();
    const key = String(id || "");
    if (!key) throw Object.assign(new Error("缺少历史记录 id。"), { reason: "invalid-id", status: 400 });
    const image = await runTransaction(["history", "historyBlobs"], "readonly", (tx) => {
      const metaReq = tx.objectStore("history").get(key);
      const blobsReq = tx.objectStore("historyBlobs").get(key);
      let image = null;
      // 同一事务内请求按发起顺序完成：blobsReq 回调时 metaReq 必已就绪。
      blobsReq.onsuccess = () => {
        const blobs = blobsReq.result;
        if (!metaReq.result || !blobs) return;
        image = kind === "thumb"
          ? (blobs.thumb ?? blobs.result ?? null) // 缩略图缺失回落原图
          : (blobs.result ?? blobs.thumb ?? null);
      };
      return () => image;
    });
    if (!image) throw notFoundError("历史记录不存在或已被删除。");
    return image;
  }

  async function deleteHistory(id) {
    if (!enabled) throw disabledError();
    const key = String(id || "");
    if (!key) return { ok: true, removed: false };
    const removed = await runTransaction(["history", "historyBlobs"], "readwrite", (tx) => {
      const history = tx.objectStore("history");
      const blobs = tx.objectStore("historyBlobs");
      let existed = false;
      const getReq = history.get(key);
      getReq.onsuccess = () => {
        if (!getReq.result) return;
        existed = true;
        history.delete(key);
        blobs.delete(key);
      };
      return () => existed;
    });
    return { ok: true, removed };
  }

  async function listRefs(collection = "gallery") {
    assertCollection(collection);
    if (!enabled) throw disabledError();
    return runTransaction([refMetaStore(collection)], "readonly", (tx) => {
      const entries = [];
      const request = tx.objectStore(refMetaStore(collection)).index("order").openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        entries.push(projectRef(cursor.value));
        cursor.continue();
      };
      return () => entries;
    }).then((entries) => ({ ok: true, enabled: true, entries }));
  }

  async function getRefImage(collection, id, kind = "full") {
    assertCollection(collection);
    if (!enabled) throw disabledError();
    const key = String(id || "");
    if (!key) throw Object.assign(new Error("缺少参考图 id。"), { reason: "invalid-id", status: 400 });
    const image = await runTransaction([refMetaStore(collection), refBlobsStore(collection)], "readonly", (tx) => {
      const metaReq = tx.objectStore(refMetaStore(collection)).get(key);
      const blobsReq = tx.objectStore(refBlobsStore(collection)).get(key);
      let image = null;
      blobsReq.onsuccess = () => {
        const blobs = blobsReq.result;
        if (!metaReq.result || !blobs) return;
        image = kind === "thumb"
          ? (blobs.thumb ?? blobs.full ?? null)
          : (blobs.full ?? blobs.thumb ?? null);
      };
      return () => image;
    });
    if (!image) throw notFoundError("参考图不存在或已被删除。");
    return image;
  }

  async function addRef(collection, payload = {}) {
    assertCollection(collection);
    if (!enabled) throw disabledError();
    const image = decodeDataUrlImage(payload.imageDataUrl, FULL_IMAGE_MAX_CHARS);
    if (!image) throw invalidImageError();
    const thumbnail = decodeDataUrlImage(payload.thumbnail, THUMB_MAX_CHARS);
    let digest;
    try {
      digest = await sha256Hex(image.bytes); // 摘要在事务外算好
    } catch (error) {
      throw Object.assign(new Error("crypto.subtle 不可用，无法计算图片指纹。"), {
        reason: "digest-unavailable", status: 503, cause: error
      });
    }
    const metaName = refMetaStore(collection);
    const blobsName = refBlobsStore(collection);
    const width = Number(payload.width) || 0;
    const height = Number(payload.height) || 0;

    const attempt = () => runTransaction([metaName, blobsName], "readwrite", (tx) => {
      const metaStore = tx.objectStore(metaName);
      const blobStore = tx.objectStore(blobsName);
      let savedId = null;
      const digestReq = metaStore.index("hash").get(digest);
      digestReq.onsuccess = () => {
        const existing = digestReq.result;
        if (existing) {
          // 同字节已存在：只刷新元数据并移到队首（MRU），不新增条目。
          savedId = existing.id;
          metaStore.put({
            ...existing,
            width: width || existing.width,
            height: height || existing.height,
            addedAt: new Date(nowFn()).toISOString()
          });
          return;
        }
        const id = randomId();
        savedId = id;
        metaStore.put({ id, hash: digest, width, height, addedAt: new Date(nowFn()).toISOString(), hasThumb: Boolean(thumbnail) });
        blobStore.put({
          id,
          full: new Blob([image.bytes], { type: image.contentType }),
          thumb: thumbnail ? new Blob([thumbnail.bytes], { type: thumbnail.contentType }) : null
        });
        // 淘汰超上限的最旧条目：同一事务内连带删 Blob，不产生孤儿。
        const cursorReq = metaStore.index("order").openCursor(null, "prev");
        let seen = 0;
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          seen += 1;
          if (seen > refMaxEntries) {
            cursor.delete();
            blobStore.delete(cursor.primaryKey);
          }
          cursor.continue();
        };
      };
      return () => savedId;
    });

    let id = null;
    try {
      id = await attempt();
    } catch (error) {
      // 并发同字节入库撞唯一 hash 索引：整事务已回滚，重试一次走 MRU 刷新分支。
      if (error?.originalName !== "ConstraintError") throw error;
      id = await attempt();
    }
    return { ok: true, id };
  }

  async function deleteRef(collection, id) {
    assertCollection(collection);
    if (!enabled) throw disabledError();
    const key = String(id || "");
    if (!key) return { ok: true, removed: false };
    const removed = await runTransaction([refMetaStore(collection), refBlobsStore(collection)], "readwrite", (tx) => {
      const metaStore = tx.objectStore(refMetaStore(collection));
      const blobStore = tx.objectStore(refBlobsStore(collection));
      let existed = false;
      const getReq = metaStore.get(key);
      getReq.onsuccess = () => {
        if (!getReq.result) return;
        existed = true;
        metaStore.delete(key);
        blobStore.delete(key);
      };
      return () => existed;
    });
    return { ok: true, removed };
  }

  async function reserveAttempt(limit = defaultAttemptLimit) {
    if (!enabled) throw disabledError();
    const effectiveLimit = Number.isInteger(limit) ? limit : defaultAttemptLimit;
    const timestamp = new Date(nowFn());
    const today = localDateKey(timestamp);
    if (effectiveLimit <= 0) {
      return { used: 0, limit: 0, date: today }; // 与 rate-limit 口径一致：不限额不计数
    }
    return runTransaction(["counters"], "readwrite", (tx, fail) => {
      const store = tx.objectStore("counters");
      const getReq = store.get(ATTEMPTS_KEY);
      let reserved = null;
      getReq.onsuccess = () => {
        const entry = getReq.result;
        const used = entry && entry.date === today && Number.isInteger(entry.count) && entry.count >= 0
          ? entry.count
          : 0; // 跨本地日历日自动清零
        if (used >= effectiveLimit) {
          fail(Object.assign(
            new Error(`今日渲染次数已达上限（${effectiveLimit} 次），请明天再试。`),
            { status: 429, pauseQueue: true, reason: "quota-exceeded", used, limit: effectiveLimit, date: today }
          ));
          try { tx.abort(); } catch {}
          return;
        }
        store.put({ date: today, count: used + 1 }, ATTEMPTS_KEY);
        reserved = { used: used + 1, limit: effectiveLimit, date: today };
      };
      return () => reserved;
    });
  }

  function close() {
    const db = database;
    database = null;
    openPromise = null;
    if (db) {
      db.onversionchange = null;
      try { db.close(); } catch {}
    }
  }

  return {
    listHistory,
    getHistoryImage,
    saveHistory,
    deleteHistory,
    listRefs,
    getRefImage,
    addRef,
    deleteRef,
    reserveAttempt,
    close
  };
}

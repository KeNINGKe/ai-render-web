import { SHARED_EXTRA_REFS, SHARED_HISTORY } from "./shared-content.js";

// 固定内容直接读站点文件，不写进访客的图库，清理个人存储也不会丢失。
export function createSharedRendererApi(api, { fetchImpl = globalThis.fetch } = {}) {
  async function image(file) {
    const response = await fetchImpl(new URL(file, import.meta.url));
    if (!response.ok) throw new Error("固定图片读取失败，请刷新页面后重试");
    return response.blob();
  }

  async function merge(read, shared) {
    let data;
    try { data = await read(); }
    catch (error) { data = { warning: error.message, entries: [] }; }
    const entries = (data.entries || []).filter((entry) => !shared.some((fixed) =>
      entry.id === fixed.id || entry.id === fixed.sourceId || (entry.hash && entry.hash === fixed.hash)
    ));
    return { ...data, ok: true, enabled: true, entries: [...shared.map((entry) => ({ ...entry })), ...entries] };
  }

  function protectedEntry() {
    return Promise.reject(new Error("网站固定内容不能删除，可清理自己的记录"));
  }

  return {
    ...api,
    listHistory: () => merge(() => api.listHistory(), SHARED_HISTORY),
    getHistoryImage(id, kind = "result") {
      const entry = SHARED_HISTORY.find((item) => item.id === id);
      if (!entry) return api.getHistoryImage(id, kind);
      if (kind !== "result" && kind !== "thumb") return Promise.reject(new Error("无效的图片类型"));
      return image(kind === "thumb" ? entry.thumbFile : entry.resultFile);
    },
    deleteHistory: (id) => SHARED_HISTORY.some((entry) => entry.id === id) ? protectedEntry() : api.deleteHistory(id),
    listRefs: (collection) => collection === "extraRefs"
      ? merge(() => api.listRefs(collection), SHARED_EXTRA_REFS)
      : api.listRefs(collection),
    getRefImage(collection, id, kind = "full") {
      const entry = collection === "extraRefs" && SHARED_EXTRA_REFS.find((item) => item.id === id);
      return entry ? image(entry.file) : api.getRefImage(collection, id, kind);
    },
    deleteRef: (collection, id) => collection === "extraRefs" && SHARED_EXTRA_REFS.some((entry) => entry.id === id)
      ? protectedEntry() : api.deleteRef(collection, id)
  };
}

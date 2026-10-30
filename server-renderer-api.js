const COLLECTION_PATHS = Object.freeze({ gallery: "/api/ref-gallery", extraRefs: "/api/extra-refs" });

export function createServerRendererApi(config = {}, {
  fetchImpl = globalThis.fetch,
  redirectToLogin = () => { globalThis.location.href = "/login"; }
} = {}) {
  function collectionPath(collection) {
    const path = Object.hasOwn(COLLECTION_PATHS, collection) ? COLLECTION_PATHS[collection] : null;
    if (!path) throw Object.assign(new Error("无效的参考图库"), { status: 400 });
    return path;
  }

  async function request(path, { body, signal, blob = false, authProbe = false } = {}) {
    let response;
    try {
      response = await fetchImpl(path, {
        ...(body === undefined ? {} : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }),
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      error.status ??= 0;
      throw error;
    }
    if (authProbe && response.status === 404) return { ok: false };
    if (response.status === 401 && !path.endsWith("/logout")) redirectToLogin();
    let data;
    if (response.ok && blob) return response.blob();
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok || !data || data.ok === false) {
      const error = new Error(data?.message || (response.ok ? "服务器响应格式无效" : `请求失败（${response.status}）`));
      error.status = response.status;
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
      if (response.status === 401 || response.status === 429 || data?.pauseQueue) error.pauseQueue = true;
      throw error;
    }
    return data;
  }

  const imagePath = (path, id, kind) => `${path}/image?id=${encodeURIComponent(id)}&kind=${encodeURIComponent(kind)}`;
  return {
    getAuth: () => request("/api/auth/me", { authProbe: true }),
    async logout() {
      try { return await request("/api/auth/logout", { body: {} }); }
      finally { redirectToLogin(); }
    },
    getStatus: () => request("/api/seedream/status"),
    render: (payload, { signal } = {}) => request("/api/seedream/render", { body: payload, signal }),
    listHistory: () => request("/api/render-history"),
    getHistoryImage: (id, kind = "result") => request(imagePath("/api/render-history", id, kind), { blob: true }),
    deleteHistory: (id) => request("/api/render-history/delete", { body: { id } }),
    saveComposite: (payload) => request("/api/render-history/save-composite", { body: payload }),
    listRefs: (collection) => request(collectionPath(collection)),
    getRefImage: (collection, id, kind = "full") => request(imagePath(collectionPath(collection), id, kind), { blob: true }),
    addRef: (collection, payload) => request(`${collectionPath(collection)}/add`, { body: payload }),
    deleteRef: (collection, id) => request(`${collectionPath(collection)}/delete`, { body: { id } })
  };
}

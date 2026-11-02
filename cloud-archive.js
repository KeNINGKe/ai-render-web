const BUCKET = 'render-results';
const TABLE = 'render_records';
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = ['getUser', 'signIn', 'signInAnonymously', 'signOut', 'requireUser', 'getProfile', 'saveRender', 'listRenders', 'getImage', 'deleteRender'];

function fail(message, status = 0, code = '') {
  return Object.assign(new Error(message), { name: 'CloudArchiveError', status, code });
}

function validateConfig(config) {
  let url;
  try { url = new URL(config.url); } catch { throw fail('云归档 URL 无效'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.supabase\.co$/.test(url.hostname)
    || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw fail('云归档仅支持 https://<project>.supabase.co');
  }
  const key = config.publishableKey;
  let allowed = typeof key === 'string' && /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (!allowed && typeof key === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    try {
      const part = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      allowed = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='))).role === 'anon';
    } catch { /* Invalid JWTs are never accepted as project keys. */ }
  }
  if (!allowed) throw fail('仅允许 Supabase publishable key 或 role=anon 的旧版 JWT；禁止 secret/service_role');
  return { url: url.origin, key };
}

function isoDate(value, endOfDay = false) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw fail('日期必须为 ISO 日期或时间');
  }
  const day = value.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) throw fail('日期无效');
  const date = new Date(value.length === 10 ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value);
  if (!Number.isFinite(date.getTime())) throw fail('日期无效');
  return date.toISOString();
}

function imageBlob(dataUrl) {
  if (typeof dataUrl !== 'string') throw fail('图片必须为 base64 Data URL');
  const match = /^data:(image\/(?:png|jpeg|webp|gif|avif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || !match[2] || match[2].length % 4 !== 0) throw fail('不支持的图片 Data URL');
  const encoded = match[2];
  const length = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (length > MAX_IMAGE_BYTES) throw fail('单张图片不能超过 50MB');
  let binary;
  try { binary = atob(encoded); } catch { throw fail('图片 base64 无效'); }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  let mime = '';
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) mime = 'image/png';
  else if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') mime = 'image/webp';
  else if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) mime = 'image/gif';
  else if (bytes.length >= 16 && ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) mime = 'image/avif';
  if (!mime || mime !== match[1]) throw fail('图片 MIME 与文件魔数不一致');
  return { blob: new Blob([bytes], { type: mime }), ext: mime === 'image/jpeg' ? 'jpg' : mime.slice(6) };
}

function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail(`${label} 必须为 UUID`);
  return value.toLowerCase();
}

function entryPaths(entry) {
  const owner = assertUuid(entry?.owner_id, 'owner_id');
  const id = assertUuid(entry?.id, 'id');
  const validate = (path, kind) => {
    if (typeof path !== 'string' || !new RegExp(`^${owner}/${id}/${kind}\\.(png|jpg|webp|gif|avif)$`).test(path)) throw fail('云图片路径无效');
    return path;
  };
  return { result: validate(entry.result_path, 'result'), thumb: entry.thumb_path ? validate(entry.thumb_path, 'thumb') : null };
}

/** Browser-only Supabase REST client. No renderer/ARK credentials are used here. */
export function createCloudArchive(config = {}, deps = {}) {
  if (!config || (!config.url && !config.publishableKey)) {
    return Object.fromEntries([['enabled', false], ...METHODS.map(name => [name, async () => { throw fail('云归档未配置'); }])]);
  }
  const { url, key } = validateConfig(config);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const cryptoImpl = deps.cryptoImpl ?? globalThis.crypto;
  let storage = deps.storage;
  if (storage === undefined) {
    try { storage = globalThis.sessionStorage; } catch { /* Fall back to memory, never localStorage. */ }
  }
  const sessionKey = `cloud-archive:${url}:session`;
  let session = null;
  let generation = 0;
  let refreshPromise = null;
  const persist = value => {
    session = value;
    try {
      if (value) storage?.setItem(sessionKey, JSON.stringify(value));
      else storage?.removeItem(sessionKey);
    } catch { /* A blocked sessionStorage still allows an in-memory session. */ }
  };
  const clear = () => { generation += 1; persist(null); };
  try {
    const value = JSON.parse(storage?.getItem(sessionKey) ?? 'null');
    if (value && typeof value.access_token === 'string' && value.access_token && typeof value.refresh_token === 'string' && value.refresh_token && Number.isFinite(value.expires_at)) session = value;
    else storage?.removeItem(sessionKey);
  } catch { try { storage?.removeItem(sessionKey); } catch { /* Storage unavailable. */ } }

  async function request(path, { token, method = 'GET', body, headers = {}, responseType = 'json' } = {}) {
    const controller = new AbortController();
    let timer;
    const operation = async () => {
      const response = await fetchImpl(`${url}${path}`, {
        method, signal: controller.signal, redirect: 'error', credentials: 'omit',
        headers: { apikey: key, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body,
      });
      if (!response.ok) {
        if (response.status === 401) clear();
        let detail;
        try { detail = await response.json(); } catch { detail = {}; }
        throw fail(detail.message || detail.msg || detail.error_description || detail.error || `云服务请求失败 (${response.status})`, response.status, detail.code || detail.error_code || String(detail.statusCode || ''));
      }
      const data = responseType === 'blob' ? await response.blob()
        : response.status === 204 ? null : await response.json();
      return { data, headers: response.headers };
    };
    try {
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(fail('云服务请求超时，请稍后重试')); }, 30_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  const jsonRequest = (path, options = {}) => request(path, {
    ...options, body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  function acceptSession(data) {
    if (!data || typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token) throw fail('登录响应缺少有效会话');
    const expiresAt = Number(data.expires_at) || Math.floor(Date.now() / 1000) + Number(data.expires_in);
    if (!Number.isFinite(expiresAt)) throw fail('登录响应缺少会话有效期');
    persist({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expiresAt });
  }
  async function token() {
    if (!session) throw fail('请先登录云归档', 401);
    if (session.expires_at > Date.now() / 1000 + 60) return session.access_token;
    if (!refreshPromise) {
      const version = generation;
      const refreshToken = session.refresh_token;
      refreshPromise = (async () => {
        try {
          const { data } = await jsonRequest('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken } });
          if (version !== generation) throw fail('会话已结束，请重新登录', 401);
          acceptSession(data);
          return session.access_token;
        } catch (error) {
          if (version === generation && (error.status === 400 || error.status === 401)) clear();
          throw error;
        } finally { refreshPromise = null; }
      })();
    }
    return refreshPromise;
  }
  async function authRequest(path, options) { return request(path, { ...options, token: await token() }); }
  async function authJson(path, options) { return jsonRequest(path, { ...options, token: await token() }); }
  async function getUser() {
    if (!session) return null;
    try {
      const { data } = await authRequest('/auth/v1/user');
      assertUuid(data?.id, '用户 ID');
      return data;
    } catch (error) { if (error.status === 401) return null; throw error; }
  }
  async function requireUser() {
    const user = await getUser();
    if (!user) throw fail('请先登录云归档', 401);
    return user;
  }
  async function signIn(email, password) {
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) throw fail('请填写邮箱和密码');
    clear();
    const version = generation;
    const { data } = await jsonRequest('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: email.trim(), password } });
    if (version !== generation) throw fail('登录已取消');
    acceptSession(data);
    return requireUser();
  }
  // 游客自动归档：服务端需在 Authentication → Sign In / Providers 开启 Anonymous sign-ins。
  // 每个浏览器首次渲染时静默创建一个匿名身份；档案触发器仍会生成 member 档案，管理员可看全部记录。
  async function signInAnonymously() {
    clear();
    const version = generation;
    const label = `匿名-${Math.random().toString(36).slice(2, 6)}`;
    const { data } = await jsonRequest('/auth/v1/signup', { method: 'POST', body: { data: { display_name: label } } });
    if (version !== generation) throw fail('登录已取消');
    acceptSession(data);
    return requireUser();
  }
  async function signOut() {
    try { if (session) await authJson('/auth/v1/logout', { method: 'POST' }); }
    finally { clear(); }
  }
  async function getProfile() {
    const user = await requireUser();
    const params = new URLSearchParams({ select: 'id,display_name,role', id: `eq.${user.id}` });
    const { data } = await authRequest(`/rest/v1/profiles?${params}`);
    if (!Array.isArray(data) || data.length !== 1) throw fail('未找到云用户档案，请联系管理员');
    return data[0];
  }
  async function stableId(owner, localId) {
    if (typeof localId !== 'string' || !localId.trim() || localId.length > 1024) throw fail('归档需要非空 localId（最多 1024 字符）');
    if (!cryptoImpl?.subtle?.digest) throw fail('当前环境不支持安全摘要，请使用 HTTPS');
    const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([owner, localId]))));
    const bytes = digest.slice(0, 16);
    bytes[6] = (bytes[6] & 15) | 0x80; // UUID v8, SHA-256-derived application UUID.
    bytes[8] = (bytes[8] & 63) | 0x80;
    const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  async function findRecord(id) {
    const params = new URLSearchParams({ select: '*', id: `eq.${id}`, limit: '1' });
    const { data } = await authRequest(`/rest/v1/${TABLE}?${params}`);
    if (!Array.isArray(data)) throw fail('云归档记录响应无效');
    return data[0] ?? null;
  }
  const objectUrl = path => `/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
  async function upload(path, image) {
    try {
      await authRequest(objectUrl(path), { method: 'POST', body: image.blob, headers: { 'Content-Type': image.blob.type, 'x-upsert': 'false' } });
    } catch (error) {
      if (error.status !== 409 && !['Duplicate', 'ResourceAlreadyExists', '409'].includes(error.code)) throw error;
      // A previous/concurrent attempt owns this stable path. Never overwrite it.
    }
  }
  async function saveRender(payload) {
    const user = await requireUser();
    const owner = assertUuid(user.id, '用户 ID');
    const id = await stableId(owner, payload?.localId);
    if (await findRecord(id)) return { id };
    const result = imageBlob(payload.imageDataUrl);
    const thumb = payload.thumbnail == null || payload.thumbnail === '' ? null : imageBlob(payload.thumbnail);
    for (const field of ['prompt', 'model', 'size']) if (typeof payload[field] !== 'string') throw fail(`${field} 必须为字符串`);
    if (!Number.isInteger(payload.referenceCount) || payload.referenceCount < 0) throw fail('referenceCount 必须为非负整数');
    const record = {
      id, owner_id: owner, created_at: payload.createdAt ? isoDate(payload.createdAt) : new Date().toISOString(),
      prompt: payload.prompt, model: payload.model, size: payload.size, reference_count: payload.referenceCount,
      result_path: `${owner}/${id}/result.${result.ext}`, thumb_path: thumb ? `${owner}/${id}/thumb.${thumb.ext}` : null,
    };
    await upload(record.result_path, result);
    if (thumb) await upload(record.thumb_path, thumb);
    // Never clean up on an ambiguous failure: the DB may have committed successfully.
    const params = new URLSearchParams({ on_conflict: 'id', select: 'id' });
    const { data } = await authJson(`/rest/v1/${TABLE}?${params}`, {
      method: 'POST', body: record, headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    });
    if (!Array.isArray(data) || (data[0]?.id !== id && !(await findRecord(id)))) throw fail('云归档记录未确认保存，请使用相同 localId 重试');
    return { id };
  }
  async function listRenders({ search = '', owner = '', from = '', to = '', offset = 0, limit = 24 } = {}) {
    if (typeof search !== 'string' || search.length > 2000) throw fail('搜索词必须为字符串且不超过 2000 字符');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('分页参数无效（limit 为 1–100）');
    const params = new URLSearchParams({
      select: '*,profiles!render_records_owner_id_fkey(display_name,email)',
      order: 'created_at.desc,id.desc', offset: String(offset), limit: String(limit),
    });
    // No `or` grammar is built from user input. Encode the complete literal operand.
    if (search) params.set('prompt', `ilike.%${search.replace(/[\\%_*,()"']/g, char => `\\${char}`)}%`);
    if (owner) params.set('owner_id', `eq.${assertUuid(owner, 'owner')}`);
    const start = from ? isoDate(from) : '';
    const end = to ? isoDate(to, true) : '';
    if (start && end && start > end) throw fail('开始日期不能晚于结束日期');
    if (start) params.append('created_at', `gte.${start}`);
    if (end) params.append('created_at', `lte.${end}`);
    await requireUser();
    const { data, headers } = await authRequest(`/rest/v1/${TABLE}?${params}`, { headers: { Prefer: 'count=exact' } });
    const count = /\/(\d+)$/.exec(headers.get('content-range') ?? '');
    if (!Array.isArray(data) || !count) throw fail('云列表缺少有效分页计数');
    const total = Number(count[1]);
    return { entries: data, total, hasMore: offset + data.length < total };
  }
  async function getImage(entry, kind = 'result') {
    const paths = entryPaths(entry);
    if (!['result', 'thumb', 'thumbnail'].includes(kind)) throw fail('图片类型无效');
    const path = kind === 'result' ? paths.result : paths.thumb;
    if (!path) throw fail('该记录没有缩略图');
    const { data } = await authRequest(objectUrl(path), { responseType: 'blob' });
    return data;
  }
  async function deleteRender(entry) {
    const id = assertUuid(entry?.id, 'id');
    const user = await requireUser();
    const record = await findRecord(id);
    if (!record) throw fail('归档不存在或没有访问权限', 404);
    if (record.owner_id !== user.id && (await getProfile()).role !== 'admin') throw fail('没有删除权限', 403);
    const paths = entryPaths(record);
    const names = [paths.result, paths.thumb].filter(Boolean);
    const { data } = await authJson(`/storage/v1/object/${BUCKET}`, { method: 'DELETE', body: { prefixes: names } });
    if (!Array.isArray(data)) throw fail('未确认云图片删除');
    for (const name of names) {
      if (data.some(item => item.name === name)) continue;
      // Storage RLS can silently return []; confirm absence rather than swallowing denial.
      try { await authRequest(objectUrl(name), { responseType: 'blob' }); }
      catch (error) { if (error.status === 404 || ['NoSuchKey', 'ObjectNotFound'].includes(error.code)) continue; throw error; }
      throw fail('云图片未删除，归档记录已保留', 403);
    }
    const params = new URLSearchParams({ id: `eq.${id}`, select: 'id' });
    const removed = await authJson(`/rest/v1/${TABLE}?${params}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
    if (!Array.isArray(removed.data) || removed.data[0]?.id !== id) throw fail('未确认云归档记录删除');
  }
  return { enabled: true, getUser, signIn, signInAnonymously, signOut, requireUser, getProfile, saveRender, listRenders, getImage, deleteRender };
}

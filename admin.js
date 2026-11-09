import { createCloudArchive } from './cloud-archive.js';
import { RUNTIME_CONFIG } from './runtime-config.js';

const cloud = createCloudArchive(RUNTIME_CONFIG.cloudArchive);
const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(['authPanel','authTitle','authDescription','loginForm','email','password','loginSubmit','message','management','refresh','signOut','filters','search','owner','ownerOptions','from','to','reset','count','listState','renderList','pageInfo','previous','next','detailDialog','closeDetail','detailImage','imageState','metadata','detailPrompt','copyPrompt','detailMessage','download','deleteRender'].map(id => [id, $(id)]));
const LIMIT = 24;
// <button id="reset"> 在筛选表单内，HTML 命名控件访问使 filters.reset 指向该按钮而非原生方法，
// 必须显式从原型调用才能真正重置表单。
const resetFilters = () => HTMLFormElement.prototype.reset.call(ui.filters);
let epoch = 0, detailEpoch = 0, offset = 0, total = 0, admin = false, selected = null, originalBlob = null, opener = null;
const urls = new Set();
let thumbUrls = new Set(), detailUrl = null;
let imageActive = 0;
const imageQueue = [];
let imageRequests = 0;
const imageWaiters = [];
async function readImage(entry, kind) {
  if (imageRequests >= 4) await new Promise(resolve => imageWaiters.push(resolve));
  else imageRequests++;
  try { return await cloud.getImage(entry, kind); }
  finally { const next = imageWaiters.shift(); if (next) next(); else imageRequests--; }
}
const errorText = (error) => error?.message || '操作失败，请稍后重试。';
const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; };
const dateText = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value || '—') : date.toLocaleString('zh-CN', { hour12: false }); };
const ownerLabel = entry => { const profile = Array.isArray(entry.profiles) ? entry.profiles[0] : entry.profiles; return entry.submitted_by || profile?.display_name || profile?.email || '匿名成员'; };
function blobUrl(blob) { const url = URL.createObjectURL(blob); urls.add(url); return url; }
function revoke(url) { if (url) { URL.revokeObjectURL(url); urls.delete(url); } }
function clearThumbs() { for (const url of thumbUrls) revoke(url); thumbUrls.clear(); imageQueue.splice(0); }
function closeDetail() {
  detailEpoch++; selected = null; originalBlob = null; revoke(detailUrl); detailUrl = null;
  ui.detailImage.removeAttribute('src'); ui.detailImage.hidden = true; ui.detailPrompt.textContent = ''; ui.metadata.replaceChildren(); ui.detailMessage.textContent = '';
  if (ui.detailDialog.open) ui.detailDialog.close();
  if (opener?.isConnected) opener.focus(); opener = null;
}
function clearPrivateView() {
  epoch++; admin = false; offset = 0; clearThumbs(); closeDetail(); ui.renderList.replaceChildren(); ui.ownerOptions.replaceChildren();
  ui.management.hidden = true; ui.refresh.hidden = true; ui.signOut.hidden = true; ui.authPanel.hidden = false;
  ui.count.textContent = ''; ui.pageInfo.textContent = ''; ui.message.textContent = ''; ui.password.value = ''; resetFilters();
}
function loginState(title = '管理员登录', description = '使用已开通的云端账号登录。管理员权限由数据库 profiles 与访问策略共同控制。') {
  ui.authTitle.textContent = title; ui.authDescription.textContent = description; ui.loginForm.hidden = false; ui.authPanel.hidden = false;
}
async function authorize() {
  const token = ++epoch;
  ui.loginForm.hidden = true; ui.authTitle.textContent = '正在验证账号'; ui.authDescription.textContent = '正在读取数据库中的管理员权限…';
  const user = await cloud.getUser(); if (token !== epoch) return;
  if (!user) { loginState(); return; }
  ui.signOut.hidden = false;
  const profile = await cloud.getProfile(); if (token !== epoch) return;
  if (profile?.role !== 'admin') {
    ui.authTitle.textContent = '此账号没有管理权限'; ui.authDescription.textContent = '请联系项目管理员，在数据库中授权 profiles.role = admin，并启用对应的 RLS 策略后再访问。'; ui.loginForm.hidden = true; return;
  }
  admin = true; ui.authPanel.hidden = true; ui.management.hidden = false; ui.refresh.hidden = false;
  await loadRecords();
}
function pumpImages() {
  while (imageActive < 4 && imageQueue.length) {
    const job = imageQueue.shift(); if (job.token !== epoch || !admin) continue;
    imageActive++;
    (async () => {
      try {
        const blob = await readImage(job.entry, job.entry.thumb_path ? 'thumb' : 'result');
        if (job.token !== epoch || !admin || !job.frame.isConnected) return;
        const url = blobUrl(blob); thumbUrls.add(url);
        const image = node('img'); image.alt = '渲染结果缩略图'; image.src = url; image.loading = 'lazy';
        image.onerror = () => { if (job.frame.isConnected) job.frame.textContent = '缩略图暂不可用'; revoke(url); thumbUrls.delete(url); };
        job.frame.replaceChildren(image);
      } catch { if (job.token === epoch && job.frame.isConnected) job.frame.textContent = '缩略图暂不可用'; }
      finally { imageActive--; pumpImages(); }
    })();
  }
}
function renderEntry(entry, token) {
  const card = node('article', 'render-card'); card.dataset.id = entry.id;
  const frame = node('div', 'thumb-frame', '正在读取缩略图…');
  const content = node('div', 'card-content');
  const profile = Array.isArray(entry.profiles) ? entry.profiles[0] : entry.profiles;
  content.append(node('p', 'card-owner', ownerLabel(entry)), node('p', 'card-email', profile?.email || ''), node('p', 'card-meta', dateText(entry.created_at)), node('p', 'card-meta', `${entry.model || '—'} · ${entry.size || '—'}`), node('p', 'card-prompt', entry.prompt || '无提示词'));
  const button = node('button', 'detail-open', '查看详情'); button.type = 'button'; button.addEventListener('click', () => openDetail(entry, button)); content.append(button); card.append(frame, content);
  imageQueue.push({ entry, token, frame }); return card;
}
async function loadRecords() {
  if (!admin) return;
  const token = ++epoch; clearThumbs(); closeDetail(); ui.renderList.replaceChildren(); ui.message.textContent = ''; ui.listState.hidden = false; ui.listState.textContent = '正在读取团队档案…'; ui.renderList.setAttribute('aria-busy','true'); ui.previous.disabled = true; ui.next.disabled = true; ui.count.textContent = '正在加载…';
  try {
    const from = ui.from.value, to = ui.to.value;
    if (from && to && from > to) throw new Error('开始日期不能晚于结束日期。');
    const owner = ui.owner.value.trim();
    if (owner && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner)) throw new Error('请选择当前页人员，或输入完整的人员 UUID。');
    const result = await cloud.listRenders({ search: ui.search.value.trim(), owner, from, to, offset, limit: LIMIT });
    if (token !== epoch || !admin) return;
    total = result.total ?? result.entries.length;
    ui.count.textContent = `共 ${total} 条记录 · 每页 ${LIMIT} 条`; ui.listState.hidden = result.entries.length > 0; ui.listState.textContent = '没有符合条件的渲染记录。';
    ui.renderList.replaceChildren(...result.entries.map(entry => renderEntry(entry, token)));
    ui.ownerOptions.replaceChildren(); const owners = new Map();
    for (const entry of result.entries) owners.set(entry.owner_id, ownerLabel(entry));
    for (const [id, name] of owners) { const option = node('option'); option.value = id; option.label = name; ui.ownerOptions.append(option); }
    ui.pageInfo.textContent = `第 ${Math.floor(offset / LIMIT) + 1} 页${result.entries.length ? ` · ${offset + 1}–${offset + result.entries.length}` : ''}`;
    ui.previous.disabled = offset === 0; ui.next.disabled = !result.hasMore;
    pumpImages();
  } catch (error) {
    if (token !== epoch) return;
    ui.count.textContent = '读取失败'; ui.listState.textContent = errorText(error); ui.listState.hidden = false; ui.pageInfo.textContent = ''; ui.previous.disabled = offset === 0;
  } finally { if (token === epoch) ui.renderList.setAttribute('aria-busy','false'); }
}
async function openDetail(entry, button) {
  closeDetail(); opener = button; selected = entry; const token = ++detailEpoch;
  ui.detailPrompt.textContent = entry.prompt || ''; ui.detailMessage.textContent = ''; ui.download.disabled = true; ui.deleteRender.disabled = false; ui.copyPrompt.textContent = '复制提示词'; ui.imageState.hidden = false; ui.imageState.textContent = '正在读取原图…';
  const profile = Array.isArray(entry.profiles) ? entry.profiles[0] : entry.profiles;
  const rows = [['人员', ownerLabel(entry)], ['邮箱', profile?.email || '—'], ['用户 ID', entry.owner_id], ['记录 ID', entry.id], ['生成时间', dateText(entry.created_at)], ['模型', entry.model || '—'], ['尺寸', entry.size || '—'], ['参考图', entry.reference_count ?? 0]];
  ui.metadata.replaceChildren(...rows.flatMap(([name, value]) => [node('dt', '', name), node('dd', '', value)]));
  ui.detailDialog.showModal(); ui.closeDetail.focus();
  try {
    const blob = await readImage(entry, 'result'); if (token !== detailEpoch || !admin) return;
    originalBlob = blob; detailUrl = blobUrl(blob); ui.detailImage.src = detailUrl; ui.detailImage.hidden = false; ui.imageState.hidden = true; ui.download.disabled = false;
    ui.detailImage.onerror = () => { if (token === detailEpoch) { ui.detailImage.hidden = true; ui.imageState.hidden = false; ui.imageState.textContent = '原图无法预览，可尝试下载。'; } };
  } catch(error) { if (token === detailEpoch) ui.imageState.textContent = errorText(error); }
}
ui.loginForm.addEventListener('submit', async event => {
  event.preventDefault(); ui.loginSubmit.disabled = true; ui.message.textContent = '';
  const email = ui.email.value.trim(), password = ui.password.value; ui.password.value = '';
  try { await cloud.signIn(email, password); await authorize(); } catch(error) { ui.message.textContent = errorText(error); loginState(); } finally { ui.loginSubmit.disabled = false; }
});
ui.signOut.addEventListener('click', async () => {
  clearPrivateView(); ui.loginForm.hidden = true; ui.authTitle.textContent = '正在退出登录'; ui.authDescription.textContent = '正在清除云端会话…';
  try { await cloud.signOut(); loginState(); } catch(error) { ui.authTitle.textContent = '退出未完成'; ui.authDescription.textContent = errorText(error); ui.signOut.hidden = false; }
});
ui.filters.addEventListener('submit', event => { event.preventDefault(); offset = 0; loadRecords(); });
ui.reset.addEventListener('click', () => { resetFilters(); offset = 0; loadRecords(); });
ui.refresh.addEventListener('click', () => loadRecords());
ui.previous.addEventListener('click', () => { offset = Math.max(0, offset - LIMIT); loadRecords(); });
ui.next.addEventListener('click', () => { offset += LIMIT; loadRecords(); });
ui.closeDetail.addEventListener('click', closeDetail);
ui.detailDialog.addEventListener('cancel', event => { event.preventDefault(); closeDetail(); });
ui.detailDialog.addEventListener('click', event => { if (event.target === ui.detailDialog) { const r = ui.detailDialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDetail(); } });
ui.copyPrompt.addEventListener('click', async () => {
  const token = detailEpoch; const text = selected?.prompt || '';
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else { const field = node('textarea'); field.value = text; document.body.append(field); field.select(); const ok = document.execCommand('copy'); field.remove(); if (!ok) throw new Error('复制失败，请手动选择提示词。'); }
    if (token === detailEpoch) ui.copyPrompt.textContent = '已复制';
  } catch(error) { if (token === detailEpoch) ui.detailMessage.textContent = errorText(error); }
});
ui.download.addEventListener('click', () => {
  if (!selected || !originalBlob) return;
  const ext = originalBlob.type === 'image/jpeg' ? 'jpg' : originalBlob.type === 'image/webp' ? 'webp' : 'png';
  const link = node('a'); link.href = detailUrl; link.download = `render-${String(selected.id).replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`; document.body.append(link); link.click(); link.remove();
});
ui.deleteRender.addEventListener('click', async () => {
  const entry = selected, token = detailEpoch; if (!entry || !admin || !confirm('确定删除这条云端渲染记录及其图片？此操作无法撤销。')) return;
  ui.deleteRender.disabled = true; ui.detailMessage.textContent = '';
  try { await cloud.deleteRender(entry); if (token !== detailEpoch || !admin) return; closeDetail(); if (ui.renderList.children.length === 1 && offset) offset = Math.max(0, offset - LIMIT); await loadRecords(); }
  catch(error) { if (token === detailEpoch) ui.detailMessage.textContent = errorText(error); }
  finally { if (token === detailEpoch) ui.deleteRender.disabled = false; }
});
window.addEventListener('pagehide', () => { epoch++; detailEpoch++; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); });
if (!cloud.enabled) {
  ui.authTitle.textContent = '尚未配置云服务'; ui.authDescription.textContent = '请先创建 Supabase 项目、执行云端表与 RLS 策略迁移，并在构建配置 cloudArchive 中填写项目 URL 与公开 publishableKey，再重新构建。配置完成后使用真实邮箱账号登录；此处不会展示模拟或本地记录。';
} else {
  authorize().catch(error => { clearPrivateView(); loginState('无法验证账号', errorText(error)); });
}

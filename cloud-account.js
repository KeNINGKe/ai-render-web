// 团队账号独立于火山方舟 Key；未配置云服务时不增加登录步骤。
export async function initCloudAccount({ archive, syncHistory, onChange = () => {} }) {
  if (!archive.enabled) return;
  const section = document.querySelector("#cloudAccount");
  const form = document.querySelector("#cloudLoginForm");
  const member = document.querySelector("#cloudAccountUser");
  const message = document.querySelector("#cloudAccountMessage");
  const password = document.querySelector("#cloudPassword");
  const sync = document.querySelector("#cloudSyncHistory");
  const logout = document.querySelector("#cloudSignOut");
  section.hidden = false;
  function show(text) { message.textContent = text; }
  function busy(value) {
    for (const button of section.querySelectorAll("button")) button.disabled = value;
  }
  async function refresh() {
    const user = await archive.getUser();
    form.hidden = Boolean(user);
    member.hidden = !user;
    document.querySelector("#cloudAccountName").textContent =
      user ? (user.email || (user.is_anonymous ? "游客身份 · 渲染自动归档" : "已登录")) : "";
    onChange(user);
    return user;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    busy(true);
    show("正在登录…");
    try {
      await archive.signIn(document.querySelector("#cloudEmail").value.trim(), password.value);
      password.value = "";
      await refresh();
      show("已登录。之后生成的结果会自动同步到管理后台。");
    } catch (error) { show(error.message); }
    finally { password.value = ""; busy(false); }
  });
  logout.addEventListener("click", async () => {
    busy(true);
    try {
      await archive.signOut();
      await refresh();
      show("已退出团队账号。");
    } catch (error) { show(error.message); }
    finally { busy(false); }
  });
  sync.addEventListener("click", async () => {
    if (!confirm("将当前浏览器保存的个人渲染历史同步到团队后台？同步后管理员可查看这些图片和提示词。")) return;
    busy(true);
    show("正在同步本机历史，请保持页面打开…");
    try {
      const result = await syncHistory((done, total) => show(`正在同步 ${done} / ${total}…`));
      show(`同步完成：${result.saved} 条成功，${result.failed} 条失败。失败的记录仍保存在本机，可以重试同步。`);
    } catch (error) { show(error.message); }
    finally { busy(false); }
  });
  try { await refresh(); }
  catch (error) { show(error.message); }
}

// 纯前端口令只减少随手访问，不构成服务端授权边界。
export async function verifyPassphrase(passphrase, gate, cryptoImpl = globalThis.crypto) {
  if (!gate || !Number.isInteger(gate.iterations) || gate.iterations < 100_000 || gate.iterations > 1_000_000) {
    throw new Error("访问口令配置无效，请联系维护者重新构建");
  }
  const decode = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  const salt = decode(gate.salt);
  const expected = decode(gate.digest);
  if (salt.length < 16 || expected.length !== 32) throw new Error("访问口令配置无效");
  const key = await cryptoImpl.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const actual = new Uint8Array(await cryptoImpl.subtle.deriveBits({
    name: "PBKDF2", salt, iterations: gate.iterations, hash: "SHA-256"
  }, key, 256));
  return actual.every((byte, index) => byte === expected[index]);
}

export async function unlockStaticPage(config) {
  const gatePanel = document.querySelector("#accessGate");
  const workspace = document.querySelector("#workspace");
  gatePanel.hidden = false;
  workspace.hidden = true;
  const form = document.querySelector("#accessForm");
  const password = document.querySelector("#accessPassword");
  const message = document.querySelector("#accessMessage");
  const button = document.querySelector("#accessSubmit");
  password.focus();
  await new Promise((resolve) => {
    const submit = async (event) => {
      event.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      try {
        if (!await verifyPassphrase(password.value, config.gate)) {
          message.textContent = "访问口令不正确";
          password.select();
          return;
        }
        password.value = "";
        form.removeEventListener("submit", submit);
        gatePanel.hidden = true;
        document.body.dataset.gate = "open";
        workspace.hidden = false;
        resolve();
      } catch (error) {
        message.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };
    form.addEventListener("submit", submit);
  });
}

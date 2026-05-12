const form = document.querySelector("#providerForm");
const providersEl = document.querySelector("#providers");
const messageEl = document.querySelector("#message");
const statusEl = document.querySelector("#status");
const syncButton = document.querySelector("#syncButton");
const doctorButton = document.querySelector("#doctorButton");
const defaultButton = document.querySelector("#defaultButton");
const clearButton = document.querySelector("#clearButton");

let editingName = null;

function showMessage(value) {
  messageEl.hidden = false;
  messageEl.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload.error || "请求失败。");
  }
  return payload;
}

function formData() {
  const data = new FormData(form);
  const payload = {
    name: String(data.get("name") || "").trim(),
    baseUrl: String(data.get("baseUrl") || "").trim(),
    apiKey: String(data.get("apiKey") || "").trim(),
    model: String(data.get("model") || "").trim(),
  };

  if (!payload.apiKey) delete payload.apiKey;
  if (!payload.model) delete payload.model;
  return payload;
}

async function load() {
  const [status, providers] = await Promise.all([
    api("/api/status"),
    api("/api/providers"),
  ]);
  const repairText = status.startupRepair?.repaired
    ? ` · 已修复会话 provider 到 ${status.startupRepair.statusBefore.targetProviderId}`
    : "";
  statusEl.textContent = `${status.codexHome}${repairText}`;
  renderProviders(providers.providers);
}

function renderProviders(providers) {
  providersEl.innerHTML = "";
  providersEl.classList.toggle("is-empty", providers.length === 0);
  if (providers.length === 0) {
    return;
  }

  for (const provider of providers) {
    const row = document.createElement("article");
    row.className = `provider${provider.isActive ? " active" : ""}`;
    row.innerHTML = `
      <div class="provider-header">
        <div>
          <div class="provider-name"></div>
          <div class="provider-url"></div>
        </div>
        <div class="provider-meta"></div>
      </div>
      <div class="row-actions">
        <button type="button" data-action="switch">切换</button>
        <button type="button" class="secondary" data-action="edit">编辑</button>
        <button type="button" class="danger" data-action="remove">删除</button>
      </div>
    `;

    row.querySelector(".provider-name").textContent = provider.name;
    row.querySelector(".provider-url").textContent = provider.baseUrl;
    row.querySelector(".provider-meta").textContent = `${provider.isActive ? "当前 · " : ""}${provider.id} · key:${provider.hasApiKey ? "有" : "无"}`;

    row.querySelector('[data-action="switch"]').addEventListener("click", async () => {
      try {
        showMessage(await api(`/api/providers/${encodeURIComponent(provider.name)}/switch`, {
          method: "POST",
          body: JSON.stringify({}),
        }));
        await load();
      } catch (error) {
        showMessage(error.message);
      }
    });

    row.querySelector('[data-action="edit"]').addEventListener("click", () => {
      editingName = provider.name;
      form.elements.name.value = provider.name;
      form.elements.baseUrl.value = provider.baseUrl;
      form.elements.apiKey.value = "";
      form.elements.model.value = provider.model || "";
    });

    row.querySelector('[data-action="remove"]').addEventListener("click", async () => {
      if (!confirm(`删除提供商「${provider.name}」？`)) {
        return;
      }
      try {
        showMessage(await api(`/api/providers/${encodeURIComponent(provider.name)}`, { method: "DELETE" }));
        await load();
      } catch (error) {
        showMessage(error.message);
      }
    });

    providersEl.append(row);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = formData();
    const path = editingName ? `/api/providers/${encodeURIComponent(editingName)}` : "/api/providers";
    const method = editingName ? "PATCH" : "POST";
    showMessage(await api(path, { method, body: JSON.stringify(payload) }));
    editingName = null;
    form.reset();
    await load();
  } catch (error) {
    showMessage(error.message);
  }
});

clearButton.addEventListener("click", () => {
  editingName = null;
  form.reset();
});

syncButton.addEventListener("click", async () => {
  try {
    showMessage(await api("/api/sync", { method: "POST" }));
  } catch (error) {
    showMessage(error.message);
  }
});

doctorButton.addEventListener("click", async () => {
  try {
    showMessage(await api("/api/doctor"));
  } catch (error) {
    showMessage(error.message);
  }
});

defaultButton.addEventListener("click", async () => {
  try {
    showMessage(await api("/api/providers/default/switch", { method: "POST" }));
    await load();
  } catch (error) {
    showMessage(error.message);
  }
});

load().catch((error) => showMessage(error.message));

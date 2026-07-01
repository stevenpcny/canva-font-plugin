const runBtn = document.getElementById("run");
const runAddPagesBtn = document.getElementById("runAddPages");
const runUploadVideosBtn = document.getElementById("runUploadVideos");
const runAnimateBtn = document.getElementById("runAnimate");
const proofreadBtn = document.getElementById("runProofread");
const applyBtn = document.getElementById("applyCorrections");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const proofLogEl = document.getElementById("proofLog");
const colorEl = document.getElementById("color");
const colorHexEl = document.getElementById("colorHex");
const apiKeyEl = document.getElementById("apiKey");
const saveKeyBtn = document.getElementById("saveKey");
const providerEl = document.getElementById("provider");
const modelEl = document.getElementById("model");
const apiKeyRow = document.getElementById("apiKeyRow");
const modelRow = document.getElementById("modelRow");
const apiKeyHint = document.getElementById("apiKeyHint");
const modelHint = document.getElementById("modelHint");
const orFreeRow = document.getElementById("orFreeRow");
const orFreeModelEl = document.getElementById("orFreeModel");
const refreshModelsBtn = document.getElementById("refreshModels");
const orFreeHint = document.getElementById("orFreeHint");
const geminiRow = document.getElementById("geminiRow");
const geminiModelEl = document.getElementById("geminiModel");
const refreshGeminiBtn = document.getElementById("refreshGeminiModels");
const geminiHint = document.getElementById("geminiHint");

const OR_MODELS_URL = "https://openrouter.ai/api/v1/models";
const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MODELS_CACHE_TTL = 6 * 60 * 60 * 1000; // 模型列表缓存 6 小时
let orFreeModels = [];  // [{id, name}] OpenRouter 免费模型
let geminiModels = [];  // [{id, name}] Gemini 可用模型（按 key）

// 各后端默认模型 + key 提示（与 background.js 保持一致）
const PROVIDER_META = {
  gemini: { defaultModel: "gemini-2.5-flash", keyPlaceholder: "AIza... / AQ...", needsKey: true,
            keyHint: "Gemini key（AIza 或 AQ 开头），在 aistudio.google.com 获取。" },
  openrouter: { defaultModel: "google/gemini-2.0-flash-exp:free", keyPlaceholder: "sk-or-...", needsKey: true,
            keyHint: "OpenRouter key（sk-or- 开头），在 openrouter.ai/keys 获取。" },
  local: { defaultModel: "gemini-2.5-flash", keyPlaceholder: "", needsKey: false,
            keyHint: "本机代理无需 key，确保 localhost:8787 在运行。" },
};

// 内存态：各后端的 key / model，分开持久化
let proofKeys = { gemini: "", openrouter: "" };
let proofModels = { gemini: "", openrouter: "", local: "" };
const proofRulesEl = document.getElementById("proofRules");
const resetRulesBtn = document.getElementById("resetRules");
const DEFAULT_PROOF_RULES = proofRulesEl.defaultValue; // textarea 初始内容即默认规则
const videoFolderNameEl = document.getElementById("videoFolderName");
const posXEl = document.getElementById("posX");
const posYEl = document.getElementById("posY");
const readPosBtn = document.getElementById("readPos");
const applyPosBtn = document.getElementById("applyPos");

let pendingCorrections = null; // 校对结果暂存，等用户确认

function log(line) {
  logEl.style.display = "block";
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function proofLog(html) {
  proofLogEl.style.display = "block";
  proofLogEl.innerHTML += html;
  proofLogEl.scrollTop = proofLogEl.scrollHeight;
}

// 归一为 #RRGGBB；带不带 # / 大小写都认，非法返回 null
function normalizeHex(raw) {
  const v = (raw || "").trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(v) ? "#" + v.toUpperCase() : null;
}

// 两个颜色输入双向同步（文本框支持直接粘贴色值）
colorEl.addEventListener("input", () => { colorHexEl.value = colorEl.value.toUpperCase(); });
colorHexEl.addEventListener("input", () => {
  const hex = normalizeHex(colorHexEl.value);
  if (hex) colorEl.value = hex;
});
colorHexEl.addEventListener("blur", () => {
  const hex = normalizeHex(colorHexEl.value);
  if (hex) colorHexEl.value = hex;
});

// 用模型列表填充下拉，并尽量同步选中当前模型
function fillSelect(selectEl, placeholder, list) {
  const cur = modelEl.value.trim();
  selectEl.innerHTML = `<option value="">${placeholder}</option>`;
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    if (m.id === cur) opt.selected = true;
    selectEl.appendChild(opt);
  }
}

// 拉取 OpenRouter 免费模型（pricing 全 0）；force=true 跳过缓存
async function loadFreeModels(force) {
  if (!force && orFreeModels.length) { fillSelect(orFreeModelEl, "— 选择免费模型 —", orFreeModels); return; }
  orFreeHint.textContent = "正在拉取…";
  try {
    const resp = await fetch(OR_MODELS_URL);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    orFreeModels = (data.data || [])
      .filter((m) => m.pricing && m.pricing.prompt === "0" && m.pricing.completion === "0")
      .map((m) => ({ id: m.id, name: m.name || m.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    chrome.storage.local.set({ orFreeModels, orFreeModelsAt: Date.now() });
    fillSelect(orFreeModelEl, "— 选择免费模型 —", orFreeModels);
    orFreeHint.textContent = `共 ${orFreeModels.length} 个免费模型，实时拉取自 openrouter.ai。`;
  } catch (e) {
    orFreeHint.textContent = "拉取失败：" + e.message + "（仍可在下方手填模型）。";
  }
}

// 拉取 Gemini 可用模型（按当前 key，筛 generateContent，去掉 tts/image 等非文本模型）
async function loadGeminiModels(force) {
  const key = (apiKeyEl.value || proofKeys.gemini || "").trim();
  if (!key) { geminiHint.textContent = "请先填写 Gemini key 再点刷新。"; return; }
  if (!force && geminiModels.length) { fillSelect(geminiModelEl, "— 选择模型 —", geminiModels); return; }
  geminiHint.textContent = "正在拉取…";
  try {
    const resp = await fetch(GEMINI_MODELS_URL + "?pageSize=200&key=" + encodeURIComponent(key));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    geminiModels = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName || m.name }))
      .filter((m) => !/tts|image|embedding|aqa/i.test(m.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    chrome.storage.local.set({ geminiModels, geminiModelsAt: Date.now() });
    fillSelect(geminiModelEl, "— 选择模型 —", geminiModels);
    geminiHint.textContent = `共 ${geminiModels.length} 个可用模型（按你的 key）。`;
  } catch (e) {
    geminiHint.textContent = "拉取失败：" + e.message + "（仍可手填模型）。";
  }
}

// 切换后端时回填该后端的 key/model，并按需显隐 key 行 / 模型下拉
function syncProviderUI() {
  const p = providerEl.value;
  const meta = PROVIDER_META[p];
  apiKeyRow.style.display = meta.needsKey ? "" : "none";
  apiKeyEl.value = proofKeys[p] || "";
  apiKeyEl.placeholder = meta.keyPlaceholder;
  apiKeyHint.textContent = meta.keyHint;
  modelEl.value = proofModels[p] || "";
  modelEl.placeholder = meta.defaultModel;
  modelHint.textContent = "默认：" + meta.defaultModel;
  orFreeRow.style.display = p === "openrouter" ? "" : "none";
  geminiRow.style.display = p === "gemini" ? "" : "none";
  if (p === "openrouter") {
    if (orFreeModels.length) fillSelect(orFreeModelEl, "— 选择免费模型 —", orFreeModels);
    else loadFreeModels(false);
  } else if (p === "gemini") {
    if (geminiModels.length) fillSelect(geminiModelEl, "— 选择模型 —", geminiModels);
    else loadGeminiModels(false);
  }
}

// API key / model / provider + 校对规则 + 文件夹名 持久化
chrome.storage.local.get(
  ["proofProvider", "proofKeys", "proofModels", "anthropicApiKey", "proofRules", "videoFolderName",
   "orFreeModels", "orFreeModelsAt", "geminiModels", "geminiModelsAt"],
  (res) => {
    if (res.proofKeys) proofKeys = { ...proofKeys, ...res.proofKeys };
    if (res.proofModels) proofModels = { ...proofModels, ...res.proofModels };
    // 缓存未过期则直接用，过期则置空待切到对应后端时重新拉取
    const fresh = (ts) => ts && Date.now() - ts < MODELS_CACHE_TTL;
    if (Array.isArray(res.orFreeModels) && fresh(res.orFreeModelsAt)) orFreeModels = res.orFreeModels;
    if (Array.isArray(res.geminiModels) && fresh(res.geminiModelsAt)) geminiModels = res.geminiModels;
    // 旧版单 key 迁移：按前缀归类到对应后端
    if (res.anthropicApiKey && !res.proofKeys) {
      const k = res.anthropicApiKey.trim();
      if (k.startsWith("AIza") || k.startsWith("AQ.")) proofKeys.gemini = k; else proofKeys.openrouter = k;
      chrome.storage.local.set({ proofKeys });
    }
    providerEl.value = res.proofProvider
      || (proofKeys.gemini ? "gemini" : proofKeys.openrouter ? "openrouter" : "gemini");
    if (res.proofRules) proofRulesEl.value = res.proofRules;
    if (res.videoFolderName) videoFolderNameEl.value = res.videoFolderName;
    syncProviderUI();
  }
);

providerEl.addEventListener("change", () => {
  chrome.storage.local.set({ proofProvider: providerEl.value });
  syncProviderUI();
});
modelEl.addEventListener("input", () => {
  proofModels[providerEl.value] = modelEl.value.trim();
  chrome.storage.local.set({ proofModels });
});
// 从下拉选中模型 → 填入模型框并持久化到当前后端
function pickModel(selectEl) {
  if (!selectEl.value) return;
  modelEl.value = selectEl.value;
  proofModels[providerEl.value] = selectEl.value;
  chrome.storage.local.set({ proofModels });
}
orFreeModelEl.addEventListener("change", () => pickModel(orFreeModelEl));
geminiModelEl.addEventListener("change", () => pickModel(geminiModelEl));
refreshModelsBtn.addEventListener("click", () => loadFreeModels(true));
refreshGeminiBtn.addEventListener("click", () => loadGeminiModels(true));
proofRulesEl.addEventListener("input", () => {
  chrome.storage.local.set({ proofRules: proofRulesEl.value });
});
resetRulesBtn.addEventListener("click", () => {
  proofRulesEl.value = DEFAULT_PROOF_RULES;
  chrome.storage.local.set({ proofRules: DEFAULT_PROOF_RULES });
  statusEl.textContent = "已恢复默认校对规则。";
});
videoFolderNameEl.addEventListener("input", () => {
  chrome.storage.local.set({ videoFolderName: videoFolderNameEl.value.trim() });
});

saveKeyBtn.addEventListener("click", () => {
  const p = providerEl.value;
  const key = apiKeyEl.value.trim();
  if (!key) { statusEl.textContent = "请输入 API Key。"; return; }
  proofKeys[p] = key;
  chrome.storage.local.set({ proofKeys }, () => {
    statusEl.textContent = "API Key 已保存。";
  });
  if (p === "gemini") loadGeminiModels(true); // 有 key 后立即拉取 Gemini 模型列表
});

async function getCanvaTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/[^/]*canva\.com\/design\//.test(tab.url || "")) {
    statusEl.textContent = "请在 Canva 设计编辑页（canva.com/design/…）上打开本插件。";
    return null;
  }
  return tab;
}

function setBusy(busy) {
  runBtn.disabled = busy;
  runAddPagesBtn.disabled = busy;
  runUploadVideosBtn.disabled = busy;
  runAnimateBtn.disabled = busy;
  readPosBtn.disabled = busy;
  applyPosBtn.disabled = busy;
  proofreadBtn.disabled = busy;
  if (busy) applyBtn.disabled = true;
}

function startTask(payload) {
  setBusy(true);
  statusEl.textContent = "正在运行…";
  logEl.textContent = "";

  const port = chrome.runtime.connect({ name: "run" });
  port.postMessage(payload);

  port.onMessage.addListener((msg) => {
    if (msg.type === "log") log(msg.text);
    else if (msg.type === "status") statusEl.textContent = msg.text;
    else if (msg.type === "done") {
      statusEl.textContent = msg.ok ? "✅ 完成。" : "⚠️ 已结束（有错误，见日志）。";
      setBusy(false);
    }
  });

  port.onDisconnect.addListener(() => setBusy(false));
}

// —— 校对专用消息通道 ——

function startProofread(payload) {
  setBusy(true);
  pendingCorrections = null;
  applyBtn.disabled = true;
  statusEl.textContent = "正在提取字幕…";
  proofLogEl.innerHTML = "";
  proofLogEl.style.display = "none";
  logEl.textContent = "";

  const port = chrome.runtime.connect({ name: "run" });
  port.postMessage(payload);

  port.onMessage.addListener((msg) => {
    if (msg.type === "log") log(msg.text);
    else if (msg.type === "status") statusEl.textContent = msg.text;
    else if (msg.type === "proofread-result") {
      const corrections = msg.corrections || [];
      if (corrections.length === 0) {
        proofLog("<div style='color:#16a34a;'>未发现需要修正的内容。</div>");
        proofLogEl.style.display = "block";
      } else {
        proofLogEl.style.display = "block";
        proofLog(`<div style="margin-bottom:6px;font-weight:600;">发现 ${corrections.length} 处建议修正：</div>`);
        for (const c of corrections) {
          const pg = c.page ? `<span style="color:#7c3aed;">[第${c.page}页]</span> ` : "";
          proofLog(
            `<div style="margin-bottom:8px;">${pg}` +
            `<span class="diff-del">${esc(c.original)}</span><br/>` +
            `<span class="diff-add">${esc(c.corrected)}</span>` +
            (c.reason ? ` <span class="diff-reason">(${esc(c.reason)})</span>` : "") +
            `</div>`
          );
        }
        pendingCorrections = corrections;
        applyBtn.disabled = false;
      }
      statusEl.textContent = corrections.length
        ? `校对完成，${corrections.length} 处建议。审核后点「应用修正」。`
        : "校对完成，无需修正。";
      setBusy(false);
    }
    else if (msg.type === "done") {
      if (!msg.ok) statusEl.textContent = "⚠️ 校对出错，见日志。";
      setBusy(false);
    }
  });

  port.onDisconnect.addListener(() => setBusy(false));
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// —— 按钮事件 ——

runBtn.addEventListener("click", async () => {
  const size = parseInt(document.getElementById("size").value, 10);
  const threshold = parseInt(document.getElementById("threshold").value, 10);

  if (!size || size < 1 || size > 800) {
    statusEl.textContent = "请输入有效的目标字号（1–800）。";
    return;
  }

  const tab = await getCanvaTab();
  if (!tab) return;

  const allPages = !document.getElementById("currentOnly").checked;
  startTask({ type: "run", tabId: tab.id, size, threshold, allPages });
});

runAddPagesBtn.addEventListener("click", async () => {
  const count = parseInt(document.getElementById("pageCount").value, 10);
  if (!count || count < 1 || count > 200) {
    statusEl.textContent = "请输入有效的页数（1–200）。";
    return;
  }

  const tab = await getCanvaTab();
  if (!tab) return;

  startTask({ type: "add-pages", tabId: tab.id, count });
});

runUploadVideosBtn.addEventListener("click", async () => {
  const folder = videoFolderNameEl.value.trim();
  if (!folder) {
    statusEl.textContent = "请输入 Uploads 文件夹名称。";
    return;
  }

  const tab = await getCanvaTab();
  if (!tab) return;

  startTask({ type: "place-videos", tabId: tab.id, folder });
});

runAnimateBtn.addEventListener("click", async () => {
  const color = normalizeHex(colorHexEl.value);
  if (!color) {
    statusEl.textContent = "请输入有效的颜色（如 #0CC0DF）。";
    return;
  }
  colorHexEl.value = color;
  colorEl.value = color;

  const tab = await getCanvaTab();
  if (!tab) return;

  const allPages = !document.getElementById("currentOnly").checked;
  startTask({ type: "animate", tabId: tab.id, color, allPages });
});

proofreadBtn.addEventListener("click", async () => {
  const provider = providerEl.value;
  const apiKey = apiKeyEl.value.trim(); // 本机代理可为空
  const model = modelEl.value.trim();   // 留空由 background 用默认模型
  const rules = proofRulesEl.value.trim();

  if (PROVIDER_META[provider].needsKey && !apiKey) {
    statusEl.textContent = "请先填写并保存该后端的 API Key。";
    return;
  }

  const tab = await getCanvaTab();
  if (!tab) return;

  const allPages = !document.getElementById("currentOnly").checked;
  startProofread({ type: "proofread", tabId: tab.id, allPages, provider, apiKey, model, rules });
});

applyBtn.addEventListener("click", async () => {
  if (!pendingCorrections || !pendingCorrections.length) return;

  const tab = await getCanvaTab();
  if (!tab) return;

  const allPages = !document.getElementById("currentOnly").checked;
  applyBtn.disabled = true;
  startTask({ type: "apply-corrections", tabId: tab.id, corrections: pendingCorrections, allPages });
  pendingCorrections = null;
});

readPosBtn.addEventListener("click", async () => {
  const tab = await getCanvaTab();
  if (!tab) return;

  setBusy(true);
  statusEl.textContent = "正在读取位置…";
  logEl.textContent = "";

  const port = chrome.runtime.connect({ name: "run" });
  port.postMessage({ type: "read-position", tabId: tab.id });

  port.onMessage.addListener((msg) => {
    if (msg.type === "log") log(msg.text);
    else if (msg.type === "status") statusEl.textContent = msg.text;
    else if (msg.type === "position-result") {
      posXEl.value = msg.x;
      posYEl.value = msg.y;
      statusEl.textContent = `已读取位置：X=${msg.x}, Y=${msg.y}`;
      setBusy(false);
    }
    else if (msg.type === "done") {
      if (!msg.ok) statusEl.textContent = "⚠️ 读取位置失败，见日志。";
      setBusy(false);
    }
  });

  port.onDisconnect.addListener(() => setBusy(false));
});

applyPosBtn.addEventListener("click", async () => {
  const x = posXEl.value.trim();
  const y = posYEl.value.trim();
  if (!x || !y) {
    statusEl.textContent = "请先填写或读取 X/Y 坐标。";
    return;
  }

  const tab = await getCanvaTab();
  if (!tab) return;

  const allPages = !document.getElementById("currentOnly").checked;
  startTask({ type: "set-position", tabId: tab.id, x, y, allPages });
});

const DEFAULTS = {
  enabled: true,
  debugMarker: true,
  sourceLang: "en",
  targetLang: "zh-Hans",
  fontScale: 100,
};

const ids = ["enabled", "debugMarker", "sourceLang", "targetLang", "fontScale"];
let fontScaleSaveTimer = 0;

function normalizeFontScale(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULTS.fontScale;
  return Math.min(400, Math.max(50, Math.round(parsed / 10) * 10));
}

function updateFontScaleLabel() {
  const scale = normalizeFontScale(document.getElementById("fontScale").value);
  document.getElementById("fontScaleValue").textContent = `${scale}%`;
}

function showStatus(text) {
  const el = document.getElementById("status");
  el.hidden = false;
  el.textContent = text;
}

function readForm() {
  return {
    enabled: document.getElementById("enabled").checked,
    debugMarker: document.getElementById("debugMarker").checked,
    sourceLang: document.getElementById("sourceLang").value,
    targetLang: document.getElementById("targetLang").value,
    fontScale: normalizeFontScale(document.getElementById("fontScale").value),
  };
}

function writeForm(data) {
  document.getElementById("enabled").checked = Boolean(data.enabled);
  document.getElementById("debugMarker").checked = Boolean(data.debugMarker);
  document.getElementById("sourceLang").value = data.sourceLang || DEFAULTS.sourceLang;
  document.getElementById("targetLang").value = data.targetLang || DEFAULTS.targetLang;
  document.getElementById("fontScale").value = String(normalizeFontScale(data.fontScale));
  updateFontScaleLabel();
}

function save() {
  const payload = readForm();
  chrome.runtime.sendMessage({ type: "SET_SETTINGS", payload }, () => {
    if (chrome.runtime.lastError) {
      showStatus("保存失败");
      return;
    }
    showStatus("已保存");
  });
}

chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (res) => {
  writeForm({ ...DEFAULTS, ...(res || {}) });
  // 等设置写入表单后再绑 change，避免加载完成前误把默认值存回 storage
  // writeForm 用 .checked/.value 赋值，不会触发 change
  for (const id of ids) {
    const eventName = id === "fontScale" ? "input" : "change";
    document.getElementById(id).addEventListener(eventName, () => {
      if (id === "fontScale") {
        updateFontScaleLabel();
        // range 在拖动期间会连续触发 input；合并写入以避免触及 sync 写入配额。
        clearTimeout(fontScaleSaveTimer);
        fontScaleSaveTimer = setTimeout(save, 120);
        return;
      }
      save();
    });
  }
});

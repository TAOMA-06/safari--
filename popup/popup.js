const DEFAULTS = {
  enabled: true,
  debugMarker: true,
  sourceLang: "en",
  targetLang: "zh-Hans",
};

const ids = ["enabled", "debugMarker", "sourceLang", "targetLang"];

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
  };
}

function writeForm(data) {
  document.getElementById("enabled").checked = Boolean(data.enabled);
  document.getElementById("debugMarker").checked = Boolean(data.debugMarker);
  document.getElementById("sourceLang").value = data.sourceLang || DEFAULTS.sourceLang;
  document.getElementById("targetLang").value = data.targetLang || DEFAULTS.targetLang;
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
    document.getElementById(id).addEventListener("change", save);
  }
});

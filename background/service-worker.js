/**
 * Background service worker (MV3)
 * Safari 15.4+ / Chrome 均支持 service_worker。
 * 负责设置默认值与 popup ↔ content 的 GET/SET_SETTINGS 中转。
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  debugMarker: true,
  sourceLang: "en",
  targetLang: "zh-Hans",
  // 以 YouTube 原生字幕的百分比概念保存，范围 50%–400%。
  fontScale: 100,
  layout: "stacked", // stacked | side-by-side（Phase 2）
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (existing) => {
    const merged = { ...DEFAULT_SETTINGS, ...existing };
    chrome.storage.sync.set(merged);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_SETTINGS") {
    chrome.storage.sync.get(null, (settings) => {
      sendResponse({ ...DEFAULT_SETTINGS, ...settings });
    });
    return true; // async response
  }

  if (message?.type === "SET_SETTINGS") {
    chrome.storage.sync.set(message.payload || {}, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});

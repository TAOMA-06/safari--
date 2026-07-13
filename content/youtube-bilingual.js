/**
 * YouTube 双语字幕 — Content Script
 *
 * 流程：
 * 1. 注入 page-bridge 读取 captionTracks（主世界）
 * 2. 按设置选原文轨 / 译文轨，拉取 timedtext (fmt=json3)
 * 3. 按时间对齐对齐，叠放 #yt-bilingual-overlay
 */

(() => {
  const MARKER_ID = "yt-bilingual-debug-marker";
  const OVERLAY_ID = "yt-bilingual-overlay";
  const BRIDGE_CHANNEL = "yt-bilingual-bridge";
  const ALIGN_TOLERANCE_MS = 400;
  const STATUS = {
    idle: "idle",
    loading: "loading",
    ready: "ready",
    empty: "empty",
    error: "error",
  };

  /** 语言别名：设置值 → 可能出现在 captionTracks 中的代码 */
  const LANG_ALIASES = {
    en: ["en", "en-US", "en-GB", "en-u000"],
    ja: ["ja", "ja-JP"],
    ko: ["ko", "ko-KR"],
    "zh-Hans": ["zh-Hans", "zh-CN", "zh", "zh-Hans-CN", "zh-Hans-SG"],
    "zh-Hant": ["zh-Hant", "zh-TW", "zh-HK", "zh-Hant-TW", "zh-Hant-HK"],
    es: ["es", "es-ES", "es-MX", "es-419"],
    fr: ["fr", "fr-FR", "fr-CA"],
    de: ["de", "de-DE"],
  };

  /** @type {Record<string, unknown>} */
  let settings = {
    enabled: true,
    debugMarker: true,
    sourceLang: "en",
    targetLang: "zh-Hans",
  };

  /** @type {Array<{ startMs: number, durMs: number, sourceText: string, targetText: string }>} */
  let alignedCues = [];
  let engineStatus = STATUS.idle;
  let statusDetail = "";
  let currentVideoId = null;
  let lastHandledVideoId = null;
  let loadGeneration = 0;
  let rafId = 0;
  let lastRenderedKey = "";
  let bridgeReady = false;
  let bridgeInjected = false;
  let bridgeListenerAttached = false;
  let pendingBridge = new Map();
  let requestSeq = 0;
  let settingsReloadTimer = 0;
  let navigateTimer = 0;

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (res) => {
          if (chrome.runtime.lastError) {
            resolve(settings);
            return;
          }
          if (res) settings = { ...settings, ...res };
          resolve(settings);
        });
      } catch {
        resolve(settings);
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let langChanged = false;
    let enabledChanged = false;

    for (const [key, { newValue }] of Object.entries(changes)) {
      const prev = settings[key];
      settings[key] = newValue;
      if (key === "sourceLang" || key === "targetLang") {
        if (prev !== newValue) langChanged = true;
      }
      if (key === "enabled" && prev !== newValue) enabledChanged = true;
    }

    applyDebugMarker();

    if (!settings.enabled) {
      stopEngine();
      setStatus(STATUS.idle, "已关闭");
      applyDebugMarker();
      return;
    }

    if (enabledChanged || langChanged) {
      clearTimeout(settingsReloadTimer);
      settingsReloadTimer = setTimeout(() => {
        startBilingualEngine({ force: true });
      }, 200);
    }
  });

  // ---------------------------------------------------------------------------
  // Debug marker
  // ---------------------------------------------------------------------------

  function findCaptionWindow() {
    return (
      document.querySelector(".ytp-caption-window-container") ||
      document.querySelector(".caption-window") ||
      document
        .querySelector(".ytp-caption-segment")
        ?.closest(".ytp-caption-window-container")
    );
  }

  function setStatus(next, detail = "") {
    engineStatus = next;
    statusDetail = detail;
  }

  function applyDebugMarker() {
    const existing = document.getElementById(MARKER_ID);

    if (!settings.enabled || !settings.debugMarker) {
      existing?.remove();
      return;
    }

    const captionPresent = Boolean(findCaptionWindow());
    let el = existing;
    if (!el) {
      el = document.createElement("div");
      el.id = MARKER_ID;
      el.setAttribute("role", "status");
      document.documentElement.appendChild(el);
    }

    const statusText = {
      [STATUS.idle]: "待命",
      [STATUS.loading]: "加载字幕中…",
      [STATUS.ready]: `双语就绪 · ${alignedCues.length} 条`,
      [STATUS.empty]: "无可用字幕",
      [STATUS.error]: "加载失败",
    }[engineStatus];

    const base = captionPresent
      ? "双语字幕插件已加载 · 检测到字幕区域"
      : "双语字幕插件已加载 · 等待字幕开启";

    el.textContent = statusDetail
      ? `${base} · ${statusText} · ${statusDetail}`
      : `${base} · ${statusText}`;
    el.dataset.caption = captionPresent ? "1" : "0";
    el.dataset.status = engineStatus;
  }

  // ---------------------------------------------------------------------------
  // Page bridge（主世界）
  // ---------------------------------------------------------------------------

  function ensureBridge() {
    if (bridgeInjected) return;
    bridgeInjected = true;

    if (!bridgeListenerAttached) {
      window.addEventListener("message", onBridgeMessage);
      bridgeListenerAttached = true;
    }

    const src = chrome.runtime.getURL("content/page-bridge.js");
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.dataset.ytBilingual = "1";
    script.onload = () => script.remove();
    script.onerror = () => {
      console.warn("[yt-bilingual] page-bridge 注入失败");
      bridgeInjected = false;
    };
    (document.documentElement || document.head).appendChild(script);
  }

  function onBridgeMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== BRIDGE_CHANNEL) return;

    if (data.direction === "ready") {
      bridgeReady = true;
      return;
    }

    if (data.direction === "response" && data.requestId != null) {
      const pending = pendingBridge.get(data.requestId);
      if (!pending) return;
      pendingBridge.delete(data.requestId);
      pending.resolve(data.payload);
    }
  }

  function bridgeRequest(type, timeoutMs = 4000) {
    ensureBridge();
    const requestId = ++requestSeq;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingBridge.delete(requestId);
        reject(new Error("bridge timeout"));
      }, timeoutMs);

      pendingBridge.set(requestId, {
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
      });

      const send = () => {
        window.postMessage(
          {
            channel: BRIDGE_CHANNEL,
            direction: "request",
            requestId,
            type,
          },
          "*"
        );
      };

      if (bridgeReady) {
        send();
      } else {
        // 桥可能尚未 ready：短轮询再发
        let tries = 0;
        const wait = setInterval(() => {
          tries += 1;
          if (bridgeReady || tries > 20) {
            clearInterval(wait);
            send();
          }
        }, 50);
      }
    });
  }

  /**
   * 兜底：从页面内嵌脚本文本解析 ytInitialPlayerResponse（首屏有效，SPA 后可能过期）
   */
  function parseTracksFromDom() {
    const scripts = document.querySelectorAll("script");
    for (const el of scripts) {
      const text = el.textContent || "";
      if (!text.includes("ytInitialPlayerResponse")) continue;
      const marker = "ytInitialPlayerResponse";
      const idx = text.indexOf(marker);
      if (idx < 0) continue;
      const eq = text.indexOf("=", idx);
      if (eq < 0) continue;
      let i = eq + 1;
      while (i < text.length && /\s/.test(text[i])) i += 1;
      if (text[i] !== "{") continue;
      try {
        const json = extractJsonObject(text, i);
        const data = JSON.parse(json);
        const raw =
          data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        return raw
          .filter((t) => t?.baseUrl)
          .map((t) => ({
            baseUrl: t.baseUrl,
            languageCode: t.languageCode || "",
            kind: t.kind || "",
            name:
              t.name?.simpleText ||
              (Array.isArray(t.name?.runs)
                ? t.name.runs.map((r) => r.text || "").join("")
                : "") ||
              "",
            vssId: t.vssId || "",
            isTranslatable: Boolean(t.isTranslatable),
          }));
      } catch {
        /* try next script */
      }
    }
    return [];
  }

  function extractJsonObject(text, startIdx) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIdx; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(startIdx, i + 1);
      }
    }
    throw new Error("unbalanced json");
  }

  // ---------------------------------------------------------------------------
  // 字幕轨 / timedtext
  // ---------------------------------------------------------------------------

  /**
   * @returns {Promise<Array<{ baseUrl: string, languageCode: string, name?: string, kind?: string, isTranslatable?: boolean }>>}
   */
  async function fetchCaptionTracks() {
    try {
      const payload = await bridgeRequest("GET_CAPTION_TRACKS");
      if (payload?.tracks?.length) {
        if (payload.videoId) currentVideoId = payload.videoId;
        return payload.tracks;
      }
      if (payload?.error) {
        console.warn("[yt-bilingual] bridge error", payload.error);
      }
    } catch (e) {
      console.warn("[yt-bilingual] bridge request failed", e);
    }

    const domTracks = parseTracksFromDom();
    if (domTracks.length) {
      console.log("[yt-bilingual] captionTracks from DOM fallback", domTracks.length);
      return domTracks;
    }
    return [];
  }

  /**
   * @param {string} baseUrl
   * @param {{ tlang?: string }} [opts]
   * @returns {Promise<Array<{ startMs: number, durMs: number, text: string }>>}
   */
  async function fetchTimedText(baseUrl, opts = {}) {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "json3");
    if (opts.tlang) {
      url.searchParams.set("tlang", opts.tlang);
    }

    const res = await fetch(url.toString(), {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`timedtext HTTP ${res.status}`);
    }

    const data = await res.json();
    return parseJson3Events(data);
  }

  function parseJson3Events(data) {
    const events = Array.isArray(data?.events) ? data.events : [];
    /** @type {Array<{ startMs: number, durMs: number, text: string }>} */
    const cues = [];

    for (const ev of events) {
      if (!ev || ev.tStartMs == null) continue;
      if (!Array.isArray(ev.segs) || !ev.segs.length) continue;

      const text = ev.segs
        .map((s) => (s && typeof s.utf8 === "string" ? s.utf8 : ""))
        .join("")
        .replace(/\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (!text || text === "\n") continue;

      cues.push({
        startMs: Number(ev.tStartMs) || 0,
        durMs: Number(ev.dDurationMs) || 1000,
        text,
      });
    }

    return cues;
  }

  function expandLangCodes(code) {
    const key = String(code || "");
    const aliases = LANG_ALIASES[key];
    if (aliases) return aliases.map((c) => c.toLowerCase());
    return [key.toLowerCase()];
  }

  function langMatches(trackLang, wanted) {
    const t = String(trackLang || "").toLowerCase();
    const wantedList = expandLangCodes(wanted);
    if (wantedList.includes(t)) return true;
    // 前缀：en-US vs en
    return wantedList.some(
      (w) => t === w || t.startsWith(`${w}-`) || w.startsWith(`${t}-`)
    );
  }

  /**
   * 选原文轨：优先非 asr 人工轨，再 asr。
   */
  function pickSourceTrack(tracks, sourceLang) {
    const matched = tracks.filter((t) => langMatches(t.languageCode, sourceLang));
    if (!matched.length) {
      // 回退：任意英文 / 第一条
      const en = tracks.filter((t) => langMatches(t.languageCode, "en"));
      const pool = en.length ? en : tracks;
      return pickPreferManual(pool);
    }
    return pickPreferManual(matched);
  }

  function pickPreferManual(tracks) {
    const manual = tracks.find((t) => t.kind !== "asr");
    return manual || tracks[0] || null;
  }

  /**
   * 选译文：已有目标语言轨 → 否则用可翻译原文轨 + tlang。
   * @returns {{ track: object|null, tlang: string|null, mode: string }}
   */
  function pickTargetAccess(tracks, sourceTrack, targetLang) {
    const existing = tracks.filter((t) => langMatches(t.languageCode, targetLang));
    if (existing.length) {
      // 避免与原文完全同一轨
      const different = existing.find(
        (t) => !sourceTrack || t.baseUrl !== sourceTrack.baseUrl
      );
      return {
        track: different || existing[0],
        tlang: null,
        mode: "existing",
      };
    }

    const tlang = expandLangCodes(targetLang)[0] || targetLang;
    if (sourceTrack?.isTranslatable !== false && sourceTrack?.baseUrl) {
      return { track: sourceTrack, tlang, mode: "tlang-source" };
    }

    const anyTranslatable = tracks.find((t) => t.isTranslatable && t.baseUrl);
    if (anyTranslatable) {
      return { track: anyTranslatable, tlang, mode: "tlang-any" };
    }

    return { track: null, tlang: null, mode: "none" };
  }

  /**
   * 按重叠优先、否则最近邻（容差 ALIGN_TOLERANCE_MS）对齐。
   */
  function alignCues(sourceCues, targetCues) {
    if (!sourceCues.length) return [];

    if (!targetCues.length) {
      return sourceCues.map((s) => ({
        startMs: s.startMs,
        durMs: s.durMs,
        sourceText: s.text,
        targetText: "",
      }));
    }

    const targets = targetCues;
    let tip = 0;

    return sourceCues.map((src) => {
      const srcStart = src.startMs;
      const srcEnd = src.startMs + src.durMs;
      const srcMid = srcStart + src.durMs / 2;

      while (tip < targets.length - 1 && targets[tip].startMs + targets[tip].durMs < srcStart - ALIGN_TOLERANCE_MS) {
        tip += 1;
      }

      let best = null;
      let bestScore = Infinity;
      let bestOverlap = 0;

      const from = Math.max(0, tip - 2);
      const to = Math.min(targets.length, tip + 40);

      for (let i = from; i < to; i += 1) {
        const tgt = targets[i];
        const tgtStart = tgt.startMs;
        const tgtEnd = tgt.startMs + tgt.durMs;
        const overlap = Math.min(srcEnd, tgtEnd) - Math.max(srcStart, tgtStart);

        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = tgt;
          bestScore = 0;
          continue;
        }

        if (bestOverlap > 0) continue;

        const tgtMid = tgtStart + tgt.durMs / 2;
        const dist = Math.abs(srcMid - tgtMid);
        if (dist < bestScore) {
          bestScore = dist;
          best = tgt;
        }
      }

      let targetText = "";
      if (best) {
        if (bestOverlap > 0) {
          targetText = best.text;
        } else if (bestScore <= ALIGN_TOLERANCE_MS) {
          targetText = best.text;
        }
      }

      return {
        startMs: src.startMs,
        durMs: src.durMs,
        sourceText: src.text,
        targetText,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Overlay + 时间驱动
  // ---------------------------------------------------------------------------

  function getPlayerRoot() {
    return (
      document.querySelector(".html5-video-player") ||
      document.querySelector("#movie_player")
    );
  }

  function getVideoEl() {
    const root = getPlayerRoot();
    return (
      root?.querySelector("video") ||
      document.querySelector("video.html5-main-video") ||
      document.querySelector("#movie_player video")
    );
  }

  function ensureOverlayHost() {
    let el = document.getElementById(OVERLAY_ID);
    if (el) return el;

    const root = getPlayerRoot();
    if (!root) return null;

    el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.setAttribute("aria-live", "polite");
    el.innerHTML =
      '<span class="yt-bi-line source"></span><span class="yt-bi-line target"></span>';
    root.appendChild(el);
    // DOM 被外部移除后重建时，须清空缓存，否则会跳过往新节点写入文本
    lastRenderedKey = "";
    return el;
  }

  function setNativeCaptionsDimmed(dimmed) {
    document.documentElement.classList.toggle("yt-bilingual-active", Boolean(dimmed));
  }

  function clearOverlay() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) {
      const source = el.querySelector(".yt-bi-line.source");
      const target = el.querySelector(".yt-bi-line.target");
      if (source) source.textContent = "";
      if (target) target.textContent = "";
      el.hidden = true;
    }
    lastRenderedKey = "";
    // 无双语内容时恢复原生字幕可见性（yt-bilingual-active 会 opacity:0 隐藏原生轨）
    setNativeCaptionsDimmed(false);
  }

  function removeOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
    setNativeCaptionsDimmed(false);
    lastRenderedKey = "";
  }

  function findCueAt(timeMs) {
    const cues = alignedCues;
    if (!cues.length) return null;

    let lo = 0;
    let hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cues[mid];
      const end = c.startMs + c.durMs;
      if (timeMs < c.startMs) hi = mid - 1;
      else if (timeMs >= end) lo = mid + 1;
      else return c;
    }

    // 空隙：展示最近刚结束的 cue（短时延续）会显得粘滞，直接返回 null
    return null;
  }

  function renderBilingualOverlay(cue) {
    if (!settings.enabled) {
      clearOverlay();
      setNativeCaptionsDimmed(false);
      return;
    }

    if (!cue || (!cue.sourceText && !cue.targetText)) {
      clearOverlay();
      // 无当前句时不强行隐藏原生字幕，避免空白
      return;
    }

    const el = ensureOverlayHost();
    if (!el) return;

    const key = `${cue.startMs}|${cue.sourceText}|${cue.targetText}`;
    if (key === lastRenderedKey) {
      el.hidden = false;
      setNativeCaptionsDimmed(true);
      return;
    }
    lastRenderedKey = key;

    const sourceEl = el.querySelector(".yt-bi-line.source");
    const targetEl = el.querySelector(".yt-bi-line.target");
    if (sourceEl) {
      sourceEl.textContent = cue.sourceText || "";
      sourceEl.hidden = !cue.sourceText;
    }
    if (targetEl) {
      targetEl.textContent = cue.targetText || "";
      targetEl.hidden = !cue.targetText;
    }
    el.hidden = false;
    setNativeCaptionsDimmed(true);
  }

  function stopTicker() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function tick() {
    rafId = 0;
    if (!settings.enabled || !alignedCues.length) {
      clearOverlay();
      return;
    }

    const video = getVideoEl();
    if (!video) {
      rafId = requestAnimationFrame(tick);
      return;
    }

    // 广告期间主 video 可能仍在播，但广告轨无字幕：保持降级为空
    const timeMs = Math.floor(video.currentTime * 1000);
    renderBilingualOverlay(findCueAt(timeMs));
    rafId = requestAnimationFrame(tick);
  }

  function startTicker() {
    stopTicker();
    if (!settings.enabled || !alignedCues.length) return;
    rafId = requestAnimationFrame(tick);
  }

  function stopEngine() {
    stopTicker();
    alignedCues = [];
    removeOverlay();
  }

  // ---------------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------------

  function getUrlVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const shorts = u.pathname.match(/\/shorts\/([^/?]+)/);
      if (shorts) return shorts[1];
      const embed = u.pathname.match(/\/embed\/([^/?]+)/);
      if (embed) return embed[1];
    } catch {
      /* ignore */
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitForTracks(generation, maxAttempts = 8) {
    for (let i = 0; i < maxAttempts; i += 1) {
      if (generation !== loadGeneration) return null;
      const tracks = await fetchCaptionTracks();
      if (tracks.length) return tracks;
      await sleep(400 + i * 200);
    }
    return [];
  }

  /**
   * 加载用户所选原语言 + 目标语言双轨并进入渲染循环。
   */
  async function startBilingualEngine(opts = {}) {
    if (!settings.enabled) {
      stopEngine();
      setStatus(STATUS.idle, "已关闭");
      applyDebugMarker();
      return;
    }

    const videoId = getUrlVideoId();
    if (!videoId) {
      // 非观看页（首页等）
      stopEngine();
      setStatus(STATUS.idle, "");
      applyDebugMarker();
      return;
    }

    if (!opts.force && videoId === currentVideoId && alignedCues.length) {
      startTicker();
      return;
    }

    const generation = ++loadGeneration;
    currentVideoId = videoId;
    lastHandledVideoId = videoId;
    setStatus(STATUS.loading, videoId);
    applyDebugMarker();
    clearOverlay();

    try {
      const tracks = await waitForTracks(generation);
      if (generation !== loadGeneration) return;

      if (!tracks || !tracks.length) {
        alignedCues = [];
        stopTicker();
        setStatus(STATUS.empty, "无 captionTracks");
        applyDebugMarker();
        console.log("[yt-bilingual] 暂无字幕轨");
        return;
      }

      console.log(
        "[yt-bilingual] tracks",
        tracks.map((t) => `${t.languageCode}${t.kind ? `(${t.kind})` : ""}`)
      );

      const sourceTrack = pickSourceTrack(tracks, settings.sourceLang);
      if (!sourceTrack) {
        alignedCues = [];
        setStatus(STATUS.empty, "无原文轨");
        applyDebugMarker();
        return;
      }

      const targetAccess = pickTargetAccess(
        tracks,
        sourceTrack,
        settings.targetLang
      );

      const sourcePromise = fetchTimedText(sourceTrack.baseUrl);
      let targetPromise;

      if (targetAccess.mode === "none" || !targetAccess.track) {
        targetPromise = Promise.resolve([]);
      } else if (targetAccess.tlang) {
        targetPromise = fetchTimedText(targetAccess.track.baseUrl, {
          tlang: targetAccess.tlang,
        });
      } else {
        targetPromise = fetchTimedText(targetAccess.track.baseUrl);
      }

      const [sourceCues, targetCues] = await Promise.all([
        sourcePromise,
        targetPromise,
      ]);

      if (generation !== loadGeneration) return;

      alignedCues = alignCues(sourceCues, targetCues);

      if (!alignedCues.length) {
        setStatus(STATUS.empty, "字幕为空");
        applyDebugMarker();
        console.log("[yt-bilingual] cues empty");
        return;
      }

      setStatus(
        STATUS.ready,
        `${settings.sourceLang}→${settings.targetLang} · ${targetAccess.mode}`
      );
      applyDebugMarker();
      console.log("[yt-bilingual] aligned cues", alignedCues.length, {
        source: sourceCues.length,
        target: targetCues.length,
        mode: targetAccess.mode,
      });

      startTicker();
    } catch (e) {
      if (generation !== loadGeneration) return;
      console.warn("[yt-bilingual] engine error", e);
      alignedCues = [];
      stopTicker();
      clearOverlay();
      setStatus(STATUS.error, String(e?.message || e));
      applyDebugMarker();
    }
  }

  // ---------------------------------------------------------------------------
  // SPA 导航
  // ---------------------------------------------------------------------------

  let lastUrl = location.href;

  function scheduleEngineReload(reason) {
    clearTimeout(navigateTimer);
    setStatus(STATUS.loading, reason || "切换视频…");
    applyDebugMarker();
    // YouTube 换页后 player response 稍晚才就绪
    navigateTimer = setTimeout(() => startBilingualEngine({ force: true }), 500);
  }

  function onNavigated() {
    const videoId = getUrlVideoId();
    if (videoId && videoId === lastHandledVideoId && alignedCues.length) {
      return;
    }
    console.log("[yt-bilingual] navigation", location.href);
    lastHandledVideoId = videoId;
    stopEngine();
    if (!videoId) {
      setStatus(STATUS.idle, "");
      applyDebugMarker();
      return;
    }
    scheduleEngineReload("切换视频…");
  }

  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavigated();
    }
  }

  const urlWatcher = new MutationObserver(() => {
    checkUrlChange();
    // 节流：仅更新调试条是否检测到字幕区域
    applyDebugMarker();
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async function boot() {
    await loadSettings();
    ensureBridge();
    applyDebugMarker();

    urlWatcher.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    const onYtNavigate = () => {
      lastUrl = location.href;
      onNavigated();
    };
    document.addEventListener("yt-navigate-finish", onYtNavigate);
    window.addEventListener("yt-navigate-finish", onYtNavigate);

    // history API 兜底
    const wrapHistory = (fnName) => {
      const raw = history[fnName];
      if (typeof raw !== "function") return;
      history[fnName] = function (...args) {
        const ret = raw.apply(this, args);
        queueMicrotask(checkUrlChange);
        return ret;
      };
    };
    wrapHistory("pushState");
    wrapHistory("replaceState");
    window.addEventListener("popstate", checkUrlChange);

    console.log("[yt-bilingual] content script ready", {
      enabled: settings.enabled,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
    });

    await startBilingualEngine({ force: true });
  }

  boot();
})();

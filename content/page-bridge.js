/**
 * 运行在页面主世界（MAIN world），读取 ytInitialPlayerResponse / player API。
 * Content Script 通过 window.postMessage 与本脚本通信。
 */
(function () {
  const CHANNEL = "yt-bilingual-bridge";
  const TIMED_TEXT_AUTH_KEYS = [
    "potc",
    "pot",
    "xorb",
    "xobt",
    "xovt",
    "cbrand",
    "cbr",
    "cbrver",
    "c",
    "cver",
    "cplayer",
    "cos",
    "cosver",
    "cplatform",
  ];

  function trackName(track) {
    if (!track?.name) return "";
    if (typeof track.name === "string") return track.name;
    if (track.name.simpleText) return track.name.simpleText;
    if (Array.isArray(track.name.runs)) {
      return track.name.runs.map((r) => r.text || "").join("");
    }
    return "";
  }

  function normalizeTracks(rawTracks) {
    if (!Array.isArray(rawTracks)) return [];
    return rawTracks
      .filter((t) => t && typeof t.baseUrl === "string" && t.baseUrl)
      .map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode || "",
        kind: t.kind || "",
        name: trackName(t),
        vssId: t.vssId || "",
        isTranslatable: Boolean(t.isTranslatable),
      }));
  }

  function readPlayerResponse() {
    const player =
      document.querySelector("#movie_player") ||
      document.querySelector(".html5-video-player");

    if (player && typeof player.getPlayerResponse === "function") {
      try {
        const res = player.getPlayerResponse();
        if (res) return res;
      } catch {
        /* ignore */
      }
    }

    if (window.ytInitialPlayerResponse) {
      return window.ytInitialPlayerResponse;
    }

    try {
      const cfg = window.ytplayer?.config?.args?.player_response;
      if (typeof cfg === "string") return JSON.parse(cfg);
      if (cfg && typeof cfg === "object") return cfg;
    } catch {
      /* ignore */
    }

    return null;
  }

  function getCaptionTracks() {
    const response = readPlayerResponse();
    const raw =
      response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return normalizeTracks(raw);
  }

  function getVideoId() {
    try {
      const player =
        document.querySelector("#movie_player") ||
        document.querySelector(".html5-video-player");
      if (player && typeof player.getVideoData === "function") {
        const data = player.getVideoData();
        if (data?.video_id) return data.video_id;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function getPlayer() {
    return (
      document.querySelector("#movie_player") ||
      document.querySelector(".html5-video-player")
    );
  }

  /**
   * 2026 年的 YouTube timedtext 需要播放器生成的 pot
   * (Proof-of-Origin Token)。captionTracks.baseUrl 本身不再包含该参数，
   * 直接请求会得到 HTTP 200 + 空响应。
   */
  function readTimedTextAuthParams() {
    const videoId = getVideoId();
    let entries = [];
    try {
      entries = performance.getEntriesByType("resource");
    } catch {
      return {};
    }

    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const name = entries[i]?.name;
      if (typeof name !== "string" || !name.includes("/api/timedtext")) {
        continue;
      }
      try {
        const url = new URL(name);
        if (videoId && url.searchParams.get("v") !== videoId) continue;
        const params = {};
        for (const key of TIMED_TEXT_AUTH_KEYS) {
          const value = url.searchParams.get(key);
          if (value) params[key] = value;
        }
        if (params.pot) return params;
      } catch {
        /* try previous resource */
      }
    }
    return {};
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function ensureTimedTextAuthParams(sourceLang) {
    let params = readTimedTextAuthParams();
    if (params.pot) return params;

    // 若用户没有打开原生 CC，先请 YouTube 播放器加载原文轨，
    // 由播放器自身生成 pot；插件叠放就绪后会隐藏原生单语字幕。
    try {
      const player = getPlayer();
      player?.loadModule?.("captions");
      // loadModule 是异步的；立即 setOption 会被播放器静默忽略。
      await sleep(250);
      const response = readPlayerResponse();
      const rawTracks =
        response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const wanted = String(sourceLang || "en").toLowerCase();
      const rawTrack =
        rawTracks.find((track) => {
          const code = String(track?.languageCode || "").toLowerCase();
          return code === wanted || code.startsWith(`${wanted}-`);
        }) || rawTracks[0];
      player?.setOption?.("captions", "track", {
        languageCode: rawTrack?.languageCode || sourceLang || "en",
        kind: rawTrack?.kind || "",
        vssId: rawTrack?.vssId || "",
      });
      player?.setOption?.("captions", "reload", true);
    } catch {
      /* fall through to polling */
    }

    for (let i = 0; i < 12; i += 1) {
      await sleep(150);
      params = readTimedTextAuthParams();
      if (params.pot) return params;
    }
    return {};
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== "request") {
      return;
    }

    if (data.type === "GET_CAPTION_TRACKS") {
      let tracks = [];
      let error = null;
      try {
        tracks = getCaptionTracks();
      } catch (e) {
        error = String(e?.message || e);
      }

      window.postMessage(
        {
          channel: CHANNEL,
          direction: "response",
          requestId: data.requestId,
          type: "GET_CAPTION_TRACKS",
          payload: {
            tracks,
            videoId: getVideoId(),
            timedTextParams: readTimedTextAuthParams(),
            error,
          },
        },
        "*"
      );
      return;
    }

    if (data.type === "GET_TIMEDTEXT_PARAMS") {
      const timedTextParams = await ensureTimedTextAuthParams(data.sourceLang);
      window.postMessage(
        {
          channel: CHANNEL,
          direction: "response",
          requestId: data.requestId,
          type: "GET_TIMEDTEXT_PARAMS",
          payload: { timedTextParams, videoId: getVideoId() },
        },
        "*"
      );
    }
  });

  window.postMessage(
    { channel: CHANNEL, direction: "ready", type: "BRIDGE_READY" },
    "*"
  );
})();

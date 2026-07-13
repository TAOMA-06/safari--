/**
 * 运行在页面主世界（MAIN world），读取 ytInitialPlayerResponse / player API。
 * Content Script 通过 window.postMessage 与本脚本通信。
 */
(function () {
  const CHANNEL = "yt-bilingual-bridge";

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

  window.addEventListener("message", (event) => {
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
            error,
          },
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

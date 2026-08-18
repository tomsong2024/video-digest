/*
 * Bilibili platform adapter.
 *
 * Implements the adapter contract declared in platforms/adapter-base.js.
 * Fetches captions via the official Bilibili player API
 * (api.bilibili.com), which requires the user's SESSDATA cookie as
 * authentication. Public videos with CC subtitles work without the cookie;
 * cookie-gated videos require the user to paste their own SESSDATA in
 * YouTube Digest Settings.
 */

(function () {
  if (!globalThis.YTD_PLATFORMS) {
    throw new Error("adapter-base.js must load before bilibili.js");
  }

  // Bilibili BV id format: "BV" + 10 chars from the base58 alphabet
  // [1-9A-HJ-NP-Za-km-z] (excludes 0, I, O, l). av ids are integers
  // prefixed with "av" (case-insensitive in our matcher; canonicalised
  // to lowercase).
  const BV_REGEX = /^BV[1-9A-HJ-NP-Za-km-z]{10}$/;
  const AV_REGEX = /^av\d+$/i;
  const BILIBILI_VIEW_API = "https://api.bilibili.com/x/web-interface/view";
  // Both endpoints return the same subtitle shape. We try the newer
  // wbi/v2 endpoint first because it is documented to expose AI
  // subtitles that v2 sometimes omits, then fall back to v2 when
  // wbi/v2 fails outright or returns an empty list.
  const BILIBILI_PLAYER_API_V2 = "https://api.bilibili.com/x/player/v2";
  const BILIBILI_PLAYER_API_WBI = "https://api.bilibili.com/x/player/wbi/v2";
  const BILIBILI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

  function normalizeVideoId(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return null;
    if (BV_REGEX.test(trimmed)) return trimmed;
    if (AV_REGEX.test(trimmed)) return trimmed.toLowerCase();
    return null;
  }

  function isBilibiliVideoPath(pathname) {
    if (typeof pathname !== "string") return false;
    if (!pathname.startsWith("/video/")) return false;
    const id = pathname.split("/")[2] || "";
    return BV_REGEX.test(id) || AV_REGEX.test(id);
  }

  function matches(url) {
    if (typeof url !== "string") return false;
    if (!url.startsWith("https://www.bilibili.com/")) return false;
    try {
      const u = new URL(url);
      if (isBilibiliVideoPath(u.pathname)) return true;
      // Bilibili also serves "bangumi" episodes at /bangumi/play/{epid}
      // and short links at /bvid.html. Those can be added later — keep
      // the surface minimal for the first release.
      return false;
    } catch (_) {
      return false;
    }
  }

  function extractVideoId(url) {
    if (typeof url !== "string") return null;
    try {
      const u = new URL(url);
      if (isBilibiliVideoPath(u.pathname)) {
        return normalizeVideoId(u.pathname.split("/")[2] || "");
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  function canonicalUrl(videoId) {
    const id = normalizeVideoId(videoId);
    if (!id) throw new Error("Invalid Bilibili video ID.");
    // Preserve the original case for BV ids — Bilibili URLs are
    // case-sensitive, and the API rejects mismatched casing.
    return `https://www.bilibili.com/video/${id}`;
  }

  /**
   * MAIN-world script used by background.js to read the page's
   * canonical title / author. Bilibili doesn't expose a global player
   * like YouTube's movie_player, so we scrape the standard DOM nodes
   * the public web player renders.
   */
  function getMainWorldScript() {
    return (
      "try {" +
      "  var meta = document.querySelector('meta[name=\"description\"]');" +
      "  var titleEl = document.querySelector(" +
      "    'h1.video-title, h1.title, .video-title, .video-info-title .title'" +
      "  );" +
      "  var authorEl = document.querySelector(" +
      "    '.up-name, .up-info__name, .username, a[data-usercard-mid]'" +
      "  );" +
      "  var metaContent = meta && meta.content ? meta.content : '';" +
      "  var titleText = titleEl && titleEl.textContent" +
      "    ? titleEl.textContent.trim()" +
      "    : '';" +
      "  return {" +
      "    title: titleText || metaContent," +
      "    channelName: authorEl ? authorEl.textContent.trim() : ''," +
      "    description: metaContent," +
      "    duration: 0," +
      "  };" +
      "} catch (e) {" +
      "  return null;" +
      "}"
    );
  }

  // ---- Transcript fetching via the official Bilibili player API ----

  /**
   * Reads the user's SESSDATA cookie from a settings object, preferring
   * the new per-adapter `transcriptKeys.bilibili` slot and falling back
   * to the legacy top-level `bilibiliSessdata` alias so saved settings
   * keep working across the migration window. Returns "" when no cookie
   * is configured so callers can do a plain truthy check.
   */
  function readSessdataCookie(settings) {
    if (!settings) return "";
    const bucket =
      settings.transcriptKeys && settings.transcriptKeys.bilibili;
    if (typeof bucket === "string" && bucket.trim()) return bucket.trim();
    if (typeof settings.bilibiliSessdata === "string") {
      return settings.bilibiliSessdata.trim();
    }
    return "";
  }

  /**
   * Builds the minimal header set the Bilibili web API expects. B站's
   * edge layer rejects requests that arrive without a User-Agent and
   * without an explicit Origin / Referer, so we send them even when no
   * SESSDATA cookie is configured (public videos work anonymously).
   */
  function buildBilibiliHeaders(sessdata) {
    const headers = {
      // Mirrors Chrome 124 on Windows; B站 blocks obviously headless
      // fetch clients that omit a User-Agent.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Referer: "https://www.bilibili.com/",
      Origin: "https://www.bilibili.com",
    };
    if (sessdata) headers["Cookie"] = `SESSDATA=${sessdata}`;
    return headers;
  }

  /**
   * Wraps fetch() so a transport-layer failure (DNS / TLS / aborted /
   * connection refused — surfaced by Chrome as the opaque TypeError
   * "Failed to fetch") becomes a more informative Error that names
   * the URL path. Without this wrapper the side panel would only ever
   * see the bare string "Failed to fetch" with no way to tell which
   * B站 endpoint (view API / player API / subtitle body) actually
   * died. Callers re-throw with their own prefix so the existing
   * "Bilibili view API failed:" / "Bilibili player API failed:" /
   * "Subtitle download failed:" message format stays stable for
   * existing tests and downstream consumers.
   *
   * @param {string} url
   * @param {Object|undefined} headers
   * @returns {Promise<Response>}
   */
  async function bilibiliFetch(url, headers) {
    let response;
    try {
      response = await fetch(url, { headers });
    } catch (networkErr) {
      let path = url;
      try {
        path = new URL(url).pathname;
      } catch (_) {
        // Keep the raw url if URL parsing fails (e.g. relative form
        // tests pass in). The path is for diagnostics only.
      }
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[bilibili.js] transport failure", {
          url,
          path,
          name: networkErr && networkErr.name,
          message: networkErr && networkErr.message,
        });
      }
      throw new Error(
        `network error (${(networkErr && networkErr.message) || "transport failed"}) for ${path}`,
      );
    }
    return response;
  }

  async function readJsonBounded(response) {
    if (!response || !response.ok) return null;
    const reader =
      response.body && response.body.getReader
        ? response.body.getReader()
        : null;
    if (reader) {
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value ? value.byteLength : 0;
        if (bytes > BILIBILI_MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch (_) {}
          throw new Error("Response exceeded size limit");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text.trimStart());
    }
    if (typeof response.text === "function") {
      const text = await response.text();
      if (
        new TextEncoder().encode(text).byteLength >
        BILIBILI_MAX_RESPONSE_BYTES
      ) {
        throw new Error("Response exceeded size limit");
      }
      return JSON.parse(text.trimStart());
    }
    return await response.json();
  }

  async function fetchViewMetadata(bvId, sessdata) {
    const apiUrl = new URL(BILIBILI_VIEW_API);
    apiUrl.searchParams.set("bvid", bvId);
    const headers = buildBilibiliHeaders(sessdata);
    let response;
    try {
      response = await bilibiliFetch(apiUrl.toString(), headers);
    } catch (networkErr) {
      // Surface transport failures (DNS / TLS / aborted / connection
      // refused) with the same "view API failed" prefix the side
      // panel already understands, plus the underlying fetch() reason.
      throw new Error(`Bilibili view API failed: ${networkErr.message}`);
    }
    if (!response || !response.ok) {
      const status = response && response.status;
      // Surface HTTP failures separately so the user can tell network /
      // CORS / WAF blocking apart from real API rejections.
      throw new Error(
        `Bilibili view API failed: HTTP ${status || "no response"}`,
      );
    }
    const data = await readJsonBounded(response);
    if (!data || data.code !== 0 || !data.data || !data.data.cid) {
      const reason =
        (data && (data.message || data.code)) ||
        "Bilibili video metadata unavailable";
      if (typeof console !== "undefined" && console.warn) {
        console.warn(
          "[bilibili.js] view API rejected",
          {bvId, code: data && data.code, message: data && data.message},
        );
      }
      throw new Error(`Bilibili view API failed: ${reason}`);
    }
    return data.data.cid;
  }

  /**
   * Hits a single player-API endpoint and returns its parsed subtitle
   * payload. Throws on transport / API rejection so the caller can decide
   * whether to retry with a different endpoint. Both `x/player/v2` and
   * `x/player/wbi/v2` use this same shape; we treat the response uniformly.
   *
   * @returns {Promise<{subtitles: Array, needLoginSubtitle: boolean}>}
   */
  async function fetchSubtitleListFromEndpoint(apiBase, bvId, cid, sessdata) {
    const apiUrl = new URL(apiBase);
    apiUrl.searchParams.set("bvid", bvId);
    apiUrl.searchParams.set("cid", String(cid));
    const headers = buildBilibiliHeaders(sessdata);
    let response;
    try {
      response = await bilibiliFetch(apiUrl.toString(), headers);
    } catch (networkErr) {
      // Surface transport failures with the same "player API failed"
      // prefix the side panel already understands, plus the failing
      // endpoint path so the user can tell whether it was wbi/v2 or v2.
      throw new Error(`Bilibili player API failed: ${networkErr.message}`);
    }
    if (!response || !response.ok) {
      const status = response && response.status;
      throw new Error(
        `Bilibili player API failed: HTTP ${status || "no response"}`,
      );
    }
    const data = await readJsonBounded(response);
    if (!data || data.code !== 0 || !data.data) {
      const reason =
        (data && (data.message || data.code)) ||
        "Bilibili subtitle list unavailable";
      throw new Error(`Bilibili player API failed: ${reason}`);
    }
    // Bilibili returns `data.subtitle` as an OBJECT { subtitles: [...] }
    // (not as the array itself). Treat both shapes defensively so a
    // future API revision doesn't take the whole flow down with a
    // confusing "Bilibili player API failed: OK" error.
    const subtitlesContainer = data.data.subtitle;
    const subtitles = Array.isArray(subtitlesContainer)
      ? subtitlesContainer
      : Array.isArray(subtitlesContainer && subtitlesContainer.subtitles)
        ? subtitlesContainer.subtitles
        : [];
    // `need_login_subtitle: true` means the track exists but requires the
    // user to log in via SESSDATA — without it we can see that a caption
    // exists but cannot fetch the body. Surface this so the side panel can
    // hint at re-authenticating.
    const needLoginSubtitle = !!(
      data.data && data.data.need_login_subtitle
    );
    return { subtitles, needLoginSubtitle };
  }

  /**
   * Resolves the best available subtitle list for a video. We try the
   * newer `x/player/wbi/v2` endpoint first because it is documented to
   * expose AI subtitles that `x/player/v2` sometimes omits, then fall
   * back to `x/player/v2` when wbi/v2 fails outright or returns an empty
   * list.
   *
   * Throws only when BOTH endpoints fail — a single-endpoint failure
   * (likely a transient HTTP 412 / network blip on wbi/v2) is treated as
   * "best effort, keep going" so we don't lose subtitles when v2 still
   * works. When both endpoints fail the side panel surfaces the original
   * BILIBILI_PLAYER_ERROR message so the user can re-login / refresh
   * SESSDATA instead of seeing a generic "no transcript" wall.
   *
   * @returns {Promise<{subtitles: Array, needLoginSubtitle: boolean}>}
   */
  async function fetchSubtitleList(bvId, cid, sessdata) {
    let wbiResult = null;
    let wbiError = null;
    try {
      wbiResult = await fetchSubtitleListFromEndpoint(
        BILIBILI_PLAYER_API_WBI,
        bvId,
        cid,
        sessdata,
      );
    } catch (err) {
      wbiError = err;
      if (typeof console !== "undefined" && console.warn) {
        console.warn(
          "[bilibili.js] wbi/v2 player API rejected",
          {bvId, cid, message: err && err.message},
        );
      }
    }
    if (wbiResult && wbiResult.subtitles.length > 0) {
      if (
        typeof console !== "undefined" &&
        console.warn &&
        wbiResult.needLoginSubtitle
      ) {
        console.warn(
          "[bilibili.js] player API succeeded but subtitles require login",
          {bvId, count: wbiResult.subtitles.length},
        );
      }
      return wbiResult;
    }
    let v2Result = null;
    let v2Error = null;
    try {
      v2Result = await fetchSubtitleListFromEndpoint(
        BILIBILI_PLAYER_API_V2,
        bvId,
        cid,
        sessdata,
      );
    } catch (err) {
      v2Error = err;
      if (typeof console !== "undefined" && console.warn) {
        console.warn(
          "[bilibili.js] v2 player API rejected",
          {bvId, cid, message: err && err.message},
        );
      }
    }
    if (v2Result && v2Result.subtitles.length > 0) {
      return {
        subtitles: v2Result.subtitles,
        // Prefer wbi/v2's flag if it set it — v2 sometimes omits the flag
        // when it can't see the gated tracks at all.
        needLoginSubtitle:
          (wbiResult && wbiResult.needLoginSubtitle) ||
          v2Result.needLoginSubtitle,
      };
    }
    if (v2Error) {
      // Both endpoints failed — surface the v2 error (typically the more
      // informative one since it's the stable, widely-used API). The wbi
      // error is already logged above.
      throw v2Error;
    }
    if (typeof console !== "undefined" && console.warn) {
      // Reaching this point means both endpoints succeeded but neither
      // had any subtitles to offer (or wbi failed but v2 succeeded empty).
      // Surface the raw state so future Bilibili response-shape regressions
      // are visible in the service-worker console without having to re-run
      // a network capture. The flag is preserved for debugging gated videos.
      console.warn(
        "[bilibili.js] both player API endpoints returned no usable subtitles",
        {
          bvId,
          wbiFailed: !!wbiError,
          wbiNeedLogin: !!(wbiResult && wbiResult.needLoginSubtitle),
          v2NeedLogin: !!(v2Result && v2Result.needLoginSubtitle),
        },
      );
    }
    return {
      subtitles: [],
      needLoginSubtitle: !!(
        (wbiResult && wbiResult.needLoginSubtitle) ||
        (v2Result && v2Result.needLoginSubtitle)
      ),
    };
  }

  function pickPreferredSubtitle(subtitles) {
    if (!subtitles.length) return null;
    // Prefer Simplified Chinese, then any Chinese variant, then the
    // first available track. Bilibili may serve auto-generated
    // subtitles with a lan value starting with "ai" — treat those as
    // last-resort fallbacks.
    const exactZhHans = subtitles.find(
      (s) => s && s.lan && /^zh-Hans$/i.test(s.lan),
    );
    if (exactZhHans) return exactZhHans;
    const anyChinese = subtitles.find(
      (s) => s && s.lan && /^zh/i.test(s.lan),
    );
    if (anyChinese) return anyChinese;
    const manual = subtitles.find((s) => s && s.type === 0);
    if (manual) return manual;
    return subtitles[0];
  }

  /**
   * Normalises a subtitle URL returned by Bilibili's player API.
   *
   * Bilibili returns subtitle bodies at URLs like
   *   //aisubtitle.hdslb.com/bfs/ai_subtitle/prod/<id>?auth_key=...
   * — a protocol-relative form. That works in a document context where
   * the URL inherits the page's protocol, but the MV3 service worker
   * has no base URL, so fetch("//host/path") throws the opaque
   * "Failed to fetch" TypeError. B站's subtitle CDN is always served
   * over HTTPS, so we default to https:// for protocol-relative URLs.
   * Path-relative URLs ("/bfs/...") can't be salvaged — the host is
   * missing — so we throw an informative error rather than letting
   * fetch() produce a more confusing message.
   */
  function normalizeBilibiliSubtitleUrl(url) {
    if (typeof url !== "string" || !url) {
      throw new Error(
        `Invalid subtitle URL: ${typeof url === "string" ? "(empty)" : String(url)}`,
      );
    }
    if (url.startsWith("//")) {
      return "https:" + url;
    }
    if (url.startsWith("/")) {
      throw new Error(
        `Invalid subtitle URL (path-relative without host): ${url.slice(0, 80)}`,
      );
    }
    return url;
  }

  async function downloadSubtitleBody(subtitleUrl) {
    // Normalise protocol-relative URLs BEFORE calling fetch. Without
    // this the MV3 service worker can't resolve "//host/path" and the
    // failure surfaces as a bare "Failed to fetch" with no way to tell
    // it was just a missing scheme prefix.
    const normalizedUrl = normalizeBilibiliSubtitleUrl(subtitleUrl);
    let response;
    try {
      response = await bilibiliFetch(normalizedUrl, undefined);
    } catch (networkErr) {
      // Surface transport failures with the same "Subtitle download
      // failed" prefix the side panel already understands, plus the
      // subtitle host's path so the user can tell whether their
      // network or B站's CDN is the bottleneck.
      throw new Error(`Subtitle download failed: ${networkErr.message}`);
    }
    if (!response.ok) {
      throw new Error(
        "Subtitle download failed: HTTP " + response.status,
      );
    }
    return await readJsonBounded(response);
  }

  function parseSubtitleBody(body) {
    const transcript = [];
    let plainText = "";
    let timestampedText = "";
    if (!body || !Array.isArray(body.body)) {
      return {
        transcript,
        transcriptText: "",
        transcriptTextTimestamped: "",
        language: null,
      };
    }
    for (const chunk of body.body) {
      if (!chunk) continue;
      const text = String(chunk.content || "").trim();
      if (!text) continue;
      const fromSeconds = Number(chunk.from) || 0;
      const toSeconds = Number(chunk.to) || 0;
      const minutes = Math.floor(fromSeconds / 60);
      const seconds = Math.floor(fromSeconds % 60);
      const timestamp =
        minutes + ":" + String(seconds).padStart(2, "0");
      transcript.push({
        text,
        start: fromSeconds,
        duration: Math.max(0, toSeconds - fromSeconds),
        language: null,
      });
      plainText += text + " ";
      timestampedText += "[" + timestamp + "] " + text + "\n";
    }
    const detectedLang =
      (typeof body.lan === "string" && body.lan) ||
      (typeof body.lan_doc === "string" && body.lan_doc) ||
      null;
    return {
      transcript,
      transcriptText: plainText.trim(),
      transcriptTextTimestamped: timestampedText.trim(),
      language: detectedLang,
    };
  }

  async function fetchTranscript({ videoId, settings }) {
    const sessdata = readSessdataCookie(settings);
    if (!sessdata) {
      return {
        success: false,
        error: "NO_BILIBILI_COOKIE",
        message:
          "Bilibili SESSDATA cookie not configured. Open YouTube Digest Settings.",
      };
    }

    const normalizedId = normalizeVideoId(videoId);
    if (!normalizedId) {
      return {
        success: false,
        error: "INVALID_VIDEO_ID",
        message: "Invalid Bilibili video ID.",
      };
    }

    // The public view/player API only accepts BV ids; av ids need a
    // client-side conversion that we don't ship yet. Surface a clear
    // error so the UI can guide users to open the BV version of the URL.
    if (AV_REGEX.test(normalizedId)) {
      return {
        success: false,
        error: "AV_NOT_SUPPORTED",
        message:
          "av-numbered Bilibili videos are not supported yet. Open the BV version of this URL.",
      };
    }

    let cid;
    try {
      cid = await fetchViewMetadata(normalizedId, sessdata);
    } catch (err) {
      return {
        success: false,
        error: "BILIBILI_VIEW_ERROR",
        message: err.message || "Bilibili video metadata unavailable.",
      };
    }

    // `fetchSubtitleList` resolves with `{subtitles, needLoginSubtitle}`
    // when at least one of the two endpoints (wbi/v2, then v2) returns a
    // well-formed response — empty or not. It only throws when BOTH
    // endpoints fail, which usually means the SESSDATA expired or B站 is
    // rate-limiting us; that case surfaces as BILIBILI_PLAYER_ERROR so the
    // side panel can prompt the user to refresh their cookie. A "video
    // has no subtitles" case resolves cleanly to NO_TRANSCRIPT below.
    let subtitleList;
    try {
      subtitleList = await fetchSubtitleList(normalizedId, cid, sessdata);
    } catch (err) {
      return {
        success: false,
        error: "BILIBILI_PLAYER_ERROR",
        message: err.message || "Bilibili subtitle list unavailable.",
      };
    }
    const subtitles = subtitleList.subtitles;
    const needLoginSubtitle = !!subtitleList.needLoginSubtitle;

    const preferred = pickPreferredSubtitle(subtitles);
    if (!preferred || !preferred.subtitle_url) {
      // When B站 reports `need_login_subtitle: true` we know captions
      // exist on the video but are gated behind SESSDATA. The side
      // panel surfaces a re-login hint in this case; we still send a
      // NO_TRANSCRIPT so the rest of the failure-handling UX keeps
      // working unchanged.
      const message = needLoginSubtitle
        ? "No subtitle track is available for this Bilibili video. The video has subtitles but they require logging in via SESSDATA — paste your cookie in YouTube Digest Settings."
        : "No subtitle track is available for this Bilibili video.";
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message,
      };
    }

    let body;
    try {
      body = await downloadSubtitleBody(preferred.subtitle_url);
    } catch (err) {
      return {
        success: false,
        error: "SUBTITLE_DOWNLOAD_ERROR",
        message: err.message || "Subtitle file download failed.",
      };
    }

    const parsed = parseSubtitleBody(body);
    if (parsed.transcript.length === 0) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message: "Bilibili returned an empty subtitle body.",
      };
    }

    return {
      success: true,
      source: "native",
      transcript: parsed.transcript,
      transcriptText: parsed.transcriptText,
      transcriptTextTimestamped: parsed.transcriptTextTimestamped,
      language: parsed.language || preferred.lan || null,
    };
  }

  globalThis.YTD_PLATFORMS.register({
    id: "bilibili",
    matches: matches,
    extractVideoId: extractVideoId,
    canonicalUrl: canonicalUrl,
    getMainWorldScript: getMainWorldScript,
    fetchTranscript: fetchTranscript,
    playerSelectors: {
      // Bilibili renders the toolbar as `.video-toolbar` with an inner
      // left/right split. The "like / coin / favorite / share" row lives
      // inside `.toolbar-left`; we preprend the Digest button there.
      actionBarRow: ".video-toolbar, .toolbar",
      actionBarGroup:
        ".video-toolbar .toolbar-left, .video-toolbar-left, .toolbar-left",
      actionBarFallback:
        ".video-toolbar, .toolbar, #toolbar, .bpx-player-toolbar",
      playerContainer:
        "#bilibili-player, .bilibili-player, .bpx-player-container, .bpx-player",
      videoElement: "video",
      titleElement:
        "h1.video-title, h1.title, .video-title, .video-info-title .title",
      channelElement:
        ".up-name, .up-info__name, .username, a[data-usercard-mid]",
      descriptionElement:
        ".desc-info-text, .video-desc, .description, .bpx-player-video-info__desc",
    },
    // Bilibili uses hash-based SPA navigation; the player fires a
    // popstate that the page-level router catches. content.js listens
    // for `popstate` natively, so we don't need a custom event name.
    spaNavigationEvent: "",
  });
})();
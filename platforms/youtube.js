/*
 * YouTube platform adapter.
 *
 * Migrated from background.js's handleFetchTranscript / getPlayerVideoDetails
 * and content.js's hard-coded selectors. Behaviour must be identical to the
 * pre-refactor implementation.
 */

(function () {
  if (!globalThis.YTD_PLATFORMS) {
    throw new Error("adapter-base.js must load before youtube.js");
  }

  const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{6,20}$/;

  function normalizeVideoId(raw) {
    const trimmed = String(raw || "").trim();
    if (!VIDEO_ID_REGEX.test(trimmed)) return null;
    return trimmed;
  }

  function matches(url) {
    if (typeof url !== "string") return false;
    if (!url.startsWith("https://www.youtube.com/")) return false;
    try {
      const u = new URL(url);
      if (u.pathname === "/watch") return !!u.searchParams.get("v");
      // YouTube Shorts intentionally do not have native captions, but we
      // still let the adapter match — the transcript fetcher will return
      // NO_TRANSCRIPT naturally and ASR can be wired up later.
      if (u.pathname.startsWith("/shorts/")) {
        return !!u.pathname.split("/")[2];
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  function extractVideoId(url) {
    if (typeof url !== "string") return null;
    try {
      const u = new URL(url);
      if (u.pathname === "/watch") {
        return normalizeVideoId(u.searchParams.get("v"));
      }
      if (u.pathname.startsWith("/shorts/")) {
        return normalizeVideoId(u.pathname.split("/")[2] || "");
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  function canonicalUrl(videoId) {
    const id = normalizeVideoId(videoId);
    if (!id) throw new Error("Invalid YouTube video ID.");
    return `https://www.youtube.com/watch?v=${id}`;
  }

  /**
   * Returns the function body executed inside the page's MAIN world to read
   * canonical videoDetails. The result MUST be JSON-serialisable or null.
   */
  function getMainWorldScript() {
    return (
      "try {" +
      "  var player = document.getElementById('movie_player');" +
      "  var details = player && player.getPlayerResponse && player.getPlayerResponse();" +
      "  details = details && details.videoDetails;" +
      "  if (!details) return null;" +
      "  return {" +
      "    title: details.title || ''," +
      "    channelName: details.author || ''," +
      "    description: details.shortDescription || ''," +
      "    duration: Number(details.lengthSeconds) || 0," +
      "  };" +
      "} catch (e) {" +
      "  return null;" +
      "}"
    );
  }

  // ---- Transcript fetching via Supadata ----

  const SUPADATA_ENDPOINT = "https://api.supadata.ai/v1/transcript";
  const SUPADATA_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const POLL_MAX_ATTEMPTS = 60;
  const POLL_INTERVAL_MS = 1000;

  async function readJsonBounded(response) {
    if (!response.ok) return null;
    const reader = response.body && response.body.getReader
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
        if (bytes > SUPADATA_MAX_RESPONSE_BYTES) {
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
      if (new TextEncoder().encode(text).byteLength > SUPADATA_MAX_RESPONSE_BYTES) {
        throw new Error("Response exceeded size limit");
      }
      return JSON.parse(text.trimStart());
    }
    return await response.json();
  }

  function parseSupadataContent(data) {
    const transcript = [];
    let plainText = "";
    let timestampedText = "";
    if (!data || !Array.isArray(data.content)) {
      return {
        transcript,
        transcriptText: "",
        transcriptTextTimestamped: "",
        language: null,
      };
    }
    for (const chunk of data.content) {
      if (!chunk || !chunk.text) continue;
      const cleanText = String(chunk.text).replace(/>> ?/g, "").trim();
      if (!cleanText) continue;
      const startSeconds = Math.floor((chunk.offset || 0) / 1000);
      const minutes = Math.floor(startSeconds / 60);
      const seconds = startSeconds % 60;
      const timestamp =
        minutes + ":" + String(seconds).padStart(2, "0");
      transcript.push({
        text: cleanText,
        start: startSeconds,
        duration: Math.floor((chunk.duration || 0) / 1000),
        language: chunk.lang || data.lang || null,
      });
      plainText += cleanText + " ";
      timestampedText += "[" + timestamp + "] " + cleanText + "\n";
    }
    return {
      transcript,
      transcriptText: plainText.trim(),
      transcriptTextTimestamped: timestampedText.trim(),
      language: typeof data.lang === "string" ? data.lang : null,
    };
  }

  /**
   * Reads the Supadata API key from a settings object, preferring the new
   * per-adapter `transcriptKeys.youtube` slot and falling back to the legacy
   * top-level `supadataApiKey` alias. Returns "" when no key is configured so
   * callers can do a plain truthy check.
   */
  function readSupadataApiKey(settings) {
    if (!settings) return "";
    const bucket =
      settings.transcriptKeys && settings.transcriptKeys.youtube;
    if (typeof bucket === "string" && bucket.trim()) return bucket.trim();
    return typeof settings.supadataApiKey === "string"
      ? settings.supadataApiKey.trim()
      : "";
  }

  async function pollTranscriptJob(jobId, supadataApiKey) {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise(function (resolve) {
        setTimeout(resolve, POLL_INTERVAL_MS);
      });
      const response = await fetch(
        SUPADATA_ENDPOINT + "/" + encodeURIComponent(jobId),
        { headers: { "x-api-key": supadataApiKey } },
      );
      if (!response.ok) {
        throw new Error("Job polling failed: " + response.status);
      }
      const data = await readJsonBounded(response);
      if (data && data.status === "completed") {
        const parsed = parseSupadataContent(data);
        if (parsed.transcript.length === 0) {
          return {
            success: false,
            error: "EMPTY_TRANSCRIPT",
            message: "Supadata returned an empty transcript for this video.",
          };
        }
        return { success: true, source: "native", transcript: parsed.transcript, transcriptText: parsed.transcriptText, transcriptTextTimestamped: parsed.transcriptTextTimestamped, language: parsed.language };
      }
      if (data && data.status === "failed") {
        throw new Error("Transcript processing failed");
      }
    }
    throw new Error("Transcript job timed out after 60 seconds");
  }

  async function fetchTranscript({ videoId, settings }) {
    // Transcript-provider keys live in `settings.transcriptKeys.youtube`
    // after Stage 2-1. We still tolerate the legacy top-level
    // `supadataApiKey` alias so direct callers and pre-normalize shapes
    // (e.g. older saved settings) keep working during the migration window.
    const supadataApiKey = readSupadataApiKey(settings);
    if (!supadataApiKey) {
      return {
        success: false,
        error: "NO_SUPADATA_KEY",
        message:
          "Supadata API key not configured. Open YouTube Digest Settings.",
      };
    }

    let canonicalVideoUrl;
    try {
      canonicalVideoUrl = canonicalUrl(videoId);
    } catch (err) {
      return { success: false, error: "INVALID_VIDEO_ID", message: err.message };
    }

    const apiUrl = new URL(SUPADATA_ENDPOINT);
    apiUrl.searchParams.set("url", canonicalVideoUrl);
    apiUrl.searchParams.set("text", "false");
    apiUrl.searchParams.set("lang", "en");
    apiUrl.searchParams.set("mode", "native");

    let response;
    try {
      response = await fetch(apiUrl.toString(), {
        method: "GET",
        headers: { "x-api-key": supadataApiKey },
      });
    } catch (err) {
      return {
        success: false,
        error: err && err.message ? err.message : "Network error",
        message: err && err.message ? err.message : "Network error",
      };
    }

    if (response.status === 202) {
      const jobData = await readJsonBounded(response);
      return await pollTranscriptJob(jobData && jobData.jobId, supadataApiKey);
    }

    if (response.status === 206) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "No native subtitle track is available for this video.",
      };
    }

    if (!response.ok) {
      if (response.status === 401) {
        return {
          success: false,
          error: "INVALID_SUPADATA_KEY",
          message:
            "Your Supadata API key is invalid. Open YouTube Digest Settings.",
        };
      }
      if (response.status === 404) {
        return {
          success: false,
          error: "NO_TRANSCRIPT",
          message: "No subtitles found for this video.",
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          error: "RATE_LIMITED",
          message:
            "Supadata rate limit reached. Please wait a minute and try again.",
        };
      }
      return {
        success: false,
        error: "SUPADATA_ERROR_" + response.status,
        message: "Supadata API error: " + response.status,
      };
    }

    const data = await readJsonBounded(response);
    const parsed = parseSupadataContent(data);
    if (parsed.transcript.length === 0) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message: "Supadata returned an empty transcript for this video.",
      };
    }
    return {
      success: true,
      source: "native",
      transcript: parsed.transcript,
      transcriptText: parsed.transcriptText,
      transcriptTextTimestamped: parsed.transcriptTextTimestamped,
      language: parsed.language,
    };
  }

  globalThis.YTD_PLATFORMS.register({
    id: "youtube",
    matches: matches,
    extractVideoId: extractVideoId,
    canonicalUrl: canonicalUrl,
    getMainWorldScript: getMainWorldScript,
    fetchTranscript: fetchTranscript,
    playerSelectors: {
      // Action bar: the row of native buttons next to Like / Share.
      actionBarRow:
        "ytd-watch-metadata #actions-inner",
      // The button group container that our Digest button is prepended into.
      actionBarGroup:
        "ytd-watch-metadata #actions-inner #top-level-buttons-computed",
      // Fallback selectors used when the primary row isn't visible.
      actionBarFallback:
        "ytd-watch-metadata #actions #top-level-buttons-computed," +
        " ytd-watch-metadata #top-level-buttons-computed," +
        " #primary #actions #top-level-buttons-computed",
      // Player container we overlay the Note button on.
      playerContainer:
        "#movie_player.html5-video-player, #movie_player, .html5-video-player",
      // The HTML5 <video> element whose currentTime we read / seek.
      videoElement: "video.html5-main-video",
      // DOM scrapers used when getMainWorldScript() fails (rare on YouTube).
      titleElement:
        "h1.ytd-watch-metadata yt-formatted-string, #title h1 yt-formatted-string",
      channelElement:
        "#channel-name yt-formatted-string a, ytd-channel-name yt-formatted-string a",
      descriptionElement:
        "#description-inner," +
        " ytd-watch-metadata #description yt-attributed-string," +
        " #description yt-formatted-string," +
        " ytd-expander#description yt-attributed-string",
    },
    spaNavigationEvent: "yt-navigate-finish",
  });
})();
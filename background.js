/**
 * BACKGROUND SERVICE WORKER
 *
 * This is the "brain" of the extension. It runs in the background and handles:
 * 1. Opening the side panel when the user clicks the extension icon
 * 2. Fetching YouTube transcripts via Supadata API
 * 3. Calling the AI provider to analyze the transcript
 * 4. Sending results back to the side panel
 *
 * Think of it like a backend server — it does the heavy lifting
 * so the UI (side panel) can stay fast and responsive.
 */

// Import safe defaults and validation helpers. Secret keys live in
// chrome.storage.local and are never part of the extension source.
importScripts("settings.js");

// Platform adapters — registry first, then each concrete adapter. The registry
// is idempotent across service-worker restarts; concrete adapters self-register
// at load time.
importScripts("platforms/adapter-base.js");
importScripts("platforms/youtube.js");
importScripts("platforms/bilibili.js");

const DEBUG = false;
const AI_PROVIDER_IDLE_TIMEOUT_MS = 50_000;
const AI_PROVIDER_HARD_TIMEOUT_MS = 120_000;
const AI_PROVIDER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// Prevent the YouTube content script from reading API keys or cached data.
// Side panel, options, and service-worker contexts remain trusted.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[YouTube Digest] Could not restrict storage access:", error),
  );

async function getSettings() {
  const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
  return YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
}

/**
 * Resolves the platform adapter that owns the sender's tab.
 *
 * Content-script messages carry `sender.tab.url` directly; side-panel messages
 * don't, so we fall back to the active tab. Returns null when the current
 * tab isn't a recognised video page — callers must handle that gracefully.
 */
async function resolveAdapterFromSender(sender) {
  const senderUrl = sender?.tab?.url;
  if (senderUrl) {
    const adapter = YTD_PLATFORMS.findByUrl(senderUrl);
    if (adapter) return adapter;
  }
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    const url = tabs[0]?.url;
    return url ? YTD_PLATFORMS.findByUrl(url) : null;
  } catch (_) {
    return null;
  }
}

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`Could not load prompt file: ${fileName}`);
    }
    // Normalize line endings once on first read. Windows checkouts with
    // core.autocrlf=true hand us CRLF, but every downstream pattern in this
    // helper (section boundaries, fenced code blocks, variable substitution)
    // assumes LF. Normalizing here keeps the parser side-effect free and means
    // tests + CI run identically regardless of the developer's git config.
    markdown = (await response.text()).replace(/\r\n?/g, "\n");
    promptFileCache.set(fileName, markdown);
  }

  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`Prompt section not found: ${fileName}#${heading}`);
  }

  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    const error = new Error(
      "AI API key not configured. Open YouTube Digest Settings.",
    );
    error.code = "NO_AI_KEY";
    throw error;
  }
  const body = {
    model: settings.aiModel,
    max_tokens: maxTokens,
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  // MiniMax-M3 defaults to `thinking: { type: "adaptive" }` and emits a
  // `<think>...</think>` block in the response. Product features (analyze /
  // translate / explain / save) need bounded, predictable latency and don't
  // want the thinking trace bleeding into the UI, so we explicitly disable
  // it. Per the MiniMax M3 Chat Completions schema, the field is only
  // meaningful on MiniMax-M3 (M2.x models ignore it), and DeepSeek's API
  // doesn't define it — sending it to either other provider could confuse
  // their parsers or silently no-op, so we scope it to MiniMax-M3 only.
  if (settings.provider === "minimax") {
    body.thinking = { type: "disabled" };
  }

  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimeoutId;
  let hardTimeoutId;
  const abortForTimeout = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = setTimeout(
      () => abortForTimeout("idle"),
      AI_PROVIDER_IDLE_TIMEOUT_MS,
    );
  };

  hardTimeoutId = setTimeout(
    () => abortForTimeout("hard"),
    AI_PROVIDER_HARD_TIMEOUT_MS,
  );
  resetIdleTimeout();
  try {
    const response = await fetch(
      YTD_SETTINGS.chatCompletionsUrl(settings),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.aiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    // Receiving headers proves the AI provider is still making progress.
    // The provider may then send blank-line body chunks while a non-streaming
    // request queues.
    resetIdleTimeout();

    const data = await readBoundedAiResponse(response, resetIdleTimeout);
    if (!response.ok) {
      const errorData = data && typeof data === "object" ? data : {};
      const error = new Error(
        errorData.error?.message ||
          errorData.message ||
          `AI provider error: ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      const error = new Error("AI provider returned an empty response.");
      error.code = "EMPTY_AI_RESPONSE";
      throw error;
    }

    return { text, settings };
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeoutError = new Error(
        "AI request was inactive for 50 seconds. Please Retry.",
      );
      timeoutError.code = "AI_IDLE_TIMEOUT";
      throw timeoutError;
    }
    if (timeoutKind === "hard") {
      const timeoutError = new Error(
        "AI request exceeded the 120-second limit. Please Retry.",
      );
      timeoutError.code = "AI_HARD_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimeoutId);
    clearTimeout(hardTimeoutId);
  }
}

/**
 * Surfaces AI provider failures from a consumer (analyze / translate /
 * explain / save) without making them look like code bugs.
 *
 * `requestAiCompletion()` decorates transport failures and HTTP rejections
 * with `.status` (HTTP status) and `.code` (typed codes like NO_AI_KEY /
 * AI_IDLE_TIMEOUT / EMPTY_AI_RESPONSE). When the failure is just a
 * misconfigured API key (HTTP 401), an exhausted quota (HTTP 429), or a
 * missing key (NO_AI_KEY), we log a console.warn with an actionable hint
 * pointing at YouTube Digest Settings instead of a generic console.error.
 * Anything else (network drops, malformed responses, timeouts, parse
 * errors, ...) keeps the original console.error severity so genuine bugs
 * stay visible in bug reports.
 *
 * @param {string} label — Short tag identifying the consumer, e.g.
 *   "Analysis", "Translation". Used inside the log prefix.
 * @param {unknown} error — The error thrown by `requestAiCompletion()`.
 */
function logAiConsumerError(label, error) {
  if (error && error.status === 401) {
    console.warn(
      `[YouTube Digest] ${label} skipped: AI provider rejected the API key. Update it in YouTube Digest Settings.`,
      error.message,
    );
    return;
  }
  if (error && error.status === 429) {
    console.warn(
      `[YouTube Digest] ${label} skipped: AI provider rate-limited the request. Try again shortly.`,
      error.message,
    );
    return;
  }
  if (error && error.code === "NO_AI_KEY") {
    console.warn(
      `[YouTube Digest] ${label} skipped: AI provider key not configured. Open YouTube Digest Settings to add one.`,
    );
    return;
  }
  console.error(`[YouTube Digest] ${label}:`, error);
}

async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let responseText = "";
    let responseBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Every received chunk is activity, including the AI provider's blank
      // lines.
      onActivity();
      const byteLength = value?.byteLength ?? 0;
      responseBytes += byteLength;
      if (responseBytes > AI_PROVIDER_MAX_RESPONSE_BYTES) {
        await reader.cancel?.().catch(() => {});
        const error = new Error("AI provider response exceeded the 2 MiB limit.");
        error.code = "AI_RESPONSE_TOO_LARGE";
        throw error;
      }
      responseText += decoder.decode(value, { stream: true });
    }
    responseText += decoder.decode();
    return JSON.parse(responseText.trimStart());
  }

  // Some fetch implementations do not expose a readable stream. Preserve a
  // bounded body read for that case.
  if (typeof response.text === "function") {
    const responseText = await response.text();
    onActivity();
    const byteLength = new TextEncoder().encode(responseText).byteLength;
    if (byteLength > AI_PROVIDER_MAX_RESPONSE_BYTES) {
      const error = new Error("AI provider response exceeded the 2 MiB limit.");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    return JSON.parse(responseText.trimStart());
  }

  // Legacy/test fetch shims may expose only json(). The hard and idle timers
  // still bound this fallback even though chunk-level activity is unavailable.
  const data = await response.json();
  onActivity();
  return data;
}

// ============================================================
// SIDE PANEL SETUP
// ============================================================

/**
 * When the user clicks the extension icon, open the side panel.
 * Chrome's Side Panel API lets us show a persistent panel alongside the page.
 */
chrome.action.onClicked.addListener((tab) => {
  // Re-enable + open without awaiting — preserves user gesture context
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "sidepanel.html",
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * Allow the side panel to open on any page, but it's designed for YouTube.
 */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

/**
 * Keep the side panel scoped to tabs that match a registered platform adapter.
 *
 * Chrome side panels are "global" by default: once opened, the panel follows
 * you to every tab. To make YouTube Digest behave like a per-video tool, we
 * enable the panel on tabs that any registered adapter recognises and disable
 * it everywhere else. Disabling on a tab makes Chrome hide/close the panel for
 * that tab, so it never lingers on a new tab or some other website.
 *
 * We have to react to BOTH things that can change "what tab you're looking at":
 *   - onUpdated: the current tab navigates to a new URL
 *   - onActivated: you switch to (or open) a different tab
 * The original code only handled onUpdated, which is why the panel stayed
 * visible when switching to an already-loaded non-video tab.
 */
function updatePanelForTab(tabId, url) {
  // Any registered adapter that recognises this URL means we have UI for it.
  // A future platform (B站, Vimeo, ...) just has to register itself here.
  const adapter = YTD_PLATFORMS.findByUrl(url);
  const enabled = !!adapter;
  // setOptions can reject if the tab just closed — ignore that harmlessly.
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled })
    .catch(() => {});
}

// A tab navigated to a new URL.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return; // ignore title/favicon-only updates
  updatePanelForTab(tabId, changeInfo.url);
});

// The user switched to a different tab (or opened a new one).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updatePanelForTab(tabId, tab.url);
  } catch (e) {
    // Tab vanished before we could read it — nothing to do.
  }
});

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel and content script.
 * This is like a switchboard — different "actions" trigger different handlers.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We need to return true to indicate we'll respond asynchronously
  if (message.action === "fetchTranscript") {
    // videoUrl is optional — background.js falls back to the active tab.
    handleFetchTranscript({
      videoId: message.videoId,
      videoUrl: message.videoUrl,
      videoTitle: message.videoTitle,
      channelName: message.channelName,
      description: message.description,
    })
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response
  }

  if (message.action === "analyzeTranscript") {
    // Pass video duration to help the AI validate timestamps
    handleAnalyzeTranscript(
      message.transcriptText,
      message.videoTitle,
      message.channelName,
      message.videoDescription,
      message.videoDuration,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "explainSelection") {
    // Explain selected text using the AI provider.
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === "saveNote") {
    // Save a note at the current timestamp. The adapter is resolved from the
    // sender's tab URL when available (content script); otherwise we fall back
    // to the active tab so the side panel path still works.
    resolveAdapterFromSender(sender).then((adapter) => {
      handleSaveNote({
        videoId: message.videoId,
        timestamp: message.timestamp,
        videoTitle: message.videoTitle,
        channelName: message.channelName,
        adapter,
      })
        .then(sendResponse)
        .catch((err) =>
          sendResponse({ success: false, error: err.message }),
        );
    });
    return true;
  }

  if (message.action === "getNotes") {
    // Get all saved notes
    handleGetNotes(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "deleteNote") {
    // Delete a specific note
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getVideoInfo") {
    handleGetVideoInfo(message.tabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  // Translation: send content to the AI provider.
  if (message.action === "translateContent") {
    handleTranslateContent(
      message.content,
      message.contentType,
      message.targetLanguage,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Punctuation restore: ask the AI provider to insert Chinese sentence
  // punctuation into a transcript that arrived without any. The side panel
  // uses this for the original tab and the export pipeline; failures fall
  // back to the local heuristic.
  if (message.action === "punctuateTranscript") {
    handleAddPunctuation(message.transcriptText, message.videoTitle)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "checkConfig") {
    getSettings()
      .then((settings) => {
        // Per-adapter transcript-key status. Iterating the registered
        // adapter ids means new platforms (e.g. bilibili) show up here
        // automatically once they're added to YTD_SETTINGS.TRANSCRIPT_ADAPTER_IDS.
        const transcriptKeysStatus = {};
        for (const adapterId of YTD_SETTINGS.TRANSCRIPT_ADAPTER_IDS) {
          transcriptKeysStatus[adapterId] = !!YTD_SETTINGS.transcriptKeyFor(
            settings,
            adapterId,
          );
        }
        const providerId = settings.provider;
        sendResponse({
          transcriptKeysStatus,
          // Legacy alias for the YouTube key. Kept so existing consumers
          // (sidepanel.js) keep reading it transparently until they migrate
          // to the per-platform shape in Stage 2-1f.
          hasSupadataKey: !!transcriptKeysStatus.youtube,
          hasAiKey: !!settings.aiApiKey,
          // Stage 3: expose the active AI provider so the side panel can
          // name the exact service (DeepSeek / MiniMax M3) in its
          // "missing key" copy instead of a generic "AI provider".
          provider: providerId,
          aiProviderLabel:
            YTD_SETTINGS.aiProviderField(providerId, "label") || providerId,
          // Stage nc01: expose the Notescollection token status so the side
          // panel can enable/disable the push button.
          hasNotescollectionToken: !!settings.notescollectionToken,
        });
      })
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  // Stage nc01: Push current video digest to Notescollection.
  if (message.action === "pushToNotescollection") {
    handlePushToNotescollection(message.videoId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "openSidePanel") {
    const tabId = sender.tab?.id;
    debugLog("[YouTube Digest BG] openSidePanel requested from tab:", tabId);

    // Re-enable the panel (it may have been disabled by auto-close) and open it.
    // IMPORTANT: we call setOptions + open synchronously (no await between them)
    // to preserve the user gesture context. Chrome requires sidePanel.open()
    // to be called within a user gesture — awaiting anything first can expire it.
    if (tabId) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
      chrome.sidePanel
        .open({ tabId })
        .then(() => {
          // Broadcast to side panel to start digest (in case it's already open)
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "startDigestFromButton" })
              .catch(() => {});
          }, 300);
        })
        .catch((err) => {
          console.error("[YouTube Digest BG] openSidePanel error:", err);
        });
    } else {
      // Fallback: find the active tab
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then((tabs) => {
          if (tabs[0]) {
            chrome.sidePanel.setOptions({
              tabId: tabs[0].id,
              path: "sidepanel.html",
              enabled: true,
            });
            chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
              console.error(
                "[YouTube Digest BG] openSidePanel fallback error:",
                err,
              );
            });
          }
        });
    }

    sendResponse({ success: true });
    return false;
  }

  // Relay messages from side panel to content script
  if (message.action === "relayToContent") {
    debugLog("[YouTube Digest BG] Relay request:", message.payload?.action);
    (async () => {
      try {
        // Pick the best target tab in priority order:
        //   1. The last-focused window's active tab (typical user case)
        //   2. Any active tab whose URL a registered adapter recognises
        //   3. Any tab whose URL a registered adapter recognises
        // This replaces the old "query YouTube tabs" fallback chain so it
        // works for B站 / Vimeo / X / 抖音 without further surgery.
        let tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        debugLog(
          "[YouTube Digest BG] Active tab in last focused window:",
          tabs.length,
          tabs[0]?.url,
        );

        let target = tabs[0];
        if (!target || !YTD_PLATFORMS.findByUrl(target.url)) {
          tabs = await chrome.tabs.query({ active: true });
          target = tabs.find((tab) => YTD_PLATFORMS.findByUrl(tab.url)) || null;
          debugLog(
            "[YouTube Digest BG] Active adapter-matching tabs:",
            tabs.length,
            "→ chosen:",
            target?.url,
          );
        }

        if (!target) {
          const allTabs = await chrome.tabs.query({});
          target = allTabs.find((tab) => YTD_PLATFORMS.findByUrl(tab.url)) || null;
          debugLog(
            "[YouTube Digest BG] Any adapter-matching tabs → chosen:",
            target?.url,
          );
        }

        if (target) {
          debugLog(
            "[YouTube Digest BG] Sending to tab:",
            target.id,
            "URL:",
            target.url,
          );
          let response = null;
          try {
            response = await chrome.tabs.sendMessage(
              target.id,
              message.payload,
            );
          } catch (err) {
            // The content script's onMessage listener may not be attached
            // yet — common races: the MV3 service worker just woke up, the
            // tab was just (re-)opened, the page is still pre-`document_idle`,
            // or the user navigated and reloaded. This is recoverable: the
            // MAIN-world `getPlayerVideoDetails` fallback below does not
            // depend on the content script, so we demote this to a warning
            // (not an error) and let the rest of the flow run.
            console.warn(
              "[YouTube Digest BG] Content script not responsive for relay; trying MAIN-world fallback where applicable:",
              message.payload?.action,
              err.message,
            );
          }

          // For getVideoInfo, PREFER the platform adapter's canonical player
          // data over the DOM scrape. The adapter's getMainWorldScript reads
          // its native player object (movie_player on YouTube, equivalent on
          // other sites) and returns the FULL description; DOM scrapes are
          // truncated. Fall back to DOM only for fields the player missed.
          //
          // This path runs unconditionally — it injects a MAIN-world script
          // via chrome.scripting.executeScript which does NOT require the
          // content script to be listening, so it covers the "content script
          // not responsive" race above and keeps the side panel's getVideoInfo
          // call from ever failing because of a stale listener registration.
          if (message.payload?.action === "getVideoInfo") {
            const playerInfo = await getPlayerVideoDetails(target.id);
            if (playerInfo) {
              response = {
                title: playerInfo.title || response?.title || "",
                channelName:
                  playerInfo.channelName || response?.channelName || "",
                duration: playerInfo.duration || response?.duration || 0,
                description:
                  playerInfo.description || response?.description || "",
              };
            }
            // Always resolve getVideoInfo with a structured (possibly
            // empty) response so the side panel can read `.title` etc.
            // without first null-checking.
            debugLog(
              "[YouTube Digest BG] Got getVideoInfo response:",
              response || "(empty)",
            );
            sendResponse({
              success: true,
              response: response || {
                title: "",
                channelName: "",
                description: "",
                duration: 0,
              },
            });
          } else if (response != null) {
            debugLog("[YouTube Digest BG] Got response from content:", response);
            sendResponse({ success: true, response });
          } else {
            // Non-getVideoInfo actions (seekTo / getCurrentTime /
            // highlightMoments) genuinely need the content script's
            // listener — there's no MAIN-world mirror. Surface the
            // condition as a structured failure (warn, not error) so the
            // caller can decide how to degrade without seeing a noisy
            // console.error stack.
            console.warn(
              "[YouTube Digest BG] Relay action has no MAIN-world fallback:",
              message.payload?.action,
            );
            sendResponse({
              success: false,
              error:
                "Content script not responsive in target tab for " +
                (message.payload?.action || "unknown") +
                ".",
            });
          }
        } else {
          debugLog("[YouTube Digest BG] No supported video tab found");
          sendResponse({ success: false, error: "No supported video tab found" });
        }
      } catch (err) {
        // Catch-all for unexpected failures during the relay orchestration
        // itself (tab gone mid-flight, executor rejected, etc.). Demoted
        // from console.error because a single noisy line in the SW console
        // is more confusing than helpful — keep this as a warn.
        console.warn(
          "[YouTube Digest BG] Relay orchestration error:",
          err.message,
        );
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});

/**
 * Reads the current video's canonical details straight from its native player.
 *
 * Content scripts live in an isolated world and can't touch the page's own
 * JavaScript. But with the "scripting" permission we can run a tiny function
 * in the page's MAIN world, where each platform's player object lives.
 *
 * Each adapter exposes `getMainWorldScript()` — a function body that returns
 * a JSON-serialisable object with title / channelName / description /
 * duration, or null on failure. The result MUST be JSON-serialisable; that
 * is the only contract that crosses the MAIN/world boundary.
 *
 * Returns null on any failure so callers can fall back to DOM scraping.
 */
async function getPlayerVideoDetails(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    return null;
  }
  const adapter = YTD_PLATFORMS.findByUrl(tab?.url);
  if (
    !adapter ||
    typeof adapter.getMainWorldScript !== "function"
  ) {
    return null;
  }
  try {
    // The script is a plain function body (not an expression), so wrap it in
    // `new Function(...)` to get a callable. Chrome serialises the function
    // via toString() and re-creates it in the MAIN world; the body must not
    // close over anything from this service worker.
    const fn = new Function(adapter.getMainWorldScript());
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: fn,
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[YTD] Player details unavailable:", e.message);
    return null;
  }
}

// ============================================================
// TRANSCRIPT FETCHING — ROUTED VIA PLATFORM ADAPTER
// ============================================================

/**
 * Resolves which platform adapter owns the active tab and delegates the
 * transcript fetch to it. Each adapter encapsulates its own API client
 * (Supadata for YouTube, the B站 / Vimeo / X / 抖音 equivalents later) and
 * returns the same TranscriptResult shape.
 *
 * @param {Object} args
 * @param {string} args.videoId  - The canonical platform video ID.
 * @param {string} [args.videoUrl] - Optional canonical watch URL. When
 *   omitted we fall back to the last-active tab's URL so existing side-panel
 *   callers that only know videoId keep working during the migration.
 * @returns {Promise<TranscriptResult>}
 */
async function handleFetchTranscript({ videoId, videoUrl, videoTitle, channelName, description } = {}) {
  try {
    // Resolve the URL in priority order: explicit arg → active tab.
    let resolvedUrl = typeof videoUrl === "string" && videoUrl ? videoUrl : null;
    if (!resolvedUrl) {
      try {
        const tabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        if (tabs[0]?.url) resolvedUrl = tabs[0].url;
      } catch (_) {
        // No active tab (e.g. service worker invoked from options page).
      }
    }

    const adapter = resolvedUrl ? YTD_PLATFORMS.findByUrl(resolvedUrl) : null;
    if (!adapter || typeof adapter.fetchTranscript !== "function") {
      return {
        success: false,
        error: "UNSUPPORTED_PLATFORM",
        message:
          "The current video platform is not supported by YouTube Digest.",
      };
    }

    // Build cache key and store video metadata alongside the transcript.
    const cacheData = {
      videoTitle: videoTitle || "",
      channelName: channelName || "",
      description: description || "",
      videoUrl: resolvedUrl || "",
      videoId,
      adapterId: adapter.id,
      cachedAt: Date.now(),
    };
    // Store metadata first (async, don't block transcript fetch)
    const cacheKey = `digest_${adapter.id}_${videoId}`;
    chrome.storage.local.set({ [cacheKey]: cacheData }).catch(() => {});

    const settings = await getSettings();
    return await adapter.fetchTranscript({ videoId, settings, metadata: cacheData });
  } catch (error) {
    console.error("[YTD] Transcript fetch error:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch transcript",
    };
  }
}

// ============================================================
// JSON HELPER
// ============================================================

/**
 * Parses JSON returned by an LLM, tolerating the small mistakes they sometimes
 * make. Some models occasionally emit a trailing
 * comma before a ] or }, or wraps the JSON in prose / code fences. Plain
 * JSON.parse throws on those, which is what caused the "Unexpected token ']'"
 * error on the Overview tab. This function strips fences, isolates the outer
 * JSON object, removes trailing commas, and only then parses.
 *
 * @param {string} text - The raw text from the model
 * @returns {Object} - The parsed object (throws if still unparseable)
 */
function parseLooseJson(text) {
  let cleaned = (text || "").trim();

  // Strip ```json ... ``` style code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  // MiniMax-M3 sometimes leaves a <think>...</think> trace in
  // `choices[0].message.content` even when `thinking: {type: "disabled"}`
  // was requested (e.g. on the no-`response_format` retry path, or when the
  // provider silently ignores the field). The block can contain JSON-shaped
  // examples that would otherwise break our "first { to last }" isolation.
  // Strip it before isolating braces. Non-greedy so we only remove fully
  // closed blocks; an unclosed <think> is left in place so subsequent
  // isolation either finds the real JSON or fails loudly.
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // Isolate the outermost { ... } in case the model added a sentence around it
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    // Most common LLM slip: a trailing comma right before a } or ].
    // e.g. ["a", "b", ]  ->  ["a", "b" ]
    const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

// ============================================================
// AI ANALYSIS
// ============================================================

/**
 * Sends the transcript to the AI provider for analysis.
 *
 * The prompt asks the model to produce chapters covering the whole video
 * and 3-5 key quotes with timestamps.
 *
 * @param {string} transcriptText - The full transcript as plain text
 * @param {string} videoTitle - The video title
 * @param {string} channelName - The channel name
 * @returns {Object} - { success, analysis } or { success: false, error }
 */
async function handleAnalyzeTranscript(
  transcriptText,
  videoTitle,
  channelName,
  videoDescription,
  videoDuration,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI API key not configured. Open YouTube Digest Settings.",
      };
    }

    // Convert duration to MM:SS format for context
    // The transcript text is already prefixed with [M:SS] markers. Its LAST
    // marker is the most reliable signal of where the content actually ends —
    // more trustworthy than the duration metadata, which is sometimes missing
    // or wrong. We use the larger of (metadata duration, last transcript stamp).
    let lastTranscriptSeconds = 0;
    const stampMatches = transcriptText.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last =
        stampMatches[stampMatches.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(videoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;

    // The "last chapter must be after" threshold (75% in) forces the model to
    // cover the WHOLE video instead of front-loading chapters near the start.
    // We do NOT prescribe a chapter count — the model picks the natural splits.
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: videoTitle || "Unknown",
      channelName: channelName || "Unknown",
      videoDescription: videoDescription || "No description available",
      transcriptText,
    };
    const systemPrompt = await loadPromptSection(
      "analysis.md",
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadPromptSection(
      "analysis.md",
      "User prompt",
      promptVariables,
    );

    debugLog("[YouTube Digest] Requesting video analysis", settings.aiModel);
    const { text: responseText } = await requestAiCompletion({
      maxTokens: 8192,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    // Parse the JSON, tolerating trailing commas / stray prose
    let analysis = parseLooseJson(responseText);

    // Treat every model response as untrusted data. Rebuild the supported
    // schema and derive display timestamps from validated numeric seconds.
    analysis = validateAndFixTimestamps(analysis, maxTimestampSeconds);

    return {
      success: true,
      analysis: analysis,
    };
  } catch (error) {
    logAiConsumerError("Analysis", error);
    if (error.status === 401) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: "AI provider rejected the API key.",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "AI provider rate-limited this request. Try again shortly.",
      };
    }
    return {
      success: false,
      error: error.message || "Failed to analyze transcript",
    };
  }
}

/**
 * Validates all timestamps in the analysis and fixes any that exceed video duration.
 * This is a safety net to prevent hallucinated timestamps from reaching the UI.
 *
 * @param {Object} analysis - The parsed analysis from AI provider
 * @param {number} maxSeconds - Maximum valid timestamp in seconds
 * @returns {Object} - Analysis with validated timestamps
 */
function validateAndFixTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;

  // Helper to format seconds as MM:SS
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };

  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (
    Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : []
  )
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (
    Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : []
  )
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return { chapters, keyQuotes, keyMoments };
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Gets video info (title, channel, description) from the active YouTube tab.
 * We do this by asking the content script to read the page.
 */
async function handleGetVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "getVideoInfo",
    });
    return response;
  } catch (error) {
    return { title: "", channelName: "", description: "" };
  }
}

// ============================================================
// EXPLAIN SELECTION
// ============================================================

/**
 * Explains selected text using the AI provider.
 * Provides context, definitions, and clarification for complex terms.
 *
 * @param {string} selectedText - The text the user selected
 * @param {string} transcriptContext - Surrounding transcript for context
 * @param {string} videoTitle - Video title for additional context
 * @returns {Object} - { success, explanation } or { success: false, error }
 */
// ============================================================
// NOTE MANAGEMENT
// ============================================================

/**
 * Saves a note at the current timestamp.
 * Fetches the transcript if needed, finds the relevant line, and cleans it up.
 *
 * The note's adapter id is captured alongside the video id so future stages
 * can scope / migrate notes per-platform; the digest cache key is also
 * prefixed by adapter id so B站 and YouTube digests don't collide.
 */
async function handleSaveNote({
  videoId,
  timestamp,
  videoTitle,
  channelName,
  adapter,
}) {
  try {
    if (!adapter) {
      return {
        success: false,
        error: "UNSUPPORTED_PLATFORM",
        message: "Cannot save notes on this page.",
      };
    }
    const adapterId = adapter.id;
    const canonicalVideoUrl = adapter.canonicalUrl(videoId);
    const cacheKey = `digest_${adapterId}_${videoId}`;
    const safeTimestamp = Math.max(0, Math.floor(Number(timestamp) || 0));

    // First, try to get the transcript from the digest cache. The side panel
    // saves digests to chrome.storage.LOCAL — this used to look in
    // storage.session (the wrong store), so it missed every time and
    // refetched the transcript from Supadata on every saved note.
    let transcript = null;
    try {
      const cached = await chrome.storage.local.get(cacheKey);
      if (cached[cacheKey]?.transcript) {
        transcript = cached[cacheKey].transcript;
        debugLog(`[YTD] Using cached transcript for note (${adapterId})`);
      }
    } catch (e) {
      debugLog("[YTD] No cached transcript, fetching...");
    }

    // If no cached transcript, fetch it
    if (!transcript) {
      const transcriptResult = await handleFetchTranscript({
        videoId,
        videoUrl: canonicalVideoUrl,
      });
      if (!transcriptResult.success) {
        return { success: false, error: "Could not fetch transcript" };
      }
      transcript = transcriptResult.transcript;
    }

    // Find the transcript line at the current timestamp
    // Look for the line that contains this timestamp (or the closest one before)
    let matchedLine = null;
    let matchedIndex = 0;
    let contextLines = [];
    let beforeLine = null; // a few sentences before
    let afterLine = null; // a few sentences after

    for (let i = 0; i < transcript.length; i++) {
      const line = transcript[i];
      if (
        line.start <= safeTimestamp &&
        (!transcript[i + 1] || transcript[i + 1].start > safeTimestamp)
      ) {
        matchedLine = line;
        matchedIndex = i;

        // Build a buffer of 2 lines before and 4 lines after the target.
        // This gives the model enough text to find a natural sentence boundary
        // and complete a thought that spans multiple short caption chunks.
        const beforeLines = [];
        for (let j = 1; j <= 2 && i - j >= 0; j++) {
          beforeLines.unshift(transcript[i - j].text);
        }
        if (beforeLines.length > 0) {
          beforeLine = beforeLines.join(" ");
        }

        const afterLines = [];
        for (let j = 1; j <= 4 && i + j < transcript.length; j++) {
          afterLines.push(transcript[i + j].text);
        }
        if (afterLines.length > 0) {
          afterLine = afterLines.join(" ");
        }

        // Get broader context (8 lines before and 12 lines after) for understanding
        const startIdx = Math.max(0, i - 8);
        const endIdx = Math.min(transcript.length - 1, i + 12);
        for (let j = startIdx; j <= endIdx; j++) {
          contextLines.push(transcript[j].text);
        }
        break;
      }
    }

    if (!matchedLine) {
      // Fallback: use the last line if timestamp is beyond transcript
      matchedLine = transcript[transcript.length - 1];
      matchedIndex = transcript.length - 1;

      // Get buffer sentence (only before, since we're at the end)
      const beforeLines = [];
      for (let j = 1; j <= 2 && matchedIndex - j >= 0; j++) {
        beforeLines.unshift(transcript[matchedIndex - j].text);
      }
      if (beforeLines.length > 0) {
        beforeLine = beforeLines.join(" ");
      }

      const startIdx = Math.max(0, matchedIndex - 8);
      for (let j = startIdx; j <= matchedIndex; j++) {
        contextLines.push(transcript[j].text);
      }
    }

    // Clean up the text with the AI provider.
    const cleanedText = await cleanupNoteText(
      matchedLine.text,
      beforeLine,
      afterLine,
      contextLines.join(" "),
      videoTitle,
    );

    // Format timestamp as MM:SS
    const minutes = Math.floor(safeTimestamp / 60);
    const seconds = safeTimestamp % 60;
    const formattedTimestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    // Create timestamped URL. NOTE: `&t=` is YouTube's query-param style;
    // each future adapter that uses fragment-style or a different separator
    // should expose a `timestampedUrl(videoId, seconds)` method.
    const timestampedUrl = `${canonicalVideoUrl}&t=${safeTimestamp}s`;

    // Create the note object. `adapterId` is captured so multi-platform
    // notes can be filtered / migrated independently. Old notes without it
    // are treated as YouTube notes by sidepanel.js for backward compat.
    const note = {
      id: `note_${Date.now()}`,
      adapterId: adapterId,
      videoId: videoId,
      videoTitle:
        typeof videoTitle === "string"
          ? videoTitle.slice(0, 500)
          : "Untitled Video",
      channelName:
        typeof channelName === "string" ? channelName.slice(0, 300) : "",
      timestamp: formattedTimestamp,
      timestampSeconds: safeTimestamp,
      timestampedUrl: timestampedUrl,
      text: cleanedText,
      rawText: matchedLine.text,
      createdAt: Date.now(),
    };

    // Save to storage
    await saveNoteToStorage(note);

    // Notify side panel to refresh notes list
    chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

    return { success: true, note };
  } catch (error) {
    logAiConsumerError("Save note", error);
    return { success: false, error: error.message };
  }
}

/**
 * Cleans up transcript lines using the AI provider.
 * Takes the target line plus buffer sentences (1 before, 1 after).
 * Uses JSON output to prevent any preambles from appearing.
 */
async function cleanupNoteText(
  targetText,
  beforeText,
  afterText,
  fullContext,
  videoTitle,
) {
  const settings = await getSettings();
  if (!settings.aiApiKey) {
    return [beforeText, targetText, afterText].filter(Boolean).join(" ");
  }

  try {
    debugLog("[YouTube Digest] Requesting note cleanup");
    const variables = {
      videoTitle: videoTitle || "Unknown",
      fullContext,
      beforeText: beforeText || "(none)",
      targetText,
      afterText: afterText || "(none)",
    };
    const systemPrompt = await loadPromptSection(
      "note-cleanup.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "note-cleanup.md",
      "User prompt",
      variables,
    );
    const { text: resultText } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    let result = resultText.trim() || targetText;

    // Parse the JSON response (tolerating trailing commas / fences).
    try {
      const parsed = parseLooseJson(result);
      if (typeof parsed.quote === "string" && parsed.quote.trim()) {
        return parsed.quote.trim().slice(0, 3000);
      }
    } catch (parseError) {
      console.warn(
        "[YouTube Digest] JSON parse failed for note, stripping preambles:",
        parseError,
      );
      result = result.replace(
        /^(Here'?s?( the)?( cleaned)?( version)?:?\s*)/i,
        "",
      );
      result = result.replace(
        /^(The cleaned (quote|text|version)( is)?:?\s*)/i,
        "",
      );
      result = result.replace(/^(I will.*?:?\s*)/i, "");
      result = result.replace(/^(Cleaned:?\s*)/i, "");
      result = result.replace(/^["']|["']$/g, "");
    }

    return result.slice(0, 3000);
  } catch (e) {
    // `requestAiCompletion()` decorates transport failures and HTTP
    // rejections with `.status` (HTTP status) and `.code` (typed
    // codes like NO_AI_KEY / AI_IDLE_TIMEOUT). Surface them as
    // actionable console.warn instead of a generic error so a
    // misconfigured AI key / exhausted quota doesn't look like a
    // code bug. The note is still saved with the raw-text fallback
    // returned below — the cleanup step is best-effort polish, not
    // a hard requirement for a note to exist.
    if (e && e.status === 401) {
      console.warn(
        "[YouTube Digest] Note saved without AI polish: AI provider rejected the API key. Update it in YouTube Digest Settings.",
        e.message,
      );
    } else if (e && e.status === 429) {
      console.warn(
        "[YouTube Digest] Note saved without AI polish: AI provider rate-limited the request. Try again shortly.",
        e.message,
      );
    } else if (e && e.code === "NO_AI_KEY") {
      console.warn(
        "[YouTube Digest] Note saved without AI polish: AI provider key not configured. Open YouTube Digest Settings to add one.",
      );
    } else {
      console.error("[YouTube Digest] Cleanup error:", e);
    }
  }

  // Return combined raw text if cleanup fails
  return [beforeText, targetText, afterText].filter(Boolean).join(" ");
}

/**
 * Saves a note to chrome.storage.local
 */
async function saveNoteToStorage(note) {
  const result = await chrome.storage.local.get("ytd_notes");
  const notes = result.ytd_notes || [];
  notes.unshift(note); // Add to beginning (newest first)

  // Keep only last 100 notes to prevent storage bloat
  if (notes.length > 100) {
    notes.splice(100);
  }

  await chrome.storage.local.set({ ytd_notes: notes });
}

/**
 * Gets notes from storage, optionally filtered by video ID
 */
async function handleGetNotes(videoId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];

    if (videoId) {
      notes = notes.filter((n) => n.videoId === videoId);
    }

    return { success: true, notes };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Deletes a note by ID
 */
async function handleDeleteNote(noteId) {
  try {
    const result = await chrome.storage.local.get("ytd_notes");
    let notes = result.ytd_notes || [];
    notes = notes.filter((n) => n.id !== noteId);
    await chrome.storage.local.set({ ytd_notes: notes });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// NOTESCOLLECTION PUSH (Stage nc01)
// ============================================================

const NOTESCOLLECTION_API_URL =
  "https://api.notescollection.site/api/collections/e6d2104f-4273-4fb7-9aa4-d3d172653173/feedback";

/**
 * Builds a Markdown-formatted string from the digest data.
 * Formats transcript with timestamps for better readability.
 */
function buildMarkdownContent(digest, videoNotes) {
  const lines = [];

  // Title
  lines.push(`# ${digest?.videoTitle || "Unknown Video"}`);
  lines.push("");

  // Metadata block
  lines.push("---");
  if (digest?.videoUrl) {
    lines.push(`**Video:** [${digest.videoTitle || "Unknown Video"}](${digest.videoUrl})`);
  } else {
    lines.push(`**Video:** ${digest?.videoTitle || "Unknown Video"}`);
  }
  if (digest?.channelName) {
    lines.push(`**Channel:** ${digest.channelName}`);
  }
  if (videoNotes.length > 0) {
    lines.push(`**Notes:** ${videoNotes.length} saved`);
  }
  lines.push(`**Exported:** ${new Date().toLocaleString()}`);
  lines.push("---");
  lines.push("");

  // Video description/remarks section
  if (digest?.description && digest.description.trim()) {
    lines.push("## Description");
    lines.push("");
    // Split description into paragraphs
    const descParagraphs = digest.description
      .split(/\n{2,}/)
      .map(p => p.trim())
      .filter(p => p.length > 0);
    for (const para of descParagraphs) {
      lines.push(para);
      lines.push("");
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // Notes section
  if (videoNotes.length > 0) {
    lines.push("## Notes");
    lines.push("");
    for (const note of videoNotes) {
      const time = note.timestamp || "";
      const text = note.text || "";
      lines.push(`> **[${time}]** ${text}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // Transcript section - use timestamped version if available
  const transcriptText = digest?.transcriptTextTimestamped || digest?.transcriptText || "";
  
  if (transcriptText) {
    lines.push("## Transcript");
    lines.push("");
    
    // Check if it's timestamped format [MM:SS] text
    const timestampPattern = /\[(\d+):(\d{2})\]\s*(.+)/g;
    const hasTimestamps = timestampPattern.test(transcriptText);
    
    if (hasTimestamps) {
      // Format with timestamps - each line as a blockquote
      const cleanPattern = /\[(\d+):(\d{2})\]\s*(.+)/g;
      let match;
      while ((match = cleanPattern.exec(transcriptText)) !== null) {
        const mins = match[1];
        const secs = match[2];
        const text = match[3].trim();
        lines.push(`> **${mins}:${secs}** ${text}`);
      }
    } else {
      // Plain text - try to split into sentences
      // Split by common sentence endings
      const sentences = transcriptText
        .replace(/([。！？.!?])/g, '$1\n')
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      
      for (const sentence of sentences) {
        lines.push(sentence);
        lines.push("");
      }
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(`*Exported by YouTube Digest*`);

  return lines.join("\n");
}

/**
 * Pushes the current video's digest (transcript + notes) to Notescollection.
 *
 * @param {string} videoId - The video ID to push.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function handlePushToNotescollection(videoId) {
  const settings = await getSettings();
  const token = settings.notescollectionToken;

  if (!token) {
    return { success: false, error: "NO_TOKEN" };
  }

  try {
    // Gather video info and notes.
    const result = await chrome.storage.local.get("ytd_notes");
    const allNotes = result.ytd_notes || [];
    const videoNotes = allNotes.filter((n) => n.videoId === videoId);

    // Try to get the cached digest for the video.
    // Try to find adapter from notes first, then fall back to querying tabs.
    let adapterId = videoNotes[0]?.adapterId;
    let videoUrl = videoNotes[0]?.videoUrl;
    
    if (!adapterId) {
      // Try to find the active tab with a matching adapter
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tabs[0]?.url) {
        const adapter = YTD_PLATFORMS.findByUrl(tabs[0].url);
        if (adapter) {
          adapterId = adapter.id;
          videoUrl = tabs[0].url;
        }
      }
    }
    
    // Last resort: default to youtube
    adapterId = adapterId || "youtube";
    
    const cacheKey = `digest_${adapterId}_${videoId}`;
    const cachedDigest = await chrome.storage.local.get(cacheKey);
    const digest = cachedDigest[cacheKey];

    // Build Markdown-formatted content.
    const content = buildMarkdownContent(digest, videoNotes);

    // Build the push payload with Markdown content.
    const payload = {
      feedbackContent: content,
    };

    // Make the API call.
    const response = await fetch(NOTESCOLLECTION_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.warn(
        `[YouTube Digest] Notescollection push failed: ${response.status} ${response.statusText} ${errorText}`.slice(0, 300),
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    return { success: true };
  } catch (error) {
    console.warn("[YouTube Digest] Notescollection push error:", error.message);
    return { success: false, error: "NETWORK_ERROR" };
  }
}

async function handleExplainSelection(
  selectedText,
  transcriptContext,
  videoTitle,
) {
  try {
    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return {
        success: false,
        error: "NO_AI_KEY",
        message: "AI API key not configured.",
      };
    }

    const variables = {
      videoTitle: videoTitle || "Unknown",
      selectedText,
      transcriptContext: transcriptContext || "None",
    };
    const systemPrompt = await loadPromptSection(
      "explain.md",
      "System prompt",
      variables,
    );
    const userPrompt = await loadPromptSection(
      "explain.md",
      "User prompt",
      variables,
    );

    debugLog("[YouTube Digest] Requesting selection explanation");
    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return {
      success: true,
      explanation: explanation.trim(),
    };
  } catch (error) {
    logAiConsumerError("Explain selection", error);
    return {
      success: false,
      error: error.message || "Failed to explain selection",
    };
  }
}

// ============================================================
// PUNCTUATION RESTORE — Re-punctuate unpunctuated Chinese transcripts
// ============================================================
//
// AI captions from Bilibili / 自动字幕 often arrive as a wall of Chinese
// characters with no sentence breaks. Reading them is exhausting, so when
// the user enables `aiPunctuationEnabled` we ask the active AI provider to
// insert Chinese sentence punctuation while preserving every word and every
// line break. The side panel keeps the local heuristic as a hard fallback so
// the UI is never blocked by a missing key, rate limit, or upstream failure.

/**
 * Hard upper bound for one punctuation request, in characters. Long
 * transcripts are split at `[M:SS]` boundaries below this length so each
 * call stays well under the provider's token limit. The value deliberately
 * errs on the low side: a typical 1.5-byte-per-character model token is
 * close to a single CJK character, and we want enough headroom for the
 * system prompt + output budget.
 */
const PUNCTUATION_BATCH_MAX_CHARS = 4000;

/**
 * True when the text contains any CJK punctuation — the heuristic + AI
 * downstream path should treat that text as already punctuated and skip the
 * restore call to stay idempotent and avoid clobbering real punctuation.
 */
function looksAlreadyPunctuated(text) {
  if (typeof text !== "string" || !text) return false;
  return /[\u3000-\u303f\uff00-\uffef]/.test(text);
}

/**
 * Splits a timestamped transcript into batches at `[M:SS]` line boundaries,
 * each batch below `PUNCTUATION_BATCH_MAX_CHARS`. Empty batches are dropped.
 * The first batch always carries `null` as the previous-tail; subsequent
 * batches carry the last ~120 characters of the previous batch's tail so the
 * AI sees the boundary sentence and can finish it cleanly.
 */
function splitTranscriptForPunctuation(text) {
  if (typeof text !== "string" || !text) return [];
  const stampBoundary = /(\[\d+:\d{2}\]\s*)/g;
  const positions = [];
  let match;
  while ((match = stampBoundary.exec(text)) !== null) {
    positions.push({ index: match.index, stamp: match[1] });
  }
  if (positions.length === 0) {
    return [{ text: text.trim(), previousTail: null }];
  }

  const segments = [];
  let cursor = 0;
  for (let i = 0; i < positions.length; i += 1) {
    const next =
      i + 1 < positions.length ? positions[i + 1].index : text.length;
    const segment = text.slice(cursor, next).trim();
    if (segment) segments.push({ start: cursor, end: next, text: segment });
    cursor = next;
  }

  const batches = [];
  let buffer = "";
  for (const segment of segments) {
    const candidate = buffer ? `${buffer}\n${segment.text}` : segment.text;
    if (
      buffer &&
      candidate.length > PUNCTUATION_BATCH_MAX_CHARS &&
      buffer.length >= 1
    ) {
      batches.push(buffer);
      buffer = segment.text;
    } else if (!buffer && segment.text.length > PUNCTUATION_BATCH_MAX_CHARS) {
      // A single segment longer than the budget — emit it on its own and
      // let the model cope. The prompt warns against truncation so it will
      // either complete it or stop cleanly at the end.
      batches.push(segment.text);
      buffer = "";
    } else {
      buffer = candidate;
    }
  }
  if (buffer) batches.push(buffer);

  return batches.map((batch, index) => ({
    text: batch,
    previousTail:
      index === 0
        ? null
        : String(batches[index - 1] || "").slice(-120),
  }));
}

/**
 * Heuristic guardrail: if the AI-returned text drops more than 40 % of the
 * CJK characters that were in the source, treat it as a truncation /
 * hallucination and fall back to the local heuristic so the user keeps a
 * readable transcript.
 */
function punctuationLooksPlausible(sourceText, candidateText) {
  if (typeof candidateText !== "string" || !candidateText.trim()) return false;
  if (typeof sourceText !== "string" || !sourceText) return true;
  const sourceChars = (sourceText.match(/[\u3400-\u9fff]/g) || []).length;
  const candidateChars = (candidateText.match(/[\u3400-\u9fff]/g) || []).length;
  if (sourceChars < 40) return candidateChars >= Math.floor(sourceChars * 0.4);
  return candidateChars >= sourceChars * 0.6;
}

/**
 * Strips accidental wrapping that some models add — leading `Output:` /
 * `Result:` prefixes, surrounding markdown fences, and a trailing
 * `<think>...</think>` block. Operates on a string in place and returns the
 * cleaned text. Conservative: it only strips patterns that match verbatim.
 */
function stripPunctuationWrapping(text) {
  if (typeof text !== "string") return text;
  // Strip leading labels like `Output:`, `Result:`, or the compound
  // `Punctuated Text:` (Chinese fullwidth colon included). The model
  // occasionally introduces these as headings before the actual
  // punctuated transcript; `Output:` / `Result:` are also explicitly
  // forbidden by the prompt but we defend against prompt drift.
  let cleaned = text.replace(
    /^\s*(?:Output|Result|Punctuated(?:\s+Text)?|Text)\s*[:：]\s*/i,
    "",
  );
  cleaned = cleaned.replace(/^\s*```(?:[A-Za-z0-9_-]+)?\s*\n?/, "");
  cleaned = cleaned.replace(/\n?```\s*$/, "");
  // Scrub reasoning traces the model might leak through. The
  // English-style `<think>...</think>` blocks are forbidden by the
  // prompt; the Chinese-style `思考中...思考结束` pattern shows up
  // when the underlying model falls back to native-language
  // reasoning. We strip both — the leading whitespace is consumed
  // so the surrounding sentence boundaries don't end up with a
  // double space.
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, "");
  cleaned = cleaned.replace(/[\s\u3000]*思考[\s\S]*?思考结束/g, "");
  return cleaned.trim();
}

/**
 * Calls the AI provider once for the given batch. Mirrors callAiTranslation
 * but uses a flat text payload instead of a JSON object — punctuation
 * output is plain text, not a structured object.
 */
async function callAiPunctuation(systemPrompt, userContent, options = {}) {
  try {
    const { text } = await requestAiCompletion({
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokens ?? 2048,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });
    return { success: true, text };
  } catch (error) {
    // requestAiCompletion() decorates transport / HTTP failures with
    // `.status` but only sets `.code` for the typed transport codes
    // (NO_AI_KEY / EMPTY_AI_RESPONSE / timeouts). Punctuation needs a
    // dedicated AI_RATE_LIMITED code so the sidepanel can surface the
    // existing "AI quota exhausted, retry shortly" toast instead of
    // falling back to the local heuristic silently.
    if (error.status === 429) {
      return {
        success: false,
        error: error.message || "Rate limited — try again in a moment",
        code: "AI_RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

/**
 * Re-punctuates a Chinese transcript using the AI provider. The caller passes
 * the timestamped transcript (each entry prefixed with `[M:SS]`) so the model
 * can preserve the line boundaries that the side panel needs to recover the
 * per-entry timestamps after punctuation. Returns
 * `{ success: true, timestampedText, plainText }` on success or
 * `{ success: false, error, code }` on any failure — the caller (sidepanel.js)
 * decides whether to fall back to the local heuristic.
 *
 * `plainText` is the timestamped text with `[M:SS]` markers and any leading
 * whitespace stripped from each line, suitable for the read-only display and
 * the export pipeline. `timestampedText` keeps the markers intact for entry
 * reconstruction.
 */
async function handleAddPunctuation(timestampedText, videoTitle) {
  try {
    if (typeof timestampedText !== "string" || !timestampedText.trim()) {
      return { success: false, error: "Empty transcript" };
    }
    if (looksAlreadyPunctuated(timestampedText)) {
      const plainText = timestampedText
        .replace(/\[\d+:\d{2}\]\s*/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return {
        success: true,
        timestampedText,
        plainText,
        skipped: "already_punctuated",
      };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "AI API key not configured", code: "NO_AI_KEY" };
    }
    if (settings.aiPunctuationEnabled === false) {
      return { success: false, error: "AI punctuation disabled in settings", code: "DISABLED" };
    }

    const batches = splitTranscriptForPunctuation(timestampedText);
    if (batches.length === 0) {
      return { success: false, error: "No batchable text found" };
    }

    const systemPrompt = await loadPromptSection(
      "punctuation.md",
      "System prompt",
    );

    const pieces = [];
    for (const [index, batch] of batches.entries()) {
      const userPrompt = await loadPromptSection(
        "punctuation.md",
        "User prompt",
        {
          videoTitle: videoTitle || "Unknown",
          transcriptText: batch.text,
        },
      );
      const tailNote = batch.previousTail
        ? `\n\nFor context, the previous chunk ended with: "${batch.previousTail}" — continue naturally from there without repeating it.`
        : "";
      const result = await callAiPunctuation(systemPrompt, userPrompt + tailNote);
      if (!result.success) {
        return result;
      }
      const cleaned = stripPunctuationWrapping(result.text);
      if (!punctuationLooksPlausible(batch.text, cleaned)) {
        return {
          success: false,
          error: "AI punctuation output failed plausibility check",
          code: "IMPLAUSIBLE_OUTPUT",
        };
      }
      pieces.push(cleaned);
      // Light debug signal so log scrapers can see how many batches ran.
      debugLog(
        `[YouTube Digest] Punctuation batch ${index + 1}/${batches.length} ok`,
      );
    }

    const joinedTimestamped = pieces.join("\n").trim();
    const joinedPlain = joinedTimestamped
      .replace(/\[\d+:\d{2}\]\s*/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return {
      success: true,
      timestampedText: joinedTimestamped,
      plainText: joinedPlain,
    };
  } catch (error) {
    logAiConsumerError("Punctuation restore", error);
    return {
      success: false,
      error: error.message || "Punctuation restore failed",
      code: error.code,
    };
  }
}

// ============================================================
// TRANSLATION — Translate transcript batches into Simplified Chinese
// ============================================================
// Uses a low temperature for consistent, natural translations.

/**
 * Shared base rules that every translation prompt includes.
 * These ensure translations sound natural rather than machine-translated.
 *
 * @param {string} targetLanguage - Must be 'zh'
 * @returns {Promise<string>} - The base translation rules
 */
async function getTranslationBaseRules(targetLanguage) {
  if (targetLanguage !== "zh") {
    throw new Error(`Unsupported translation target: ${targetLanguage}`);
  }
  const langName = "Simplified Chinese";
  const langSpecific = await loadPromptSection(
    "translation.md",
    "Chinese rules",
  );
  return loadPromptSection("translation.md", "Shared base rules", {
    langName,
    langSpecific,
  });
}

function validateTranscriptBatchRequest(content) {
  const segments = content?.segments;
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 4) {
    throw new Error("Transcript translation requires 1 to 4 segments");
  }

  const seenIds = new Set();
  let totalCharacters = 0;
  const normalized = segments.map((segment) => {
    const id = typeof segment?.id === "string" ? segment.id.trim() : "";
    const text = typeof segment?.text === "string" ? segment.text.trim() : "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id) || seenIds.has(id)) {
      throw new Error("Transcript translation segment IDs must be unique and stable");
    }
    if (!text || text.length > 4000) {
      throw new Error("Transcript translation segment text is invalid or too long");
    }
    seenIds.add(id);
    totalCharacters += text.length;
    return { id, text };
  });
  if (totalCharacters > 12000) {
    throw new Error("Transcript translation batch is too large");
  }
  return normalized;
}

function looksLikeChineseTranslation(text, sourceText) {
  const latinLetters = (sourceText.match(/[A-Za-z]/g) || []).length;
  if (latinLetters < 20) return true;
  return /[\u3400-\u9fff]/.test(text);
}

/**
 * Aligns untrusted model output by exact stable ID. Missing, duplicated,
 * unknown, empty, or clearly non-Chinese values become explicit row errors.
 */
function normalizeTranslatedSegmentBatch(parsed, sourceSegments) {
  const candidates = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const sourceById = new Map(sourceSegments.map((segment) => [segment.id, segment]));
  const translatedById = new Map();

  candidates.forEach((candidate) => {
    if (
      typeof candidate?.id !== "string" ||
      typeof candidate?.text !== "string" ||
      !sourceById.has(candidate.id) ||
      translatedById.has(candidate.id)
    ) {
      return;
    }
    const text = candidate.text.trim();
    const source = sourceById.get(candidate.id);
    if (text && looksLikeChineseTranslation(text, source.text)) {
      translatedById.set(candidate.id, text);
    }
  });

  return {
    segments: sourceSegments.map((source) => ({
      id: source.id,
      text: translatedById.get(source.id) || "",
      error: translatedById.has(source.id)
        ? ""
        : "Missing or invalid Chinese translation",
    })),
  };
}

/**
 * Translates content using the AI provider.
 * @param {Object} content - JSON object containing semantic transcript segments
 * @param {string} contentType - Must be 'transcriptBatch'
 * @param {string} targetLanguage - 'zh' for Simplified Chinese
 * @param {string} videoTitle - The video title (for context)
 * @returns {Object} - { success, translatedContent } or { success: false, error }
 */
async function handleTranslateContent(
  content,
  contentType,
  targetLanguage,
  videoTitle,
) {
  try {
    if (targetLanguage !== "zh") {
      return {
        success: false,
        error: `Unsupported translation target: ${String(targetLanguage)}`,
      };
    }
    if (contentType !== "transcriptBatch") {
      return {
        success: false,
        error: `Unsupported translation content type: ${String(contentType)}`,
      };
    }

    const settings = await getSettings();
    if (!settings.aiApiKey) {
      return { success: false, error: "AI API key not configured" };
    }

    const sourceSegments = validateTranscriptBatchRequest(content);
    const langName = "Simplified Chinese";
    const baseRules = await getTranslationBaseRules(targetLanguage);
    const systemPrompt = await loadPromptSection(
      "translation.md",
      "Transcript batch translation",
      {
        langName,
        videoTitle: videoTitle || "Unknown",
        baseRules,
      },
    );
    const userContent = JSON.stringify({ segments: sourceSegments });
    const translationOptions = {
      temperature: 0.2,
      maxTokens: 1536,
      responseFormat: { type: "json_object" },
    };
    let result = await callAiTranslation(
      systemPrompt,
      userContent,
      translationOptions,
    );

    // AI provider JSON mode can rarely return an empty content string. The prompt
    // already requires JSON, so retry once without response_format.
    if (!result.success && result.code === "EMPTY_AI_RESPONSE") {
      result = await callAiTranslation(systemPrompt, userContent, {
        temperature: translationOptions.temperature,
        maxTokens: translationOptions.maxTokens,
      });
    }
    if (!result.success) return result;

    const parsed = parseLooseJson(result.text);
    const aligned = normalizeTranslatedSegmentBatch(parsed, sourceSegments);
    if (!aligned.segments.some((segment) => segment.text)) {
      return {
        success: false,
        error: "Translation returned no valid Chinese segments",
      };
    }
    return { success: true, translatedContent: aligned };
  } catch (error) {
    logAiConsumerError("Translation", error);
    return { success: false, error: error.message || "Translation failed" };
  }
}

/**
 * Makes a single DeepSeek call for translation.
 * Uses temperature 0.3 for consistent, predictable translations.
 *
 * @param {string} systemPrompt - The system-level instructions
 * @param {string} userContent - The user message (content to translate)
 * @returns {Object} - { success, text } or { success: false, error }
 */
async function callAiTranslation(
  systemPrompt,
  userContent,
  { temperature = 0.3, maxTokens = 8192, responseFormat } = {},
) {
  try {
    const { text } = await requestAiCompletion({
      temperature,
      maxTokens,
      responseFormat,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    });

    return { success: true, text };
  } catch (error) {
    if (error.status === 429) {
      return {
        success: false,
        error: "Rate limited — try again in a moment",
        code: "RATE_LIMITED",
      };
    }
    return { success: false, error: error.message, code: error.code };
  }
}

// Pure validators are exposed for the repository's Node tests only.
globalThis.__YTD_TRANSLATION_TESTING__ = {
  requestAiCompletion,
  callAiTranslation,
  parseLooseJson,
  validateTranscriptBatchRequest,
  normalizeTranslatedSegmentBatch,
  handleTranslateContent,
  handleAddPunctuation,
  callAiPunctuation,
  splitTranscriptForPunctuation,
  punctuationLooksPlausible,
  stripPunctuationWrapping,
  looksAlreadyPunctuated,
  cleanupNoteText,
  logAiConsumerError,
};

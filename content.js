/**
 * CONTENT SCRIPT
 *
 * Runs in the ISOLATED world of the current video page. It owns the page DOM
 * touch-points: extracting video info, injecting UI affordances (Digest /
 * Note buttons), and listening for SPA navigation.
 *
 * Platform-specific selectors and navigation hooks come from the active
 * PlatformAdapter (see platforms/adapter-base.js). On any page no adapter
 * claims, this script no-ops so it can stay registered across all hosts in
 * manifest.json without doing the wrong thing on the wrong site.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// GLOBAL STATE
// ============================================================

let activeAdapter = null;
let ytdNoteButton = null;
let ytdNoteButtonTimer = null;
let ytdNoteButtonRetryTimer = null;
let ytdDigestButton = null;
let digestButtonObserver = null;
let digestButtonReconcileTimer = null;
let digestButtonResizeListenerAdded = false;

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * When the page loads, inject our Digest button and Note button.
 * We wait a bit for YouTube's UI to fully render.
 */
function init() {
  // Resolve the adapter for the current URL once. If no platform claims
  // this page, this script has nothing to do — bail before wiring any
  // listeners so it doesn't fight other content scripts on shared hosts.
  activeAdapter = YTD_PLATFORMS.findByUrl(location.href);
  if (!activeAdapter) return;

  // Try to inject the buttons immediately
  injectDigestButton();
  tryInjectNoteButton();

  // Also set up an observer to handle YouTube's dynamic content loading
  // (YouTube is an SPA, so elements appear/disappear as you navigate)
  setupButtonObserver();
  setupDigestButtonResizeListener();

  // Subscribe to whichever SPA navigation event the active adapter declares.
  // Different platforms use different signals (YouTube: "yt-navigate-finish",
  // Bilibili: a custom event, Vimeo: nothing — falls back to URL polling).
  // Adapter scripts load before this one via manifest.json ordering, so the
  // adapter is already registered by the time init() runs.
  if (typeof activeAdapter.spaNavigationEvent === "string") {
    document.addEventListener(activeAdapter.spaNavigationEvent, spaNavHandler);
  }
}

/**
 * Returns true when the current URL is a watchable video page for the active
 * adapter. SPA-friendly: re-checked on every navigation event because the
 * adapter's matches() may go from true to false mid-session.
 */
function isVideoPage() {
  return !!activeAdapter && activeAdapter.matches(location.href);
}

/**
 * Defensive accessor for adapter-supplied CSS selectors. Returns an empty
 * string for missing entries so querySelector() just yields null rather than
 * throwing a syntax error in callers.
 */
function selector(key) {
  return (activeAdapter && activeAdapter.playerSelectors && activeAdapter.playerSelectors[key]) || "";
}

/**
 * Returns true when a chrome.runtime call failed because the extension
 * context is gone — typically because the user reloaded/updated the
 * extension at chrome://extensions while this content script was still
 * alive on the page, or the service worker was torn down mid-session.
 *
 * Chrome surfaces this as an opaque "Error: Extension context invalidated."
 * with no programmatic error code, so we pattern-match the message. The
 * only recovery is a page refresh (so the new content script gets
 * injected); callers should NOT treat this as a bug — it's a normal
 * lifecycle event. Downgrading the log level from `error` to `warn` and
 * showing a friendly "REFRESH" hint instead of a generic "ERROR" keeps
 * the developer console clean and tells the user what to do next.
 */
function isExtensionContextLost(err) {
  if (!err) return false;
  const message = (err && err.message) || String(err);
  return /Extension context invalidated/i.test(message);
}

/**
 * Attempts to inject the note button. If the player container isn't ready yet,
 * retry a few times with a short delay. YouTube renders the player asynchronously
 * after navigation, so a single immediate attempt can miss it.
 */
function tryInjectNoteButton() {
  if (!isVideoPage()) return;

  // Clear any existing retry so we don't stack timers
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  let attempts = 0;
  const maxAttempts = 30; // ~3 seconds of retrying
  const playerSelector = selector("playerContainer");

  function attempt() {
    attempts++;
    const playerContainer = playerSelector
      ? document.querySelector(playerSelector)
      : null;

    if (playerContainer) {
      injectNoteButton();
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
      return;
    }

    if (attempts >= maxAttempts) {
      debugLog(
        "[YouTube Digest Content] Player container not found after retries, giving up",
      );
      if (ytdNoteButtonRetryTimer) {
        clearInterval(ytdNoteButtonRetryTimer);
        ytdNoteButtonRetryTimer = null;
      }
    }
  }

  attempt();
  if (!ytdNoteButton || !ytdNoteButton.isConnected) {
    ytdNoteButtonRetryTimer = setInterval(attempt, 100);
  }
}

// Run init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

/**
 * Listen for messages from the side panel or background script.
 * When they ask for video info, we read it from the page.
 * When they send key moments, we highlight them on the progress bar.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("[YouTube Digest Content] Received message:", message.action, message);

  if (message.action === "getVideoInfo") {
    // Read video title and channel name from the page
    const info = extractVideoInfo();
    debugLog("[YouTube Digest Content] Returning video info:", info);
    sendResponse(info);
    return false; // Synchronous response
  }

  if (message.action === "highlightMoments") {
    // Key moment markers disabled — chapters are shown in the side panel only.
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "getCurrentTime") {
    // Return the current video playback time (used by auto-scroll)
    const videoSelector = selector("videoElement");
    const video = videoSelector ? document.querySelector(videoSelector) : null;
    sendResponse({
      currentTime: video ? Math.floor(video.currentTime) : 0,
      paused: video ? video.paused : true,
    });
    return false;
  }

  if (message.action === "seekTo") {
    // Jump the video to a specific timestamp
    debugLog("[YouTube Digest Content] Seeking to:", message.seconds);
    seekToTimestamp(message.seconds);
    sendResponse({ success: true });
    return false;
  }

  // Unknown action - still send a response to prevent hanging
  debugLog("[YouTube Digest Content] Unknown action:", message.action);
  sendResponse({ success: false, error: "Unknown action" });
  return false;
});

// ============================================================
// DIGEST BUTTON INJECTION
// ============================================================

/**
 * Injects a "Digest" button into YouTube's action bar.
 * The button appears next to Share, Save, etc. below the video.
 *
 * When clicked, it opens the YouTube Digest side panel.
 */
function isVisibleDigestHost(element) {
  if (!element || !element.isConnected) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * YouTube keeps hidden copies of its responsive action toolbar in the DOM.
 * querySelector() can return one of those 0x0 copies before the toolbar the
 * viewer can actually see, so inspect every candidate and resolve the native
 * button group inside the visible action row for the current video.
 *
 * The selector strings come from the active adapter's playerSelectors so
 * other platforms (Bilibili / Vimeo / X) can describe their own action bars
 * without this script knowing about them.
 */
function findDigestButtonHost() {
  const primarySelector = selector("actionBarRow");
  if (!primarySelector) return null;

  const primaryActionRows = Array.from(
    document.querySelectorAll(primarySelector),
  );

  for (const actionRow of primaryActionRows) {
    if (!isVisibleDigestHost(actionRow)) continue;

    const groupSelector = selector("actionBarGroup");
    const visibleButtonGroup = groupSelector
      ? Array.from(actionRow.querySelectorAll(groupSelector)).find(
          isVisibleDigestHost,
        )
      : null;
    if (visibleButtonGroup) return visibleButtonGroup;
  }

  const fallbackSelector = selector("actionBarFallback");
  if (!fallbackSelector) return null;
  const fallbackCandidates = Array.from(
    document.querySelectorAll(fallbackSelector),
  );

  return (
    fallbackCandidates.find((candidate) => isVisibleDigestHost(candidate)) ||
    null
  );
}

function createDigestButton() {
  const digestButton = document.createElement("button");
  digestButton.id = "ytd-digest-button";
  digestButton.type = "button";
  digestButton.setAttribute("aria-label", "Open YouTube Digest");
  digestButton.innerHTML = `
    <span class="ytd-digest-icon" style="font-size: 11px;">▶</span>
    <span class="ytd-digest-label">Digest</span>
  `;

  // Style the button — rounded pill in our terracotta accent, sized to sit
  // comfortably among YouTube's native action buttons.
  digestButton.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 18px;
    height: 36px;
    border: none;
    border-radius: 18px;
    background: #c8674f;
    color: white;
    font-family: "Roboto", "Arial", sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    margin-right: 8px;
    transition: background 0.2s, transform 0.1s, box-shadow 0.2s;
    box-shadow: 0 2px 8px rgba(200, 103, 79, 0.3);
    flex: 0 0 auto;
    align-self: center;
    width: max-content;
    min-width: max-content;
    max-width: max-content;
    white-space: nowrap;
  `;

  // Hover effects
  digestButton.addEventListener("mouseenter", () => {
    digestButton.style.background = "#b25742";
    digestButton.style.transform = "scale(1.02)";
  });

  digestButton.addEventListener("mouseleave", () => {
    digestButton.style.background = "#c8674f";
    digestButton.style.transform = "scale(1)";
  });

  // Click handler — open the side panel
  digestButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    debugLog("[YouTube Digest] Digest button clicked");

    // Send message to background script to open side panel
    try {
      const result = await chrome.runtime.sendMessage({
        action: "openSidePanel",
      });
      debugLog("[YouTube Digest] openSidePanel response:", result);
    } catch (err) {
      if (isExtensionContextLost(err)) {
        // Expected after a manual extension reload/update — page
        // refresh fixes it. Don't pollute the console with an error.
        console.warn(
          "[YouTube Digest] Extension context invalidated; refresh the page so the side panel can open.",
        );
        return;
      }
      console.error("[YouTube Digest] Failed to open side panel:", err);
    }
  });

  ytdDigestButton = digestButton;
  return digestButton;
}

/**
 * Reconciles the Digest button with YouTube's currently visible action row.
 * This is intentionally idempotent because YouTube rebuilds its watch page
 * during navigation and at responsive breakpoints.
 */
function injectDigestButton() {
  const existingButtons = Array.from(
    document.querySelectorAll("#ytd-digest-button"),
  );

  if (!isVideoPage()) {
    existingButtons.forEach((button) => button.remove());
    ytdDigestButton = null;
    return false;
  }

  const actionsContainer = findDigestButtonHost();
  if (!actionsContainer) {
    debugLog("[YouTube Digest Content] Visible actions container not found yet");
    return false;
  }

  let digestButton = existingButtons.find(
    (button) => button === ytdDigestButton,
  );

  if (!digestButton) {
    existingButtons.forEach((button) => button.remove());
    existingButtons.length = 0;
    digestButton = createDigestButton();
  }

  existingButtons.forEach((button) => {
    if (button !== digestButton) button.remove();
  });

  if (digestButton.parentElement !== actionsContainer) {
    // YouTube turns #actions-inner into a vertical flex column at narrow
    // breakpoints. A direct child there stretches into a full-width second
    // row, so keep Digest inside the native horizontal button group and
    // prepend it to preserve visibility when space is limited.
    actionsContainer.insertBefore(digestButton, actionsContainer.firstChild);
  }

  debugLog("[YouTube Digest Content] Digest button reconciled");
  return true;
}

function scheduleDigestButtonReconciliation(delay = 80) {
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
  }

  digestButtonReconcileTimer = setTimeout(() => {
    digestButtonReconcileTimer = null;
    injectDigestButton();
  }, delay);
}

function setupDigestButtonResizeListener() {
  if (digestButtonResizeListenerAdded) return;

  window.addEventListener("resize", () => {
    scheduleDigestButtonReconciliation(120);
  });
  digestButtonResizeListenerAdded = true;
}

/**
 * Sets up a MutationObserver to watch for YouTube's dynamic content changes.
 * When the action buttons container appears (after navigation), we inject our button.
 */
function setupButtonObserver() {
  if (digestButtonObserver) return;

  digestButtonObserver = new MutationObserver(() => {
    // Check if we need to inject the buttons
    if (isVideoPage()) {
      scheduleDigestButtonReconciliation();
      if (!ytdNoteButton || !ytdNoteButton.isConnected) {
        tryInjectNoteButton();
      }
    }
  });

  // Watch the entire body for changes (YouTube rebuilds large chunks of the DOM)
  digestButtonObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ============================================================
// NOTE BUTTON (Overlay on Video Player)
// ============================================================

/**
 * Injects a "Note" button overlay on top of the YouTube video player.
 * The button appears when the mouse enters or moves over the player and hides
 * after the cursor stays still for more than 2 seconds or leaves the player.
 */
function injectNoteButton() {
  // Don't inject if we're not on a video page
  if (!isVideoPage()) return;

  // Don't inject if button already exists and is properly tracked.
  // If a stale button exists (e.g., from a previous content-script instance),
  // remove it and re-inject so event listeners are attached to the live one.
  const existingButton = document.getElementById("ytd-note-button");
  if (existingButton) {
    if (ytdNoteButton === existingButton && existingButton.isConnected) {
      return; // already injected and connected
    }
    existingButton.remove();
  }

  // Find the video player container. Most platforms rebuild this dynamically,
  // so we delegate the selector list to the active adapter.
  const playerSelector = selector("playerContainer");
  const playerContainer = playerSelector
    ? document.querySelector(playerSelector)
    : null;

  if (!playerContainer) {
    debugLog(
      "[YouTube Digest Content] Player container not found yet, will retry",
    );
    return;
  }

  // Ensure the player container has relative positioning for absolute children
  if (
    window.getComputedStyle(playerContainer).position === "static" ||
    !playerContainer.style.position
  ) {
    playerContainer.style.position = "relative";
  }

  debugLog("[YouTube Digest Content] Injecting note button");

  // Create the push/digest button — a soft rounded pill that floats over the player
  const pushButton = document.createElement("button");
  pushButton.id = "ytd-push-button";
  pushButton.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right: 7px;">
      <polygon points="5 3 19 12 5 21 5 3"></polygon>
    </svg>
    <span>Push</span>
  `;

  // Soft rounded pill in the terracotta accent, with a gentle shadow.
  // Start hidden; visibility is controlled by mouse activity.
  pushButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    z-index: 9999;
    display: flex;
    align-items: center;
    padding: 9px 16px;
    background: #c8674f;
    color: white;
    border: none;
    border-radius: 999px;
    font-family: system-ui, -apple-system, "Roboto", sans-serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.2px;
    cursor: pointer;
    transition: opacity 0.18s ease, transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    opacity: 0;
    pointer-events: none;
    box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  `;

  ytdNoteButton = pushButton;

  // Show button when mouse enters or moves over the player.
  // Hide after 2 seconds of idle or when the mouse leaves.
  playerContainer.addEventListener("mouseenter", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mousemove", () => {
    showNoteButton();
    resetNoteButtonTimer();
  });

  playerContainer.addEventListener("mouseleave", () => {
    clearTimeout(ytdNoteButtonTimer);
    ytdNoteButtonTimer = null;
    hideNoteButton();
  });

  // Hover effect — lift slightly
  pushButton.addEventListener("mouseenter", () => {
    pushButton.style.background = "#b25742";
    pushButton.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
    pushButton.style.transform = "translateY(-1px)";
  });

  pushButton.addEventListener("mouseleave", () => {
    pushButton.style.background = "#c8674f";
    pushButton.style.boxShadow = "0 4px 14px rgba(0,0,0,0.3)";
    pushButton.style.transform = "translateY(0)";
  });

  // Click handler — open the side panel (same as Digest button)
  pushButton.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    debugLog("[YouTube Digest] Push button clicked");

    // Send message to background script to open side panel
    try {
      const result = await chrome.runtime.sendMessage({
        action: "openSidePanel",
      });
      debugLog("[YouTube Digest] openSidePanel response:", result);
    } catch (err) {
      if (isExtensionContextLost(err)) {
        console.warn(
          "[YouTube Digest] Extension context invalidated; refresh the page so the side panel can open.",
        );
        return;
      }
      console.error("[YouTube Digest] Failed to open side panel:", err);
    }
  });

  playerContainer.appendChild(pushButton);

  debugLog("[YouTube Digest Content] Push button injected");
}

function showNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "1";
  ytdNoteButton.style.pointerEvents = "auto";
}

function hideNoteButton() {
  if (!ytdNoteButton) return;
  ytdNoteButton.style.opacity = "0";
  ytdNoteButton.style.pointerEvents = "none";
}

function resetNoteButtonTimer() {
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = setTimeout(() => {
    hideNoteButton();
  }, 2000);
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

/**
 * Reads the video title, channel name, and description directly from the
 * page DOM. Selector strings come from the active adapter so each platform
 * can describe its own markup. Falls back to empty strings rather than
 * throwing when selectors are missing — callers tolerate missing fields.
 */
function extractVideoInfo() {
  const titleSelector = selector("titleElement");
  const channelSelector = selector("channelElement");
  const descriptionSelector = selector("descriptionElement");
  const videoSelector = selector("videoElement");

  // Try direct page properties first (more reliable than shadow DOM selectors)
  // document.title format: "Video Title - Channel Name"
  let title = "";
  let channelName = "";
  if (document.title && document.title.includes(" - ")) {
    const parts = document.title.split(" - ");
    title = parts.slice(0, -1).join(" - ").trim();
    channelName = parts[parts.length - 1].trim();
  } else if (document.title) {
    title = document.title;
  }

  // Try shadow DOM selectors as fallback
  const titleElement = titleSelector
    ? document.querySelector(titleSelector)
    : null;
  if (titleElement) {
    const text = titleElement.textContent?.trim();
    if (text) title = text;
  }

  const channelElement = channelSelector
    ? document.querySelector(channelSelector)
    : null;
  if (channelElement) {
    const text = channelElement.textContent?.trim();
    if (text) channelName = text;
  }

  const videoElement = videoSelector
    ? document.querySelector(videoSelector)
    : null;

  const descriptionElement = descriptionSelector
    ? document.querySelector(descriptionSelector)
    : null;

  return {
    title: title || "",
    channelName: channelName || "",
    duration: videoElement?.duration || 0,
    description: descriptionElement?.textContent?.trim() || "",
  };
}

// ============================================================
// PROGRESS BAR KEY MOMENTS
// ============================================================

/**
 * Adds colored marker dots to YouTube's video progress bar
 * at the positions of key moments identified by the AI provider.
 *
 * How it works:
 * - YouTube's progress bar is a <div> element with a known class
 * - We calculate each moment's position as a percentage of total duration
 * - We inject small colored <div> elements at those positions
 * - The markers are absolutely positioned on top of the progress bar
 *
 * This is a "bonus feature" — it gives you a visual preview
 * of where the good stuff is in the video.
 */
function highlightKeyMoments(moments, videoDuration) {
  // Disabled: no timeline markers. Chapters live only in the side panel.
  return;
}

// ============================================================
// SEEK TO TIMESTAMP
// ============================================================

/**
 * Jumps the YouTube video to a specific timestamp (in seconds).
 * This is called when the user clicks a timestamp in the side panel.
 *
 * We simply set the video element's .currentTime property,
 * which is the standard HTML5 way to seek in a video.
 */
function seekToTimestamp(seconds) {
  const videoSelector = selector("videoElement");
  const video = videoSelector ? document.querySelector(videoSelector) : null;
  if (!video) {
    console.error("[YouTube Digest Content] No video element found for seek");
    return;
  }

  debugLog("[YouTube Digest Content] Seeking to:", seconds);
  video.currentTime = seconds;
  // Also play the video if it's paused
  if (video.paused) {
    video.play().catch(() => {}); // Ignore autoplay errors
  }
}

// ============================================================
// PAGE NAVIGATION DETECTION
// ============================================================

/**
 * Most video sites are SPAs — navigating between videos doesn't fully
 * reload the page, so we listen for the adapter-declared navigation event
 * (e.g. YouTube's "yt-navigate-finish") and reset the UI between videos.
 *
 * Declared as a function (not const) so init() can reference it on the very
 * first call even when readyState is already "interactive" or "complete" and
 * init() runs synchronously before this declaration would otherwise be
 * reached. Function declarations are hoisted, const arrow bindings are not.
 */
function spaNavHandler() {
  // Re-resolve the adapter for the new URL. If the page navigated to a
  // non-video URL, clear activeAdapter so subsequent no-ops are cheap.
  activeAdapter = YTD_PLATFORMS.findByUrl(location.href);
  if (!activeAdapter) {
    document
      .querySelectorAll("#ytd-digest-button")
      .forEach((button) => button.remove());
    ytdDigestButton = null;
    const strayPush = document.getElementById("ytd-push-button");
    if (strayPush) strayPush.remove();
    ytdNoteButton = null;
    return;
  }

  // Clean up old key moment markers when navigating to a new video
  const existingMarkers = document.querySelectorAll(".ytd-key-moment-markers");
  existingMarkers.forEach((m) => m.remove());

  // Remove old buttons (they will be re-injected for the new video)
  document
    .querySelectorAll("#ytd-digest-button")
    .forEach((button) => button.remove());
  ytdDigestButton = null;
  if (digestButtonReconcileTimer) {
    clearTimeout(digestButtonReconcileTimer);
    digestButtonReconcileTimer = null;
  }

  const existingPushButton = document.getElementById("ytd-push-button");
  if (existingPushButton) existingPushButton.remove();

  // Reset push button state
  ytdNoteButton = null;
  clearTimeout(ytdNoteButtonTimer);
  ytdNoteButtonTimer = null;
  if (ytdNoteButtonRetryTimer) {
    clearInterval(ytdNoteButtonRetryTimer);
    ytdNoteButtonRetryTimer = null;
  }

  // Re-inject buttons for the new video (with a small delay for the page
  // to render). The adapter's matches() decides whether we're still on a
  // watchable page; non-video URLs are filtered by init() on the next run.
  setTimeout(() => {
    if (!isVideoPage()) return;
    scheduleDigestButtonReconciliation(0);
    tryInjectNoteButton();
  }, 500);
};

// (The SPA listener is registered inside init() above, after activeAdapter
// is resolved. We don't register anything at the top level — adapter scripts
// run earlier than this file via manifest.json ordering, but activeAdapter is
// only set after the init() call below.)

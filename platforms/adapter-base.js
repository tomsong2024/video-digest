/*
 * Platform adapter registry.
 *
 * Loaded by both background.js (via importScripts) and content.js (via the
 * manifest's content_scripts ordering). Each concrete adapter is a plain
 * object literal that the registry stores in registration order.
 *
 * Usage in background.js:
 *   importScripts("platforms/adapter-base.js");
 *   importScripts("platforms/youtube.js"); // calls YTD_PLATFORMS.register(...)
 *
 * Usage in content.js:
 *   const adapter = YTD_PLATFORMS.findByUrl(location.href);
 *   if (!adapter) return; // not on a supported video page
 *
 * Adapter contract (duck-typed; no enforced base class to keep the registry
 * friendly to be loaded multiple times under MV3 service-worker restart):
 *
 *   {
 *     id: "youtube",                  // Stable identifier, used as cache key prefix.
 *     matches(url: string): boolean,  // True iff this URL is a watchable video page.
 *     extractVideoId(url: string): string | null, // Returns canonical platform ID.
 *     canonicalUrl(videoId: string): string,      // Returns canonical watch URL.
 *
 *     // Optional — required for any adapter used by background.js to fetch
 *     // transcripts and player details.
 *     fetchTranscript({videoId, settings}): Promise<TranscriptResult>,
 *     getMainWorldScript(): string,    // Function body executed in MAIN world
 *                                     // to read canonical videoDetails.
 *                                     // Must return a plain object or null.
 *
 *     // Optional — used by content.js to inject UI elements.
 *     playerSelectors: {
 *       actionBarRow: string,         // CSS selector for the row of action buttons.
 *       actionBarGroup: string,       // CSS selector for the button group container.
 *       playerContainer: string,      // CSS selector for the player wrapper.
 *       videoElement: string,         // CSS selector for the <video> element.
 *     },
 *     spaNavigationEvent: string,      // Event name to listen to for in-page nav.
 *   }
 *
 * TranscriptResult shape (returned by fetchTranscript):
 *   {
 *     success: true,
 *     transcript: [{ start: number, duration: number, text: string, language: string|null }],
 *     transcriptText: string,             // Plain text, joined for display.
 *     transcriptTextTimestamped: string,  // "[MM:SS] text\n..." for AI.
 *     language: string | null,
 *     source: "native" | "asr" | "third-party",
 *   }
 * or on failure:
 *   { success: false, error: string, message: string }
 */

(function (global) {
  const YTD_PLATFORMS = {
    _adapters: [],

    /**
     * Registers an adapter. Re-registering the same id overwrites in place
     * to keep things idempotent across service-worker restarts.
     */
    register(adapter) {
      if (!adapter || typeof adapter.id !== "string" || !adapter.id) {
        throw new Error("Adapter must have a non-empty string id.");
      }
      const required = ["matches", "extractVideoId", "canonicalUrl"];
      for (const fn of required) {
        if (typeof adapter[fn] !== "function") {
          throw new Error(`Adapter "${adapter.id}" is missing ${fn}()`);
        }
      }
      const existingIndex = this._adapters.findIndex((a) => a.id === adapter.id);
      if (existingIndex >= 0) {
        this._adapters[existingIndex] = adapter;
      } else {
        this._adapters.push(adapter);
      }
    },

    /**
     * Returns the first adapter whose matches() returns true for the URL,
     * or null when no adapter recognises it.
     */
    findByUrl(url) {
      const normalized = String(url || "").trim();
      for (const adapter of this._adapters) {
        try {
          if (adapter.matches(normalized)) return adapter;
        } catch (err) {
          console.warn(`[YTD] Adapter "${adapter.id}".matches() threw:`, err);
        }
      }
      return null;
    },

    findById(id) {
      if (!id) return null;
      return this._adapters.find((a) => a.id === id) || null;
    },

    list() {
      return this._adapters.slice();
    },

    /** Test helper: clears all registered adapters (Node tests only). */
    _reset() {
      this._adapters.length = 0;
    },
  };

  global.YTD_PLATFORMS = YTD_PLATFORMS;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = YTD_PLATFORMS;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
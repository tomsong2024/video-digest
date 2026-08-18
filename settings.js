/**
 * Shared, non-secret configuration helpers.
 *
 * API keys are stored in chrome.storage.local by options.js. This file contains
 * defaults and validation only, so it is safe to publish.
 *
 * Transcript provider keys (Supadata today, Bilibili/Vimeo/X equivalents
 * tomorrow) are bucketed by PlatformAdapter id under `transcriptKeys`. The
 * legacy top-level `supadataApiKey` field is still accepted on input and
 * mirrored back on output so existing users, tests, and adapter call sites
 * keep working through the migration window.
 *
 * AI providers are registered in `AI_PROVIDERS`. The active provider is
 * stored under `settings.provider`; its `baseUrl` and `model` are derived
 * from the registry so call sites read `settings.aiBaseUrl` / `settings.aiModel`
 * without having to look the provider up. Users pick the provider in the
 * options page; the model name and endpoint are locked.
 */
var YTD_SETTINGS = (() => {
  const STORAGE_KEY = "ytd_settings";
  /**
   * Adapter ids that own a transcript-provider key slot. Order matters only
   * for iteration; lookup goes through `transcriptKeys[adapterId]`.
   *
   * When Stage 2 ships a new platform (e.g. bilibili.js), append its id here
   * so the bucket is recognised by `normalize` and `transcriptKeyFor`.
   */
  const TRANSCRIPT_ADAPTER_IDS = Object.freeze(["youtube", "bilibili"]);
  /**
   * AI providers users can pick in the options page. Order matters only for
   * iteration in the UI; runtime lookup goes through `settings.provider`.
   *
   * Adding a provider here is enough to surface it in the radio list — no
   * background.js or options.js wiring changes needed. Keep model names and
   * endpoints locked so users can't accidentally misconfigure a request.
   */
  const AI_PROVIDERS = Object.freeze({
    deepseek: Object.freeze({
      label: "DeepSeek V4 Flash",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      keyLink: "https://platform.deepseek.com/api_keys",
    }),
    minimax: Object.freeze({
      label: "MiniMax M3",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M3",
      keyLink: "https://platform.minimax.io/user-center/basic-information/interface-key",
    }),
  });
  const AI_PROVIDER_IDS = Object.freeze(Object.keys(AI_PROVIDERS));
  const DEFAULTS = Object.freeze({
    provider: "minimax",
    aiApiKey: "",
    // Derived from `provider` at normalize time. Kept on the output so the
    // existing `settings.aiBaseUrl` / `settings.aiModel` call sites in
    // background.js continue to read them without provider-aware logic.
    aiBaseUrl: AI_PROVIDERS.minimax.baseUrl,
    aiModel: AI_PROVIDERS.minimax.model,
    // Legacy alias for `transcriptKeys.youtube`. Kept on output until every
    // call site has been migrated to read from `transcriptKeys` directly.
    supadataApiKey: "",
    transcriptKeys: Object.freeze({}),
    // When true, background.js sends the unpunctuated Chinese transcript to
    // the active AI provider on every digest and replaces it with the
    // punctuated version before rendering / export. When false, the side
    // panel keeps using its local heuristic-only fallback. Defaults to true
    // so users get readable B-station captions out of the box; the option
    // page exposes the toggle so users on tight AI quotas can opt out.
    aiPunctuationEnabled: true,
  });

  function isLegacyCustom(input) {
    return !!input && trimString(input.provider) === "custom";
  }

  /**
   * Resolves the active AI provider id from a (possibly partial) input.
   * Anything not in the registry falls back to the default. The legacy
   * "custom" marker is treated as "unknown" so old storage round-trips into
   * the default provider rather than being rejected outright.
   */
  function resolveProviderId(input) {
    const requested = trimString(input && input.provider);
    return AI_PROVIDERS[requested] ? requested : DEFAULTS.provider;
  }

  function trimString(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  /**
   * Builds the per-adapter transcript key bucket from any supported input
   * shape. Accepts both the legacy `supadataApiKey` field (folded into the
   * `youtube` bucket) and the new `transcriptKeys` object. Unknown adapter ids
   * are ignored so a partially-typed future bucket can't crash normalize.
   */
  function normalizeTranscriptKeys(input) {
    const known = new Set(TRANSCRIPT_ADAPTER_IDS);
    const merged = {};
    const legacy = trimString(input && input.supadataApiKey);
    if (legacy && known.has("youtube")) {
      merged.youtube = legacy;
    }
    const incoming = input && input.transcriptKeys;
    if (incoming && typeof incoming === "object") {
      for (const adapterId of known) {
        const value = trimString(incoming[adapterId]);
        if (value) merged[adapterId] = value;
      }
    }
    return Object.freeze(merged);
  }

  function normalize(input = {}) {
    const transcriptKeys = normalizeTranscriptKeys(input);
    const provider = resolveProviderId(input);
    const providerConfig = AI_PROVIDERS[provider];
    // Legacy "custom" storage may carry a non-DeepSeek key in `aiApiKey`.
    // The migration clears it so it never leaks to the new active provider.
    return {
      provider,
      aiApiKey: isLegacyCustom(input) ? "" : trimString(input.aiApiKey),
      aiBaseUrl: providerConfig.baseUrl,
      aiModel: providerConfig.model,
      // Legacy alias — mirrors `transcriptKeys.youtube` so call sites that
      // haven't migrated yet keep reading the YouTube key transparently.
      supadataApiKey: transcriptKeys.youtube || "",
      transcriptKeys,
      // Strict boolean coercion — but only when the key is actually
      // present in storage. A missing key falls back to the default
      // so fresh-install users get the AI pass without having to flip
      // the option on, while a stray "yes" / 1 from a future migration
      // still collapses to false (the explicit false is what opts out).
      aiPunctuationEnabled: hasOwn(input, "aiPunctuationEnabled")
        ? input.aiPunctuationEnabled === true
        : DEFAULTS.aiPunctuationEnabled,
    };
  }

  function hasOwn(value, key) {
    return !!value && Object.prototype.hasOwnProperty.call(value, key);
  }

  function migrateLegacyCustom(input = {}) {
    return {
      settings: normalize(input),
      migrated: isLegacyCustom(input),
    };
  }

  function chatCompletionsUrl(settings) {
    const providerConfig = AI_PROVIDERS[(settings && settings.provider) || DEFAULTS.provider]
      || AI_PROVIDERS[DEFAULTS.provider];
    return `${providerConfig.baseUrl}/chat/completions`;
  }

  /**
   * Reads the transcript-provider key for a given adapter id from a normalized
   * settings object. Returns "" when the bucket is empty so callers can do a
   * plain truthy check without a separate guard.
   */
  function transcriptKeyFor(settings, adapterId) {
    if (!settings || typeof adapterId !== "string") return "";
    return trimString(settings.transcriptKeys && settings.transcriptKeys[adapterId]);
  }

  /**
   * Lists adapter ids that currently have a non-empty transcript-provider key
   * configured. Used by sidepanel/status surfaces to drive per-platform
   * "missing key" copy without hard-coding platform names.
   */
  function listTranscriptKeyIds(settings) {
    const keys = settings && settings.transcriptKeys;
    if (!keys || typeof keys !== "object") return [];
    return Object.keys(keys).filter((id) => trimString(keys[id]));
  }

  /**
   * Lists AI provider ids in the order the options page should render them.
   * Returned array is a copy so callers can't mutate the frozen registry.
   */
  function listAiProviderIds() {
    return AI_PROVIDER_IDS.slice();
  }

  /**
   * Reads a single field off the AI provider registry, or "" when the id is
   * unknown. Used by options.js to render provider-aware copy (label, link,
   * placeholder) without leaking the whole config object into the DOM.
   */
  function aiProviderField(providerId, field) {
    const config = AI_PROVIDERS[providerId];
    if (!config || !field) return "";
    const value = config[field];
    return typeof value === "string" ? value : "";
  }

  /**
   * Returns the canonical watch URL for a (adapterId, videoId) pair by
   * delegating to the registered PlatformAdapter. Looks up the adapter
   * lazily so settings.js can be parsed before platforms/adapter-base.js
   * loads (e.g. in background.js's importScripts order). Throws when no
   * adapter matches the id or the adapter rejects the id format.
   *
   * @param {string} adapterId - Stable adapter id ("youtube", future
   *   "bilibili", etc). Case-sensitive.
   * @param {string} videoId - Platform-specific video identifier.
   * @returns {string} Canonical watch URL.
   */
  function canonicalVideoUrl(adapterId, videoId) {
    if (typeof YTD_PLATFORMS === "undefined" || !YTD_PLATFORMS) {
      throw new Error(
        "Adapter registry not loaded. Load platforms/adapter-base.js before calling canonicalVideoUrl().",
      );
    }
    const adapter = YTD_PLATFORMS.findById(adapterId);
    if (!adapter) {
      throw new Error("Unknown platform adapter: " + String(adapterId));
    }
    return adapter.canonicalUrl(videoId);
  }

  return {
    STORAGE_KEY,
    DEFAULTS,
    TRANSCRIPT_ADAPTER_IDS,
    AI_PROVIDERS,
    listAiProviderIds,
    aiProviderField,
    isLegacyCustom,
    normalize,
    migrateLegacyCustom,
    chatCompletionsUrl,
    transcriptKeyFor,
    listTranscriptKeyIds,
    canonicalVideoUrl,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_SETTINGS;
}

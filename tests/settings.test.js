const test = require("node:test");
const assert = require("node:assert/strict");

// Adapter scripts must register before settings.canonicalVideoUrl() is
// called, mirroring the importScripts order background.js uses.
require("../platforms/adapter-base.js");
require("../platforms/youtube.js");
require("../platforms/bilibili.js");

const settings = require("../settings.js");

test("AI provider defaults use the MiniMax M3 registry entry", () => {
  const normalized = settings.normalize({
    provider: "unexpected",
    aiApiKey: "  example-key  ",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "example-model",
    supadataApiKey: "  example-supadata  ",
  });

  // Anything not in the registry falls back to the default provider, which
  // is MiniMax M3 (per the AI_PROVIDERS registry). The user's stale
  // baseUrl/model are dropped because they're locked to the provider.
  assert.equal(normalized.provider, "minimax");
  assert.equal(normalized.aiBaseUrl, "https://api.minimaxi.com/v1");
  assert.equal(normalized.aiModel, "MiniMax-M3");
  assert.equal(normalized.aiApiKey, "example-key");
  assert.equal(normalized.supadataApiKey, "example-supadata");
  assert.equal(
    settings.chatCompletionsUrl(normalized),
    "https://api.minimaxi.com/v1/chat/completions",
  );
});

test("DeepSeek V4 Flash is selectable through the provider registry", () => {
  const normalized = settings.normalize({
    provider: "deepseek",
    aiApiKey: "  deepseek-key  ",
  });

  assert.equal(normalized.provider, "deepseek");
  assert.equal(normalized.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(normalized.aiModel, "deepseek-v4-flash");
  assert.equal(normalized.aiApiKey, "deepseek-key");
  assert.equal(
    settings.chatCompletionsUrl(normalized),
    "https://api.deepseek.com/chat/completions",
  );
});

test("AI_PROVIDERS registry exposes both DeepSeek and MiniMax M3", () => {
  // Adding a new provider here is enough to surface it in the options page
  // radio list — no background.js / options.js wiring needed. The label is
  // the user-facing name; baseUrl + model + keyLink must be locked so a
  // typo can't silently send traffic to the wrong service.
  assert.equal(settings.aiProviderField("deepseek", "label"), "DeepSeek V4 Flash");
  assert.equal(settings.aiProviderField("deepseek", "baseUrl"), "https://api.deepseek.com");
  assert.equal(settings.aiProviderField("deepseek", "model"), "deepseek-v4-flash");
  assert.equal(
    settings.aiProviderField("deepseek", "keyLink"),
    "https://platform.deepseek.com/api_keys",
  );

  assert.equal(settings.aiProviderField("minimax", "label"), "MiniMax M3");
  assert.equal(settings.aiProviderField("minimax", "baseUrl"), "https://api.minimaxi.com/v1");
  assert.equal(settings.aiProviderField("minimax", "model"), "MiniMax-M3");
  assert.equal(
    settings.aiProviderField("minimax", "keyLink"),
    "https://platform.minimax.io/user-center/basic-information/interface-key",
  );

  // listAiProviderIds returns a fresh copy in the registry order so the
  // options page renders a stable radio list without mutating frozen state.
  assert.deepEqual(settings.listAiProviderIds(), ["deepseek", "minimax"]);
  // Mutating the returned array must not leak into the registry.
  const ids = settings.listAiProviderIds();
  ids.push("rogue");
  assert.deepEqual(settings.listAiProviderIds(), ["deepseek", "minimax"]);

  // Unknown provider ids and unknown fields fall back to "" so callers
  // don't have to guard for null/undefined separately.
  assert.equal(settings.aiProviderField("rogue", "label"), "");
  assert.equal(settings.aiProviderField("minimax", "secret"), "");
  assert.equal(settings.aiProviderField("minimax", ""), "");
});

test("legacy custom migration clears only the AI key and is idempotent", () => {
  const legacy = {
    provider: "custom",
    aiApiKey: "custom-secret",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "example-model",
    supadataApiKey: " supadata-secret ",
  };
  const first = settings.migrateLegacyCustom(legacy);

  // "custom" is treated as unknown so the legacy round-trips into the
  // default provider (MiniMax M3). Stale baseUrl/model are dropped because
  // they're now derived from the registry.
  assert.equal(first.migrated, true);
  assert.equal(first.settings.provider, "minimax");
  assert.equal(first.settings.aiBaseUrl, settings.DEFAULTS.aiBaseUrl);
  assert.equal(first.settings.aiModel, settings.DEFAULTS.aiModel);
  assert.equal(first.settings.aiApiKey, "");
  assert.equal(first.settings.supadataApiKey, "supadata-secret");

  const second = settings.migrateLegacyCustom(first.settings);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.settings, first.settings);

  // After migration the user picks a provider (here: DeepSeek) and the
  // active baseUrl/model flip to that registry entry.
  const configuredDeepSeek = settings.normalize({
    ...first.settings,
    provider: "deepseek",
    aiApiKey: "new-deepseek-key",
  });
  assert.equal(configuredDeepSeek.provider, "deepseek");
  assert.equal(configuredDeepSeek.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(configuredDeepSeek.aiModel, "deepseek-v4-flash");
  assert.equal(configuredDeepSeek.aiApiKey, "new-deepseek-key");
});

test("canonicalVideoUrl delegates to the registered adapters", () => {
  assert.equal(
    settings.canonicalVideoUrl("youtube", "ydTeb_I0b94"),
    "https://www.youtube.com/watch?v=ydTeb_I0b94",
  );
  // Bilibili is registered too — valid BV ids round-trip to the canonical
  // bilibili.com URL, and the adapter rejects garbage ids with a clear
  // "Invalid Bilibili video ID" message (mirroring the YouTube adapter).
  assert.equal(
    settings.canonicalVideoUrl("bilibili", "BV1xx411c7mD"),
    "https://www.bilibili.com/video/BV1xx411c7mD",
  );
  assert.throws(
    () => settings.canonicalVideoUrl("youtube", '"><script>'),
    /Invalid YouTube video ID/,
  );
  assert.throws(
    () => settings.canonicalVideoUrl("bilibili", "abc123"),
    /Invalid Bilibili video ID/,
  );

  // Unknown adapter id surfaces a clear error so callers can debug.
  assert.throws(
    () => settings.canonicalVideoUrl("no-such-adapter", "abc123"),
    /Unknown platform adapter: no-such-adapter/,
  );
});

test("transcriptKeys bucket folds legacy supadataApiKey into the youtube slot", () => {
  const normalized = settings.normalize({
    supadataApiKey: "  legacy-supadata-key  ",
  });

  assert.equal(normalized.transcriptKeys.youtube, "legacy-supadata-key");
  // Legacy alias still mirrors the youtube slot so call sites that haven't
  // migrated keep reading the key transparently.
  assert.equal(normalized.supadataApiKey, "legacy-supadata-key");
});

test("transcriptKeys bucket honours the new shape and drops unknown adapter ids", () => {
  const normalized = settings.normalize({
    transcriptKeys: {
      youtube: "new-youtube-key",
      bilibili: "future-bilibili-key",
      unknownAdapter: "should-be-dropped",
    },
  });

  // Known adapters (YouTube + Bilibili) are kept so saved settings with
  // both platforms round-trip through normalize without losing keys.
  assert.equal(normalized.transcriptKeys.youtube, "new-youtube-key");
  assert.equal(normalized.transcriptKeys.bilibili, "future-bilibili-key");
  // Unknown adapters are dropped so a partially-typed future bucket
  // can't crash normalize.
  assert.equal(normalized.transcriptKeys.unknownAdapter, undefined);
  // Legacy alias still mirrors the youtube slot.
  assert.equal(normalized.supadataApiKey, "new-youtube-key");
});

test("transcriptKeys bucket prefers the new shape over legacy when both are present", () => {
  const normalized = settings.normalize({
    supadataApiKey: "legacy-supadata-key",
    transcriptKeys: {
      youtube: "new-youtube-key",
    },
  });

  // New shape wins so saved settings with both fields round-trip to the
  // most-recent value without surprise overwrites.
  assert.equal(normalized.transcriptKeys.youtube, "new-youtube-key");
  assert.equal(normalized.supadataApiKey, "new-youtube-key");
});

test("transcriptKeyFor returns the per-adapter key with empty-string fallback", () => {
  const normalized = settings.normalize({
    transcriptKeys: { youtube: "  active-key  " },
  });

  assert.equal(settings.transcriptKeyFor(normalized, "youtube"), "active-key");
  // No key configured for an unknown adapter returns "" rather than
  // undefined so callers can do a plain truthy check.
  assert.equal(settings.transcriptKeyFor(normalized, "bilibili"), "");
  // Defensive fallbacks for partial inputs.
  assert.equal(settings.transcriptKeyFor(null, "youtube"), "");
  assert.equal(settings.transcriptKeyFor(normalized, undefined), "");
});

test("listTranscriptKeyIds surfaces only adapters with non-empty keys", () => {
  // YouTube + Bilibili are both registered adapters, so when both have keys
  // they both surface. listTranscriptKeyIds skips empty strings so future
  // adapters can opt in by setting a non-empty key without re-listing here.
  const normalized = settings.normalize({
    transcriptKeys: {
      youtube: "active-key",
      bilibili: "future-bilibili-key",
    },
  });

  assert.deepEqual(
    settings.listTranscriptKeyIds(normalized),
    ["youtube", "bilibili"],
  );
  // Empty / partial inputs return [] instead of throwing.
  assert.deepEqual(settings.listTranscriptKeyIds(null), []);
});

test("TRANSCRIPT_ADAPTER_IDS exposes the known transcript-providing adapters", () => {
  // Used by status surfaces to drive per-platform "missing key" copy
  // without hard-coding platform names. Order is the canonical render
  // order on the options page; freeze is preserved so callers can't
  // mutate the registry out from under normalize.
  assert.deepEqual(
    [...settings.TRANSCRIPT_ADAPTER_IDS],
    ["youtube", "bilibili"],
  );
  assert.equal(Object.isFrozen(settings.TRANSCRIPT_ADAPTER_IDS), true);
});

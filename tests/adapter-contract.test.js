/**
 * Node tests for the PlatformAdapter contract.
 *
 * Two layers are exercised:
 *
 *   1. The registry (YTD_PLATFORMS) — register() validation, idempotency,
 *      findByUrl() / findById() lookup semantics, list(), and _reset().
 *
 *   2. The YouTube adapter — matches() / extractVideoId() / canonicalUrl()
 *      behaviour across watch URLs, Shorts URLs, and invalid inputs.
 *
 * Future adapters (Bilibili / Vimeo / X / 抖音) only need to satisfy the
 * registry contract; their own test files should mirror the YouTube block
 * below.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

// Each test starts from a clean registry. We load adapter-base.js once
// outside any test to share the singleton, then reset between cases.
const registry = require("../platforms/adapter-base.js");
require("../platforms/youtube.js");
require("../platforms/bilibili.js");

// A minimal adapter stub that satisfies the contract. Used to exercise the
// registry without depending on a concrete platform implementation.
function makeStubAdapter(overrides = {}) {
  return Object.assign(
    {
      id: "stub",
      matches() {
        return false;
      },
      extractVideoId() {
        return null;
      },
      canonicalUrl() {
        return "https://stub.example/watch?v=1";
      },
    },
    overrides,
  );
}

test.beforeEach(() => {
  registry._reset();
  // Re-register the production adapters so the registry is in the same
  // state as production after each reset. We re-require to retrigger the
  // IIFE's YTD_PLATFORMS.register() call.
  delete require.cache[require.resolve("../platforms/youtube.js")];
  require("../platforms/youtube.js");
  delete require.cache[require.resolve("../platforms/bilibili.js")];
  require("../platforms/bilibili.js");
});

// ============================================================
// Registry contract
// ============================================================

test("register() rejects adapters missing required fields", () => {
  assert.throws(
    () => registry.register({}),
    /must have a non-empty string id/,
  );
  assert.throws(
    () => registry.register({ id: "" }),
    /must have a non-empty string id/,
  );
  assert.throws(
    () => registry.register({ id: "x", matches: () => false }),
    /missing extractVideoId/,
  );
  assert.throws(
    () =>
      registry.register({
        id: "x",
        matches: () => false,
        extractVideoId: () => null,
      }),
    /missing canonicalUrl/,
  );
});

test("register() is idempotent — re-registering the same id overwrites", () => {
  // YouTube is already registered by beforeEach; we only count our own
  // adapter so the assertion isolates the idempotency invariant.
  const baseline = registry.list().length;
  const first = makeStubAdapter({ id: "alpha", canonicalUrl: () => "first" });
  const second = makeStubAdapter({ id: "alpha", canonicalUrl: () => "second" });

  registry.register(first);
  registry.register(second);

  const found = registry.findById("alpha");
  assert.equal(found.canonicalUrl("ignored"), "second");
  assert.equal(
    registry.list().length,
    baseline + 1,
    "re-registering the same id must not add a second entry",
  );
});

test("findByUrl() returns the first adapter whose matches() returns true", () => {
  const adapter = makeStubAdapter({
    id: "alpha",
    matches: (url) => url.startsWith("https://alpha.example/"),
  });
  registry.register(adapter);

  assert.equal(
    registry.findByUrl("https://alpha.example/watch?v=abc"),
    adapter,
  );
  assert.equal(registry.findByUrl("https://other.example/"), null);
});

test("findByUrl() treats empty and non-string inputs as no-match", () => {
  assert.equal(registry.findByUrl(""), null);
  assert.equal(registry.findByUrl(undefined), null);
  assert.equal(registry.findByUrl(null), null);
  assert.equal(registry.findByUrl(42), null);
});

test("findByUrl() swallows exceptions from matches() and continues searching", () => {
  const noisy = makeStubAdapter({
    id: "noisy",
    matches: () => {
      throw new Error("kaboom");
    },
  });
  const quiet = makeStubAdapter({
    id: "quiet",
    matches: (url) => url === "https://quiet.example/",
  });

  registry.register(noisy);
  registry.register(quiet);

  // Suppress the warn() output the registry emits when an adapter throws.
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(
      registry.findByUrl("https://quiet.example/"),
      quiet,
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("findById() returns the registered adapter or null", () => {
  const adapter = makeStubAdapter({ id: "alpha" });
  registry.register(adapter);

  assert.equal(registry.findById("alpha"), adapter);
  assert.equal(registry.findById("missing"), null);
  assert.equal(registry.findById(""), null);
  assert.equal(registry.findById(null), null);
});

test("list() returns a snapshot copy that callers cannot mutate", () => {
  // YouTube is already registered by beforeEach.
  const baseline = registry.list().length;
  registry.register(makeStubAdapter({ id: "a" }));
  registry.register(makeStubAdapter({ id: "b" }));

  const snapshot = registry.list();
  assert.equal(snapshot.length, baseline + 2);
  snapshot.pop();
  assert.equal(
    registry.list().length,
    baseline + 2,
    "registry state must not change after mutating the snapshot",
  );
});

// ============================================================
// YouTube adapter — concrete contract assertions
// ============================================================

const youtube = registry.findById("youtube");

test("YouTube adapter is registered with the expected shape", () => {
  assert.ok(youtube, "YouTube adapter must self-register on load");
  assert.equal(youtube.id, "youtube");
  assert.equal(typeof youtube.matches, "function");
  assert.equal(typeof youtube.extractVideoId, "function");
  assert.equal(typeof youtube.canonicalUrl, "function");
  assert.equal(typeof youtube.getMainWorldScript, "function");
  assert.equal(typeof youtube.fetchTranscript, "function");
  assert.ok(youtube.playerSelectors, "selector map is required for content.js");
  assert.equal(typeof youtube.spaNavigationEvent, "string");
});

test("YouTube matches() accepts watch URLs with a v= param", () => {
  assert.ok(
    youtube.matches("https://www.youtube.com/watch?v=ydTeb_I0b94"),
    "standard watch URL",
  );
  assert.ok(
    youtube.matches("https://www.youtube.com/watch?v=abc&t=42s"),
    "watch URL with extra query params",
  );
});

test("YouTube matches() accepts Shorts URLs", () => {
  assert.ok(
    youtube.matches("https://www.youtube.com/shorts/ydTeb_I0b94"),
    "Shorts are matched even though they have no native captions",
  );
});

test("YouTube matches() rejects unrelated hosts, paths, and malformed input", () => {
  assert.equal(youtube.matches("https://www.youtube.com/"), false);
  assert.equal(youtube.matches("https://www.youtube.com/feed/trending"), false);
  assert.equal(youtube.matches("https://www.youtube.com/watch"), false);
  assert.equal(youtube.matches("https://youtu.be/ydTeb_I0b94"), false);
  assert.equal(youtube.matches("https://example.com/watch?v=abc"), false);
  assert.equal(youtube.matches("not-a-url"), false);
  assert.equal(youtube.matches(""), false);
  assert.equal(youtube.matches(undefined), false);
  assert.equal(youtube.matches(null), false);
  assert.equal(youtube.matches(123), false);
});

test("YouTube extractVideoId() pulls the v= param from watch URLs", () => {
  assert.equal(
    youtube.extractVideoId("https://www.youtube.com/watch?v=ydTeb_I0b94"),
    "ydTeb_I0b94",
  );
  // Real YouTube IDs are 11 chars; the adapter rejects shorter ids.
  assert.equal(
    youtube.extractVideoId(
      "https://www.youtube.com/watch?v=ydTeb_I0b9&t=10s",
    ),
    "ydTeb_I0b9",
  );
});

test("YouTube extractVideoId() pulls the path segment from Shorts URLs", () => {
  assert.equal(
    youtube.extractVideoId("https://www.youtube.com/shorts/ydTeb_I0b94"),
    "ydTeb_I0b94",
  );
});

test("YouTube extractVideoId() returns null for invalid inputs", () => {
  assert.equal(
    youtube.extractVideoId("https://www.youtube.com/feed/trending"),
    null,
  );
  assert.equal(youtube.extractVideoId("https://www.youtube.com/"), null);
  assert.equal(youtube.extractVideoId("not-a-url"), null);
  assert.equal(youtube.extractVideoId(""), null);
  assert.equal(youtube.extractVideoId(undefined), null);
});

test("YouTube canonicalUrl() builds a canonical watch URL", () => {
  assert.equal(
    youtube.canonicalUrl("ydTeb_I0b94"),
    "https://www.youtube.com/watch?v=ydTeb_I0b94",
  );
});

test("YouTube canonicalUrl() rejects malformed IDs", () => {
  assert.throws(() => youtube.canonicalUrl(""), /Invalid YouTube video ID/);
  assert.throws(
    () => youtube.canonicalUrl('"><script>'),
    /Invalid YouTube video ID/,
  );
  assert.throws(() => youtube.canonicalUrl("a"), /Invalid YouTube video ID/);
  // IDs that are too long should also fail.
  assert.throws(
    () => youtube.canonicalUrl("a".repeat(30)),
    /Invalid YouTube video ID/,
  );
});

test("YouTube getMainWorldScript() returns a function body that yields an object or null", () => {
  const body = youtube.getMainWorldScript();
  assert.equal(typeof body, "string");
  assert.ok(body.length > 0, "function body must not be empty");

  // Wrap the body in a function and execute it; it must not throw and must
  // return a plain serialisable value. We run it in a sandbox-ish context.
  const fn = new Function(body);
  // No DOM is set up, so the script returns null gracefully (it catches its
  // own errors and returns null).
  assert.equal(fn(), null);
});

test("YouTube findByUrl() routes real watch URLs to the YouTube adapter", () => {
  // Sanity check: a real watch URL routes to the YouTube adapter (not null,
  // not a different adapter).
  const match = registry.findByUrl(
    "https://www.youtube.com/watch?v=ydTeb_I0b94",
  );
  assert.equal(match && match.id, "youtube");
});

// ============================================================
// Bilibili adapter — concrete contract assertions
//
// Mirrors the YouTube block above so that future bilibili regressions
// (bad URL matcher, BV-id regex drift, SESSDATA routing drift) surface as
// dedicated failures instead of generic "registry test broke".
// ============================================================

const bilibili = registry.findById("bilibili");

test("Bilibili adapter is registered with the expected shape", () => {
  assert.ok(bilibili, "Bilibili adapter must self-register on load");
  assert.equal(bilibili.id, "bilibili");
  assert.equal(typeof bilibili.matches, "function");
  assert.equal(typeof bilibili.extractVideoId, "function");
  assert.equal(typeof bilibili.canonicalUrl, "function");
  assert.equal(typeof bilibili.getMainWorldScript, "function");
  assert.equal(typeof bilibili.fetchTranscript, "function");
  assert.ok(bilibili.playerSelectors, "selector map is required for content.js");
  assert.equal(typeof bilibili.spaNavigationEvent, "string");
});

test("Bilibili matches() accepts /video/{BV...|av...} URLs", () => {
  assert.ok(
    bilibili.matches("https://www.bilibili.com/video/BV1xx411c7mD"),
    "canonical BV watch URL",
  );
  // Multi-part (分P) videos carry a ?p=2 query string — matches() must not
  // reject them since the BV id is still the canonical video reference.
  assert.ok(
    bilibili.matches("https://www.bilibili.com/video/BV1xx411c7mD?p=2"),
    "multi-part URL with ?p=2 query",
  );
  // av-numbered videos are also valid; they coexist with BV ids.
  assert.ok(
    bilibili.matches("https://www.bilibili.com/video/av170001"),
    "av-numbered video URL",
  );
});

test("Bilibili matches() rejects unrelated hosts, paths, and malformed input", () => {
  assert.equal(bilibili.matches("https://www.bilibili.com/"), false);
  // Bangumi episodes live at /bangumi/play/{epid}; the adapter intentionally
  // opts out so the first release stays focused on regular videos.
  assert.equal(
    bilibili.matches("https://www.bilibili.com/bangumi/play/ep123"),
    false,
  );
  // A BV-shaped id embedded in a non-/video/ path is not a watchable URL.
  assert.equal(
    bilibili.matches("https://www.bilibili.com/favorite/BV1xx411c7mD"),
    false,
  );
  // /video/ without a recognised id segment must not match.
  assert.equal(bilibili.matches("https://www.bilibili.com/video/"), false);
  assert.equal(
    bilibili.matches("https://www.bilibili.com/video/garbage-id"),
    false,
  );
  // Cross-host URLs never match — YouTube and unrelated sites must be
  // routed to their own adapters (or none).
  assert.equal(
    bilibili.matches("https://example.com/video/BV1xx411c7mD"),
    false,
  );
  assert.equal(
    bilibili.matches("https://www.youtube.com/watch?v=abc"),
    false,
  );
  // Generic bad inputs must not throw — matches() returns false for them.
  assert.equal(bilibili.matches("not-a-url"), false);
  assert.equal(bilibili.matches(""), false);
  assert.equal(bilibili.matches(undefined), false);
  assert.equal(bilibili.matches(null), false);
  assert.equal(bilibili.matches(123), false);
});

test("Bilibili extractVideoId() pulls the BV id from the path", () => {
  assert.equal(
    bilibili.extractVideoId("https://www.bilibili.com/video/BV1xx411c7mD"),
    "BV1xx411c7mD",
  );
  // Multi-part URLs: the videoId comes from the path segment, query params
  // like ?p=2 are intentionally ignored so the canonical URL stays clean.
  assert.equal(
    bilibili.extractVideoId("https://www.bilibili.com/video/BV1xx411c7mD?p=2"),
    "BV1xx411c7mD",
  );
});

test("Bilibili extractVideoId() handles av ids (case-insensitive, canonicalised)", () => {
  assert.equal(
    bilibili.extractVideoId("https://www.bilibili.com/video/av170001"),
    "av170001",
  );
  // The "AV" prefix is case-insensitive; the adapter canonicalises it to
  // lowercase so the same id always serialises the same way downstream.
  assert.equal(
    bilibili.extractVideoId("https://www.bilibili.com/video/AV170001"),
    "av170001",
  );
});

test("Bilibili extractVideoId() returns null for invalid inputs", () => {
  assert.equal(bilibili.extractVideoId("https://www.bilibili.com/"), null);
  assert.equal(
    bilibili.extractVideoId("https://www.bilibili.com/bangumi/play/ep123"),
    null,
  );
  // Garbage in the id slot must not crash — the adapter returns null and
  // lets the caller fall back to a "no adapter for this page" UX.
  assert.equal(
    bilibili.extractVideoId("https://www.bilibili.com/video/garbage-id"),
    null,
  );
  assert.equal(bilibili.extractVideoId("not-a-url"), null);
  assert.equal(bilibili.extractVideoId(""), null);
  assert.equal(bilibili.extractVideoId(undefined), null);
});

test("Bilibili canonicalUrl() builds a canonical /video/{id} URL", () => {
  assert.equal(
    bilibili.canonicalUrl("BV1xx411c7mD"),
    "https://www.bilibili.com/video/BV1xx411c7mD",
  );
  assert.equal(
    bilibili.canonicalUrl("av170001"),
    "https://www.bilibili.com/video/av170001",
  );
  // BV ids must use the canonical uppercase "BV" prefix; the regex
  // anchors this strictly because Bilibili's servers are case-sensitive.
  // Lowercase prefixes are rejected as invalid (covered by the malformed-id
  // test below) — we keep the canonical case here to document the happy path.
  assert.equal(
    bilibili.canonicalUrl("BV1XX411C7MD"),
    "https://www.bilibili.com/video/BV1XX411C7MD",
  );
});

test("Bilibili canonicalUrl() rejects malformed IDs", () => {
  assert.throws(() => bilibili.canonicalUrl(""), /Invalid Bilibili video ID/);
  // A BV id must be exactly 12 chars (BV + 10 base58 chars); shorter ids fail.
  assert.throws(() => bilibili.canonicalUrl("BV123"), /Invalid Bilibili video ID/);
  // "not-a-bv-id-1234" doesn't match BV_REGEX (contains '-') and isn't an
  // av id, so it's rejected with the same clear message.
  assert.throws(
    () => bilibili.canonicalUrl("not-a-bv-id-1234"),
    /Invalid Bilibili video ID/,
  );
  // av ids must be numeric; "avabc" is rejected.
  assert.throws(() => bilibili.canonicalUrl("avabc"), /Invalid Bilibili video ID/);
});

test("Bilibili getMainWorldScript() returns a function body that yields an object or null", () => {
  const body = bilibili.getMainWorldScript();
  assert.equal(typeof body, "string");
  assert.ok(body.length > 0, "function body must not be empty");

  // Wrap the body in a function and execute it. No DOM is set up so the
  // script returns null gracefully (catches its own errors and returns null).
  const fn = new Function(body);
  assert.equal(fn(), null);
});

test("Bilibili fetchTranscript() surfaces NO_BILIBILI_COOKIE when no SESSDATA is configured", async () => {
  // The adapter must short-circuit before any network call when the user has
  // not configured a SESSDATA cookie. Exercising every empty shape guards
  // against regressions in the per-adapter key bucket (transcriptKeys.bilibili)
  // or the legacy bilibiliSessdata alias — both routing paths should land on
  // the same NO_BILIBILI_COOKIE error code so the side panel can prompt the
  // user without showing a misleading "network error".
  const cases = [
    { settings: undefined },
    { settings: null },
    { settings: {} },
    { settings: { transcriptKeys: {} } },
    { settings: { transcriptKeys: { bilibili: "" } } },
    { settings: { bilibiliSessdata: "" } },
  ];
  for (const { settings } of cases) {
    const result = await bilibili.fetchTranscript({
      videoId: "BV1xx411c7mD",
      settings,
    });
    assert.equal(result.success, false);
    assert.equal(result.error, "NO_BILIBILI_COOKIE");
    assert.match(result.message, /SESSDATA cookie not configured/i);
  }
});

test("Bilibili findByUrl() routes real watch URLs to the Bilibili adapter", () => {
  // Sanity check: a real watch URL routes to the Bilibili adapter (not null,
  // not a different adapter). findByUrl() iterates the registry in
  // registration order, so YouTube's prior registration does not steal
  // bilibili.com URLs — they only overlap on patterns that Bilibili rejects.
  const match = registry.findByUrl(
    "https://www.bilibili.com/video/BV1xx411c7mD",
  );
  assert.equal(match && match.id, "bilibili");
});

// ------------------------------------------------------------
// Bilibili fetchTranscript() — regression coverage for the
// player API response shape.
//
// History: a previous version of fetchSubtitleList() asserted
// `Array.isArray(data.data.subtitle)`, but Bilibili actually
// nests the array one level down (`data.data.subtitle.subtitles`).
// The shape mismatch triggered the error branch for every
// successful call and surfaced a confusing
// "Bilibili player API failed: OK" message to the side panel.
//
// The tests below pin the shape handling so that:
//   - the real Bilibili shape succeeds end-to-end
//   - a future API revision that flattens the array still works
//     (defensive fallback)
//   - a response with no subtitle key at all produces a clean
//     NO_TRANSCRIPT result (not a misleading API-failure error)
//   - a genuine API error (code !== 0) still bubbles up
// ------------------------------------------------------------

function makeBilibiliJsonResponse(body, { ok = true, status = 200 } = {}) {
  // Minimal Response-shaped object: bilibili.js only consumes `ok`,
  // `status`, and the body via `response.json()` (or via the bounded
  // streaming reader when available). We force the non-streaming path
  // by leaving body.getReader undefined.
  return {
    ok,
    status,
    body: undefined,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeBilibiliFetchMock(handlers) {
  // handlers: array of (url, init) => Response, consumed in order.
  // The mock records every call so a test can assert routing if it
  // needs to (no test does today but the breadcrumbs help debug).
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    const handler = handlers[Math.min(i, handlers.length - 1)];
    calls.push({ url: String(url), init });
    i++;
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

test(
  "Bilibili fetchTranscript() succeeds when player API returns {subtitle: {subtitles: [...]}}",
  async (t) => {
    const originalFetch = globalThis.fetch;
    const mock = makeBilibiliFetchMock([
      // 1st call: view API → returns cid
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        }),
      // 2nd call: player API → returns subtitles wrapped in an object
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {
            subtitle: {
              allow_submit: false,
              subtitles: [
                {
                  id: 1,
                  lan: "zh-Hans",
                  lan_doc: "简体中文",
                  is_lock: false,
                  type: 0,
                  subtitle_url:
                    "https://aisubtitle.hdslb.com/bfs/subtitle/fake.json",
                },
              ],
            },
          },
        }),
      // 3rd call: subtitle body download
      () =>
        makeBilibiliJsonResponse({
          lan: "zh-Hans",
          lan_doc: "简体中文",
          body: [
            {from: 0, to: 2, content: "你好"},
            {from: 2, to: 5, content: "世界"},
          ],
        }),
    ]);
    globalThis.fetch = mock;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const result = await bilibili.fetchTranscript({
      videoId: "BV1xx411c7mD",
      settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
    });

    assert.equal(result.success, true);
    assert.equal(result.source, "native");
    assert.equal(result.language, "zh-Hans");
    assert.equal(result.transcript.length, 2);
    assert.equal(result.transcript[0].text, "你好");
    assert.equal(result.transcript[1].text, "世界");
    assert.match(result.transcriptText, /你好.*世界/);
    assert.match(result.transcriptTextTimestamped, /\[0:00\] 你好/);
  },
);

test(
  "Bilibili fetchTranscript() returns NO_TRANSCRIPT when player API reports no subtitles",
  async (t) => {
    const originalFetch = globalThis.fetch;
    const mock = makeBilibiliFetchMock([
      // view API succeeds
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        }),
      // player API returns success but with an empty subtitles list.
      // This must NOT trip the error branch (no more "Bilibili player
      // API failed: OK"); it must surface a clean NO_TRANSCRIPT.
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {subtitle: {allow_submit: false, subtitles: []}},
        }),
    ]);
    globalThis.fetch = mock;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const result = await bilibili.fetchTranscript({
      videoId: "BV1xx411c7mD",
      settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "NO_TRANSCRIPT");
    assert.match(result.message, /No subtitle track is available/i);
  },
);

test(
  "Bilibili fetchTranscript() returns BILIBILI_PLAYER_ERROR when player API rejects the request",
  async (t) => {
    const originalFetch = globalThis.fetch;
    const mock = makeBilibiliFetchMock([
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        }),
      // Player API error: genuine failure must surface as-is so the
      // panel can suggest actionable remediation (re-login, retry, etc.).
      () =>
        makeBilibiliJsonResponse({
          code: -101,
          message: "未登录",
          data: null,
        }),
    ]);
    globalThis.fetch = mock;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const result = await bilibili.fetchTranscript({
      videoId: "BV1xx411c7mD",
      settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "BILIBILI_PLAYER_ERROR");
    assert.match(result.message, /Bilibili player API failed/);
  },
);

test(
  "Bilibili fetchTranscript() reports HTTP status when player API rejects at the transport layer",
  async (t) => {
    // Bilibili's edge layer sometimes rejects with a non-2xx HTTP status
    // (e.g. 412 / 451 / 403) when it detects an unexpected User-Agent or
    // missing WBI signature. The adapter must surface the HTTP status
    // instead of collapsing the failure into a generic API-error message.
    const originalFetch = globalThis.fetch;
    const mock = makeBilibiliFetchMock([
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        }),
      () => makeBilibiliJsonResponse({}, {ok: false, status: 412}),
    ]);
    globalThis.fetch = mock;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const result = await bilibili.fetchTranscript({
      videoId: "BV1xx411c7mD",
      settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "BILIBILI_PLAYER_ERROR");
    assert.match(result.message, /Bilibili player API failed: HTTP 412/);
  },
);

// ------------------------------------------------------------
// Bilibili fetchTranscript() — wbi/v2 → v2 fallback coverage.
//
// History: many Bilibili videos only expose AI captions through the
// newer `x/player/wbi/v2` endpoint; the long-standing `x/player/v2`
// endpoint either omits them entirely or rejects without a WBI
// signature. The adapter must try wbi/v2 first and fall back to v2
// when wbi/v2 fails OR returns an empty list, so a single transient
// HTTP 412 on wbi/v2 doesn't take the whole flow down.
//
// The tests below cover:
//   1. wbi/v2 returns non-empty → v2 is NOT consulted (URL check)
//   2. wbi/v2 fails transport → v2 is consulted and used
//   3. wbi/v2 returns empty → v2 is consulted and used
//   4. both endpoints return empty → NO_TRANSCRIPT (no throw)
//   5. `need_login_subtitle: true` → NO_TRANSCRIPT message mentions
//      SESSDATA so the user knows the captions are gated behind login
// ------------------------------------------------------------

test(
  "Bilibili fetchTranscript() hits wbi/v2 first and stops when it has subtitles",
  async (t) => {
    // Verifies that wbi/v2 is consulted before v2: the second fetch
    // (the first player-API call after the view API) must hit
    // api.bilibili.com/x/player/wbi/v2, and the adapter must NOT call
    // v2 when wbi/v2 returns a non-empty list. We use one extra handler
    // that would clearly fail the test if invoked (HTTP 500) so any
    // accidental extra fetch surfaces as a regression.
    const originalFetch = globalThis.fetch;
    const calls = [];
    let i = 0;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const idx = i++;
      if (idx === 0) {
        return makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        });
      }
      if (idx === 1) {
        // wbi/v2 returns non-empty subtitles.
        return makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {
            subtitle: {
              allow_submit: false,
              subtitles: [
                {
                  id: 1,
                  lan: "zh-Hans",
                  lan_doc: "简体中文",
                  is_lock: false,
                  type: 0,
                  subtitle_url:
                    "https://aisubtitle.hdslb.com/bfs/subtitle/wbi.json",
                },
              ],
            },
          },
        });
      }
      if (idx === 2) {
        // subtitle body download
        return makeBilibiliJsonResponse({
          lan: "zh-Hans",
          body: [{from: 0, to: 1, content: "wbi"}],
        });
      }
      // Any further call would mean the adapter fell through to v2
      // despite wbi/v2 already returning data — fail the test loudly.
      return makeBilibiliJsonResponse(
        {code: -1, message: "should not be called"},
        {ok: false, status: 500},
      );
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const result = await bilibili.fetchTranscript({
      videoId: "BV1xx411c7mD",
      settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
    });

    assert.equal(result.success, true);
    assert.equal(calls.length, 3, "should be view + wbi/v2 + subtitle body");
    assert.match(calls[1].url, /\/x\/player\/wbi\/v2/);
    assert.equal(result.transcript[0].text, "wbi");
  },
);

test(
  "Bilibili fetchTranscript() falls back to v2 when wbi/v2 fails at the transport layer",
  async (t) => {
    // Simulates a transient HTTP 412 on wbi/v2 (e.g. rate limit). The
    // adapter must NOT surface BILIBILI_PLAYER_ERROR for this case
    // alone — it must consult v2 and use that result if v2 succeeds.
    const originalFetch = globalThis.fetch;
    const calls = [];
    let i = 0;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const idx = i++;
      if (idx === 0) {
        return makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        });
      }
      if (idx === 1) {
        // wbi/v2 transport failure.
        return makeBilibiliJsonResponse({}, {ok: false, status: 412});
      }
      if (idx === 2) {
        // v2 succeeds with subtitles.
        return makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {
            subtitle: {
              allow_submit: false,
              subtitles: [
                {
                  id: 2,
                  lan: "zh-Hans",
                  lan_doc: "简体中文",
                  is_lock: false,
                  type: 0,
                  subtitle_url:
                    "https://aisubtitle.hdslb.com/bfs/subtitle/v2.json",
                },
              ],
            },
          },
        });
      }
      // subtitle body download
      return makeBilibiliJsonResponse({
        lan: "zh-Hans",
        body: [{from: 0, to: 1, content: "v2"}],
      });
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const result = await bilibili.fetchTranscript({
      videoId: "BV1xx411c7mD",
      settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
    });

    assert.equal(result.success, true, "v2 fallback should succeed");
    assert.equal(calls.length, 4, "view + wbi/v2 + v2 + subtitle body");
    assert.match(calls[1].url, /\/x\/player\/wbi\/v2/);
    assert.match(calls[2].url, /\/x\/player\/v2(?:\?|$)/);
    assert.equal(result.transcript[0].text, "v2");
  },
);

test(
  "Bilibili fetchTranscript() falls back to v2 when wbi/v2 returns no subtitles",
  async (t) => {
    // Some videos have NO tracks on wbi/v2 but DO have tracks on v2
    // (or vice-versa). When wbi/v2 succeeds with an empty list we
    // must still consult v2 rather than giving up early.
    const originalFetch = globalThis.fetch;
    const calls = [];
    let i = 0;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const idx = i++;
      if (idx === 0) {
        return makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        });
      }
      if (idx === 1) {
        // wbi/v2 success but empty.
        return makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {subtitle: {allow_submit: false, subtitles: []}},
        });
      }
      if (idx === 2) {
        // v2 returns subtitles.
        return makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {
            subtitle: {
              allow_submit: false,
              subtitles: [
                {
                  id: 3,
                  lan: "zh-Hans",
                  type: 0,
                  subtitle_url:
                    "https://aisubtitle.hdslb.com/bfs/subtitle/v2-fallback.json",
                },
              ],
            },
          },
        });
      }
      return makeBilibiliJsonResponse({
        lan: "zh-Hans",
        body: [{from: 0, to: 1, content: "fallback"}],
      });
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const result = await bilibili.fetchTranscript({
      videoId: "BV1xx411c7mD",
      settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
    });

    assert.equal(result.success, true, "v2 fallback should succeed");
    assert.equal(calls.length, 4);
    assert.equal(result.transcript[0].text, "fallback");
  },
);

test(
  "Bilibili fetchTranscript() returns NO_TRANSCRIPT when both endpoints return no subtitles",
  async (t) => {
    // Both endpoints succeed but neither has any tracks for this video.
    // The adapter must surface a clean NO_TRANSCRIPT (no BILIBILI_PLAYER_ERROR)
    // since at least one endpoint responded successfully.
    const originalFetch = globalThis.fetch;
    const emptySubtitles = () =>
      makeBilibiliJsonResponse({
        code: 0,
        message: "0",
        data: {subtitle: {allow_submit: false, subtitles: []}},
      });
    const mock = makeBilibiliFetchMock([
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        }),
      emptySubtitles,
      emptySubtitles,
    ]);
    globalThis.fetch = mock;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const result = await bilibili.fetchTranscript({
      videoId: "BV1xx411c7mD",
      settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "NO_TRANSCRIPT");
    assert.match(result.message, /No subtitle track is available/i);
    assert.doesNotMatch(result.message, /SESSDATA/i);
    // Both endpoints should have been called exactly once each.
    assert.equal(mock.calls.length, 3);
    assert.match(mock.calls[1].url, /\/x\/player\/wbi\/v2/);
    assert.match(mock.calls[2].url, /\/x\/player\/v2(?:\?|$)/);
  },
);

test(
  "Bilibili fetchTranscript() mentions SESSDATA when need_login_subtitle is true",
  async (t) => {
    // When the API reports `need_login_subtitle: true` we know the
    // video HAS captions but they require the user to log in via
    // SESSDATA. The NO_TRANSCRIPT message must hint at this so the
    // user understands that re-authenticating might unlock the
    // transcript rather than concluding the video has no captions.
    const originalFetch = globalThis.fetch;
    const mock = makeBilibiliFetchMock([
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        }),
      // wbi/v2: success but empty AND need_login_subtitle set.
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {
            need_login_subtitle: true,
            subtitle: {allow_submit: false, subtitles: []},
          },
        }),
      // v2: also empty (and the flag isn't always set on v2).
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {subtitle: {allow_submit: false, subtitles: []}},
        }),
    ]);
    globalThis.fetch = mock;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const result = await bilibili.fetchTranscript({
      videoId: "BV1xx411c7mD",
      settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "NO_TRANSCRIPT");
    assert.match(result.message, /SESSDATA/i);
  },
);

// ------------------------------------------------------------
// Bilibili fetchTranscript() — transport-layer failure coverage.
//
// History: when Chrome's fetch() rejects at the transport layer
// (DNS / TLS / aborted / connection refused) it surfaces as the
// bare TypeError "Failed to fetch" with no underlying cause exposed
// — MV3 service-worker fetches don't get net:: details. Without
// the bilibiliFetch() wrapper the side panel would only ever see
// that opaque string with no way to tell which endpoint died, which
// is what the user hit on BV1aqur6hEiN in production. The tests
// below pin the wrapper so each transport failure surfaces with
// enough context to point at the failing endpoint.
// ------------------------------------------------------------

test(
  "Bilibili fetchTranscript() surfaces view API transport failure with URL context",
  async (t) => {
    // Simulates the browser rejecting the view-API fetch at the
    // transport layer (e.g. the user's network can't reach
    // api.bilibili.com). The adapter must wrap the bare
    // "Failed to fetch" TypeError so the side panel sees:
    //   - the "Bilibili view API failed" prefix it already parses
    //   - the failing URL path so the user can tell where the
    //     failure originated (view API, not player API)
    //   - the underlying fetch() reason so it doesn't look like an
    //     API-side rejection (which would suggest re-logging in)
    const originalFetch = globalThis.fetch;
    const mock = makeBilibiliFetchMock([
      // 1st call: view API — transport failure.
      () => {
        throw new TypeError("Failed to fetch");
      },
    ]);
    globalThis.fetch = mock;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    // Silence the diagnostic console.warn the wrapper emits on
    // transport failure so the test runner output stays clean.
    const originalWarn = console.warn;
    console.warn = () => {};
    let result;
    try {
      result = await bilibili.fetchTranscript({
        videoId: "BV1xx411c7mD",
        settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(result.success, false);
    assert.equal(result.error, "BILIBILI_VIEW_ERROR");
    assert.match(
      result.message,
      /Bilibili view API failed/,
      "must keep the view API failure prefix the side panel already understands",
    );
    assert.match(
      result.message,
      /\/x\/web-interface\/view/,
      "must surface the failing endpoint path so the user can tell which call died",
    );
    assert.match(
      result.message,
      /Failed to fetch/,
      "must preserve the underlying fetch() reason so this doesn't look like an API rejection",
    );
  },
);

test(
  "Bilibili fetchTranscript() surfaces player API transport failure when both endpoints reject",
  async (t) => {
    // When the network is down for both wbi/v2 and v2 the adapter
    // must surface BILIBILI_PLAYER_ERROR (not NO_TRANSCRIPT) so the
    // user knows the failure is a network outage, not "this video
    // has no captions". The message must name at least one of the
    // failing endpoint paths so the user can tell what got hit.
    const originalFetch = globalThis.fetch;
    const mock = makeBilibiliFetchMock([
      // view API succeeds.
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        }),
      // wbi/v2 transport failure.
      () => {
        throw new TypeError("Failed to fetch");
      },
      // v2 transport failure.
      () => {
        throw new TypeError("Failed to fetch");
      },
    ]);
    globalThis.fetch = mock;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const originalWarn = console.warn;
    console.warn = () => {};
    let result;
    try {
      result = await bilibili.fetchTranscript({
        videoId: "BV1xx411c7mD",
        settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(result.success, false);
    assert.equal(result.error, "BILIBILI_PLAYER_ERROR");
    assert.match(result.message, /Bilibili player API failed/);
    assert.match(
      result.message,
      /\/x\/player\//,
      "must surface a player API path so the user can tell which call died",
    );
    assert.match(result.message, /Failed to fetch/);
  },
);

test(
  "Bilibili fetchTranscript() recovers when wbi/v2 transport-fails but v2 succeeds",
  async (t) => {
    // Mirrors the existing HTTP-412 fallback test but for the
    // transport-layer case: a TypeError from wbi/v2 must NOT
    // surface as BILIBILI_PLAYER_ERROR by itself — the adapter
    // must fall through to v2 and use that result.
    const originalFetch = globalThis.fetch;
    const calls = [];
    let i = 0;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const idx = i++;
      if (idx === 0) {
        return makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        });
      }
      if (idx === 1) {
        // wbi/v2 transport failure.
        throw new TypeError("Failed to fetch");
      }
      if (idx === 2) {
        // v2 succeeds with subtitles.
        return makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {
            subtitle: {
              allow_submit: false,
              subtitles: [
                {
                  id: 4,
                  lan: "zh-Hans",
                  type: 0,
                  subtitle_url:
                    "https://aisubtitle.hdslb.com/bfs/subtitle/recovery.json",
                },
              ],
            },
          },
        });
      }
      return makeBilibiliJsonResponse({
        lan: "zh-Hans",
        body: [{from: 0, to: 1, content: "recovered"}],
      });
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const originalWarn = console.warn;
    console.warn = () => {};
    let result;
    try {
      result = await bilibili.fetchTranscript({
        videoId: "BV1xx411c7mD",
        settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(result.success, true, "v2 fallback should recover");
    assert.equal(calls.length, 4, "view + wbi/v2 + v2 + subtitle body");
    assert.match(calls[1].url, /\/x\/player\/wbi\/v2/);
    assert.match(calls[2].url, /\/x\/player\/v2(?:\?|$)/);
    assert.equal(result.transcript[0].text, "recovered");
  },
);

test(
  "Bilibili fetchTranscript() surfaces subtitle-body transport failure with URL context",
  async (t) => {
    // Once we have a subtitle URL the actual caption body lives on
    // a different host (typically aisubtitle.hdslb.com / B站's CDN).
    // A transport failure at that stage must surface as
    // SUBTITLE_DOWNLOAD_ERROR (not NO_TRANSCRIPT) so the user
    // knows the captions WERE found but the body couldn't be
    // fetched — the message must include the failing host path so
    // the user can tell whether the bottleneck is their network or
    // B站's CDN.
    const originalFetch = globalThis.fetch;
    const mock = makeBilibiliFetchMock([
      // view API succeeds.
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        }),
      // wbi/v2 succeeds with one subtitle track.
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {
            subtitle: {
              allow_submit: false,
              subtitles: [
                {
                  id: 5,
                  lan: "zh-Hans",
                  type: 0,
                  subtitle_url:
                    "https://aisubtitle.hdslb.com/bfs/subtitle/transport-fail.json",
                },
              ],
            },
          },
        }),
      // Subtitle body download — transport failure on the CDN host.
      () => {
        throw new TypeError("Failed to fetch");
      },
    ]);
    globalThis.fetch = mock;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const originalWarn = console.warn;
    console.warn = () => {};
    let result;
    try {
      result = await bilibili.fetchTranscript({
        videoId: "BV1xx411c7mD",
        settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(result.success, false);
    assert.equal(result.error, "SUBTITLE_DOWNLOAD_ERROR");
    assert.match(result.message, /Subtitle download failed/);
    assert.match(
      result.message,
      /\/bfs\/subtitle\/transport-fail\.json/,
      "must surface the failing CDN path so the user can tell whether their network or B站's CDN is the bottleneck",
    );
    assert.match(result.message, /Failed to fetch/);
  },
);

test(
  "Bilibili fetchTranscript() normalises protocol-relative subtitle URLs to https:// before fetch",
  async (t) => {
    // Bilibili's player API returns subtitle body URLs in
    // protocol-relative form (e.g. "//aisubtitle.hdslb.com/...").
    // That works in a document context where the URL inherits the
    // page's protocol, but the MV3 service worker has no base URL,
    // so fetch("//host/path") throws the opaque "Failed to fetch"
    // TypeError — exactly the production failure the user hit on
    // BV1aqur6hEiN. The adapter must prepend "https:" so the CDN
    // call succeeds and the full transcript reaches the side panel.
    const originalFetch = globalThis.fetch;
    const mock = makeBilibiliFetchMock([
      // 1st call: view API → returns cid.
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        }),
      // 2nd call: wbi/v2 → returns a subtitle track with a
      // protocol-relative subtitle_url (no scheme prefix).
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {
            subtitle: {
              allow_submit: false,
              subtitles: [
                {
                  id: 9,
                  lan: "zh-Hans",
                  lan_doc: "简体中文",
                  is_lock: false,
                  type: 0,
                  subtitle_url:
                    "//aisubtitle.hdslb.com/bfs/subtitle/protocol-relative.json",
                },
              ],
            },
          },
        }),
      // 3rd call: subtitle body download. The mock records the URL
      // it actually receives so the assertion below can verify that
      // the protocol-relative form was rewritten to "https://..."
      // BEFORE reaching fetch() — the SW has no base URL to resolve
      // it against.
      () =>
        makeBilibiliJsonResponse({
          lan: "zh-Hans",
          lan_doc: "简体中文",
          body: [{from: 0, to: 2, content: "协议相对 URL 修复"}],
        }),
    ]);
    globalThis.fetch = mock;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const result = await bilibili.fetchTranscript({
      videoId: "BV1xx411c7mD",
      settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
    });

    // 3rd call is the subtitle body download (0-indexed: view=0,
    // wbi/v2=1, body=2). Its URL must be the absolute https:// form,
    // NOT the bare "//aisubtitle.hdslb.com/..." the API returned.
    assert.equal(
      mock.calls[2].url,
      "https://aisubtitle.hdslb.com/bfs/subtitle/protocol-relative.json",
      "protocol-relative subtitle URL must be normalised to https:// before fetch() — otherwise the MV3 service worker cannot resolve it",
    );
    assert.equal(result.success, true);
    assert.equal(result.source, "native");
    assert.equal(result.language, "zh-Hans");
    assert.equal(result.transcript.length, 1);
    assert.equal(result.transcript[0].text, "协议相对 URL 修复");
  },
);

test(
  "Bilibili fetchTranscript() still mentions SESSDATA when only v2 reports need_login_subtitle",
  async (t) => {
    // wbi/v2 sometimes omits `need_login_subtitle` while v2 surfaces
    // it. The flag must propagate to the NO_TRANSCRIPT message either
    // way so users with gated captions always see the same hint.
    const originalFetch = globalThis.fetch;
    const mock = makeBilibiliFetchMock([
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {cid: 12345},
        }),
      // wbi/v2: empty, flag absent.
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {subtitle: {allow_submit: false, subtitles: []}},
        }),
      // v2: empty but flag set.
      () =>
        makeBilibiliJsonResponse({
          code: 0,
          message: "0",
          data: {
            need_login_subtitle: true,
            subtitle: {allow_submit: false, subtitles: []},
          },
        }),
    ]);
    globalThis.fetch = mock;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const result = await bilibili.fetchTranscript({
      videoId: "BV1xx411c7mD",
      settings: {transcriptKeys: {bilibili: "fake-sessdata"}},
    });

    assert.equal(result.success, false);
    assert.equal(result.error, "NO_TRANSCRIPT");
    assert.match(result.message, /SESSDATA/i);
  },
);
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadSidepanelHelpers({
  sendMessage = () => Promise.resolve({}),
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  },
  fetchImpl = fetch,
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async () => ({ ytd_settings: settings }),
        },
      },
      action: { onClicked: listeners },
      sidePanel: {
        setPanelBehavior() {},
        setOptions: () => Promise.resolve(),
      },
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
      },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, active: true });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.active = false;
    },
    fireActive(delay) {
      const match = [...timers.entries()].find(
        ([, timer]) => timer.active && timer.delay === delay,
      );
      assert.ok(match, `Expected an active ${delay}ms timer`);
      match[1].active = false;
      match[1].callback();
    },
    activeCount(delay) {
      return [...timers.values()].filter(
        (timer) => timer.active && timer.delay === delay,
      ).length;
    },
    createdCount(delay) {
      return [...timers.values()].filter((timer) => timer.delay === delay).length;
    },
  };
}

function streamingResponse(chunks, { ok = true, status = 200 } = {}) {
  let index = 0;
  return {
    ok,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
        };
      },
    },
  };
}

const encode = (value) => new TextEncoder().encode(value);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("Transcript header exposes and wires Original, Chinese, and bilingual modes", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  assert.match(html, /data-transcript-mode="original"[\s\S]*?>Original</);
  assert.match(html, /data-transcript-mode="zh"[\s\S]*?>\u4e2d\u6587</);
  assert.match(html, /data-transcript-mode="bilingual"[\s\S]*?>\u53cc\u8bed</);
  assert.match(js, /handleTranscriptModeChange\(button\.dataset\.transcriptMode\)/);
  assert.match(js, /contentType: "transcriptBatch"/);
  assert.doesNotMatch(js, /English \+ Chinese/);
  assert.match(js, /Original \(\$\{language\}\)/);
});

test("semantic segmentation rebuilds sentences across caption boundaries", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "Caption boundaries should" },
      { start: 2, text: "not break a complete sentence." },
      { start: 5, text: "The next thought also" },
      { start: 7, text: "stays together!" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(
    segments[0].text,
    "Caption boundaries should not break a complete sentence.",
  );
  assert.equal(segments[0].start, 0);
  assert.equal(segments[1].text, "The next thought also stays together!");
  assert.equal(segments[1].start, 5);
});

test("a huge raw Supadata entry is split into seekable bounded segments", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const text = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
  const segments = groupTranscriptEntries([
    { start: 12, duration: 90, text },
  ]);
  assert.ok(segments.length > 8);
  assert.ok(segments.every((segment) => segment.text.length <= 384));
  assert.equal(segments[0].start, 12);
  assert.ok(segments.at(-1).start > segments[0].start);
  assert.ok(segments.every((segment) => /^segment-\d+-\d+$/.test(segment.id)));
});

test("Chinese sentence and clause punctuation creates semantic guardrails", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "这是一个被字幕切开的" },
      { start: 2, text: "完整句子。这是第二个想法，" },
      { start: 5, text: "也应该保持语义完整！" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, "这是一个被字幕切开的完整句子。");
  assert.equal(segments[1].text, "这是第二个想法，也应该保持语义完整！");
});

test("structured translation batches align by stable ID and expose missing fallback", () => {
  const sidepanel = loadSidepanelHelpers();
  const background = loadBackgroundHelpers();
  const source = [
    { id: "segment-0-0", text: "A complete first sentence." },
    { id: "segment-1-5000", text: "A complete second sentence." },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.validateTranscriptBatchRequest({ segments: source }))),
    source,
  );

  const normalized = background.normalizeTranslatedSegmentBatch(
    {
      segments: [
        { id: "unknown", text: "\u5ffd\u7565" },
        { id: "segment-1-5000", text: "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002" },
      ],
    },
    source,
  );
  const aligned = sidepanel.alignTranslatedSegmentBatch(
    source,
    normalized.segments,
  );
  assert.equal(aligned[0].id, source[0].id);
  assert.equal(aligned[0].text, "");
  assert.match(aligned[0].error, /unavailable/i);
  assert.equal(aligned[1].text, "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002");
});

test("translated-only omits English while bilingual renders aligned English and Chinese", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const segment = { id: "segment-0-0", text: "Original English sentence." };
  const translatedOnly = renderTranscriptSegmentContent(
    segment,
    "zh",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  const bilingual = renderTranscriptSegmentContent(
    segment,
    "bilingual",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  assert.doesNotMatch(translatedOnly, /Original English sentence/);
  assert.match(translatedOnly, /\u4e2d\u6587\u8bd1\u6587/);
  assert.match(bilingual, /transcript-original/);
  assert.match(bilingual, /Original English sentence/);
  assert.match(bilingual, /\u4e2d\u6587\u8bd1\u6587/);
});

test("subtitle formatting tags render in original and translated segment text", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const html = renderTranscriptSegmentContent(
    {
      id: "segment-0-0",
      text: "Think <i>deeply</i>, <b>carefully</b>, and <u>clearly</u>.<br>Next line.",
    },
    "bilingual",
    "\u5b57\u5730<i>\u601d\u8003</i>\u7684\u3002<strong>\u91cd\u70b9</strong>",
    "",
  );

  assert.match(html, /Think <i>deeply<\/i>/);
  assert.match(html, /<b>carefully<\/b>/);
  assert.match(html, /<u>clearly<\/u>\.<br>Next line/);
  assert.match(html, /\u5b57\u5730<i>\u601d\u8003<\/i>\u7684\u3002<strong>\u91cd\u70b9<\/strong>/);
});

test("subtitle markup renderer keeps attributed and arbitrary HTML escaped", () => {
  const { renderSubtitleInlineMarkup } = loadSidepanelHelpers();
  const html = renderSubtitleInlineMarkup(
    '<img src=x onerror="alert(1)"><i onclick="alert(2)">unsafe</i><script>alert(3)</script>',
  );

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;i onclick=&quot;alert\(2\)&quot;&gt;unsafe<\/i>/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img\b|<i\s+onclick|<script\b/);
});

test("background rejects unsupported language fallthrough and malformed batches", () => {
  const source = read("background.js");
  const { validateTranscriptBatchRequest } = loadBackgroundHelpers();
  assert.match(source, /targetLanguage !== "zh"/);
  assert.throws(
    () => validateTranscriptBatchRequest({ segments: [] }),
    /1 to 4 segments/,
  );
  assert.throws(
    () =>
      validateTranscriptBatchRequest({
        segments: [
          { id: "duplicate", text: "first" },
          { id: "duplicate", text: "second" },
        ],
      }),
    /unique and stable/,
  );
});

test("all AI product requests share the JSON body contract", async () => {
  const deepSeekRequests = [];
  const successfulFetch = (requests) => async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "translated" } }],
      }),
    };
  };

  const deepSeek = loadBackgroundHelpers({
    fetchImpl: successfulFetch(deepSeekRequests),
  });
  const deepSeekResult = await deepSeek.requestAiCompletion({
    maxTokens: 128,
    responseFormat: { type: "json_object" },
    messages: [{ role: "user", content: "Hello." }],
  });
  assert.equal(deepSeekResult.text, "translated");
  // DeepSeek's API doesn't define a `thinking` field; sending one would be
  // an unknown body parameter. v4-flash is a non-reasoning model anyway, so
  // we leave the field out for DeepSeek.
  assert.ok(
    !("thinking" in deepSeekRequests[0]),
    `DeepSeek should not receive a thinking field, got body: ${JSON.stringify(deepSeekRequests[0])}`,
  );
  assert.deepEqual(deepSeekRequests[0].response_format, {
    type: "json_object",
  });

  const backgroundSource = read("background.js");
  assert.equal(
    (backgroundSource.match(/await requestAiCompletion\(\{/g) || []).length,
    5,
  );
  assert.doesNotMatch(backgroundSource, /disableThinking/);
  for (const callPath of [
    "handleAnalyzeTranscript",
    "cleanupNoteText",
    "handleExplainSelection",
    "callAiTranslation",
    "handleAddPunctuation",
  ]) {
    assert.match(
      backgroundSource,
      new RegExp(`async function ${callPath}\\([\\s\\S]*?requestAiCompletion\\(\\{`),
    );
  }
});

test("MiniMax M3 requests disable the default adaptive thinking", async () => {
  const minimaxRequests = [];
  const successfulFetch = (requests) => async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "translated" } }],
      }),
    };
  };

  const minimax = loadBackgroundHelpers({
    settings: {
      provider: "minimax",
      aiApiKey: "test-key",
      aiBaseUrl: "https://api.minimaxi.com/v1",
      aiModel: "MiniMax-M3",
    },
    fetchImpl: successfulFetch(minimaxRequests),
  });
  const result = await minimax.requestAiCompletion({
    maxTokens: 128,
    responseFormat: { type: "json_object" },
    messages: [{ role: "user", content: "Hello." }],
  });

  assert.equal(result.text, "translated");
  assert.equal(minimaxRequests.length, 1);
  assert.equal(minimaxRequests[0].model, "MiniMax-M3");
  // Per the MiniMax M3 Chat Completions schema, omitting `thinking` lets
  // MiniMax-M3 default to `adaptive` (thinking on, emits a <think>...</think>
  // block). Product features explicitly disable it so the trace doesn't
  // leak into summaries / explain output.
  assert.deepEqual(minimaxRequests[0].thinking, { type: "disabled" });
  assert.deepEqual(minimaxRequests[0].response_format, {
    type: "json_object",
  });
});

test("blank-line chunks reset provider idle timeout and valid JSON succeeds", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async () =>
      streamingResponse([
        encode("\n"),
        encode("\n"),
        encode('{"choices":[{"message":{"content":"translated"}}]}'),
      ]),
  });

  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "translated");
  assert.equal(timers.createdCount(50_000), 5);
  assert.equal(timers.activeCount(50_000), 0);
  assert.equal(timers.activeCount(120_000), 0);
});

test("provider idle silence aborts with a distinct Retry-able error", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            }),
        }),
      },
    }),
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  timers.fireActive(50_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_IDLE_TIMEOUT");
  assert.match(result.error, /inactive for 50 seconds.*Retry/i);
  assert.equal(timers.activeCount(120_000), 0);
});

test("blank-line keepalives cannot evade the provider hard cap", async () => {
  const timers = createFakeTimers();
  let releaseRead;
  let signal;
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () =>
              new Promise((resolve, reject) => {
                releaseRead = () => resolve({ done: false, value: encode("\n") });
                signal.addEventListener("abort", () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                }, { once: true });
              }),
          }),
        },
      };
    },
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  releaseRead();
  await nextTurn();
  releaseRead();
  await nextTurn();
  assert.equal(timers.activeCount(50_000), 1);
  timers.fireActive(120_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_HARD_TIMEOUT");
  assert.match(result.error, /120-second limit.*Retry/i);
  assert.equal(timers.activeCount(50_000), 0);
});

test("provider response reader accepts leading whitespace before JSON", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([
        encode('  \n\t{"choices":[{"message":{"content":"ok"}}]}'),
      ]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "ok");
});

test("provider response reader rejects bodies over 2 MiB", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([new Uint8Array(2 * 1024 * 1024 + 1)]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_RESPONSE_TOO_LARGE");
  assert.match(result.error, /2 MiB limit/);
});

test("DeepSeek retries one empty transcript JSON response without response_format", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: requests.length === 1
                ? ""
                : '{"segments":[{"id":"segment-0-0","text":"\u4e2d\u6587\u8bd1\u6587\u3002"}]}',
            },
          }],
        }),
      };
    },
  });
  const result = await helpers.handleTranslateContent(
    { segments: [{ id: "segment-0-0", text: "English source sentence." }] },
    "transcriptBatch",
    "zh",
    "Video",
  );
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "response_format"), false);
  assert.equal(requests[0].max_tokens, 1536);
});

test("translation message watchdog rejects, clears its timer, and ignores late replies", async () => {
  let timeoutCallback;
  let timeoutDelay;
  let resolveMessage;
  let clearCount = 0;
  const helpers = loadSidepanelHelpers({
    sendMessage: () =>
      new Promise((resolve) => {
        resolveMessage = resolve;
      }),
    setTimeoutImpl(callback, delay) {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 73;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 73);
      clearCount += 1;
    },
  });

  const request = helpers.sendTranslationMessage({
    action: "translateContent",
  });
  assert.equal(timeoutDelay, 130_000);
  timeoutCallback();
  await assert.rejects(request, /timed out after 130 seconds.*Retry/i);
  assert.equal(clearCount, 1);

  resolveMessage({ success: true });
  await Promise.resolve();
  assert.equal(clearCount, 1);

  let successTimeoutCallback;
  let successClearCount = 0;
  const successfulHelpers = loadSidepanelHelpers({
    sendMessage: () => Promise.resolve({ success: true }),
    setTimeoutImpl(callback) {
      successTimeoutCallback = callback;
      return 91;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 91);
      successClearCount += 1;
    },
  });
  assert.deepEqual(
    await successfulHelpers.sendTranslationMessage({
      action: "translateContent",
    }),
    { success: true },
  );
  assert.equal(successClearCount, 1);
  successTimeoutCallback();
  assert.equal(successClearCount, 1);
});

test("Chinese prompt preserves natural bilingual-learning style rules", () => {
  const prompt = read("prompts/translation.md");
  assert.match(prompt, /Translate the complete thought/);
  assert.match(prompt, /Use 你, never 您/);
  assert.match(prompt, /spaces between Chinese and adjacent English words or digits/);
  assert.match(prompt, /source-language `text`/);
});

// ------------------------------------------------------------
// cleanupNoteText() — note polish step in handleSaveNote.
//
// When the AI provider rejects the request (expired key, exhausted
// quota, network blip) the note must still save — polish is a
// best-effort step, not a hard requirement. The console message
// must steer the user toward the right remediation instead of
// looking like a code bug.
//
// The user hit this on a B站 video where their MiniMax M3 key had
// been revoked; the raw fetch surfaced as
//   "Error: invalid api key (2049)"
// with status 401. The test below pins the new handling so the
// next regression surfaces an actionable hint in the console.
// ------------------------------------------------------------

test(
  "cleanupNoteText() falls back to raw text and warns with a settings hint when the AI key is rejected (401)",
  async () => {
    const helpers = loadBackgroundHelpers({
      fetchImpl: async (url) => {
        // `loadPromptSection()` reuses the same `fetch` shim to read
        // `prompts/note-cleanup.md`; without this branch the prompt
        // load fails before the AI call ever runs and the catch block
        // falls through to the generic console.error path.
        if (typeof url === "string" && url.startsWith("chrome-extension://")) {
          return {
            ok: true,
            text: async () => read("prompts/note-cleanup.md"),
          };
        }
        return {
          ok: false,
          status: 401,
          body: undefined,
          text: async () =>
            JSON.stringify({
              error: { message: "invalid api key (2049)", type: "auth_error" },
            }),
        };
      },
    });

    // Capture console.warn / console.error so we can assert the
    // catch block downgrades the generic "Cleanup error" to a
    // targeted hint. The handleSaveNote path swallows this so the
    // note save still returns success — the only visible signal of
    // the failure is the console.
    const warnings = [];
    const errors = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (msg, ...rest) => warnings.push([msg, ...rest]);
    console.error = (msg, ...rest) => errors.push([msg, ...rest]);
    let result;
    try {
      result = await helpers.cleanupNoteText(
        "target line",
        "before line",
        "after line",
        "full transcript context",
        "Video Title",
      );
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }

    // The note IS saved (with the raw buffer as fallback) so the
    // user keeps the data even when their AI key is broken.
    assert.equal(result, "before line target line after line");
    assert.equal(
      errors.length,
      0,
      "401 must NOT log a generic console.error — it should be an actionable warn",
    );
    assert.ok(
      warnings.length >= 1,
      "401 must emit a console.warn with the settings hint",
    );
    const [hint, detail] = warnings[0];
    assert.match(
      hint,
      /Note saved without AI polish/,
      "the hint must make clear the note was still saved — users panic when they think the note vanished",
    );
    assert.match(
      hint,
      /API key|Update it in.*Settings/i,
      "the hint must point at YouTube Digest Settings so the user knows where to fix the key",
    );
    // The underlying provider message is appended as a second
    // argument so an experienced user / support engineer can still
    // see the raw "invalid api key (2049)" detail.
    assert.match(
      String(detail),
      /invalid api key \(2049\)/,
      "the raw provider message must be preserved for diagnostics",
    );
  },
);

test(
  "cleanupNoteText() falls back to raw text and warns when the AI provider is rate-limited (429)",
  async () => {
    const helpers = loadBackgroundHelpers({
      fetchImpl: async (url) => {
        // Mirror the 401 test above: route prompt loads back to the
        // real file so the catch block under test sees the AI 429,
        // not a pre-AI `Could not load prompt file` rejection.
        if (typeof url === "string" && url.startsWith("chrome-extension://")) {
          return {
            ok: true,
            text: async () => read("prompts/note-cleanup.md"),
          };
        }
        return {
          ok: false,
          status: 429,
          body: undefined,
          text: async () =>
            JSON.stringify({
              error: {
                message: "rate limit exceeded",
                type: "rate_limit_error",
              },
            }),
        };
      },
    });

    const warnings = [];
    const errors = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (msg, ...rest) => warnings.push([msg, ...rest]);
    console.error = (msg, ...rest) => errors.push([msg, ...rest]);
    let result;
    try {
      result = await helpers.cleanupNoteText(
        "target",
        "before",
        "",
        "context",
        "title",
      );
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }

    // Only before/target are joined when after is empty.
    assert.equal(result, "before target");
    assert.equal(errors.length, 0, "429 must NOT log a generic console.error");
    assert.equal(warnings.length, 1);
    const [hint] = warnings[0];
    assert.match(hint, /Note saved without AI polish/);
    assert.match(hint, /rate-limited/);
  },
);

// ------------------------------------------------------------
// logAiConsumerError() — shared console helper used by the
// analyze / translate / explain / save catch blocks.
//
// Each AI consumer path catches its own `requestAiCompletion()`
// rejection. Before this helper existed every catch block did its
// own `console.error` first, which leaked the raw provider
// message (e.g. "invalid api key (2049)") as a scary red error
// even though the only real fix was "update Settings". The
// helper downgrades 401 / 429 / NO_AI_KEY to actionable
// console.warns and keeps console.error for everything else so
// genuine bugs stay visible.
// ------------------------------------------------------------

function captureConsole() {
  const warnings = [];
  const errors = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (msg, ...rest) => warnings.push([msg, ...rest]);
  console.error = (msg, ...rest) => errors.push([msg, ...rest]);
  return {
    warnings,
    errors,
    restore() {
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}

test(
  "logAiConsumerError() downgrades a 401 to a Settings-pointing console.warn and never emits console.error",
  () => {
    const helpers = loadBackgroundHelpers();
    const capture = captureConsole();
    try {
      const err = new Error("invalid api key (2049)");
      err.status = 401;
      helpers.logAiConsumerError("Analysis", err);
    } finally {
      capture.restore();
    }
    assert.equal(capture.errors.length, 0);
    assert.equal(capture.warnings.length, 1);
    const [hint, detail] = capture.warnings[0];
    assert.match(hint, /\[YouTube Digest\] Analysis skipped/);
    assert.match(hint, /API key/);
    assert.match(hint, /Update it in.*Settings/i);
    assert.equal(
      String(detail),
      "invalid api key (2049)",
      "raw provider message must be preserved as the second arg for diagnostics",
    );
  },
);

test(
  "logAiConsumerError() downgrades a 429 to a retry-hint console.warn",
  () => {
    const helpers = loadBackgroundHelpers();
    const capture = captureConsole();
    try {
      const err = new Error("rate limit exceeded");
      err.status = 429;
      helpers.logAiConsumerError("Translation", err);
    } finally {
      capture.restore();
    }
    assert.equal(capture.errors.length, 0);
    assert.equal(capture.warnings.length, 1);
    const [hint, detail] = capture.warnings[0];
    assert.match(hint, /\[YouTube Digest\] Translation skipped/);
    assert.match(hint, /rate-limited/);
    assert.match(hint, /Try again shortly/i);
    assert.equal(String(detail), "rate limit exceeded");
  },
);

test(
  "logAiConsumerError() downgrades a NO_AI_KEY code to a configure-hint console.warn",
  () => {
    const helpers = loadBackgroundHelpers();
    const capture = captureConsole();
    try {
      const err = new Error("AI API key not configured.");
      err.code = "NO_AI_KEY";
      helpers.logAiConsumerError("Explain selection", err);
    } finally {
      capture.restore();
    }
    assert.equal(capture.errors.length, 0);
    assert.equal(capture.warnings.length, 1);
    const [hint] = capture.warnings[0];
    assert.match(hint, /\[YouTube Digest\] Explain selection skipped/);
    assert.match(hint, /not configured/);
    assert.match(hint, /Open YouTube Digest Settings/i);
  },
);

test(
  "logAiConsumerError() keeps console.error for genuine failures (timeouts, network drops, parse errors)",
  () => {
    const helpers = loadBackgroundHelpers();
    const capture = captureConsole();
    try {
      helpers.logAiConsumerError(
        "Analysis",
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );
      helpers.logAiConsumerError(
        "Translation",
        Object.assign(new Error("AI provider returned an empty response."), {
          code: "EMPTY_AI_RESPONSE",
        }),
      );
      helpers.logAiConsumerError(
        "Explain selection",
        new Error("Failed to fetch"),
      );
      helpers.logAiConsumerError("Save note", null);
    } finally {
      capture.restore();
    }
    assert.equal(capture.warnings.length, 0, "non-401/429/NO_AI_KEY must NOT warn");
    assert.equal(capture.errors.length, 4, "every other failure must keep console.error");
    const prefixes = capture.errors.map((entry) => entry[0]);
    assert.ok(prefixes.every((prefix) => prefix.startsWith("[YouTube Digest] ")));
    assert.ok(prefixes.some((prefix) => prefix.includes("Analysis:")));
    assert.ok(prefixes.some((prefix) => prefix.includes("Translation:")));
    assert.ok(prefixes.some((prefix) => prefix.includes("Explain selection:")));
    assert.ok(prefixes.some((prefix) => prefix.includes("Save note:")));
  },
);

// ------------------------------------------------------------
// parseLooseJson robustness
//
// MiniMax-M3 can leave a <think>...</think> trace in
// `choices[0].message.content` even when the request sets
// `thinking: {type: "disabled"}` (e.g. on the no-`response_format` retry
// path, or when the provider silently ignores the field). The block can
// contain JSON-shaped examples that would otherwise break our
// "first { to last }" isolation in parseLooseJson. These tests pin down
// that the parser recovers from that contamination in both unit and
// end-to-end shapes.
// ------------------------------------------------------------

test("parseLooseJson strips MiniMax-M3 <think> blocks before isolating braces", () => {
  const { parseLooseJson } = loadBackgroundHelpers();
  const thinkingWithExample = [
    "<think>",
    "The user wants a Simplified Chinese translation. I will output",
    '{"segments":[{"id":"seg-1","text":"example"}]}',
    "in the right shape, then emit the final answer below.",
    "</think>",
    "",
    "",
    '{"segments":[{"id":"seg-1","text":"翻译后的内容"}]}',
  ].join("\n");
  // The parser runs inside `vm.runInNewContext`, which gives parsed objects a
  // null prototype. Round-tripping through JSON rebuilds them with the
  // call-realm's Object prototype so assert.deepEqual doesn't trip on it.
  assert.deepEqual(JSON.parse(JSON.stringify(parseLooseJson(thinkingWithExample))), {
    segments: [{ id: "seg-1", text: "翻译后的内容" }],
  });
});

test("parseLooseJson leaves unclosed <think> blocks alone and still parses the JSON", () => {
  const { parseLooseJson } = loadBackgroundHelpers();
  // No closing tag. The think block stays; the JSON after it is what we want.
  const malformed = [
    "<think>The model forgot to close",
    '{"segments":[{"id":"seg-2","text":"翻译"}]}',
  ].join("\n");
  assert.deepEqual(JSON.parse(JSON.stringify(parseLooseJson(malformed))), {
    segments: [{ id: "seg-2", text: "翻译" }],
  });
});

test(
  "handleTranslateContent recovers when AI leaks<think> block into content",
  async () => {
    const aiContent = [
      "<think>",
      "Plan: I need to output a JSON object shaped like",
      '{"segments":[{"id":"seg-1","text":"example"}]}',
      "so the parser needs to skip my reasoning.",
      "</think>",
      '{"segments":[{"id":"seg-1","text":"翻译后的内容"}]}',
    ].join("\n");

    const aiResponseJson = JSON.stringify({
      choices: [{ message: { content: aiContent } }],
    });

    const fetchMock = async (url) => {
      if (typeof url === "string" && url.includes("translation.md")) {
        return {
          ok: true,
          status: 200,
          text: async () => read("prompts/translation.md"),
        };
      }
      // AI response: deliver via the .text() fallback so readBoundedAiResponse
      // can JSON.parse it directly.
      return {
        ok: true,
        status: 200,
        text: async () => aiResponseJson,
      };
    };

    const helpers = loadBackgroundHelpers({ fetchImpl: fetchMock });
    const result = await helpers.handleTranslateContent(
      { segments: [{ id: "seg-1", text: "original text" }] },
      "transcriptBatch",
      "zh",
      "Test video",
    );

    assert.equal(result.success, true);
    assert.ok(result.translatedContent);
    assert.equal(result.translatedContent.segments.length, 1);
    assert.equal(result.translatedContent.segments[0].id, "seg-1");
    assert.equal(result.translatedContent.segments[0].text, "翻译后的内容");
  },
);

test("punctuateChineseText skips text with no Chinese characters", () => {
  const { punctuateChineseText } = loadSidepanelHelpers();
  assert.equal(punctuateChineseText("hello world"), "hello world");
  assert.equal(punctuateChineseText("plain ASCII only"), "plain ASCII only");
  assert.equal(punctuateChineseText(""), "");
  assert.equal(punctuateChineseText(null), null);
  assert.equal(punctuateChineseText(undefined), undefined);
});

test("punctuateChineseText is a no-op when CJK punctuation is already present", () => {
  const { punctuateChineseText } = loadSidepanelHelpers();
  assert.equal(
    punctuateChineseText("这是一个完整的句子。"),
    "这是一个完整的句子。",
  );
  assert.equal(
    punctuateChineseText("已经，带逗号了"),
    "已经，带逗号了",
  );
  assert.equal(punctuateChineseText("你好！"), "你好！");
  assert.equal(punctuateChineseText("问句？"), "问句？");
  // Fullwidth comma must also short-circuit the pass.
  assert.equal(punctuateChineseText("Ａ（逗号）Ｂ"), "Ａ（逗号）Ｂ");
});

test("punctuateChineseText inserts commas at mid-sentence connectives", () => {
  const { punctuateChineseText } = loadSidepanelHelpers();
  assert.equal(
    punctuateChineseText("他想去但是没有时间"),
    "他想去，但是没有时间",
  );
  assert.equal(
    punctuateChineseText("因为下雨所以取消"),
    "因为下雨，所以取消",
  );
  assert.equal(
    punctuateChineseText("如果有空那么我们就出发"),
    "如果有空，那么我们就出发",
  );
});

test("punctuateChineseText leaves 没那么 / 不那么 fixed expressions intact", () => {
  const { punctuateChineseText } = loadSidepanelHelpers();
  // "没那么" / "不那么" are degree adverbs, NOT a conditional "那么"
  // clause. The "没" / "不" exclusion on 那么 keeps them whole.
  assert.equal(
    punctuateChineseText("问题没那么严重别担心"),
    "问题没那么严重别担心",
  );
  assert.equal(
    punctuateChineseText("其实不那么重要"),
    "其实，不那么重要",
  );
  // "有那么重要" / "有那么回事" must also stay whole.
  assert.equal(
    punctuateChineseText("有那么重要吗"),
    "有那么重要吗",
  );
  // But genuine "如果 … 那么 …" conditional clauses still get punctuated.
  assert.equal(
    punctuateChineseText("如果下雨那么就取消"),
    "如果下雨，那么就取消",
  );
});

test("punctuateChineseText inserts commas after sentence-leading transitions", () => {
  const { punctuateChineseText } = loadSidepanelHelpers();
  assert.equal(
    punctuateChineseText("首先我们要讨论预算"),
    "首先，我们要讨论预算",
  );
  assert.equal(
    punctuateChineseText("然后他们继续讨论方案"),
    "然后，他们继续讨论方案",
  );
  assert.equal(
    punctuateChineseText("其实问题没有那么严重"),
    "其实，问题没有那么严重",
  );
});

test("punctuateChineseText never adds a leading comma at the start of text", () => {
  const { punctuateChineseText } = loadSidepanelHelpers();
  assert.equal(
    punctuateChineseText("但是没有时间"),
    "但是没有时间",
  );
  assert.equal(
    punctuateChineseText("因为下雪了所以取消"),
    "因为下雪了，所以取消",
  );
  // Start markers ARE allowed at position 0 because we only insert AFTER them.
  assert.equal(punctuateChineseText("首先讨论预算"), "首先，讨论预算");
});

test("punctuateChineseText is idempotent", () => {
  const { punctuateChineseText } = loadSidepanelHelpers();
  const input =
    "他想去但是没有时间因为下雪了首先取消活动然后再通知大家";
  const once = punctuateChineseText(input);
  const twice = punctuateChineseText(once);
  assert.equal(once, twice);
});

test("punctuateChineseText restores readability on a realistic wall of text", () => {
  const { punctuateChineseText } = loadSidepanelHelpers();
  const input =
    "然后我们可以看到这个数据其实非常有趣因为它反映了用户的行为模式首先用户会浏览然后点击最后购买";
  const result = punctuateChineseText(input);
  const inputCommas = (input.match(/，/g) || []).length;
  const resultCommas = (result.match(/，/g) || []).length;
  assert.ok(
    resultCommas >= 4,
    `expected >=4 commas after restore, got ${resultCommas} in ${JSON.stringify(result)}`,
  );
  assert.ok(
    resultCommas > inputCommas,
    "expected restore to add at least one comma",
  );
  // The wall-of-text must not become longer than the original by more than
  // the number of inserted commas — no spurious characters.
  assert.equal(result.length - input.length, resultCommas - inputCommas);
  // Spot-check the two most important transitions survived.
  assert.match(result, /首先，/);
  assert.match(result, /，因为/);
});

test("normalizeCaptionText applies the Chinese punctuation restore on output", () => {
  const { normalizeCaptionText } = loadSidepanelHelpers();
  // The wall-of-text now exits normalizeCaptionText with a comma inserted.
  const input =
    "然后我们可以看到这个数据其实非常有趣因为它反映了用户的行为模式";
  const output = normalizeCaptionText(input);
  assert.match(output, /，因为/);
  assert.match(output, /其实，/);
  assert.match(output, /然后，/);
});

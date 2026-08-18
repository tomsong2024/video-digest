const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// ------------------------------------------------------------------
// Test harnesses
// ------------------------------------------------------------------
// Mirrors translation.test.js's vm sandbox pattern so the new suite
// follows the same recipe. The sidepanel harness stubs DOM nodes just
// well enough for renderTranscript() to be a no-op in tests — that
// keeps applyAiPunctuationResult() testable without a full JSDOM
// dependency.

function loadSidepanelHelpers({
  sendMessage = () => Promise.resolve({}),
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  renderTranscriptImpl = () => {},
} = {}) {
  const listeners = { addListener() {} };
  const fakeElement = () => {
    const node = {
      innerHTML: "",
      textContent: "",
      children: [],
      classList: { add() {}, remove() {} },
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
    };
    return node;
  };
  const transcriptList = fakeElement();
  transcriptList.parentElement = {
    insertBefore() {},
  };
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
      getElementById: (id) => (id === "transcriptList" ? transcriptList : null),
      createElement: () => fakeElement(),
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
  // Stages t07: replace renderTranscript() with a spy so we can assert
  // "AI finished, now re-render" without needing a real DOM. Keeping
  // the override inside the loader means every test gets the same
  // shape.
  sandbox.renderTranscript = renderTranscriptImpl;
  // saveToCache is fire-and-forget in production. Stub it to keep the
  // sandbox free of chrome.storage writes; tests that need to assert
  // caching behaviour can replace this with a spy.
  sandbox.saveToCache = () => Promise.resolve();
  return { sandbox, helpers: sandbox.__YTD_TRANSCRIPT_TESTING__ };
}

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
    aiPunctuationEnabled: true,
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
      // background.js passes the full normalized settings object
      // (not just the base URL) to chatCompletionsUrl(); the mock
      // has to mirror that or fetch() ends up pointed at
      // `[object Object]/chat/completions`.
      chatCompletionsUrl: (settings) => `${settings.aiBaseUrl}/chat/completions`,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

// Minimal stub that returns a single JSON payload without involving
// the streaming reader. requestAiCompletion() funnels through
// readBoundedAiResponse(); for non-streaming responses the .text()
// fallback is the cleanest path the tests can hit. Crucially we do
// NOT expose a `body.getReader()`: the production reader branch
// consumes chunks via a ReadableStream default reader and would
// receive zero bytes here, then crash inside `JSON.parse("")`. Omit
// `body` entirely so readBoundedAiResponse falls through to .text().
function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload),
  };
}

// ------------------------------------------------------------------
// Punctuation prompt section
// ------------------------------------------------------------------
// The prompt file is the contract every other stage depends on. If the
// section headings move or the variable names change the runtime
// loader will throw at first call, so we pin the shape here so the
// breakage surfaces in CI rather than at the user's first digest.

test("prompts/punctuation.md exposes the System and User sections with the expected variables", () => {
  const prompt = read("prompts/punctuation.md");
  assert.match(prompt, /## System prompt/);
  assert.match(prompt, /## User prompt/);
  assert.match(prompt, /\{videoTitle\}/);
  assert.match(prompt, /\{transcriptText\}/);
  // The "spaces signal sentence breaks" rule is the direct lift from
  // the user's feedback ("如果有空格表示需要添加标点符号"); without it
  // the model treats spaces as literal whitespace and skips the
  // major breaks.
  assert.match(prompt, /multiple consecutive spaces/i);
  // Stage t07: the prompt must explicitly forbid 思 blocks and the
  // "Output:" prefix — stripPunctuationWrapping covers the runtime
  // safety net, but if the prompt stops threatening them the model
  // will start emitting them again.
  assert.match(prompt, /think[\s\S]*?block/i);
  assert.match(prompt, /Output:/);
});

test("the punctuation prompt file is reachable via the background message dispatcher", () => {
  const source = read("background.js");
  assert.match(source, /action === "punctuateTranscript"/);
  assert.match(
    source,
    /handleAddPunctuation\(message\.transcriptText, message\.videoTitle\)/,
  );
  // The handler is exposed to the Node test harness; if it disappears
  // from the export the assertions below can't reach it.
  assert.match(source, /__YTD_TRANSLATION_TESTING__[\s\S]+handleAddPunctuation/);
});

// ------------------------------------------------------------------
// lookupsAlreadyPunctuated / splitTranscriptForPunctuation
// ------------------------------------------------------------------
// These two helpers are the backbone of the up-front "is this work
// even worth doing?" check. The first one short-circuits already
// punctuated text so the AI call is skipped; the second one routes
// long transcripts into batches so the model never has to read more
// than PUNCTUATION_BATCH_MAX_CHARS at once.

test("looksAlreadyPunctuated flags CJK punctuation but leaves ASCII-only text alone", () => {
  const { looksAlreadyPunctuated } = loadBackgroundHelpers();
  assert.equal(looksAlreadyPunctuated(""), false);
  assert.equal(looksAlreadyPunctuated(null), false);
  assert.equal(looksAlreadyPunctuated(undefined), false);
  assert.equal(looksAlreadyPunctuated("hello world"), false);
  // Real Chinese punctuation triggers the short-circuit.
  assert.equal(looksAlreadyPunctuated("你好，世界。"), true);
  assert.equal(looksAlreadyPunctuated("问句？"), true);
  // Fullwidth comma alone is enough.
  assert.equal(looksAlreadyPunctuated("带，逗号"), true);
});

test("splitTranscriptForPunctuation keeps a short transcript as a single batch with no previousTail", () => {
  const { splitTranscriptForPunctuation } = loadBackgroundHelpers();
  const batches = splitTranscriptForPunctuation(
    "[0:01] 你好世界\n[0:05] 今天天气很好",
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0].previousTail, null);
  assert.match(batches[0].text, /\[0:01\]/);
  assert.match(batches[0].text, /\[0:05\]/);
});

test("splitTranscriptForPunctuation splits long transcripts at [M:SS] boundaries and threads previousTail", () => {
  const { splitTranscriptForPunctuation } = loadBackgroundHelpers();
  // Synthesize a transcript just over the 4000-char batch ceiling
  // with many timestamp lines so the helper has boundaries to slice
  // on. Each line runs ~50 chars including the stamp.
  const lines = [];
  for (let i = 0; i < 200; i += 1) {
    const stamp = `[${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}]`;
    // Pad with filler so the line is comfortably above ~50 chars.
    lines.push(`${stamp} ${"啊".repeat(20)}`);
  }
  const batches = splitTranscriptForPunctuation(lines.join("\n"));
  assert.ok(
    batches.length > 1,
    `expected long transcript to split into multiple batches, got ${batches.length}`,
  );
  // Every batch except the first must carry a previousTail so the
  // model can finish the prior sentence cleanly.
  assert.equal(batches[0].previousTail, null);
  for (let i = 1; i < batches.length; i += 1) {
    assert.ok(
      typeof batches[i].previousTail === "string" &&
        batches[i].previousTail.length > 0,
      `batch ${i} missing previousTail context`,
    );
  }
  // No batch should exceed the configured ceiling.
  for (const batch of batches) {
    assert.ok(
      batch.text.length <= 4000,
      `batch length ${batch.text.length} exceeds 4000-char limit`,
    );
  }
});

test("splitTranscriptForPunctuation handles a transcript with no timestamps", () => {
  const { splitTranscriptForPunctuation } = loadBackgroundHelpers();
  const batches = splitTranscriptForPunctuation(
    "没有任何时间戳的纯中文文本",
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0].previousTail, null);
  assert.match(batches[0].text, /没有任何时间戳/);
  // Empty / non-string inputs degrade to [] so the handler can
  // produce a clean "No batchable text" error. We use a length-based
  // check rather than `deepEqual([])` because the helper returns an
  // array whose prototype chain comes from the vm sandbox — that
  // breaks Node's `deepEqual` even when both sides are structurally
  // empty, and a length check captures the contract we actually
  // care about.
  assert.equal(splitTranscriptForPunctuation("").length, 0);
  assert.equal(splitTranscriptForPunctuation(null).length, 0);
});

// ------------------------------------------------------------------
// punctuationLooksPlausible / stripPunctuationWrapping
// ------------------------------------------------------------------
// These are the safety net for the AI output. If the model hallucinates
// or truncates we want to fall back to the local heuristic instead of
// shipping a broken transcript.

test("punctuationLooksPlausible rejects empty / non-string candidates", () => {
  const { punctuationLooksPlausible } = loadBackgroundHelpers();
  assert.equal(punctuationLooksPlausible("原文", ""), false);
  assert.equal(punctuationLooksPlausible("原文", "   "), false);
  assert.equal(punctuationLooksPlausible("原文", null), false);
  // Empty source text is treated as "no baseline to compare against"
  // and passes the heuristic so the result is used.
  assert.equal(punctuationLooksPlausible("", "任何候选"), true);
});

test("punctuationLooksPlausible flags severely truncated output as suspicious", () => {
  const { punctuationLooksPlausible } = loadBackgroundHelpers();
  const source = "你好世界这是中文转写没有标点的长句子".repeat(20);
  // A result that drops more than 40% of CJK characters is treated
  // as a truncation / hallucination.
  const truncated = "你好".repeat(3);
  assert.equal(punctuationLooksPlausible(source, truncated), false);
  // A result that keeps ≥ 60% of CJK characters passes.
  const preserved = source + "，加了标点。";
  assert.equal(punctuationLooksPlausible(source, preserved), true);
});

test("punctuationLooksPlausible uses a relaxed threshold for very short sources", () => {
  const { punctuationLooksPlausible } = loadBackgroundHelpers();
  // Below 40 CJK chars the helper uses floor(source * 0.4) so a
  // 20-char source only needs ≥ 8 CJK chars in the candidate.
  const source = "你好世界，这是中文标点".slice(0, 20);
  const candidate = "你好世界";
  assert.equal(punctuationLooksPlausible(source, candidate), true);
});

test("stripPunctuationWrapping cleans Output / Result / fence / 思 wrappers", () => {
  const { stripPunctuationWrapping } = loadBackgroundHelpers();
  assert.equal(
    stripPunctuationWrapping("Output: 你好，世界。"),
    "你好，世界。",
  );
  assert.equal(
    stripPunctuationWrapping("Result: 你好，世界。"),
    "你好，世界。",
  );
  assert.equal(
    stripPunctuationWrapping("Punctuated Text：你好，世界。"),
    "你好，世界。",
  );
  // Markdown fences wrap the whole body.
  assert.equal(
    stripPunctuationWrapping("```\n[0:01] 你好，世界。\n```"),
    "[0:01] 你好，世界。",
  );
  // 思 blocks are scrubbed even when they appear mid-doc.
  assert.equal(
    stripPunctuationWrapping("开始文本 思考中... 思考结束 结束文本"),
    "开始文本 结束文本",
  );
  // Plain text is returned untouched.
  assert.equal(
    stripPunctuationWrapping("[0:01] 你好，世界。"),
    "[0:01] 你好，世界。",
  );
  // Non-string inputs are returned as-is so callers can do their own
  // nullish guards.
  assert.equal(stripPunctuationWrapping(null), null);
});

// ------------------------------------------------------------------
// handleAddPunctuation — the actual handler
// ------------------------------------------------------------------
// These drive the production handler end-to-end with mock fetches.
// The chrome.storage fake surfaces a settings bag so each test can
// flip the NO_AI_KEY / DISABLED / success paths without a real
// extension.

test("handleAddPunctuation rejects an empty transcript with a clear error", async () => {
  const helpers = loadBackgroundHelpers();
  const result = await helpers.handleAddPunctuation("", "video");
  assert.equal(result.success, false);
  assert.match(result.error, /Empty transcript/);
});

test("handleAddPunctuation short-circuits already-punctuated transcripts without calling the AI", async () => {
  let fetchCalls = 0;
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ choices: [{ message: { content: "ignored" } }] });
    },
  });
  const punctuated = "[0:01] 你好，世界。\n[0:05] 已经是带标点的文本。";
  const result = await helpers.handleAddPunctuation(punctuated, "video");
  assert.equal(result.success, true);
  assert.equal(result.skipped, "already_punctuated");
  assert.equal(fetchCalls, 0, "already-punctuated input must not hit the AI");
  // The plain text drops the timestamp markers but keeps the punctuation.
  assert.match(result.plainText, /你好，世界。/);
  assert.match(result.plainText, /已经是带标点的文本。/);
});

test("handleAddPunctuation returns NO_AI_KEY when the provider key is missing", async () => {
  const helpers = loadBackgroundHelpers({
    settings: {
      provider: "deepseek",
      aiApiKey: "",
      aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash",
      aiPunctuationEnabled: true,
    },
  });
  const result = await helpers.handleAddPunctuation(
    "[0:01] 你好世界",
    "video",
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "NO_AI_KEY");
  assert.match(result.error, /API key/i);
});

test("handleAddPunctuation respects the aiPunctuationEnabled=false opt-out", async () => {
  let fetchCalls = 0;
  const helpers = loadBackgroundHelpers({
    settings: {
      provider: "deepseek",
      aiApiKey: "test-key",
      aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash",
      aiPunctuationEnabled: false,
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ choices: [{ message: { content: "ignored" } }] });
    },
  });
  const result = await helpers.handleAddPunctuation(
    "[0:01] 你好世界",
    "video",
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "DISABLED");
  assert.equal(fetchCalls, 0, "opt-out must not call the AI provider");
});

test("handleAddPunctuation hits the AI once with the right prompt and returns a punctuated transcript", async () => {
  const requests = [];
  const fetchMock = async (url, options) => {
    if (typeof url === "string" && url.includes("punctuation.md")) {
      return { ok: true, status: 200, text: async () => read("prompts/punctuation.md") };
    }
    requests.push(JSON.parse(options.body));
    return jsonResponse({
      choices: [
        {
          message: {
            content: "Output: [0:01] 你好，世界。今天是个晴天。",
          },
        },
      ],
    });
  };
  const helpers = loadBackgroundHelpers({ fetchImpl: fetchMock });
  const result = await helpers.handleAddPunctuation(
    "[0:01] 你好世界 今天是个晴天",
    "示例视频",
  );
  assert.equal(result.success, true);
  assert.match(result.timestampedText, /\[0:01\] 你好，世界。今天是个晴天。/);
  // The plain text drops the stamp but keeps the punctuation.
  assert.equal(result.plainText, "你好，世界。今天是个晴天。");
  // Exactly one AI call was made for this short transcript.
  assert.equal(requests.length, 1);
  // System prompt is the rendered "System prompt" section.
  assert.match(requests[0].messages[0].content, /Chinese punctuation restoration/i);
  // User prompt is the rendered "User prompt" section with the video
  // title and batch text substituted.
  assert.match(requests[0].messages[1].content, /示例视频/);
  assert.match(requests[0].messages[1].content, /\[0:01\] 你好世界/);
  // max_tokens defaults to 2048 for the punctuation pass.
  assert.equal(requests[0].max_tokens, 2048);
  // low temperature for stable punctuation.
  assert.equal(requests[0].temperature, 0.2);
});

test("handleAddPunctuation falls back to IMPLAUSIBLE_OUTPUT when the model truncates aggressively", async () => {
  const fetchMock = async (url) => {
    if (typeof url === "string" && url.includes("punctuation.md")) {
      return { ok: true, status: 200, text: async () => read("prompts/punctuation.md") };
    }
    // Pathologically short reply — drops more than 90% of the source.
    return jsonResponse({
      choices: [{ message: { content: "你好" } }],
    });
  };
  const helpers = loadBackgroundHelpers({ fetchImpl: fetchMock });
  const source = "[0:01] ".concat("啊".repeat(80));
  const result = await helpers.handleAddPunctuation(source, "video");
  assert.equal(result.success, false);
  assert.equal(result.code, "IMPLAUSIBLE_OUTPUT");
  assert.match(result.error, /plausibility check/i);
});

test("handleAddPunctuation surfaces a 429 RATE_LIMITED when the provider is throttled", async () => {
  const fetchMock = async (url) => {
    if (typeof url === "string" && url.includes("punctuation.md")) {
      return { ok: true, status: 200, text: async () => read("prompts/punctuation.md") };
    }
    return {
      ok: false,
      status: 429,
      body: undefined,
      text: async () =>
        JSON.stringify({ error: { message: "rate limit exceeded" } }),
    };
  };
  const helpers = loadBackgroundHelpers({ fetchImpl: fetchMock });
  const result = await helpers.handleAddPunctuation(
    "[0:01] 你好世界",
    "video",
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_RATE_LIMITED");
  // The error message should be the provider's hint so the user can
  // debug their quota.
  assert.match(result.error, /rate limit/i);
});

test("handleAddPunctuation splits an oversized transcript into multiple batches and threads previousTail", async () => {
  const requests = [];
  const fetchMock = async (url, options) => {
    if (typeof url === "string" && url.includes("punctuation.md")) {
      return { ok: true, status: 200, text: async () => read("prompts/punctuation.md") };
    }
    const body = JSON.parse(options.body);
    requests.push(body);
    const userPrompt = body.messages[body.messages.length - 1].content;
    // The mock has to echo back enough CJK characters to satisfy
    // punctuationLooksPlausible (≥60% of the source's CJK count).
    // A hard-coded short reply would get flagged as
    // IMPLAUSIBLE_OUTPUT before the multi-batch threading we're
    // actually trying to assert ever fires, so we mirror the source's
    // 啊-count and embed a stable marker the final assertion can
    // grep for.
    const ahCount = (userPrompt.match(/啊/g) || []).length;
    const echoed = `[${requests.length}:00] 加标点后的文本。${"啊".repeat(ahCount)}。`;
    return jsonResponse({ choices: [{ message: { content: echoed } }] });
  };
  const helpers = loadBackgroundHelpers({ fetchImpl: fetchMock });
  // Build a transcript comfortably above 4000 chars with multiple
  // timestamp boundaries so splitTranscriptForPunctuation emits
  // multiple batches.
  const lines = [];
  for (let i = 0; i < 200; i += 1) {
    const stamp = `[${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}]`;
    lines.push(`${stamp} ${"啊".repeat(20)}`);
  }
  const source = lines.join("\n");
  const result = await helpers.handleAddPunctuation(source, "video");
  assert.equal(result.success, true);
  assert.ok(requests.length > 1, "expected multiple AI batches for a long transcript");
  // Every batch after the first carries the previous-tail context
  // note in the user prompt.
  for (let i = 1; i < requests.length; i += 1) {
    assert.match(
      requests[i].messages[1].content,
      /previous chunk ended with/,
      `batch ${i + 1} should mention the previous chunk`,
    );
  }
  // The joined timestamped text is the AI output for each batch
  // concatenated by newline.
  assert.match(result.timestampedText, /加标点后的文本/);
});

test("handleAddPunctuation treats a RATE_LIMITED response as a clean downstream cache miss", async () => {
  // The side panel uses the {success:false, code:"AI_RATE_LIMITED"}
  // shape to display the existing retry toast. The error must
  // round-trip through the handler unchanged so the message router
  // in background.js can map it to the same retry UX as translations.
  const fetchMock = async (url) => {
    // The handler fetches the prompt file before calling the AI;
    // return a stub so we reach the AI path and exercise the
    // rate-limited error mapping.
    if (typeof url === "string" && url.includes("punctuation.md")) {
      return { ok: true, status: 200, text: async () => read("prompts/punctuation.md") };
    }
    return {
      ok: false,
      status: 429,
      body: undefined,
      text: async () => JSON.stringify({ error: { message: "busy" } }),
    };
  };
  const helpers = loadBackgroundHelpers({ fetchImpl: fetchMock });
  const result = await helpers.handleAddPunctuation(
    "[0:01] 你好世界",
    "video",
  );
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_RATE_LIMITED");
});

// ------------------------------------------------------------------
// sidepanel.requestAiPunctuation — the message-bus wrapper
// ------------------------------------------------------------------
// The sidepanel never calls the handler directly; it routes through
// chrome.runtime.sendMessage so the handler stays in the service
// worker. The tests below mock the message bus and verify the
// dispatch payload and the success / failure decoding.

test("requestAiPunctuation returns null for empty / whitespace-only input", async () => {
  const { helpers } = loadSidepanelHelpers();
  assert.equal(await helpers.requestAiPunctuation("", "video"), null);
  assert.equal(await helpers.requestAiPunctuation("   \n\t  ", "video"), null);
  assert.equal(await helpers.requestAiPunctuation(null, "video"), null);
  assert.equal(await helpers.requestAiPunctuation(undefined, "video"), null);
});

test("requestAiPunctuation short-circuits already-punctuated text without sending a message", async () => {
  let sendCalls = 0;
  const { helpers } = loadSidepanelHelpers({
    sendMessage: () => {
      sendCalls += 1;
      return Promise.resolve({ success: true });
    },
  });
  const result = await helpers.requestAiPunctuation(
    "[0:01] 你好，世界。",
    "video",
  );
  assert.equal(result, null);
  assert.equal(sendCalls, 0, "already-punctuated input must skip the message bus");
});

test("requestAiPunctuation sends the action, transcript text, and video title to the background", async () => {
  const sentPayloads = [];
  const { helpers } = loadSidepanelHelpers({
    sendMessage: (payload) => {
      sentPayloads.push(payload);
      return Promise.resolve({
        success: true,
        timestampedText: "[0:01] 你好，世界。",
        plainText: "你好，世界。",
      });
    },
  });
  const result = await helpers.requestAiPunctuation(
    "[0:01] 你好世界",
    "示例视频",
  );
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].action, "punctuateTranscript");
  assert.equal(sentPayloads[0].transcriptText, "[0:01] 你好世界");
  assert.equal(sentPayloads[0].videoTitle, "示例视频");
  // Field-by-field comparison rather than `deepEqual`: the result
  // object is constructed inside the vm sandbox, so its prototype
  // chain differs from the literal we construct here. Node's
  // deepStrictEqual flags that as "same structure, not
  // reference-equal" even though the contract we care about is just
  // that both fields carry the right strings.
  assert.equal(result.timestampedText, "[0:01] 你好，世界。");
  assert.equal(result.plainText, "你好，世界。");
});

test("requestAiPunctuation returns null when the background signals the input is already punctuated", async () => {
  const { helpers } = loadSidepanelHelpers({
    sendMessage: () =>
      Promise.resolve({
        success: true,
        skipped: "already_punctuated",
        timestampedText: "[0:01] 你好，世界。",
        plainText: "你好，世界。",
      }),
  });
  // The sidepanel never reaches this branch because the upfront
  // CJK check already short-circuits, but the wrapper still handles
  // it gracefully so the cache-hit path (where the heuristic check
  // was skipped) doesn't crash.
  // Bypass the short-circuit by entering a string that contains
  // some CJK but no fullwidth punctuation.
  const result = await helpers.requestAiPunctuation(
    "[0:01] 你好世界",
    "video",
  );
  assert.equal(result, null);
});

test("requestAiPunctuation returns null when the background reports an error", async () => {
  const { helpers } = loadSidepanelHelpers({
    sendMessage: () =>
      Promise.resolve({
        success: false,
        error: "AI provider returned an empty response.",
        code: "EMPTY_AI_RESPONSE",
      }),
  });
  const result = await helpers.requestAiPunctuation(
    "[0:01] 你好世界",
    "video",
  );
  assert.equal(result, null);
});

test("requestAiPunctuation rejects with a controlled timeout when the background hangs", async () => {
  let pendingResolve;
  const { helpers } = loadSidepanelHelpers({
    sendMessage: () =>
      new Promise((resolve) => {
        pendingResolve = resolve;
      }),
    setTimeoutImpl: (callback, delay) => {
      assert.equal(delay, 60_000, "punctuation timeout must be 60s");
      // Fire the timeout immediately so the test finishes; the real
      // 60s budget is irrelevant here.
      callback();
      return 1;
    },
    clearTimeoutImpl: () => {},
  });
  const result = await helpers.requestAiPunctuation(
    "[0:01] 你好世界",
    "video",
  );
  assert.equal(result, null);
  // Resolve the original message after the timeout so we can verify
  // a late reply doesn't leak through.
  pendingResolve({ success: true, timestampedText: "迟到的回复", plainText: "迟到的回复" });
  // Wait a microtask to let the late reply run through the
  // Promise.race() loser code path; nothing should change.
  await Promise.resolve();
  // The result is still null because the timeout won the race.
  assert.equal(result, null);
});

// ------------------------------------------------------------------
// sidepanel.applyAiPunctuationResult — the state-merge helper
// ------------------------------------------------------------------
// After the AI call returns, the side panel has to roll the
// punctuated text back into the per-entry `currentTranscript` array
// so groupTranscriptEntries() / renderTranscript() see the new
// sentence boundaries. These tests pin the entry realignment.

test("applyAiPunctuationResult updates the plain text and timestamped text globals", () => {
  const { sandbox, helpers } = loadSidepanelHelpers();
  let renderCalls = 0;
  sandbox.renderTranscript = () => {
    renderCalls += 1;
  };
  // Module-level `let` bindings aren't visible as sandbox globals, so
  // we drive them through the test-only accessor. Without this the
  // guards at the top of applyAiPunctuationResult would treat the
  // globals as "not set yet" and skip the merge.
  helpers.__setTranscriptState({ videoId: "video-1" });
  helpers.applyAiPunctuationResult(
    {
      timestampedText: "[0:01] 你好，世界。",
      plainText: "你好，世界。",
    },
    "video-1",
  );
  assert.equal(
    helpers.__getTranscriptState().transcriptText,
    "你好，世界。",
  );
  assert.equal(
    helpers.__getTranscriptState().transcriptTimestamped,
    "[0:01] 你好，世界。",
  );
  assert.equal(renderCalls, 1, "renderTranscript must fire once on success");
});

test("applyAiPunctuationResult rebuilds per-entry text from the punctuated timestamped output", () => {
  const { helpers } = loadSidepanelHelpers();
  // Two entries: the AI must preserve both [M:SS] markers and add
  // a comma after 你好. Driving state via the accessor (not direct
  // sandbox mutation) is required because `let` module-level bindings
  // are not exposed on the sandbox global object.
  helpers.__setTranscriptState({
    videoId: "video-1",
    transcript: [
      { start: 1, text: "[0:01] 你好世界" },
      { start: 5, text: "[0:05] 今天天气真好啊我们出门吧" },
    ],
  });
  helpers.applyAiPunctuationResult(
    {
      timestampedText: "[0:01] 你好，世界。\n[0:05] 今天天气真好啊，我们出门吧。",
      plainText: "你好，世界。\n今天天气真好啊，我们出门吧。",
    },
    "video-1",
  );
  const rebuilt = helpers.__getTranscriptState().transcript;
  assert.equal(rebuilt.length, 2);
  assert.equal(rebuilt[0].text, "[0:01] 你好，世界。");
  assert.equal(
    rebuilt[1].text,
    "[0:05] 今天天气真好啊，我们出门吧。",
  );
  // The original `start` is preserved so the timeline stays intact.
  assert.equal(rebuilt[0].start, 1);
  assert.equal(rebuilt[1].start, 5);
});

test("applyAiPunctuationResult is a no-op when the video changes mid-flight", () => {
  const { sandbox, helpers } = loadSidepanelHelpers();
  let renderCalls = 0;
  sandbox.renderTranscript = () => {
    renderCalls += 1;
  };
  helpers.__setTranscriptState({ videoId: "video-2" });
  helpers.applyAiPunctuationResult(
    {
      timestampedText: "[0:01] 你好，世界。",
      plainText: "你好，世界。",
    },
    "video-1",
  );
  // The globals were never touched because the result belongs to a
  // different video.
  assert.notEqual(
    helpers.__getTranscriptState().transcriptText,
    "你好，世界。",
  );
  assert.equal(renderCalls, 0);
});

test("applyAiPunctuationResult ignores malformed inputs without crashing", () => {
  const { sandbox, helpers } = loadSidepanelHelpers();
  let renderCalls = 0;
  sandbox.renderTranscript = () => {
    renderCalls += 1;
  };
  helpers.__setTranscriptState({ videoId: "video-1" });
  // The function is total over any input shape — null, an empty
  // object, or a payload with a missing plainText all silently no-op
  // so a future caller can fire-and-forget without first checking
  // the response shape.
  helpers.applyAiPunctuationResult(null, "video-1");
  helpers.applyAiPunctuationResult({}, "video-1");
  helpers.applyAiPunctuationResult(
    { timestampedText: "only stamp", plainText: "" },
    "video-1",
  );
  assert.equal(renderCalls, 0, "no input shape should trigger a render");
  // The malformed-input branch must leave the global at its initial
  // sentinel rather than clobbering it with a coerced string.
  // `currentTranscriptText` is declared with `let currentTranscriptText
  // = null` (not `undefined`) on purpose so the digest path can
  // distinguish "never populated" from "explicitly cleared", so the
  // test pins `null` rather than `undefined`.
  assert.equal(helpers.__getTranscriptState().transcriptText, null);
});

// ------------------------------------------------------------------
// settings.normalize — the default-toggles plumbing
// ------------------------------------------------------------------
// The default value of `aiPunctuationEnabled` is the user-facing
// contract for the new feature: enabling by default so users get
// readable B-station captions out of the box, but leaving a clean
// off-switch in options.js. Pin the behaviour so a future refactor
// can't silently flip the default off.

test("settings normalizes aiPunctuationEnabled to true by default and accepts an explicit false", () => {
  const settings = require("../settings.js");
  assert.equal(settings.DEFAULTS.aiPunctuationEnabled, true);
  // Empty input → default true.
  assert.equal(settings.normalize({}).aiPunctuationEnabled, true);
  // Explicit false round-trips (the negative contract).
  assert.equal(
    settings.normalize({ aiPunctuationEnabled: false }).aiPunctuationEnabled,
    false,
  );
  // Truthy non-boolean values are *not* auto-coerced — the toggle is
  // strict so a stray "yes" from a future migration can't silently
  // re-enable the feature.
  assert.equal(
    settings.normalize({ aiPunctuationEnabled: "yes" }).aiPunctuationEnabled,
    false,
  );
  assert.equal(
    settings.normalize({ aiPunctuationEnabled: 1 }).aiPunctuationEnabled,
    false,
  );
});

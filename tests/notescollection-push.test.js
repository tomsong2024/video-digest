const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// ============================================================
// Stage nc01: Notescollection Push Tests
// ============================================================

test("sidepanel.html contains the push button", () => {
  const html = read("sidepanel.html");
  assert.match(html, /id="pushToNotescollectionBtn"/);
  assert.match(html, /Push to Notescollection/);
  assert.match(html, /title="Push to Notescollection"/);
});

test("sidepanel.html push button is disabled by default", () => {
  const html = read("sidepanel.html");
  assert.match(html, /id="pushToNotescollectionBtn"[\s\S]*?disabled/);
});

test("sidepanel.js wires the push button click handler", () => {
  const js = read("sidepanel.js");
  // The event listener is split across multiple lines
  assert.match(js, /pushToNotescollectionBtn/);
  assert.match(js, /addEventListener.*click/);
  assert.match(js, /async function pushToNotescollection/);
});

test("sidepanel.js enables push button when token is configured", () => {
  const js = read("sidepanel.js");
  // The configStatus check should enable the button when hasNotescollectionToken is true
  assert.match(js, /hasNotescollectionToken/);
  assert.match(js, /pushBtn\.disabled\s*=\s*!/);
});

test("sidepanel.js calls background push action on click", () => {
  const js = read("sidepanel.js");
  assert.match(js, /action:\s*"pushToNotescollection"/);
  assert.match(js, /videoId:\s*currentVideoId/);
});

test("background.js exposes handlePushToNotescollection", () => {
  const bg = read("background.js");
  assert.match(bg, /async function handlePushToNotescollection/);
  assert.match(bg, /NOTESCOLLECTION_API_URL/);
});

test("background.js handles pushToNotescollection message", () => {
  const bg = read("background.js");
  assert.match(bg, /if\s*\(\s*message\.action\s*===\s*"pushToNotescollection"\s*\)/);
});

test("background.js returns NO_TOKEN when token is missing", () => {
  const bg = read("background.js");
  // The handler should check for token and return error
  assert.match(bg, /if\s*\(\s*!\s*token\s*\)/);
  assert.match(bg, /error:\s*"NO_TOKEN"/);
});

test("background.js checkConfig returns hasNotescollectionToken", () => {
  const bg = read("background.js");
  assert.match(bg, /hasNotescollectionToken:\s*!!\s*settings\.notescollectionToken/);
});

test("settings.js includes notescollectionToken in DEFAULTS", () => {
  const settings = read("settings.js");
  assert.match(settings, /notescollectionToken:\s*""/);
});

test("settings.js normalize preserves notescollectionToken", () => {
  const settings = read("settings.js");
  assert.match(settings, /notescollectionToken:\s*trimString\(input\?\.notescollectionToken\)/);
});

test("options.html contains Notescollection token input", () => {
  const html = read("options.html");
  assert.match(html, /id="notescollectionToken"/);
  assert.match(html, /Notescollection push token/);
  assert.match(html, /notescollectionTokenHelp/);
  assert.match(html, /api\.notescollection\.site/);
});

test("options.js handles Notescollection token input", () => {
  const js = read("options.js");
  assert.match(js, /notescollectionTokenInput/);
  assert.match(js, /notescollectionTokenLabel/);
  assert.match(js, /notescollectionTokenHelp/);
});

test("options.js loads Notescollection token in loadSettings", () => {
  const js = read("options.js");
  assert.match(js, /notescollectionTokenInput\.value\s*=\s*settings\.notescollectionToken/);
});

test("options.js saves Notescollection token in saveSettings", () => {
  const js = read("options.js");
  assert.match(js, /notescollectionToken:\s*notescollectionTokenInput/);
});

test("options.js includes English i18n for Notescollection", () => {
  const js = read("options.js");
  // Check that both English and Chinese sections have Notescollection copy
  assert.match(js, /notescollectionTokenLabel.*Notescollection push token/);
  // The help text spans multiple lines, just check each part exists
  assert.match(js, /notescollectionTokenHelp/);
  assert.match(js, /api\.notescollection\.site/);
});

test("options.js includes Chinese i18n for Notescollection", () => {
  const js = read("options.js");
  // Check Chinese section
  const zhSection = js.match(/"zh-CN":\s*\{[\s\S]*?\}/);
  assert.ok(zhSection);
  assert.match(zhSection[0], /notescollectionTokenLabel.*Notescollection 推送令牌/);
});

test("background.js uses correct Notescollection API URL", () => {
  const bg = read("background.js");
  assert.match(
    bg,
    /https:\/\/api\.notescollection\.site\/api\/collections\/e6d2104f-4273-4fb7-9aa4-d3d172653173\/feedback/,
  );
});

test("background.js sends Bearer token in Authorization header", () => {
  const bg = read("background.js");
  assert.match(bg, /Authorization:\s*`Bearer \$\{token\}`/);
});

test("background.js push payload uses feedbackContent field", () => {
  const bg = read("background.js");
  assert.match(bg, /feedbackContent:\s*content/);
});

test("background.js buildMarkdownContent formats notes with timestamps", () => {
  const bg = read("background.js");
  assert.match(bg, /function buildMarkdownContent/);
  assert.match(bg, /# \$\{digest/);  // Markdown h1 for title
  assert.match(bg, /\*\*Channel:\*\*/);  // Bold for metadata
  assert.match(bg, /## Notes/);  // Markdown h2 for notes section
  assert.match(bg, /\[\$\{time\}\]/);  // Timestamps in brackets
  assert.match(bg, /## Transcript/);  // Markdown h2 for transcript
  assert.match(bg, /Exported by YouTube Digest/);  // Footer
});

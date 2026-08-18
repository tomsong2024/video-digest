# YouTube Digest

[English](README.md) | [简体中文](README.zh-CN.md)

Turn YouTube and Bilibili videos into resources for deep learning. YouTube Digest brings transcripts, bilingual translation, AI overviews, explanations, and timestamped notes into one Chrome side panel, so you can study ideas and language without losing your place.

- Turn captions into a readable, searchable learning resource.
- Learn languages with the original transcript, a Simplified Chinese translation, or an aligned bilingual view.
- Build understanding with an AI overview, chapters, key quotes, and selected-text explanations.
- Navigate long videos by clicking timestamps in the transcript, overview, or notes.
- Save polished timestamped notes for later study.
- Keep control of your data with your own API keys, local Chrome storage, and no analytics or telemetry.

YouTube Digest is a bring-your-own-key project installed locally from GitHub. It is not available through the Chrome Web Store, does not include API credits, and does not run a developer-operated server.

## Install with your coding agent

You do not need to understand the code or use the command line. Send this message to your coding agent:

> Download or clone this project into a permanent folder I choose, tell me its exact full path, and use that same folder for Chrome's Load unpacked step. If I need a suggestion during this first installation, offer `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows, but do not assume either path. Walk me through installation and setup in simple terms. https://github.com/zarazhangrui/youtube-digest

Your agent should:

1. Ask where you want to keep the project, download or clone it there, and tell you the exact full path. If you want a suggestion, it can offer `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows.
2. Open the official Supadata page below and the AI provider page you plan to use (MiniMax or DeepSeek) and help you create your own accounts.
3. Walk you through selecting the exact project folder you chose in Chrome with **Load unpacked**.
4. Show you where to enter your API keys in the extension's **Settings** page.
5. Open a YouTube video with captions and confirm the transcript and translation work.

Keep this folder in the same place after installation. If you move or delete it, Chrome's unpacked extension stops working until you load the extension again from its new permanent folder.

Never paste an API key into an AI chat, source file, screenshot, or public message. Enter keys yourself, directly in the YouTube Digest Settings page. Your coding agent can point to the correct field without seeing the key.

## Install manually

If you prefer to do it yourself:

1. Open [github.com/zarazhangrui/youtube-digest](https://github.com/zarazhangrui/youtube-digest).
2. Choose **Code**, then **Download ZIP**.
3. Choose a permanent folder and unzip the project there. Optional suggestions are `~/Documents/youtube-digest` on macOS or Linux, or `%USERPROFILE%\Documents\youtube-digest` on Windows. You may use a different folder.
4. In Chrome, open `chrome://extensions`.
5. Turn on **Developer mode**.
6. Click **Load unpacked**.
7. Select the exact project folder you chose, which must contain `manifest.json`.
8. Pin YouTube Digest from Chrome's Extensions menu if you want quick access.

Because this is an unpacked extension, it does not update automatically. After downloading an update or changing local files, click **Reload** on the YouTube Digest card at `chrome://extensions`, then refresh open YouTube tabs. Moving or deleting the source folder breaks the unpacked extension until you load it again from the new location.

## Set up your API keys

YouTube Digest needs one AI key and at least one transcript-provider credential under your own accounts:

1. A **transcript-provider credential** for the platforms you want to use. YouTube needs a **Supadata API key**. Bilibili needs your own **SESSDATA cookie** unless the video has public CC subtitles. Configure only the platforms you visit, and the side panel prompts you when a video needs a key you have not added.
2. An **AI provider key** for overviews, explanations, translation, and automatic note polishing. YouTube Digest ships with MiniMax M3 selected by default and lets you switch to DeepSeek V4 Flash in Settings. Pick whichever provider you prefer. The interface and behavior are identical.

### Get a Supadata API key

1. Open the official [Supadata sign-up page](https://dash.supadata.ai/auth/sign-up).
2. Create an account and complete the short onboarding flow.
3. Supadata generates an API key automatically during onboarding.
4. Open the [Supadata dashboard](https://dash.supadata.ai/) whenever you need to find or manage the key.
5. Copy the key and paste it into **Supadata API key** in YouTube Digest Settings.

See the [official Supadata documentation](https://docs.supadata.ai/) if the dashboard flow changes.

### Get your Bilibili SESSDATA cookie

YouTube Digest uses Bilibili's official player API (`api.bilibili.com/x/player/v2`) to fetch subtitles. Public CC-subtitled videos work without any login. Login-required videos (membership content, premium-only subtitles) need your personal SESSDATA cookie.

To copy your SESSDATA:

1. Sign in to [bilibili.com](https://www.bilibili.com) in Chrome.
2. Open **Developer Tools** with `F12` (or `Cmd+Option+I` on macOS).
3. Switch to the **Application** tab. If the tab is hidden, click the `>>` overflow and pick **Application**.
4. In the left sidebar, expand **Cookies** and select `https://www.bilibili.com`.
5. Find the row named `SESSDATA`, double-click its **Value** cell, and copy the value.
6. Paste it into **Bilibili SESSDATA cookie** in YouTube Digest Settings.

Quick alternative from the browser console (Application tab → Console):

```js
document.cookie.match(/SESSDATA=([^;]+)/)?.[1]
```

The console prints just the cookie value, ready to paste. The cookie is stored only in your local Chrome extension storage. YouTube Digest never sends it anywhere except to Bilibili's own player API. Logging out of Bilibili invalidates the cookie; rotate it any time from the same DevTools panel.

av-numbered videos (e.g. `https://www.bilibili.com/video/av170001`) are not yet supported. Open the BV version of the URL on Bilibili and use that instead.

### Get a MiniMax M3 API key (default AI provider)

1. Open the official [MiniMax key page](https://platform.minimax.io/user-center/basic-information/interface-key).
2. Sign in or create a MiniMax account when prompted.
3. Choose **Create new key**, give it a recognizable name such as `YouTube Digest`, and create it.
4. Copy the key immediately. The full key may only be shown once.
5. Paste it into **AI provider key** in YouTube Digest Settings (the field label changes to match whichever provider you selected).
6. If MiniMax reports insufficient balance, top up the MiniMax account and try again.

See the [official MiniMax API documentation](https://platform.minimax.io/) for current account and API details.

### Get a DeepSeek API key (optional alternative)

1. Open the official [DeepSeek API Keys page](https://platform.deepseek.com/api_keys).
2. Sign in or create a DeepSeek Platform account when prompted.
3. Choose **Create new API key**, give it a recognizable name such as `YouTube Digest`, and create it.
4. Copy the key immediately. The full key may only be shown once.
5. Switch the AI provider radio in YouTube Digest Settings to **DeepSeek V4 Flash**, then paste the key into **AI provider key**.
6. If DeepSeek reports insufficient balance, add credit in your DeepSeek Platform account and try again.

See the [official DeepSeek API documentation](https://api-docs.deepseek.com/) for current account and API details.

Open **Settings** from the side panel. You can also open the YouTube Digest **Options** page from its card at `chrome://extensions` or by right-clicking its toolbar icon. Paste keys only into these Settings fields. Never paste a key into an AI chat, repository file, screenshot, or public message.

The published version supports MiniMax M3 by default and DeepSeek V4 Flash as an optional alternative. The endpoint and model are fixed for each provider, so the only AI credential you enter is your API key for the selected provider:

```text
Default provider: MiniMax M3
Base URL: https://api.minimaxi.com/v1
Model: MiniMax-M3

Optional alternative: DeepSeek V4 Flash
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash
```

YouTube Digest sends every AI request in non-thinking mode for responsive, predictable interactions. Pick the provider you want from the radio list in Settings, then paste the matching API key. To use another provider or model, copy the safe customization prompt in Settings and give it to a coding agent for your local copy. Never add an API key to that prompt or chat.

Keys and settings are stored in Chrome's local extension storage on your device. Release builds do not include or use `config.js`.

## Use YouTube Digest

1. Open a standard YouTube watch page with captions, or a standard Bilibili `/video/BV...` page with subtitles.
2. Click the YouTube Digest extension icon to open the side panel.
3. Read the timestamped transcript, or choose **Original**, **中文**, or **双语**.
4. Open **Overview** when you want AI-generated chapters and key quotes.
5. Select transcript text when you want an AI explanation.
6. Save a note from the player or a key quote, then revisit it from **Notes**.

## What works today

- Google Chrome 116 or newer, using the Side Panel API.
- Standard `youtube.com/watch` video pages.
- Standard `bilibili.com/video/BV...` pages with native Bilibili subtitles. Public CC-subtitled videos work without a SESSDATA cookie; cookie-gated videos need your own SESSDATA in Settings.
- Native subtitle tracks returned by Supadata. YouTube Digest prefers English when available, but may show another native language.
- Original, Simplified Chinese, and aligned bilingual transcript views.
- AI overviews, selected-text explanations, translation, automatic note polishing, and punctuation restoration for unpunctuated Chinese transcripts.
- Local notes and a local cache for recent transcript and digest results.
- MiniMax M3 (default) and DeepSeek V4 Flash (optional) for all published AI features. Pick your provider in Settings. Other providers or models require a local code adaptation and are not supported by this published version.

Shorts, live streams, private or access-restricted videos, and videos without an available native transcript may not work. Firefox, Safari, mobile browsers, and other Chromium browsers are not currently tested or supported.

YouTube Digest forces Supadata's `mode=native`. It does not request AI-generated transcripts or perform local audio transcription when native captions are unavailable.

## Supadata free tier and request costs

Current as of August 9, 2026, the [Supadata pricing page](https://supadata.ai/pricing) lists a free tier with **100 credits per month**, no credit card required. Unused credits do not roll over. Supadata pricing can change, so check the current page before relying on these numbers.

The [Supadata transcript documentation](https://docs.supadata.ai/get-transcript) describes the transcript request modes and credit behavior:

- A native transcript request uses **1 credit**, regardless of video duration.
- A generated transcript costs **2 credits per video minute**. YouTube Digest does not use this path because it forces `mode=native`.
- An unavailable native lookup returned as HTTP `206` still uses **1 credit**.

With the current native-only behavior, the free tier can cover roughly 100 transcript lookups per month when each request succeeds once. Retries and unavailable-caption lookups also consume credits, so actual successful-video coverage can be lower.

DeepSeek usage is separate from Supadata. DeepSeek may apply its own free quota, rate limits, or charges. YouTube Digest does not collect payments or resell access. Set spending limits and monitor both accounts. The estimate below explains the current DeepSeek translation cost.

## DeepSeek V4 Flash translation cost estimate

Current as of August 10, 2026, DeepSeek lists the following prices per 1 million tokens on its official [pricing page](https://api-docs.deepseek.com/quick_start/pricing/):

- Cache-hit input: **$0.0028 USD**.
- Cache-miss input: **$0.14 USD**.
- Output: **$0.28 USD**.

DeepSeek says these prices may increase soon, so check the current pricing page before relying on this estimate. Its official [token usage guide](https://api-docs.deepseek.com/quick_start/token_usage/) estimates about 0.3 token per English character and about 0.6 token per Chinese character. Its [context caching guide](https://api-docs.deepseek.com/guides/kv_cache/) explains the automatic best-effort disk cache used for repeated prefixes.

A measured 20-minute English talk contained **2,935 spoken English words** and 15,433 transcript characters. With YouTube Digest's current grouping, it became 128 semantic segments and 43 requests of three segments each. Repeated prompts and JSON brought the rendered input to about 108,528 English characters, or **about 32,600 input tokens** using DeepSeek's 0.3 token per English character heuristic. The translated Chinese JSON output is estimated at about 3,500 to 4,500 tokens using the 0.6 token per Chinese character heuristic, plus JSON and ID overhead.

If all input is billed as cache miss, input costs about $0.0046 and output costs about $0.0010 to $0.0013, for a total of about $0.0056 to $0.0059. When much of the repeated system prompt hits DeepSeek's automatic best-effort cache, a realistic lower end is about $0.002 to $0.003. A practical estimate for fully translating this talk is therefore **$0.002 to $0.006 USD, about ¥0.02 to ¥0.04**.

Translation is lazy and progressive. Cached segments are reused, and only rows you request by scrolling into them incur calls. Retries, provider behavior, and pricing changes can increase the final cost.

## AI punctuation restore: cost and fallback

Bilibili's automatic AI captions often arrive as one long string of Chinese characters with no punctuation at all, which is exhausting to read. Starting August 2026, every digest sends the fetched transcript to the active AI provider once for a punctuation-restore pass: the model only inserts Chinese punctuation (，。！？), never changes words, order, or `[M:SS]` timestamps. The punctuated version shows up in the `TRANSCRIPT:` block of the exported `.txt`, the side panel's Original tab, and any note or explanation; the video description is left untouched.

The restore call reuses the same AI request path as the Overview / explanation / translation features. A single request typically takes 3–8 seconds, and the token cost is far smaller than a translation pass (a typical digest uses 2,000–8,000 input tokens and 1,000–3,000 output tokens). See the DeepSeek pricing page above and your provider account for the live numbers.

Fallback behavior: whenever any of the following happens, YouTube Digest silently falls back to the existing local heuristic so the UI never stalls, errors out, or blocks an export.

- No AI key configured (`NO_AI_KEY`).
- The "AI add punctuation" toggle is off (`DISABLED`, see below).
- The provider returns 429 / 5xx, times out, returns empty content, or returns a clearly truncated result (`AI_RATE_LIMITED` or `IMPLAUSIBLE_OUTPUT`).
- The transcript already contains CJK punctuation (`already_punctuated`); the call is skipped entirely and the existing punctuation is kept.

How to disable it: open **Settings** in the side panel or the extension's **Options** page, then uncheck **AI add punctuation to Chinese transcripts** under the AI provider section. With it off, every digest skips the AI call and the UI / export show the local-heuristic-comma version directly. The box is checked by default; flip it back on any time on the same device.

## Remix it with your coding agent

This is a personal remix project. Upstream issues and pull requests are not accepted. If something breaks or you want a new feature, download or fork your own copy and ask your coding agent to fix, remix, or personalize it for you.

YouTube Digest uses plain HTML, CSS, and JavaScript with no build step, so it is a friendly starting point for agent-assisted projects. Ideas to try:

- Add more translation languages and let each person choose a learning language.
- Create customized summary templates for lectures, interviews, tutorials, reviews, or research talks.
- Build a vocabulary notebook that saves a word, its sentence, meaning, and video timestamp.
- Export notes and vocabulary to Markdown, CSV, Anki, or another study tool.
- Add personal topic filters that highlight the chapters most relevant to a goal.
- Add optional local-model support for a different privacy and cost tradeoff.
- Improve accessibility with keyboard navigation, font controls, and higher-contrast themes.

Ask your agent to preserve the bring-your-own-key model, keep secrets out of source files, run the checks below, and test the remix on real videos.

If you want another AI provider or model, first open the exact YouTube Digest project folder that Chrome loaded through **Load unpacked** in your coding agent. Then open YouTube Digest Settings and use **Copy customization prompt**. Replace the `[PROVIDER]` and `[MODEL]` placeholders before sending it. Do not include any API key in the prompt or chat. After the agent updates your local copy, enter the key yourself in the Settings field it identifies.

## Privacy and data flow

YouTube Digest makes provider requests directly from the extension:

1. It sends a canonical YouTube watch URL to Supadata to request the native transcript.
2. For Bilibili videos, it sends the canonical `/video/BV...` URL to `api.bilibili.com/x/web-interface/view` and `/x/player/v2`, attaching your SESSDATA cookie as authentication when one is configured.
3. It sends the transcript and relevant video metadata to MiniMax or DeepSeek (whichever provider you picked) when you request AI features.
4. Focused features send only the content they need, such as selected text with context or small transcript batches for translation.
5. It stores keys, settings, notes, and recent cache entries locally in Chrome.

There is no YouTube Digest account system, advertising, analytics, or telemetry. Supadata and DeepSeek still receive data under their own terms and privacy policies. See [PRIVACY.md](PRIVACY.md) for details.

## Troubleshooting

### The Digest button is missing on a YouTube video

- At `chrome://extensions`, find YouTube Digest and click **Reload**, then refresh the YouTube tab.
- Confirm that you are on a standard `https://www.youtube.com/watch?...` page, not a Short, embed, or live page.
- The current version automatically follows YouTube when its responsive action bar changes. Wait a moment after the page finishes loading.
- If you have an older downloaded copy, resizing the YouTube window horizontally once may reveal the button. Then download the latest version so resizing is no longer required.
- If it is still missing, ask your coding agent to inspect the content script on that exact video page.

### The side panel does not open

- Confirm that you are on a standard `https://www.youtube.com/watch?...` page.
- At `chrome://extensions`, confirm YouTube Digest is enabled and click **Reload**.
- Refresh the YouTube tab after reloading the extension.
- Ask your coding agent to inspect the extension if the problem continues.

### YouTube Digest asks for setup

- Open **Settings** and save both a Supadata key and a DeepSeek key.
- This published version uses the fixed DeepSeek V4 Flash endpoint and model. There are no Base URL or Model fields to configure.
- If Settings says a legacy custom provider was removed, enter a DeepSeek key. The old AI key was cleared so it could not be reused with the wrong service.

### No transcript is found

- Confirm the video is public and has native captions.
- Check your Supadata key, remaining credits, rate limit, and account status.
- Remember that unavailable native lookups and manual retries may still consume credits.

YouTube Digest will not fall back to generated transcription.

### No transcript is found on a Bilibili video

- Confirm the video has native subtitles on Bilibili itself (click CC on the web player).
- Public CC-subtitled videos should work without any SESSDATA. If they don't, sign in to Bilibili and add your SESSDATA in Settings.
- av-numbered URLs are not yet supported. Open the BV version of the URL on Bilibili and use that instead.
- A `BILIBILI_VIEW_ERROR` or `BILIBILI_PLAYER_ERROR` usually means the Bilibili API rejected your SESSDATA, the cookie expired, or the video is region-restricted. Refresh your SESSDATA from DevTools and try again.
- If you keep seeing `NO_BILIBILI_COOKIE`, open Settings and confirm the SESSDATA field was saved.

### The Digest button is missing on a Bilibili video

- At `chrome://extensions`, find YouTube Digest and click **Reload**, then refresh the Bilibili tab.
- Confirm that you are on `https://www.bilibili.com/video/BV...` (or `/video/av...`), not a bangumi episode (`/bangumi/play/...`) or the homepage.
- The current version targets the Bilibili public web layout. The toolbar may not appear if Bilibili ships a redesign that changes the action bar; ask your coding agent to inspect the content script on that exact video page.

### AI requests fail

- A `401` or `403` usually means the DeepSeek key or account access is invalid.
- A `429` usually means a DeepSeek rate or spending limit was reached.
- Confirm the key was created in the DeepSeek Platform account linked above and that the account has available credit.
- If you adapted a local copy for another model, use the Settings customization prompt again and ask your coding agent to inspect that local implementation.
- `AI_RATE_LIMITED` only comes from the punctuation restore call. YouTube Digest falls back to the local heuristic and shows no error; to skip the punctuation call entirely, uncheck **AI add punctuation** in Settings.

### AI punctuation restore is off or seems to do nothing

- The **AI add punctuation to Chinese transcripts** checkbox in Settings must stay checked (it is checked by default). Unchecking it skips the AI punctuation call on every digest.
- An AI failure does not show in the UI; the transcript silently falls back to the local heuristic. To confirm the AI call actually ran, open the extension's Service Worker console and look for the `Punctuation batch` debug log.
- Long transcripts are automatically split into batches at `[M:SS]` boundaries; each batch calls the AI independently and the results are stitched together. The side panel shows the original unpunctuated text until the whole transcript finishes punctuation restoration, then re-renders.
- A transcript that already contains CJK punctuation (typical of YouTube official captions or public CC subtitles) is detected as `already_punctuated` and the AI call is skipped; the punctuation you see is whatever the source provider already supplied.

Never share API keys, private transcripts, or personal notes in chats, screenshots, or logs.

## Checks for coding agents

Ask your coding agent to run these commands after changing the project:

```bash
npm test
npm run check
npm run package
```

The agent should also reload the unpacked extension in Chrome and test several real YouTube videos. Automated checks do not prove that live provider requests and YouTube interactions work.

## License

MIT. See [LICENSE](LICENSE).

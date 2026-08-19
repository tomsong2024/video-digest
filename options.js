const YTD_OPTIONS = (() => {
  const LANGUAGE_STORAGE_KEY = "ytd_options_language";
  const PREVIEW_STORAGE_PREFIX = "youtubeDigestPreview:";
  const SUPPORTED_LANGUAGES = new Set(["en", "zh-CN"]);

  const COPY = {
    en: {
      pageTitle: "YouTube Digest Settings",
      languageGroupLabel: "Interface language",
      heading: "Bring your own API keys",
      lede:
        "Keys stay in this Chrome profile and are sent only to the configured providers. This open-source extension has no developer server or analytics.",
      transcriptProvider: "Transcript providers",
      transcriptProviderLede:
        "Add the credentials for each video platform you want to use. YouTube uses a Supadata key; Bilibili uses your SESSDATA cookie. You only need to configure the platforms you visit.",
      addPlatformKey: "Add at least one platform key.",
      aiProvider: "AI provider",
      providerSummaryLabel: "Supported AI provider",
      aiApiKeyLabel: "AI provider key",
      aiProviderHelp:
        "YouTube Digest uses the selected AI provider for overviews, explanations, translation, and note polishing. ",
      aiProviderLink: "Create an account and key",
      aiProviderHelpSuffix: ".",
      privacyNote:
        "When you use AI features, the selected provider receives the video transcript and relevant video context. Review the provider's terms and pricing before saving.",
      // Stage t05: AI punctuation opt-out. The label is the visible text on
      // the checkbox; the description sits on the indented help line under
      // it so users know the per-digest cost they save by unchecking.
      aiPunctuationLabel: "AI add punctuation to Chinese transcripts",
      aiPunctuationDescription:
        "Each digest uses one extra AI call. Disable to fall back to the local heuristic.",
      // Stage nc01: Notescollection push token.
      notescollectionTokenLabel: "Notescollection push token",
      notescollectionTokenHelp:
        "Enter your Notescollection API token to enable one-click push. The token is used to authenticate requests to https://api.notescollection.site.",
      saveSettings: "Save settings",
      localRemix: "Local remix",
      customizationTitle: "Want to use another AI model?",
      customizationPurpose: "Edit and copy a safe prompt for your coding agent",
      agentBadge: "Coding agent ready",
      customizationIntro:
        "You can edit the prompt directly. Complete these three steps before copying:",
      customizationStepFolder:
        "Open the extracted YouTube Digest project folder in your coding agent.",
      customizationStepReplace:
        "Replace [PROVIDER] and [MODEL] with the service and model you want to use.",
      customizationStepKeys:
        "Never include API keys in the prompt or chat. Enter them yourself after the code is ready.",
      customizationPromptLabel: "Editable customization prompt",
      customizationReminderLabel: "Prompt reminder",
      customizationReminder:
        "Before copying, replace [PROVIDER] and [MODEL] with the provider and model you want to use.",
      customizationPrompt:
        "Customize this local YouTube Digest workspace to use [PROVIDER] with [MODEL]. Work only in the current workspace. Before editing, verify that it contains manifest.json and that the manifest name is YouTube Digest. If verification fails, stop and ask me to open the extracted YouTube Digest project folder in my coding agent. Do not search other folders, edit a guessed copy, assume an installation path, or claim Chrome can reveal the absolute OS source path. Update the provider's API endpoint, request format, and minimum Chrome host permissions. Preserve bring-your-own-key and local Chrome storage. Never put API keys in source code, commits, logs, screenshots, this prompt, or chat; after the code is ready, tell me where to enter the key myself. Keep DeepSeek-only request fields and retry behavior isolated to DeepSeek. Handle provider-specific rules separately so one provider does not affect another. Update README.md, README.zh-CN.md, PRIVACY.md, SECURITY.md, and tests. Run npm test, npm run check, and npm run package. Then explain how to reload the unpacked extension and test it on a real YouTube video.",
      copyCustomizationPrompt: "Copy edited prompt",
      localData: "Local data",
      localDataHelp:
        "Digests, translations, and notes are stored only in this Chrome profile. You can remove them at any time.",
      clearCache: "Clear cached digests",
      deleteNotes: "Delete all notes",
      resetData: "Reset extension data",
      footer:
        'Read <a href="PRIVACY.md" target="_blank">PRIVACY.md</a> in the repository for the complete data-flow description.',
      migrationWarning:
        "Custom provider settings were removed safely. Your platform keys were kept, but the AI key was cleared. Enter a key for your chosen AI provider to continue.",
      saving: "Saving…",
      addAiKey: "Add an AI provider key.",
      saved: "Saved. Reopen YouTube Digest to use these settings.",
      saveFailed: "Could not save settings. Please try again.",
      copying: "Copying…",
      promptCopied: "Edited prompt copied.",
      copyFailed:
        "Could not copy the prompt. Select the prompt text and copy it manually.",
      clearedDigests: ({ count }) =>
        `Cleared ${count} cached digest${count === 1 ? "" : "s"}.`,
      notesDeleted: "Deleted all saved notes.",
      resetConfirm:
        "Delete API keys, cached digests, translations, and saved notes from this Chrome profile?",
      allDataDeleted: "All YouTube Digest data was deleted.",
      settingsLoadFailed:
        "Could not load saved settings. You can still preview this page.",
    },
    "zh-CN": {
      pageTitle: "YouTube Digest 设置",
      languageGroupLabel: "界面语言",
      heading: "使用你自己的 API 密钥",
      lede:
        "密钥仅保存在当前 Chrome 个人资料中，只会发送给已配置的服务。本开源扩展没有开发者服务器，也不使用分析服务。",
      transcriptProvider: "字幕服务",
      transcriptProviderLede:
        "为每个想使用的视频平台填写凭据。YouTube 使用 Supadata 密钥，Bilibili 使用 SESSDATA cookie。只需配置你实际访问的平台。",
      addPlatformKey: "请至少添加一个平台的密钥。",
      aiProvider: "AI 服务",
      providerSummaryLabel: "支持的 AI 服务",
      aiApiKeyLabel: "AI 服务密钥",
      aiProviderHelp:
        "YouTube Digest 使用所选 AI 服务生成概览、解释内容、翻译字幕和润色笔记。",
      aiProviderLink: "创建账号并获取密钥",
      aiProviderHelpSuffix: "。",
      privacyNote:
        "使用 AI 功能时，所选服务会收到视频字幕及相关视频上下文。保存前请查看该服务的条款和价格。",
      // Stage t05: AI punctuation opt-out. Wording pairs with the English
      // copy so users see the same trade-off regardless of UI language.
      aiPunctuationLabel: "用 AI 为中文 transcript 加标点",
      aiPunctuationDescription:
        "每次摘要会额外调用一次 AI。关闭后会回退到本地启发式加标点。",
      // Stage nc01: Notescollection push token.
      notescollectionTokenLabel: "Notescollection 推送令牌",
      notescollectionTokenHelp:
        "填写 Notescollection API 令牌以启用一键推送。该令牌用于向 https://api.notescollection.site 验证请求。",
      saveSettings: "保存设置",
      localRemix: "本地改造",
      customizationTitle: "想使用其他 AI 模型？",
      customizationPurpose: "编辑并复制一段可安全交给编程 Agent 的提示词",
      agentBadge: "可交给编程 Agent",
      customizationIntro: "你可以直接编辑提示词。复制前完成以下三步：",
      customizationStepFolder:
        "在编程 Agent 中打开 YouTube Digest 解压后的项目文件夹。",
      customizationStepReplace:
        "把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationStepKeys:
        "不要在提示词或聊天中加入 API 密钥。代码准备好后，请自行填写。",
      customizationPromptLabel: "可编辑的自定义提示词",
      customizationReminderLabel: "提示词提醒",
      customizationReminder:
        "复制前，请先把 [PROVIDER] 和 [MODEL] 替换成你想使用的服务和模型。",
      customizationPrompt:
        "请把当前本地 YouTube Digest 工作区改为使用 [PROVIDER] 提供的 [MODEL]。只在当前工作区中操作。编辑前，先确认其中包含 manifest.json，且 manifest 中的 name 是 YouTube Digest。如果验证失败，请停止，并让我在编程 Agent 中打开 YouTube Digest 解压后的项目文件夹。不要搜索其他文件夹，不要编辑猜测的副本，不要假设安装路径，也不要声称 Chrome 可以显示操作系统中的绝对源码路径。更新该服务的 API endpoint、请求格式和最少的 Chrome host permissions。保留用户自带密钥模式和 Chrome 本地存储。不要把 API 密钥写入源代码、提交记录、日志、截图、这段提示词或聊天；代码准备好后，请告诉我应该在哪里自行填写密钥。DeepSeek 专用的请求参数和重试逻辑继续只用于 DeepSeek。新服务的专属规则请单独处理，避免相互影响。更新 README.md、README.zh-CN.md、PRIVACY.md、SECURITY.md 和测试。运行 npm test、npm run check 和 npm run package。最后，说明如何重新加载已解压的扩展，并在真实 YouTube 视频上测试。",
      copyCustomizationPrompt: "复制编辑后的提示词",
      localData: "本地数据",
      localDataHelp:
        "摘要、翻译和笔记仅保存在当前 Chrome 个人资料中。你可以随时删除。",
      clearCache: "清除缓存的摘要",
      deleteNotes: "删除全部笔记",
      resetData: "重置扩展数据",
      footer:
        '完整数据流说明请参阅仓库中的 <a href="PRIVACY.md" target="_blank">PRIVACY.md</a>。',
      migrationWarning:
        "已安全移除自定义服务设置。各平台的密钥已保留，AI 密钥已清除。请填写所选 AI 服务的密钥以继续使用。",
      saving: "正在保存…",
      addAiKey: "请填写所选 AI 服务的密钥。",
      saved: "已保存。请重新打开 YouTube Digest 以使用这些设置。",
      saveFailed: "无法保存设置，请重试。",
      copying: "正在复制…",
      promptCopied: "已复制编辑后的提示词。",
      copyFailed: "无法复制提示词。请选中提示词文本并手动复制。",
      clearedDigests: ({ count }) => `已清除 ${count} 条缓存摘要。`,
      notesDeleted: "已删除全部已保存的笔记。",
      resetConfirm:
        "要从当前 Chrome 个人资料中删除 API 密钥、缓存摘要、翻译和已保存的笔记吗？",
      allDataDeleted: "已删除全部 YouTube Digest 数据。",
      settingsLoadFailed: "无法加载已保存的设置，但你仍可预览此页面。",
    },
  };

  /**
   * Per-language, per-provider copy for the AI provider card. Keys mirror the
   * generic COPY entries (aiApiKeyLabel, aiProviderHelp, aiProviderLink,
   * aiProviderHelpSuffix, aiPrivacyNote) so applyProviderCopy() can override
   * the text applyLanguage() just wrote from the generic keys. The shared
   * `aiApiKeyPlaceholder` key drives the password input's placeholder.
   *
   * `label` is the radio's visible name. `keyLink` mirrors the registry in
   * settings.js so the help link points at the correct provider onboarding
   * page; keeping it here too lets options.js render copy without parsing
   * the registry on every change event.
   */
  const AI_PROVIDER_COPY = {
    en: {
      deepseek: {
        label: "DeepSeek V4 Flash",
        aiApiKeyLabel: "DeepSeek API key",
        aiApiKeyPlaceholder: "Paste your DeepSeek key",
        aiProviderHelp:
          "YouTube Digest uses DeepSeek V4 Flash for overviews, explanations, translation, and note polishing. ",
        aiProviderLink: "Create a DeepSeek account and key",
        aiProviderHelpSuffix:
          ". Get your key from the DeepSeek platform.",
        aiPrivacyNote:
          "When you use AI features, DeepSeek receives the video transcript and relevant video context. Review DeepSeek's terms and pricing before saving.",
        keyLink: "https://platform.deepseek.com/api_keys",
      },
      minimax: {
        label: "MiniMax M3",
        aiApiKeyLabel: "MiniMax M3 API key",
        aiApiKeyPlaceholder: "Paste your MiniMax M3 key",
        aiProviderHelp:
          "YouTube Digest uses MiniMax M3 for overviews, explanations, translation, and note polishing. ",
        aiProviderLink: "Create a MiniMax M3 account and key",
        aiProviderHelpSuffix:
          ". Get your key from the MiniMax platform.",
        aiPrivacyNote:
          "When you use AI features, MiniMax M3 receives the video transcript and relevant video context. Review MiniMax M3's terms and pricing before saving.",
        keyLink:
          "https://platform.minimax.io/user-center/basic-information/interface-key",
      },
    },
    "zh-CN": {
      deepseek: {
        label: "DeepSeek V4 Flash",
        aiApiKeyLabel: "DeepSeek API 密钥",
        aiApiKeyPlaceholder: "请粘贴 DeepSeek 密钥",
        aiProviderHelp:
          "YouTube Digest 使用 DeepSeek V4 Flash 生成概览、解释内容、翻译字幕和润色笔记。",
        aiProviderLink: "创建 DeepSeek 账号并获取密钥",
        aiProviderHelpSuffix: "。请前往 DeepSeek 平台获取密钥。",
        aiPrivacyNote:
          "使用 AI 功能时，DeepSeek 会收到视频字幕及相关视频上下文。保存前请查看 DeepSeek 的条款和价格。",
        keyLink: "https://platform.deepseek.com/api_keys",
      },
      minimax: {
        label: "MiniMax M3",
        aiApiKeyLabel: "MiniMax M3 API 密钥",
        aiApiKeyPlaceholder: "请粘贴 MiniMax M3 密钥",
        aiProviderHelp:
          "YouTube Digest 使用 MiniMax M3 生成概览、解释内容、翻译字幕和润色笔记。",
        aiProviderLink: "创建 MiniMax M3 账号并获取密钥",
        aiProviderHelpSuffix: "。请前往 MiniMax 平台获取密钥。",
        aiPrivacyNote:
          "使用 AI 功能时，MiniMax M3 会收到视频字幕及相关视频上下文。保存前请查看 MiniMax M3 的条款和价格。",
        keyLink:
          "https://platform.minimax.io/user-center/basic-information/interface-key",
      },
    },
  };

  function providerCopy(language, providerId) {
    const lang = AI_PROVIDER_COPY[normalizeLanguage(language)];
    const copy = (lang && lang[providerId]) || AI_PROVIDER_COPY.en.deepseek;
    return copy;
  }

  /**
   * Per-language, per-platform copy for the transcript-provider card. Each
   * entry mirrors the fields options.js renders inside one .platform-card
   * sub-section: the platform's visible name, the input label / placeholder,
   * and the help text + link. `keyLink` is optional because Bilibili doesn't
   * have a canonical "create a SESSDATA" page — when it's missing, the link
   * element is suppressed and only the help text is shown.
   *
   * Keys mirror the adapter id used in YTD_SETTINGS.TRANSCRIPT_ADAPTER_IDS so
   * the platform card list iterates the same ids in the same order as the
   * bucket stored under settings.transcriptKeys.
   */
  const PLATFORM_COPY = {
    en: {
      youtube: {
        sectionTitle: "YouTube",
        keyLabel: "Supadata API key",
        keyPlaceholder: "Paste your Supadata key",
        help: "Used to fetch timestamped YouTube subtitles. ",
        link: "Create a Supadata account and key",
        helpSuffix: ". Supadata generates the key during onboarding.",
        keyLink: "https://dash.supadata.ai/auth/sign-up",
      },
      bilibili: {
        sectionTitle: "Bilibili",
        keyLabel: "Bilibili SESSDATA cookie",
        keyPlaceholder: "Paste your SESSDATA cookie",
        help:
          "Required for cookie-gated Bilibili videos. Open any bilibili.com page, open DevTools \u2192 Application \u2192 Cookies, and copy the SESSDATA value. Public videos with built-in subtitles also work without it.",
        link: "",
        helpSuffix: "",
        keyLink: "",
      },
    },
    "zh-CN": {
      youtube: {
        sectionTitle: "YouTube",
        keyLabel: "Supadata API 密钥",
        keyPlaceholder: "请粘贴 Supadata 密钥",
        help: "用于获取带时间戳的 YouTube 字幕。",
        link: "创建 Supadata 账号并获取密钥",
        helpSuffix: "。Supadata 会在引导流程中生成密钥。",
        keyLink: "https://dash.supadata.ai/auth/sign-up",
      },
      bilibili: {
        sectionTitle: "Bilibili",
        keyLabel: "Bilibili SESSDATA cookie",
        keyPlaceholder: "请粘贴 SESSDATA cookie",
        help:
          "用于获取需要登录的 Bilibili 视频字幕。打开任意 bilibili.com 页面，进入开发者工具 \u2192 Application \u2192 Cookies，复制 SESSDATA 的值。带有官方字幕的公开视频即使不填写也可以使用。",
        link: "",
        helpSuffix: "",
        keyLink: "",
      },
    },
  };

  function platformCopy(language, adapterId) {
    const lang = PLATFORM_COPY[normalizeLanguage(language)];
    // Fall back to English so a missing-language copy never crashes rendering.
    // Then fall back to an empty object so the renderer can guard per-field.
    const copy =
      (lang && lang[adapterId]) ||
      (PLATFORM_COPY.en && PLATFORM_COPY.en[adapterId]) ||
      {};
    return copy;
  }

  /**
   * Returns the deterministic input id used to mount the per-platform key
   * field. Kept centralised so loadSettings / saveSettings / save payload
   * stay in lockstep without sprinkling string templates across the file.
   */
  function transcriptKeyInputId(adapterId) {
    return `transcriptKey_${adapterId}`;
  }

  function normalizeLanguage(language) {
    return SUPPORTED_LANGUAGES.has(language) ? language : "en";
  }

  function translate(language, key, params = {}) {
    const normalizedLanguage = normalizeLanguage(language);
    const value = COPY[normalizedLanguage][key] ?? COPY.en[key] ?? "";
    return typeof value === "function" ? value(params) : value;
  }

  function createStorageAdapter(chromeApi, fallbackStorage) {
    const chromeStorage = chromeApi?.storage?.local;
    const memoryStorage = new Map();

    function fallbackKeys() {
      const keys = [];
      if (!fallbackStorage) return keys;
      try {
        for (let index = 0; index < fallbackStorage.length; index += 1) {
          const key = fallbackStorage.key(index);
          if (key?.startsWith(PREVIEW_STORAGE_PREFIX)) keys.push(key);
        }
      } catch (_error) {
        return [];
      }
      return keys;
    }

    function readFallbackValue(key) {
      try {
        const rawValue = fallbackStorage?.getItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
        );
        if (rawValue !== null && rawValue !== undefined) {
          return JSON.parse(rawValue);
        }
      } catch (_error) {
        // Fall through to memory when localStorage is unavailable or malformed.
      }
      return memoryStorage.get(key);
    }

    function writeFallbackValue(key, value) {
      memoryStorage.set(key, value);
      try {
        fallbackStorage?.setItem(
          `${PREVIEW_STORAGE_PREFIX}${key}`,
          JSON.stringify(value),
        );
      } catch (_error) {
        // The in-memory copy keeps a restricted preview functional.
      }
    }

    return {
      async get(keys) {
        if (chromeStorage) return chromeStorage.get(keys);

        const requestedKeys =
          keys === null
            ? [
                ...new Set([
                  ...memoryStorage.keys(),
                  ...fallbackKeys().map((key) =>
                    key.slice(PREVIEW_STORAGE_PREFIX.length),
                  ),
                ]),
              ]
            : Array.isArray(keys)
              ? keys
              : [keys];

        return Object.fromEntries(
          requestedKeys
            .map((key) => [key, readFallbackValue(key)])
            .filter(([, value]) => value !== undefined),
        );
      },

      async set(items) {
        if (chromeStorage) return chromeStorage.set(items);
        for (const [key, value] of Object.entries(items)) {
          writeFallbackValue(key, value);
        }
      },

      async remove(keys) {
        if (chromeStorage) return chromeStorage.remove(keys);
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          memoryStorage.delete(key);
          try {
            fallbackStorage?.removeItem(`${PREVIEW_STORAGE_PREFIX}${key}`);
          } catch (_error) {
            // Memory removal is sufficient for this preview session.
          }
        }
      },

      async clear() {
        if (chromeStorage) return chromeStorage.clear();
        memoryStorage.clear();
        for (const key of fallbackKeys()) {
          try {
            fallbackStorage.removeItem(key);
          } catch (_error) {
            // Continue clearing any remaining preview keys.
          }
        }
      },
    };
  }

  async function readPreferredLanguage(storage) {
    const stored = await storage.get(LANGUAGE_STORAGE_KEY);
    return normalizeLanguage(stored[LANGUAGE_STORAGE_KEY]);
  }

  async function persistPreferredLanguage(storage, language) {
    const normalizedLanguage = normalizeLanguage(language);
    await storage.set({ [LANGUAGE_STORAGE_KEY]: normalizedLanguage });
    return normalizedLanguage;
  }

  function updateLanguageButtonState(buttons, language) {
    const normalizedLanguage = normalizeLanguage(language);
    for (const button of buttons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.language === normalizedLanguage),
      );
    }
  }

  function updateLocalizedPrompt(textarea, prompt) {
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const selectionDirection = textarea.selectionDirection;
    const scrollTop = textarea.scrollTop;
    const scrollLeft = textarea.scrollLeft;

    textarea.value = prompt;

    if (
      Number.isInteger(selectionStart) &&
      Number.isInteger(selectionEnd) &&
      typeof textarea.setSelectionRange === "function"
    ) {
      textarea.setSelectionRange(
        Math.min(selectionStart, prompt.length),
        Math.min(selectionEnd, prompt.length),
        selectionDirection || "none",
      );
    }
    textarea.scrollTop = scrollTop;
    textarea.scrollLeft = scrollLeft;
  }

  function createPromptDrafts() {
    return {
      en: translate("en", "customizationPrompt"),
      "zh-CN": translate("zh-CN", "customizationPrompt"),
    };
  }

  function switchPromptDraft(
    drafts,
    currentLanguage,
    nextLanguage,
    currentValue,
  ) {
    const normalizedCurrentLanguage = normalizeLanguage(currentLanguage);
    const normalizedNextLanguage = normalizeLanguage(nextLanguage);
    drafts[normalizedCurrentLanguage] = String(currentValue ?? "");
    if (typeof drafts[normalizedNextLanguage] !== "string") {
      drafts[normalizedNextLanguage] = translate(
        normalizedNextLanguage,
        "customizationPrompt",
      );
    }
    return {
      language: normalizedNextLanguage,
      prompt: drafts[normalizedNextLanguage],
    };
  }

  async function copyPromptValue(clipboard, value) {
    await clipboard.writeText(value);
  }

  function getSafeLocalStorage(root) {
    try {
      return root.localStorage;
    } catch (_error) {
      return null;
    }
  }

  function initialize(root = globalThis) {
    const doc = root.document;
    const settingsApi = root.YTD_SETTINGS;
    if (!doc || !settingsApi) return;

    const storage = createStorageAdapter(
      root.chrome,
      getSafeLocalStorage(root),
    );
    const form = doc.getElementById("settingsForm");
    const aiApiKeyInput = doc.getElementById("aiApiKey");
    // Stage b1-6: per-platform key fields are rendered into this container at
    // runtime from YTD_SETTINGS.TRANSCRIPT_ADAPTER_IDS + PLATFORM_COPY. The
    // static markup only carries the section heading + lede so adding a new
    // adapter surfaces a new input without editing options.html.
    const transcriptProvidersContainer = doc.getElementById(
      "transcriptProviders",
    );
    // Stage 3-3: provider-aware controls. The radio container is empty in the
    // static markup; options.js populates it from the AI_PROVIDERS registry.
    const providerOptionsContainer = doc.getElementById("providerOptions");
    const aiApiKeyLabel = doc.getElementById("aiApiKeyLabel");
    const aiProviderHelp = doc.getElementById("aiProviderHelp");
    const aiProviderLink = doc.getElementById("aiProviderLink");
    const aiProviderHelpSuffix = doc.getElementById("aiProviderHelpSuffix");
    const aiPrivacyNote = doc.getElementById("aiPrivacyNote");
    // Stage t05: AI punctuation opt-out checkbox. Wired into both
    // loadSettings() and saveSettings() so the value round-trips through
    // chrome.storage.local as settings.aiPunctuationEnabled.
    const aiPunctuationEnabledInput = doc.getElementById("aiPunctuationEnabled");
    // Stage nc01: Notescollection push token input.
    const notescollectionTokenInput = doc.getElementById("notescollectionToken");
    const customizationPrompt = doc.getElementById("customizationPrompt");
    const copyCustomizationPromptBtn = doc.getElementById(
      "copyCustomizationPromptBtn",
    );
    const copyStatus = doc.getElementById("copyStatus");
    const saveStatus = doc.getElementById("saveStatus");
    const dataStatus = doc.getElementById("dataStatus");
    const languageButtons = [...doc.querySelectorAll("[data-language]")];
    const statusStates = new Map();
    const promptDrafts = createPromptDrafts();
    let currentLanguage = "en";
    // Stage 3-4: tracks the currently-selected AI provider so the radio
    // list, help text, and save payload stay in sync.
    let currentProviderId = settingsApi.DEFAULTS.provider;

    function renderStatus(element) {
      const state = statusStates.get(element);
      element.textContent = state
        ? translate(currentLanguage, state.key, state.params)
        : "";
    }

    function setStatus(element, key, params = {}) {
      statusStates.set(element, { key, params });
      renderStatus(element);
    }

    function renderProviderOptions() {
      if (!providerOptionsContainer) return;
      const providerIds = settingsApi.listAiProviderIds();
      providerOptionsContainer.replaceChildren();
      for (const providerId of providerIds) {
        const copy = providerCopy(currentLanguage, providerId);
        const labelText = copy.label || providerId;
        const labelElement = doc.createElement("label");
        labelElement.className = "provider-radio";
        const inputElement = doc.createElement("input");
        inputElement.type = "radio";
        inputElement.name = "provider";
        inputElement.value = providerId;
        if (providerId === currentProviderId) inputElement.checked = true;
        inputElement.addEventListener("change", onProviderChanged);
        labelElement.append(inputElement, doc.createTextNode(labelText));
        providerOptionsContainer.append(labelElement);
      }
    }

    function applyProviderCopy(providerId) {
      const copy = providerCopy(currentLanguage, providerId);
      const keyLink = settingsApi.aiProviderField(providerId, "keyLink");
      if (aiApiKeyLabel) aiApiKeyLabel.textContent = copy.aiApiKeyLabel;
      if (aiApiKeyInput) aiApiKeyInput.placeholder = copy.aiApiKeyPlaceholder;
      if (aiProviderHelp) aiProviderHelp.textContent = copy.aiProviderHelp;
      if (aiProviderLink) {
        aiProviderLink.textContent = copy.aiProviderLink;
        if (keyLink) aiProviderLink.setAttribute("href", keyLink);
      }
      if (aiProviderHelpSuffix) {
        aiProviderHelpSuffix.textContent = copy.aiProviderHelpSuffix;
      }
      if (aiPrivacyNote) aiPrivacyNote.textContent = copy.aiPrivacyNote;
    }

    function onProviderChanged(event) {
      const target = event && event.target;
      const nextId = target && target.value;
      if (!nextId || !settingsApi.aiProviderField(nextId, "label")) return;
      currentProviderId = nextId;
      applyProviderCopy(nextId);
    }

    // Stage b1-6: builds one .platform-card sub-section per registered
    // transcript adapter. The card carries its own h3, label, input,
    // and help paragraph — all wired through data-i18n attributes so
    // applyPlatformCopy() can refresh text without re-rendering.
    function renderTranscriptProviders() {
      if (!transcriptProvidersContainer) return;
      transcriptProvidersContainer.replaceChildren();
      const adapterIds = settingsApi.TRANSCRIPT_ADAPTER_IDS;
      for (const adapterId of adapterIds) {
        const card = doc.createElement("div");
        card.className = "platform-card";
        card.dataset.platform = adapterId;

        const heading = doc.createElement("h3");
        heading.dataset.platformField = "sectionTitle";
        card.append(heading);

        const labelElement = doc.createElement("label");
        labelElement.htmlFor = transcriptKeyInputId(adapterId);
        labelElement.dataset.platformField = "keyLabel";
        card.append(labelElement);

        const inputElement = doc.createElement("input");
        inputElement.id = transcriptKeyInputId(adapterId);
        inputElement.name = `transcriptKey_${adapterId}`;
        inputElement.type = "password";
        inputElement.autocomplete = "off";
        inputElement.spellcheck = false;
        inputElement.dataset.platformField = "keyPlaceholder";
        card.append(inputElement);

        const help = doc.createElement("p");
        help.className = "help";
        const helpText = doc.createElement("span");
        helpText.dataset.platformField = "help";
        help.append(helpText);
        const link = doc.createElement("a");
        link.target = "_blank";
        link.rel = "noreferrer";
        link.dataset.platformField = "link";
        // Hidden when keyLink is missing — Bilibili has no canonical
        // "create a SESSDATA" page, so we surface only the help text.
        const suffix = doc.createElement("span");
        suffix.dataset.platformField = "helpSuffix";
        help.append(link, suffix);
        card.append(help);

        transcriptProvidersContainer.append(card);
      }
    }

    // Stage b1-6: refreshes the per-platform copy (titles, labels,
    // placeholders, help text + link) for the active language. Called
    // once at boot and again from applyLanguage() so a switch keeps
    // platform labels in sync without rebuilding the DOM.
    function applyPlatformCopy() {
      if (!transcriptProvidersContainer) return;
      const adapterIds = settingsApi.TRANSCRIPT_ADAPTER_IDS;
      for (const adapterId of adapterIds) {
        const card = transcriptProvidersContainer.querySelector(
          `[data-platform="${adapterId}"]`,
        );
        if (!card) continue;
        const copy = platformCopy(currentLanguage, adapterId);
        for (const node of card.querySelectorAll("[data-platform-field]")) {
          const field = node.dataset.platformField;
          if (field === "keyPlaceholder") {
            node.placeholder = copy.keyPlaceholder || "";
            continue;
          }
          if (field === "link") {
            if (copy.keyLink && copy.link) {
              node.textContent = copy.link;
              node.setAttribute("href", copy.keyLink);
              node.hidden = false;
            } else {
              node.hidden = true;
              node.removeAttribute("href");
            }
            continue;
          }
          if (field === "helpSuffix") {
            node.textContent = copy.helpSuffix || "";
            continue;
          }
          node.textContent = (copy && copy[field]) || "";
        }
      }
    }

    function applyLanguage(language) {
      const nextDraft = switchPromptDraft(
        promptDrafts,
        currentLanguage,
        language,
        customizationPrompt.value,
      );
      currentLanguage = nextDraft.language;
      doc.documentElement.lang = currentLanguage;
      doc.title = translate(currentLanguage, "pageTitle");

      for (const element of doc.querySelectorAll("[data-i18n]")) {
        element.textContent = translate(
          currentLanguage,
          element.dataset.i18n,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-html]")) {
        element.innerHTML = translate(
          currentLanguage,
          element.dataset.i18nHtml,
        );
      }
      for (const element of doc.querySelectorAll("[data-i18n-aria-label]")) {
        element.setAttribute(
          "aria-label",
          translate(currentLanguage, element.dataset.i18nAriaLabel),
        );
      }

      updateLocalizedPrompt(
        customizationPrompt,
        nextDraft.prompt,
      );
      updateLanguageButtonState(languageButtons, currentLanguage);
      for (const element of statusStates.keys()) renderStatus(element);
      // Stage 3-4: refresh provider-aware copy after a language switch so
      // the help text and link match the active interface language.
      applyProviderCopy(currentProviderId);
      // Stage b1-6: refresh per-platform key labels / help / placeholder
      // text so the transcript-provider card tracks the active language
      // alongside the AI-provider card.
      applyPlatformCopy();
    }

    async function loadSettings() {
      try {
        const stored = await storage.get(settingsApi.STORAGE_KEY);
        const migration = settingsApi.migrateLegacyCustom(
          stored[settingsApi.STORAGE_KEY],
        );
        const settings = migration.settings;
        // Stage 3-4: remember the active provider so renderProviderOptions()
        // preselects the right radio and saveSettings() round-trips the
        // user's choice back into storage.
        currentProviderId = settings.provider;

        aiApiKeyInput.value = settings.aiApiKey;
        // Stage t05: hydrate the AI-punctuation opt-out checkbox from the
        // normalized setting. Normalize collapses anything other than the
        // literal `true` to `false`, so on a fresh install (where nothing
        // is stored yet) we layer DEFAULTS.aiPunctuationEnabled back on
        // top so the checkbox starts checked — matching the documented
        // default-on behaviour.
        if (aiPunctuationEnabledInput) {
          const hasStoredSettings = !!stored[settingsApi.STORAGE_KEY];
          aiPunctuationEnabledInput.checked = hasStoredSettings
            ? Boolean(settings.aiPunctuationEnabled)
            : Boolean(settingsApi.DEFAULTS && settingsApi.DEFAULTS.aiPunctuationEnabled);
        }
        // Stage b1-6: hydrate every per-platform key input from the bucket.
        // `transcriptKeyFor` reads from `settings.transcriptKeys[adapterId]`
        // and falls back to the legacy `supadataApiKey` alias for the
        // YouTube slot, so existing users see their existing key in the
        // same field it used to live in.
        for (const adapterId of settingsApi.TRANSCRIPT_ADAPTER_IDS) {
          const input = doc.getElementById(transcriptKeyInputId(adapterId));
          if (!input) continue;
          input.value = settingsApi.transcriptKeyFor(settings, adapterId) || "";
        }
        // Stage nc01: hydrate the Notescollection push token.
        if (notescollectionTokenInput) {
          notescollectionTokenInput.value = settings.notescollectionToken || "";
        }
        if (migration.migrated) {
          await storage.set({ [settingsApi.STORAGE_KEY]: settings });
          setStatus(saveStatus, "migrationWarning");
        }
      } catch (_error) {
        setStatus(saveStatus, "settingsLoadFailed");
      }
    }

    async function loadOptions() {
      try {
        applyLanguage(await readPreferredLanguage(storage));
      } catch (_error) {
        applyLanguage("en");
      }
      // Stage b1-6: render the per-platform cards once. The active language
      // is already known by the time loadSettings() runs, so the cards can
      // pick up copy + saved values in a single pass.
      renderTranscriptProviders();
      applyPlatformCopy();
      await loadSettings();
      // Stage 3-4: render the radio list once (the visible labels are brand
      // names and don't change with language) and refresh provider-aware
      // copy now that we know the active provider from storage.
      renderProviderOptions();
      applyProviderCopy(currentProviderId);
    }

    async function saveSettings(event) {
      event.preventDefault();
      setStatus(saveStatus, "saving");

      // Stage 3-4: read the selected provider from the radio group so the
      // user's choice round-trips through normalize() and into storage.
      const selectedRadio = providerOptionsContainer?.querySelector(
        'input[name="provider"]:checked',
      );
      const selectedProviderId =
        selectedRadio?.value &&
        settingsApi.aiProviderField(selectedRadio.value, "label")
          ? selectedRadio.value
          : currentProviderId;

      // Stage b1-6: collect every per-platform key from the rendered cards.
      // Empty strings are folded so normalize() can drop them and each
      // adapter's slot stays "set" only when the user actually typed a
      // key. This lets future adapters join the bucket without editing
      // saveSettings() as long as they appear in TRANSCRIPT_ADAPTER_IDS.
      const transcriptKeys = {};
      let hasPlatformKey = false;
      for (const adapterId of settingsApi.TRANSCRIPT_ADAPTER_IDS) {
        const input = doc.getElementById(transcriptKeyInputId(adapterId));
        const value = (input?.value || "").trim();
        transcriptKeys[adapterId] = value;
        if (value) hasPlatformKey = true;
      }

      const settings = settingsApi.normalize({
        provider: selectedProviderId,
        aiApiKey: aiApiKeyInput.value,
        transcriptKeys,
        // Stage t05: read the opt-out checkbox. The missing-input branch is
        // handled by normalize()'s strict `=== true` coercion, so an absent
        // value just defaults to `false` instead of throwing.
        aiPunctuationEnabled:
          aiPunctuationEnabledInput && aiPunctuationEnabledInput.checked,
        // Stage nc01: read the Notescollection push token.
        notescollectionToken: notescollectionTokenInput
          ? notescollectionTokenInput.value.trim()
          : "",
      });

      if (!hasPlatformKey) {
        setStatus(saveStatus, "addPlatformKey");
        return;
      }
      if (!settings.aiApiKey) {
        setStatus(saveStatus, "addAiKey");
        return;
      }

      try {
        await storage.set({ [settingsApi.STORAGE_KEY]: settings });
        setStatus(saveStatus, "saved");
      } catch (_error) {
        setStatus(saveStatus, "saveFailed");
      }
    }

    async function copyCustomizationPrompt() {
      setStatus(copyStatus, "copying");
      try {
        await copyPromptValue(
          root.navigator.clipboard,
          customizationPrompt.value,
        );
        setStatus(copyStatus, "promptCopied");
      } catch (_error) {
        setStatus(copyStatus, "copyFailed");
      }
    }

    async function clearCachedDigests() {
      const all = await storage.get(null);
      const keys = Object.keys(all).filter((key) => key.startsWith("digest_"));
      if (keys.length) await storage.remove(keys);
      setStatus(dataStatus, "clearedDigests", { count: keys.length });
    }

    async function clearNotes() {
      await storage.remove("ytd_notes");
      setStatus(dataStatus, "notesDeleted");
    }

    async function resetAllData() {
      const confirmed = root.confirm(
        translate(currentLanguage, "resetConfirm"),
      );
      if (!confirmed) return;

      await storage.clear();
      await persistPreferredLanguage(storage, currentLanguage);
      await loadSettings();
      setStatus(dataStatus, "allDataDeleted");
    }

    form.addEventListener("submit", saveSettings);
    copyCustomizationPromptBtn.addEventListener(
      "click",
      copyCustomizationPrompt,
    );
    doc
      .getElementById("clearCacheBtn")
      .addEventListener("click", clearCachedDigests);
    doc.getElementById("clearNotesBtn").addEventListener("click", clearNotes);
    doc.getElementById("resetBtn").addEventListener("click", resetAllData);
    for (const button of languageButtons) {
      button.addEventListener("click", async () => {
        const language = button.dataset.language;
        applyLanguage(language);
        await persistPreferredLanguage(storage, language);
      });
    }

    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", loadOptions, { once: true });
    } else {
      void loadOptions();
    }
  }

  return {
    COPY,
    AI_PROVIDER_COPY,
    PLATFORM_COPY,
    LANGUAGE_STORAGE_KEY,
    copyPromptValue,
    createPromptDrafts,
    createStorageAdapter,
    normalizeLanguage,
    persistPreferredLanguage,
    platformCopy,
    providerCopy,
    readPreferredLanguage,
    transcriptKeyInputId,
    translate,
    updateLanguageButtonState,
    updateLocalizedPrompt,
    switchPromptDraft,
    initialize,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_OPTIONS;
}

if (typeof document !== "undefined") {
  YTD_OPTIONS.initialize();
}

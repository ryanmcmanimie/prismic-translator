// Background service worker for Prismic Document Translator
class BackgroundService {
  constructor() {
    this.init();
  }

  init() {
    console.log("Prismic Translator background service started");
    this.setupEventListeners();
  }

  setupEventListeners() {
    // Handle extension installation
    chrome.runtime.onInstalled.addListener((details) => {
      console.log("Extension installed:", details);

      if (details.reason === "install") {
        this.handleFirstInstall();
      } else if (details.reason === "update") {
        this.handleUpdate(details.previousVersion);
      }
    });

    // Handle messages from content scripts or popup
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      console.log("Background received message:", request);

      switch (request.action) {
        case "getTranslationQuota":
          this.getTranslationQuota(request.service)
            .then((quota) => sendResponse({ success: true, quota }))
            .catch((error) =>
              sendResponse({ success: false, error: error.message })
            );
          return true;

        case "logTranslationUsage":
          this.logTranslationUsage(
            request.service,
            request.charactersTranslated
          )
            .then(() => sendResponse({ success: true }))
            .catch((error) =>
              sendResponse({ success: false, error: error.message })
            );
          return true;

        case "deeplTranslate":
          this.handleDeepLTranslate(request, sendResponse);
          return true;

        case "deepseekTranslate":
          this.handleDeepSeekTranslate(request, sendResponse);
          return true;

        default:
          sendResponse({ success: false, error: "Unknown action" });
      }
    });

    // Handle tab updates to inject content script if needed
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === "complete" && tab.url) {
        if (
          tab.url.includes("prismic.io") ||
          tab.url.includes("prismicio.com")
        ) {
          this.ensureContentScriptInjected(tabId);
        }
      }
    });
  }

  async handleFirstInstall() {
    try {
      // Set default settings
      await chrome.storage.sync.set({
        sourceLanguage: "auto",
        targetLanguage: "es",
        translationService: "google",
        translateRichText: true,
        translateTitles: true,
        translateAltText: true,
        preserveFormatting: true,
        installDate: Date.now(),
      });

      console.log("Default settings saved");

      // Open welcome page or show notification
      this.showWelcomeNotification();
    } catch (error) {
      console.error("Error during first install:", error);
    }
  }

  async handleUpdate(previousVersion) {
    try {
      console.log(
        `Extension updated from ${previousVersion} to ${
          chrome.runtime.getManifest().version
        }`
      );

      // Handle any migration logic here if needed
      await this.migrateSettings(previousVersion);
    } catch (error) {
      console.error("Error during update:", error);
    }
  }

  async migrateSettings(previousVersion) {
    // Add any settings migration logic here for future updates
    console.log("Settings migration completed");
  }

  showWelcomeNotification() {
    // Show a welcome notification
    if (chrome.notifications) {
      chrome.notifications.create({
        type: "basic",
        title: "Prismic Translator Installed!",
        message:
          "Click the extension icon when viewing a Prismic document to start translating.",
      });
    }
  }

  async ensureContentScriptInjected(tabId) {
    try {
      // Check if content script is already injected
      const response = await chrome.tabs.sendMessage(tabId, { action: "ping" });
      console.log("Content script already active:", response);
    } catch (error) {
      // Content script not injected, inject it
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ["content.js"],
        });
        console.log("Content script injected into tab:", tabId);
      } catch (injectionError) {
        console.error("Failed to inject content script:", injectionError);
      }
    }
  }

  async getTranslationQuota(service) {
    try {
      const result = await chrome.storage.local.get([
        `${service}_quota`,
        `${service}_usage`,
      ]);

      const quota = result[`${service}_quota`] || this.getDefaultQuota(service);
      const usage = result[`${service}_usage`] || {
        characters: 0,
        resetDate: Date.now(),
      };

      // Reset usage if it's a new month
      const now = new Date();
      const resetDate = new Date(usage.resetDate);

      if (
        now.getMonth() !== resetDate.getMonth() ||
        now.getFullYear() !== resetDate.getFullYear()
      ) {
        usage.characters = 0;
        usage.resetDate = now.getTime();
        await chrome.storage.local.set({ [`${service}_usage`]: usage });
      }

      return {
        total: quota,
        used: usage.characters,
        remaining: Math.max(0, quota - usage.characters),
        resetDate: usage.resetDate,
      };
    } catch (error) {
      console.error("Error getting translation quota:", error);
      throw error;
    }
  }

  async logTranslationUsage(service, charactersTranslated) {
    try {
      const result = await chrome.storage.local.get(`${service}_usage`);
      const usage = result[`${service}_usage`] || {
        characters: 0,
        resetDate: Date.now(),
      };

      usage.characters += charactersTranslated;

      await chrome.storage.local.set({ [`${service}_usage`]: usage });

      console.log(
        `Logged ${charactersTranslated} characters for ${service}. Total: ${usage.characters}`
      );
    } catch (error) {
      console.error("Error logging translation usage:", error);
      throw error;
    }
  }

  getDefaultQuota(service) {
    const quotas = {
      google: 500000, // Google Translate free tier (estimated)
      deepl: 500000, // DeepL free tier
      azure: 2000000, // Azure free tier
    };

    return quotas[service] || 100000;
  }

  async handleDeepLTranslate(request, sendResponse) {
    const { text, sourceLanguage, targetLanguage, apiKey } = request;
    try {
      const response = await fetch("https://api-free.deepl.com/v2/translate", {
        method: "POST",
        headers: {
          Authorization: `DeepL-Auth-Key ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          text: text,
          source_lang: sourceLanguage.toUpperCase(),
          target_lang: targetLanguage.toUpperCase(),
          tag_handling: "html",
          ignore_tags:
            "br,hr,img,input,meta,link,script,style,title,head,iframe,svg,canvas,video,audio,object,embed,applet,frame,frameset,noframes,noscript,area,map,track,wbr,source,param,picture,base,col,colgroup,tbody,thead,tfoot,th,tr,td,caption,fieldset,legend,button,select,option,optgroup,datalist,output,progress,meter,details,summary,dialog,menu,menuitem,template,slot",
        }),
      });
      if (!response.ok) {
        sendResponse({
          success: false,
          error: `DeepL API error: ${response.status}`,
        });
        return;
      }
      const data = await response.json();
      if (data.translations && data.translations[0]) {
        sendResponse({ success: true, text: data.translations[0].text });
        return;
      }
      sendResponse({ success: false, error: "Invalid response from DeepL" });
    } catch (error) {
      sendResponse({
        success: false,
        error: "DeepL translation failed: " + error.message,
      });
    }
  }

  async handleDeepSeekTranslate(request, sendResponse) {
    const { text, sourceLanguage, targetLanguage, apiKey } = request;
    try {
      let context =
        "We are translating website marketing pages for a NetSuite Cloud ERP consultancy. Provide ONLY the final translation with NO explanatory notes or annotations.";
      // Add special context for Traditional Chinese (Hong Kong)
      if (
        targetLanguage.toLowerCase() === "zh-hk" ||
        targetLanguage.toLowerCase() === "zh-hant"
      ) {
        context +=
          " Provide clean Traditional Chinese translations optimized for Hong Kong business audiences, delivering only the final output without any annotations. Preserve all NetSuite module names in their original English forms (Advanced Inventory, Order Management, Demand Planning) as proper nouns, while localizing all other content according to Hong Kong conventions. Use industry-standard terms like '端到端可視性' (end-to-end visibility) and culturally appropriate expressions such as '骨幹' for platform and '各自為政' for siloed systems. Maintain a professional yet natural tone with Cantonese influences (using particles like '嘅' and '我哋' where appropriate), keeping proper nouns like NetSuite untranslated. Apply these rules automatically without commentary, focusing on fluent, technical translations that match Hong Kong's bilingual business environment.";
      }
      const response = await fetch(
        "https://api.deepseek.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "deepseek-chat",
            messages: [
              {
                role: "system",
                content: `${context} You are a translation engine. Translate the following text from ${sourceLanguage} to ${targetLanguage}, preserving all HTML tags and formatting.`,
              },
              { role: "user", content: text },
            ],
          }),
        }
      );
      if (!response.ok) {
        sendResponse({
          success: false,
          error: `DeepSeek API error: ${response.status}`,
        });
        return;
      }
      const data = await response.json();
      if (
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content
      ) {
        sendResponse({ success: true, text: data.choices[0].message.content });
        return;
      }
      sendResponse({ success: false, error: "Invalid response from DeepSeek" });
    } catch (error) {
      sendResponse({
        success: false,
        error: "DeepSeek translation failed: " + error.message,
      });
    }
  }
}

// Initialize background service
new BackgroundService();

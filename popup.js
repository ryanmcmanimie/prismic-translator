class PopupController {
  constructor() {
    this.elements = {
      sourceLanguage: document.getElementById("sourceLanguage"),
      targetLanguage: document.getElementById("targetLanguage"),
      translationService: document.getElementById("translationService"),
      apiKey: document.getElementById("apiKey"),
      apiKeyGroup: document.querySelector(".api-key-group"),
      translateButton: document.getElementById("translateButton"),
      status: document.getElementById("status"),
      statusText: document.getElementById("statusText"),
      progressFill: document.getElementById("progressFill"),
      btnText: document.querySelector(".btn-text"),
      btnLoading: document.querySelector(".btn-loading"),
      context: document.getElementById("context"),
      cancelButton: document.getElementById("cancelButton"),
      saveContextButton: document.getElementById("saveContextButton"),
    };

    this.init();
  }

  async init() {
    await this.loadSettings();
    this.bindEvents();
    await this.checkPrismicPage();
    this.updateTranslateButtonText();
    // Set focus to the Translate Document button for quick Enter access
    this.elements.translateButton.focus();
  }

  bindEvents() {
    this.elements.translationService.addEventListener("change", () => {
      this.handleServiceChange();
      // Save the selected service (but not the API key value)
      chrome.storage.sync.set({
        translationService: this.elements.translationService.value,
      });
    });

    this.elements.translateButton.addEventListener("click", () => {
      this.handleTranslate();
    });

    this.elements.cancelButton.addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, { action: "cancelTranslation" });
      });
      this.showStatus("Translation cancelled.", "info");
      this.elements.translateButton.disabled = false;
      this.elements.cancelButton.disabled = true;
    });

    // Save settings on change for language and context fields only
    [
      this.elements.sourceLanguage,
      this.elements.targetLanguage,
      this.elements.context,
    ].forEach((element) => {
      element.addEventListener("change", () => {
        this.saveSettings();
      });
    });

    // Save API key only when the API key field changes
    this.elements.apiKey.addEventListener("change", () => {
      const service = this.elements.translationService.value;
      const keyName = `apiKey_${service}`;
      chrome.storage.sync.set({ [keyName]: this.elements.apiKey.value });
    });

    this.elements.targetLanguage.addEventListener("change", () => {
      this.saveSettings();
      chrome.runtime.sendMessage({ action: "updateContextMenuLanguage" });
    });

    this.elements.saveContextButton.addEventListener("click", () => {
      this.saveContext();
    });
  }

  handleServiceChange() {
    const service = this.elements.translationService.value;
    const keyName = `apiKey_${service}`;
    // Show API key field for OpenAI and DeepSeek
    if (service === "openai" || service === "deepseek") {
      this.elements.apiKeyGroup.style.display = "block";
    } else {
      this.elements.apiKeyGroup.style.display = "none";
    }
    // Always load the correct API key for the selected service
    chrome.storage.sync.get([keyName], (result) => {
      this.elements.apiKey.value = result[keyName] || "";
    });
  }

  async handleTranslate() {
    if (!(await this.validateSettings())) {
      return;
    }

    this.setLoading(true);
    this.showStatus("Analyzing document fields...", "info");

    try {
      const settings = this.getTranslationSettings();

      // Send message to content script
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      const response = await chrome.tabs.sendMessage(tab.id, {
        action: "translate",
        settings: settings,
        forceFullDocument: true,
      });

      if (response.success) {
        this.showStatus(
          `Successfully translated ${response.fieldsTranslated} fields`,
          "success"
        );
      } else {
        this.showStatus(`Error: ${response.error}`, "error");
      }
    } catch (error) {
      console.error("Translation error:", error);
      this.showStatus("Translation failed. Please try again.", "error");
    } finally {
      this.setLoading(false);
    }
  }

  async validateSettings() {
    const service = this.elements.translationService.value;

    if (service !== "google" && !this.elements.apiKey.value.trim()) {
      this.showStatus(
        "Please enter your API key for the selected service",
        "error"
      );
      this.elements.apiKey.focus();
      return false;
    }

    if (
      this.elements.sourceLanguage.value === this.elements.targetLanguage.value
    ) {
      this.showStatus(
        "Source and target languages cannot be the same",
        "error"
      );
      return false;
    }

    return true;
  }

  getTranslationSettings() {
    return {
      sourceLanguage: this.elements.sourceLanguage.value,
      targetLanguage: this.elements.targetLanguage.value,
      translationService: this.elements.translationService.value,
      apiKey: this.elements.apiKey.value,
      context: this.elements.context.value,
      options: {
        preserveFormatting: true,
      },
    };
  }

  setLoading(loading) {
    this.elements.translateButton.disabled = loading;

    if (loading) {
      this.elements.btnText.style.display = "none";
      this.elements.btnLoading.style.display = "inline";
    } else {
      this.elements.btnText.style.display = "inline";
      this.elements.btnLoading.style.display = "none";
    }
  }

  showStatus(message, type = "info") {
    this.elements.status.style.display = "block";
    this.elements.statusText.textContent = message;

    // Remove existing status classes
    this.elements.status.classList.remove("error", "success");

    if (type === "error") {
      this.elements.status.classList.add("error");
    } else if (type === "success") {
      this.elements.status.classList.add("success");
    }

    // Auto-hide success messages after 3 seconds
    if (type === "success") {
      setTimeout(() => {
        this.elements.status.style.display = "none";
      }, 3000);
    }
  }

  updateProgress(percentage) {
    this.elements.progressFill.style.width = `${percentage}%`;
  }

  async checkPrismicPage() {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (
        !tab.url.includes("prismic.io") &&
        !tab.url.includes("prismicio.com") &&
        !tab.url.includes("test.html")
      ) {
        this.showStatus("Please navigate to a Prismic document page", "error");
        this.elements.translateButton.disabled = true;
        return;
      }

      // Check if content script is ready
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "ping" });
      } catch (error) {
        // Do not show status here; just retry silently
        setTimeout(() => this.checkPrismicPage(), 1000);
      }
    } catch (error) {
      console.error("Error checking Prismic page:", error);
    }
  }

  async loadSettings() {
    try {
      const result = await chrome.storage.sync.get([
        "sourceLanguage",
        "targetLanguage",
        "translationService",
        "apiKey_openai",
        "apiKey_deepseek",
        "translationContext",
      ]);

      if (result.sourceLanguage) {
        this.elements.sourceLanguage.value = result.sourceLanguage;
      }
      if (result.targetLanguage) {
        this.elements.targetLanguage.value = result.targetLanguage;
      }
      if (result.translationService) {
        this.elements.translationService.value = result.translationService;
        this.handleServiceChange();
      }
      const service = this.elements.translationService.value;
      const keyName = `apiKey_${service}`;
      if (result[keyName]) {
        this.elements.apiKey.value = result[keyName];
      }
      if (result.translationContext) {
        this.elements.context.value = result.translationContext;
      }
    } catch (error) {
      console.error("Error loading settings:", error);
    }
  }

  async saveSettings() {
    try {
      const service = this.elements.translationService.value;
      const keyName = `apiKey_${service}`;
      await chrome.storage.sync.set({
        sourceLanguage: this.elements.sourceLanguage.value,
        targetLanguage: this.elements.targetLanguage.value,
        translationService: this.elements.translationService.value,
        [keyName]: this.elements.apiKey.value,
        translationContext: this.elements.context.value,
      });
    } catch (error) {
      console.error("Error saving settings:", error);
    }
  }

  async updateTranslateButtonText() {
    // Check if there is selected text in the active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(
          tabs[0].id,
          { action: "checkSelection" },
          (response) => {
            const hasSelection = response && response.hasSelection;
            const btnText = document.querySelector(".btn-text");
            if (btnText) {
              btnText.textContent = hasSelection
                ? "Translate Selected"
                : "Translate Document";
            }
          }
        );
      }
    });
  }

  async saveContext() {
    try {
      await chrome.storage.sync.set({
        translationContext: this.elements.context.value,
      });
      this.showStatus("Context saved!", "success");
    } catch (error) {
      this.showStatus("Failed to save context.", "error");
    }
  }
}

// Initialize popup when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  new PopupController();
});

// Listen for progress updates from the content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translationProgress") {
    const progressFill = document.getElementById("progressFill");
    if (progressFill) {
      progressFill.style.width = `${request.percent}%`;
    }
  }
  if (request.action === "translationStatus") {
    const statusText = document.getElementById("statusText");
    if (statusText) {
      statusText.textContent = request.text;
    }
  }
});

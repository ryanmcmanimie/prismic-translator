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
      translateRichText: document.getElementById("translateRichText"),
      translateTitles: document.getElementById("translateTitles"),
      translateAltText: document.getElementById("translateAltText"),
      preserveFormatting: document.getElementById("preserveFormatting"),
      cancelButton: document.getElementById("cancelButton"),
    };

    this.init();
  }

  async init() {
    await this.loadSettings();
    this.bindEvents();
    await this.checkPrismicPage();
  }

  bindEvents() {
    this.elements.translationService.addEventListener("change", () => {
      this.handleServiceChange();
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

    // Save settings on change
    [
      this.elements.sourceLanguage,
      this.elements.targetLanguage,
      this.elements.translationService,
      this.elements.apiKey,
      this.elements.translateRichText,
      this.elements.translateTitles,
      this.elements.translateAltText,
      this.elements.preserveFormatting,
    ].forEach((element) => {
      element.addEventListener("change", () => {
        this.saveSettings();
      });
    });
  }

  handleServiceChange() {
    const service = this.elements.translationService.value;
    const needsApiKey = service !== "google";
    this.elements.apiKeyGroup.style.display = needsApiKey ? "block" : "none";
    if (needsApiKey) {
      this.elements.apiKey.required = true;
    } else {
      this.elements.apiKey.required = false;
    }
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
      options: {
        translateRichText: this.elements.translateRichText.checked,
        translateTitles: this.elements.translateTitles.checked,
        translateAltText: this.elements.translateAltText.checked,
        preserveFormatting: this.elements.preserveFormatting.checked,
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
        this.showStatus("Loading Prismic page detector...", "info");
        // Content script might not be ready yet
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
        "apiKey",
        "translateRichText",
        "translateTitles",
        "translateAltText",
        "preserveFormatting",
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
      if (result.apiKey) {
        this.elements.apiKey.value = result.apiKey;
      }

      // Load checkbox settings
      this.elements.translateRichText.checked =
        result.translateRichText !== false;
      this.elements.translateTitles.checked = result.translateTitles !== false;
      this.elements.translateAltText.checked =
        result.translateAltText !== false;
      this.elements.preserveFormatting.checked =
        result.preserveFormatting !== false;
    } catch (error) {
      console.error("Error loading settings:", error);
    }
  }

  async saveSettings() {
    try {
      await chrome.storage.sync.set({
        sourceLanguage: this.elements.sourceLanguage.value,
        targetLanguage: this.elements.targetLanguage.value,
        translationService: this.elements.translationService.value,
        apiKey: this.elements.apiKey.value,
        translateRichText: this.elements.translateRichText.checked,
        translateTitles: this.elements.translateTitles.checked,
        translateAltText: this.elements.translateAltText.checked,
        preserveFormatting: this.elements.preserveFormatting.checked,
      });
    } catch (error) {
      console.error("Error saving settings:", error);
    }
  }
}

// Initialize popup when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  new PopupController();
});

(function () {
  if (window.__prismicTranslatorLoaded) return;
  window.__prismicTranslatorLoaded = true;

  class PrismicTranslator {
    constructor() {
      this.translationService = null;
      this.fieldSelectors = [
        // Modern Prismic field selectors (based on actual HTML structure)
        'input[id*="."]', // Prismic uses IDs like ":r9fa:.uid", ":r9fa:.tiny_title"
        'textarea[id*="."]', // Textarea fields with Prismic ID pattern
        'div[contenteditable="true"].tiptap.ProseMirror', // Rich text fields using TipTap editor
        'input[placeholder*="Alt text"]', // Image alt text fields
        'input[placeholder*="Short description for the visually impaired"]', // Alt text variations
        'textarea[placeholder*="..."]', // Generic textarea placeholders
        'input[placeholder*="Enter"]', // Input fields with "Enter" placeholder
        'input[placeholder*="Add new tag"]', // Tag fields
        // Legacy selectors for older Prismic versions
        'input[data-testid*="field"]',
        'textarea[data-testid*="field"]',
        'div[data-testid*="rich-text"] [contenteditable="true"]',
        'input[data-testid*="title"]',
        'textarea[data-testid*="title"]',
        'input[data-testid*="text"]',
        'textarea[data-testid*="text"]',
        '[data-field-type="StructuredText"] [contenteditable]',
        '[data-field-type="Text"] input',
        '[data-field-type="Text"] textarea',
        '[data-field-type="Title"] input',
        '[data-field-type="Title"] textarea',
        // Generic fallback selectors
        '.field input[type="text"]',
        ".field textarea",
        '.rich-text-editor [contenteditable="true"]',
      ];

      this.languageCodeMap = {
        en: "en-us",
        es: "es-es",
        fr: "fr-fr",
        de: "de-de",
        it: "it-it",
        pt: "pt-pt",
        ru: "ru-ru",
        ja: "ja-jp",
        ko: "ko-kr",
        zh: "zh-cn", // Simplified Chinese
        hk: "zh-hk", // Traditional Chinese
      };

      this.init();
    }

    init() {
      console.log("Prismic Translator content script loaded");
      this.setupMessageListener();
    }

    setupMessageListener() {
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        console.log("Content script received message:", request);

        switch (request.action) {
          case "ping":
            sendResponse({ success: true, message: "Content script ready" });
            break;

          case "translate":
            this.handleTranslateRequest(
              request.settings,
              request.forceFullDocument
            )
              .then((result) => sendResponse(result))
              .catch((error) =>
                sendResponse({ success: false, error: error.message })
              );
            return true; // Keep message channel open for async response

          case "preview":
            this.handlePreviewRequest(request.settings)
              .then((result) => sendResponse(result))
              .catch((error) =>
                sendResponse({ success: false, error: error.message })
              );
            return true;

          case "cancelTranslation":
            this.cancelTranslation();
            sendResponse({ success: true });
            break;

          case "translateSelectionContextMenu":
            console.log("[Prismic Translator] Context menu action received");
            // Use the last used settings if available, or default settings
            const lastSettings = window.prismicTranslatorLastSettings || {
              sourceLanguage: "en",
              targetLanguage: "hk",
              translationService: "openai",
              options: {
                translateRichText: true,
                translateTitles: true,
                translateAltText: true,
                preserveFormatting: true,
              },
            };
            const keyName = `apiKey_${lastSettings.translationService}`;
            chrome.storage.sync.get([keyName], (result) => {
              const apiKey = result[keyName] || "";
              const settings = { ...lastSettings, apiKey };
              window.prismicTranslatorInstance =
                window.prismicTranslatorInstance || new PrismicTranslator();
              // Log the current selection
              const selection = window.getSelection();
              if (
                selection &&
                selection.rangeCount &&
                selection.toString().trim().length > 0
              ) {
                const container = document.createElement("div");
                for (let i = 0; i < selection.rangeCount; i++) {
                  container.appendChild(
                    selection.getRangeAt(i).cloneContents()
                  );
                }
                const selectedHtml = container.innerHTML;
                console.log(
                  "[Prismic Translator] Selected HTML for context menu translation:",
                  selectedHtml
                );
              } else {
                console.log(
                  "[Prismic Translator] No selection found for context menu translation."
                );
              }
              Promise.resolve(
                window.prismicTranslatorInstance.handleTranslateRequest(
                  settings
                )
              )
                .then((result) => {
                  console.log(
                    "[Prismic Translator] Context menu translation result:",
                    result
                  );
                })
                .catch((error) => {
                  console.error(
                    "[Prismic Translator] Context menu translation error:",
                    error
                  );
                });
            });
            break;

          case "checkSelection":
            const selection = window.getSelection();
            sendResponse({
              hasSelection: selection && selection.toString().trim().length > 0,
            });
            break;

          default:
            sendResponse({ success: false, error: "Unknown action" });
        }
      });
    }

    // Add a flag to allow cancellation
    translationCancelled = false;

    // Add a method to cancel translation
    cancelTranslation() {
      this.translationCancelled = true;
      console.log("Translation cancelled by user.");
    }

    // Helper: Split large text into chunks (by paragraph, fallback to hard split)
    splitLargeText(text, charLimit) {
      const paragraphs = text.split(/\n{2,}/); // Split by double newlines
      const chunks = [];
      let current = "";
      for (const para of paragraphs) {
        if ((current + para).length > charLimit) {
          if (current) chunks.push(current);
          current = para;
        } else {
          current += (current ? "\n\n" : "") + para;
        }
      }
      if (current) chunks.push(current);
      // Fallback: If any chunk is still too large, hard split
      return chunks.flatMap((chunk) =>
        chunk.length > charLimit
          ? chunk.match(new RegExp(`.{1,${charLimit}}`, "g"))
          : [chunk]
      );
    }

    // Helper: Create batches of fields not exceeding charLimit
    createBatches(fields, charLimit = 3000) {
      const batches = [];
      let currentBatch = [];
      let currentCount = 0;
      for (const field of fields) {
        const text = this.getFieldText(field) || "";
        // If a single field is too large, split it
        if (text.length > charLimit) {
          const chunks = this.splitLargeText(text, charLimit);
          for (const chunk of chunks) {
            batches.push([{ element: field, text: chunk }]);
          }
          continue;
        }
        // If adding this field would exceed the limit, start a new batch
        if (currentCount + text.length > charLimit && currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = [];
          currentCount = 0;
        }
        currentBatch.push({ element: field, text });
        currentCount += text.length;
      }
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }
      return batches;
    }

    async handleTranslateRequest(settings, forceFullDocument = false) {
      // Always ensure options exists and has preserveFormatting
      if (!settings.options) {
        settings.options = { preserveFormatting: true };
      } else if (typeof settings.options.preserveFormatting === "undefined") {
        settings.options.preserveFormatting = true;
      }
      // Always initialize translationService
      this.translationService = new TranslationService(settings);
      this.translationContext = settings.context || "";
      // Only translate selection if NOT forced (i.e., context menu)
      if (!forceFullDocument) {
        if (window.__prismicTranslatorSelectionInProgress) return;
        window.__prismicTranslatorSelectionInProgress = true;
        const selection = window.getSelection();
        let originalRange = null;
        if (
          selection &&
          selection.rangeCount &&
          selection.toString().trim().length > 0
        ) {
          originalRange = selection.getRangeAt(0).cloneRange();
          const anchorNode = selection.anchorNode;
          // Check if selection is inside a textarea or input
          const textarea =
            anchorNode && anchorNode.nodeType === 3
              ? anchorNode.parentElement.closest('textarea, input[type="text"]')
              : null;

          if (textarea) {
            // Handle textarea/input selection
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const originalText = textarea.value.substring(start, end);
            try {
              const translatedText = await this.translationService.translate(
                originalText,
                settings.sourceLanguage,
                settings.targetLanguage,
                this.translationContext
              );
              textarea.setRangeText(translatedText, start, end, "end");
              textarea.dispatchEvent(new Event("input", { bubbles: true }));
              textarea.dispatchEvent(new Event("change", { bubbles: true }));
              window.__prismicTranslatorSelectionInProgress = false;
              return {
                success: true,
                fieldsTranslated: 1,
                totalFields: 1,
                errors: [],
              };
            } catch (error) {
              window.__prismicTranslatorSelectionInProgress = false;
              return { success: false, error: error.message };
            }
          } else {
            // Get the selected HTML
            const container = document.createElement("div");
            for (let i = 0; i < selection.rangeCount; i++) {
              container.appendChild(selection.getRangeAt(i).cloneContents());
            }
            const selectedHtml = container.innerHTML;
            try {
              const translatedHtml = await this.translationService.translate(
                selectedHtml,
                settings.sourceLanguage,
                settings.targetLanguage,
                this.translationContext
              );
              // Helper to check if range is still in the document
              function isRangeInDocument(range) {
                let container = range.commonAncestorContainer;
                while (container) {
                  if (container === document.body) return true;
                  container = container.parentNode;
                }
                return false;
              }
              // Restore the original selection and replace content if valid
              if (originalRange && isRangeInDocument(originalRange)) {
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(originalRange);
                originalRange.deleteContents();
                // Ensure i18n prefixes are updated in the translated HTML
                const fixedHtml = this.replaceAllI18nPrefixes(translatedHtml);
                const fragment =
                  originalRange.createContextualFragment(fixedHtml);
                originalRange.insertNode(fragment);
                // Clean up empty blocks in the parent container
                this.cleanupEmptyBlocks(
                  (originalRange.commonAncestorContainer.nodeType === 1
                    ? originalRange.commonAncestorContainer
                    : originalRange.commonAncestorContainer.parentElement) ||
                    document.body
                );
              }
              window.__prismicTranslatorSelectionInProgress = false;
              return {
                success: true,
                fieldsTranslated: 1,
                totalFields: 1,
                errors: [],
              };
            } catch (error) {
              window.__prismicTranslatorSelectionInProgress = false;
              return { success: false, error: error.message };
            }
          }
        }
        window.__prismicTranslatorSelectionInProgress = false;
      }
      try {
        console.log("Starting translation with settings:", settings);

        this.translationCancelled = false;

        // Gradually scroll down the page to trigger lazy loading
        let scrollStep = window.innerHeight / 4; // Scroll by a quarter of the viewport at a time (slower)
        let currentY = 0;
        let maxScroll = document.body.scrollHeight;
        let attempts = 0;
        while (currentY < maxScroll && attempts < 30) {
          window.scrollTo(0, currentY);
          await new Promise((resolve) => setTimeout(resolve, 600)); // Wait 600ms between scrolls (slower)
          currentY += scrollStep;
          maxScroll = document.body.scrollHeight; // Update in case page grows
          attempts++;
        }
        // Final scroll to bottom and wait
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Log the number of alt text fields found by placeholder
        const altTextFields = document.querySelectorAll(
          'input[placeholder*="Short description"]'
        );
        console.log(
          `[Prismic Translator] Alt text fields found by placeholder: ${altTextFields.length}`,
          altTextFields
        );

        const fields = this.findTranslatableFields({
          skipRichtextWithImageNodeView: forceFullDocument,
        });
        console.log("Translatable fields found:", fields.length, fields);

        if (fields.length === 0) {
          return {
            success: false,
            error: "No translatable fields found on this page",
          };
        }

        console.log(`Found ${fields.length} translatable fields`);

        let translatedCount = 0;
        const errors = [];

        for (let i = 0; i < fields.length; i++) {
          if (this.translationCancelled) {
            console.log("Translation stopped at field", i + 1);
            break;
          }
          const field = fields[i];

          try {
            const originalText = this.getFieldText(field);

            if (!originalText || originalText.trim().length === 0) {
              // Still update progress for skipped fields
              const percent = Math.round(((i + 1) / fields.length) * 100);
              chrome.runtime.sendMessage({
                action: "translationProgress",
                percent,
              });
              chrome.runtime.sendMessage({
                action: "translationStatus",
                text: `Translating ${i + 1}/${fields.length} elements...`,
              });
              continue;
            }

            console.log(
              `Translating field ${i + 1}/${fields.length}:`,
              originalText.substring(0, 50) + "..."
            );

            const translatedText = await this.translationService.translate(
              originalText,
              settings.sourceLanguage,
              settings.targetLanguage,
              this.translationContext
            );

            if (translatedText && translatedText !== originalText) {
              this.setFieldText(
                field,
                translatedText,
                settings.options.preserveFormatting
              );
              translatedCount++;

              // Add visual feedback
              this.highlightField(field, "success");
            } else {
              // Even if not translated, still update i18n prefix if needed
              this.setFieldText(
                field,
                originalText,
                settings.options.preserveFormatting
              );
            }

            // Small delay to avoid overwhelming the API
            await this.delay(100);
          } catch (error) {
            console.error(`Error translating field ${i + 1}:`, error);
            errors.push(`Field ${i + 1}: ${error.message}`);
            this.highlightField(field, "error");
          }
          // Send progress update after each field
          const percent = Math.round(((i + 1) / fields.length) * 100);
          chrome.runtime.sendMessage({
            action: "translationProgress",
            percent,
          });
          chrome.runtime.sendMessage({
            action: "translationStatus",
            text: `Translating ${i + 1}/${fields.length} elements...`,
          });
        }

        const result = {
          success: true,
          fieldsTranslated: translatedCount,
          totalFields: fields.length,
          errors: errors,
        };

        if (errors.length > 0) {
          result.warning = `${errors.length} fields failed to translate`;
        }

        // Save last used settings for context menu reuse
        window.prismicTranslatorLastSettings = settings;

        return result;
      } catch (error) {
        console.error("Translation request failed:", error);
        return { success: false, error: error.message };
      }
    }

    async handlePreviewRequest(settings) {
      try {
        const fields = this.findTranslatableFields();

        if (fields.length === 0) {
          return {
            success: false,
            error: "No translatable fields found on this page",
          };
        }

        // Add preview styling to show which fields will be translated
        fields.forEach((field) => {
          this.highlightField(field, "preview");
        });

        // Remove preview styling after 5 seconds
        setTimeout(() => {
          fields.forEach((field) => {
            this.removeHighlight(field);
          });
        }, 5000);

        return {
          success: true,
          fieldsFound: fields.length,
          message: "Fields highlighted for 5 seconds",
        };
      } catch (error) {
        console.error("Preview request failed:", error);
        return { success: false, error: error.message };
      }
    }

    findTranslatableFields({ skipRichtextWithImageNodeView } = {}) {
      let fields = [];
      // Select all matching fields, including those in groups and all alt text fields
      const selectors = [
        'input[id*="."], textarea[id*="."], div[contenteditable="true"][id*="."]',
        'input[id*="["], textarea[id*="["], div[contenteditable="true"][id*="["]',
        'input[placeholder*="Short description for the visually impaired"]', // Explicitly include alt text fields
      ];
      selectors.forEach((sel) => {
        fields = fields.concat(Array.from(document.querySelectorAll(sel)));
      });

      // Explicitly find all fields in ALL repeating group items
      document.querySelectorAll('ul[aria-label="Group"] > li').forEach((li) => {
        // Find all inputs, textareas, and contenteditables in this group item
        li.querySelectorAll(
          'input, textarea, div[contenteditable="true"]'
        ).forEach((el) => {
          fields.push(el);
        });
        // Also find all image alt text fields in this group item
        li.querySelectorAll('input[type="text"]').forEach((input) => {
          const id = input.getAttribute("id") || "";
          let label = "";
          if (id) {
            const labelEl = li.querySelector(`label[for="${id}"]`);
            if (labelEl) label = labelEl.textContent.toLowerCase();
          }
          const placeholder = (
            input.getAttribute("placeholder") || ""
          ).toLowerCase();
          if (
            label.includes("alt text") ||
            placeholder.includes("visually impaired")
          ) {
            fields.push(input);
          }
        });
      });

      // Add all image alt text fields outside of groups
      document.querySelectorAll('input[type="text"]').forEach((input) => {
        const id = input.getAttribute("id") || "";
        let label = "";
        if (id) {
          const labelEl = document.querySelector(`label[for="${id}"]`);
          if (labelEl) label = labelEl.textContent.toLowerCase();
        }
        const placeholder = (
          input.getAttribute("placeholder") || ""
        ).toLowerCase();
        if (
          label.includes("alt text") ||
          placeholder.includes("visually impaired")
        ) {
          fields.push(input);
        }
      });

      // Remove duplicates
      fields = Array.from(new Set(fields));

      // Log and filter fields using shouldSkipField
      fields.forEach((el) => {
        const id = el.getAttribute("id") || "";
        const label = this.getFieldLabel(el) || "";
        const value = this.getFieldText(el) || "";
        const skipped = this.shouldSkipField(el);
        console.log(`[Prismic Translator] Field:`, {
          id,
          label,
          value,
          skipped,
        });
      });
      fields = fields.filter((el) => {
        if (this.shouldSkipField(el)) return false;
        if (
          skipRichtextWithImageNodeView &&
          this.getFieldType(el) === "richtext" &&
          el.querySelector &&
          (el.querySelector(".imageViewNodeWrapper") ||
            el.querySelector(".react-renderer.node-embed"))
        ) {
          console.log(
            "[Prismic Translator] Skipping richtext field with imageViewNodeWrapper or react-renderer node-embed",
            el
          );
          return false;
        }
        return true;
      });
      return fields;
    }

    isTranslatableField(element, options) {
      // Skip if element is not visible
      if (!this.isElementVisible(element)) {
        return false;
      }

      // Skip if element is disabled or readonly
      if (element.disabled || element.readOnly) {
        return false;
      }

      // Skip fields that shouldn't be translated
      if (this.shouldSkipField(element)) {
        return false;
      }

      // Check field type options
      const fieldType = this.getFieldType(element);

      switch (fieldType) {
        case "richtext":
          return options.translateRichText;
        case "title":
          return options.translateTitles;
        case "alttext":
          return options.translateAltText;
        case "tag":
          return false; // Don't translate tags by default
        case "text":
          return true;
        default:
          return true;
      }
    }

    shouldSkipField(element) {
      const id = (element.getAttribute("id") || "").toLowerCase();
      const name = (element.getAttribute("name") || "").toLowerCase();
      const ariaLabel = (
        element.getAttribute("aria-label") || ""
      ).toLowerCase();
      const dataLabel = (
        element.getAttribute("data-label") || ""
      ).toLowerCase();
      const placeholder = (
        element.getAttribute("placeholder") || ""
      ).toLowerCase();
      const label = this.getFieldLabel(element).toLowerCase();
      const value = this.getFieldText(element);
      const isGroupField = id.includes("[") && id.includes("]");
      // Try to find the associated label text
      let labelText = "";
      if (element.id) {
        const labelEl = document.querySelector(`label[for="${element.id}"]`);
        if (labelEl) labelText = labelEl.innerText.toLowerCase();
      }
      // Always allow alt text fields
      if (
        placeholder.includes("alt text") ||
        placeholder.includes("short description for the visually impaired") ||
        label.includes("alt text")
      ) {
        return false;
      }
      // Skip technical/ID fields
      const forbiddenKeywords = [
        "uid",
        "youtube",
        "video id",
        "slug",
        "guid",
        "vimeo",
        "wistia",
      ];
      if (
        forbiddenKeywords.some(
          (keyword) =>
            id.includes(keyword) ||
            name.includes(keyword) ||
            ariaLabel.includes(keyword) ||
            dataLabel.includes(keyword) ||
            label.includes(keyword) ||
            labelText.includes(keyword)
        )
      ) {
        console.log(
          `[Prismic Translator] Skipping field due to forbidden keyword:`,
          { id, name, ariaLabel, dataLabel, label, labelText, value }
        );
        return true;
      }
      // Skip email fields
      if (
        element.type === "email" ||
        placeholder.toLowerCase().includes("email") ||
        label.includes("email")
      ) {
        return true;
      }

      // Skip numeric fields
      if (element.type === "number" || element.inputMode === "numeric") {
        return true;
      }

      // Skip very short content that's likely not translatable
      if (value.length > 0 && value.length < 3 && !isGroupField) {
        return true;
      }

      // Skip content that looks like code or IDs
      if (
        value.match(/^[a-zA-Z0-9_-]+$/) &&
        value.length < 20 &&
        !isGroupField
      ) {
        return true;
      }

      // Skip fields where the label is exactly 'name'
      if (
        label.trim() === "name" ||
        labelText.trim() === "name" ||
        placeholder.trim() === "name"
      ) {
        return true;
      }

      return false;
    }

    getFieldType(element) {
      const testId = element.getAttribute("data-testid") || "";
      const placeholder = (
        element.getAttribute("placeholder") || ""
      ).toLowerCase();
      const fieldType = element.getAttribute("data-field-type") || "";
      const id = element.getAttribute("id") || "";
      const label = this.getFieldLabel(element).toLowerCase();

      // Check for rich text fields (TipTap/ProseMirror)
      if (
        element.classList.contains("tiptap") ||
        element.classList.contains("ProseMirror") ||
        testId.includes("rich-text") ||
        fieldType === "StructuredText" ||
        (element.contentEditable === "true" && element.tagName === "DIV")
      ) {
        return "richtext";
      }

      // Check for title fields
      if (
        testId.includes("title") ||
        fieldType === "Title" ||
        id.includes("title") ||
        label.includes("title")
      ) {
        return "title";
      }

      // Check for alt text fields
      if (
        placeholder.includes("alt text") ||
        placeholder.includes("alt-text") ||
        placeholder.includes("short description for the visually impaired") ||
        label.includes("alt text")
      ) {
        return "alttext";
      }

      // Check for tag fields
      if (
        placeholder.toLowerCase().includes("tag") ||
        id.includes("tag") ||
        label.toLowerCase().includes("tag")
      ) {
        return "tag";
      }

      return "text";
    }

    getFieldLabel(element) {
      // Try to find the associated label for better field type detection
      const id = element.getAttribute("id");
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) {
          return label.textContent || "";
        }
      }

      // Look for nearby label elements
      const parent = element.closest("._root_1yilc_1") || element.parentElement;
      if (parent) {
        const label = parent.querySelector("label");
        if (label) {
          return label.textContent || "";
        }
      }

      return "";
    }

    isElementVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    }

    getFieldText(element) {
      if (element.contentEditable === "true") {
        // For rich text fields, get the HTML
        return element.innerHTML;
      }
      return element.value || "";
    }

    setFieldText(element, text, preserveFormatting = true) {
      // Always update i18n URL prefixes for any content
      text = this.replaceAllI18nPrefixes(text);
      if (element.contentEditable === "true") {
        // For rich text, preserve inline images and only translate their alt text
        const { htmlWithPlaceholders, images } =
          this.extractImagesAndReplaceWithPlaceholders(element.innerHTML);
        // If there are images, handle alt text translation separately
        if (images.length > 0) {
          // Translate alt text for each image
          const altPromises = images.map((img) => {
            // Only translate if alt text is non-empty
            if (img.alt && img.alt.trim().length > 0) {
              return this.translationService.translate(
                img.alt,
                this.translationService.settings.sourceLanguage,
                this.translationService.settings.targetLanguage
              );
            } else {
              return Promise.resolve("");
            }
          });
          Promise.all(altPromises).then((translatedAlts) => {
            // Restore images with translated alt text
            const finalHTML = this.restoreImagesWithTranslatedAlt(
              text,
              images,
              translatedAlts
            );
            element.innerHTML = finalHTML;
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
          });
        } else {
          // No images, just set the translated HTML
          element.innerHTML = text;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else if (element.value !== undefined) {
        // Always update i18n prefix for any text field
        let newValue = this.replaceAllI18nPrefixes(text);
        element.value = newValue;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    // Helper: Extract images and replace with placeholders
    extractImagesAndReplaceWithPlaceholders(html) {
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = html;
      const images = [];
      let imageIndex = 0;
      tempDiv.querySelectorAll("img").forEach((img) => {
        const placeholder = `[[IMAGE_${imageIndex}]]`;
        images.push({
          html: img.outerHTML,
          alt: img.alt,
          index: imageIndex,
        });
        // Replace img with placeholder
        const span = document.createElement("span");
        span.textContent = placeholder;
        img.replaceWith(span);
        imageIndex++;
      });
      return {
        htmlWithPlaceholders: tempDiv.innerHTML,
        images,
      };
    }

    // Helper: Restore images with translated alt text
    restoreImagesWithTranslatedAlt(html, images, translatedAlts) {
      let result = html;
      images.forEach((img, i) => {
        // Replace alt text in the original image HTML
        const parser = new DOMParser();
        const doc = parser.parseFromString(img.html, "text/html");
        const imgTag = doc.querySelector("img");
        if (imgTag) imgTag.alt = translatedAlts[i];
        const newImgHtml = imgTag ? imgTag.outerHTML : img.html;
        result = result.replace(`[[IMAGE_${img.index}]]`, newImgHtml);
      });
      return result;
    }

    replaceAllI18nPrefixes(text) {
      // Replace all /xx-xx/ or /xx-xxx/ with the correct code for the target language
      let targetLang =
        (this.translationService &&
          this.translationService.settings &&
          this.translationService.settings.targetLanguage) ||
        "en";
      // Defensive: treat zh-hant and zh-hk as hk
      if (targetLang === "zh-hant" || targetLang === "zh-hk") {
        targetLang = "hk";
      }
      let code = this.languageCodeMap[targetLang] || targetLang;
      // Only allow valid xx-xx or xx-xxx codes
      if (!/^[a-z]{2}-[a-z]{2,3}$/i.test(code)) {
        code = "en-us";
      }
      // Replace all occurrences of /xx-xx/ or /xx-xxx/ in the text
      return text.replace(/\/[a-z]{2}-[a-z]{2,3}\//gi, `/${code}/`);
    }

    setRichTextWithFormatting(element, translatedText) {
      // For TipTap/ProseMirror editors, try to maintain structure
      // Handle <ul>/<ol> lists and <li> items
      const lists = element.querySelectorAll("ul,ol");
      if (lists.length > 0) {
        // Split translatedText by lines or sentences for <li>
        lists.forEach((list) => {
          const items = list.querySelectorAll("li");
          const translatedItems = this.splitIntoListItems(
            translatedText,
            items.length
          );
          items.forEach((li, idx) => {
            if (translatedItems[idx]) {
              this.replaceTextNodesPreserveTags(li, translatedItems[idx]);
            }
          });
        });
        return;
      }
      // Handle paragraphs
      const paragraphs = element.querySelectorAll("p");
      if (paragraphs.length === 1) {
        this.replaceTextNodesPreserveTags(paragraphs[0], translatedText);
      } else if (paragraphs.length > 1) {
        const sentences = this.splitIntoSentences(translatedText);
        paragraphs.forEach((p, index) => {
          if (sentences[index]) {
            this.replaceTextNodesPreserveTags(p, sentences[index]);
          }
        });
      } else {
        // No paragraphs found, just replace content
        this.replaceTextNodesPreserveTags(element, translatedText);
      }
    }

    replaceTextNodesPreserveTags(element, newText) {
      // Recursively replace only text nodes, preserving all HTML tags
      const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );
      let node;
      let textLeft = newText;
      while ((node = walker.nextNode()) && textLeft.length > 0) {
        // Find the next chunk of text to insert (split by the length of the original node)
        const chunk = textLeft.slice(0, node.textContent.length);
        node.textContent = chunk;
        textLeft = textLeft.slice(chunk.length);
      }
      // If there's leftover text, append it as a new text node
      if (textLeft.length > 0) {
        element.appendChild(document.createTextNode(textLeft));
      }
    }

    splitIntoListItems(text, count) {
      // Try to split by <li> or newlines, fallback to sentences
      let items = text
        .split(/<li>|\n|•|\r/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (items.length < count) {
        items = this.splitIntoSentences(text);
      }
      // Pad or trim to match count
      while (items.length < count) items.push("");
      return items.slice(0, count);
    }

    splitIntoSentences(text) {
      // Simple sentence splitting for distributing across paragraphs
      return text
        .split(/[.!?]+/)
        .filter((s) => s.trim().length > 0)
        .map((s) => s.trim() + ".");
    }

    highlightField(element, type) {
      element.classList.add(`prismic-translator-${type}`);

      // Add CSS if not already added
      if (!document.getElementById("prismic-translator-styles")) {
        const style = document.createElement("style");
        style.id = "prismic-translator-styles";
        style.textContent = `
        .prismic-translator-success {
          box-shadow: 0 0 0 2px #28a745 !important;
          transition: box-shadow 0.3s ease !important;
        }
        .prismic-translator-error {
          box-shadow: 0 0 0 2px #dc3545 !important;
          transition: box-shadow 0.3s ease !important;
        }
        .prismic-translator-preview {
          box-shadow: 0 0 0 2px #007bff !important;
          transition: box-shadow 0.3s ease !important;
        }
      `;
        document.head.appendChild(style);
      }
    }

    removeHighlight(element) {
      element.classList.remove(
        "prismic-translator-success",
        "prismic-translator-error",
        "prismic-translator-preview"
      );
    }

    escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    }

    delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    updateLinksToTargetLanguage(text) {
      // Replace /en-us/ or similar with the correct code for the target language
      const targetLang =
        (this.translationService &&
          this.translationService.settings &&
          this.translationService.settings.targetLanguage) ||
        "en";
      const code = this.languageCodeMap[targetLang] || targetLang;
      return text.replace(
        /\/(en-us|es-es|fr-fr|de-de|it-it|pt-pt|ru-ru|ja-jp|ko-kr|zh-cn|zh-hk)\//gi,
        `/${code}/`
      );
    }

    preserveBasicFormatting(element, translatedText) {
      // Simple approach: replace text content while keeping HTML structure
      const originalHTML = element.innerHTML;
      const originalText = element.textContent;

      if (originalText.trim() === "") {
        element.textContent = translatedText;
        return;
      }

      // Try to replace text while preserving HTML tags
      try {
        const newHTML = originalHTML.replace(originalText, translatedText);
        element.innerHTML = newHTML;
      } catch (error) {
        // Fallback to simple text replacement
        element.textContent = translatedText;
      }
    }

    // Helper: Remove empty headings, paragraphs, list items, and orphan trailing breaks
    cleanupEmptyBlocks(root) {
      if (!root || !root.querySelectorAll) return;
      // Remove empty headings, paragraphs, list items
      root.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li").forEach((el) => {
        if (
          !el.textContent.trim() &&
          (!el.querySelector("*") ||
            el.innerHTML.trim() === "" ||
            el.innerHTML.trim() === "<br>" ||
            el.classList.contains("is-empty"))
        ) {
          el.remove();
        }
      });
      // Remove empty ol/ul
      root.querySelectorAll("ol, ul").forEach((list) => {
        const items = Array.from(list.querySelectorAll("li"));
        if (
          items.length === 0 ||
          items.every(
            (li) =>
              !li.textContent.trim() &&
              (!li.querySelector("*") ||
                li.innerHTML.trim() === "" ||
                li.classList.contains("is-empty"))
          )
        ) {
          list.remove();
        }
      });
      // Remove trailing breaks if they are the only child
      root.querySelectorAll("br.ProseMirror-trailingBreak").forEach((br) => {
        if (br.parentElement && br.parentElement.childNodes.length === 1) {
          br.remove();
        }
      });
    }
  }

  class TranslationService {
    constructor(settings) {
      this.settings = settings;
      this.apiKey = settings.apiKey;
      this.service = settings.translationService;
    }

    async translate(text, sourceLanguage, targetLanguage, context) {
      switch (this.service) {
        case "openai":
          return await this.translateWithOpenAI(
            text,
            sourceLanguage,
            targetLanguage,
            context
          );
        case "deepl":
          return await this.translateWithDeepL(
            text,
            sourceLanguage,
            targetLanguage,
            context
          );
        case "azure":
          return await this.translateWithAzure(
            text,
            sourceLanguage,
            targetLanguage,
            context
          );
        case "deepseek":
          return await this.translateWithDeepSeek(
            text,
            sourceLanguage,
            targetLanguage,
            context
          );
        default:
          throw new Error("Unsupported translation service");
      }
    }

    async translateWithOpenAI(text, sourceLanguage, targetLanguage, context) {
      if (!this.apiKey) {
        throw new Error("OpenAI API key is required");
      }
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            action: "openaiTranslate",
            text: text,
            sourceLanguage: sourceLanguage,
            targetLanguage: targetLanguage,
            apiKey: this.apiKey,
            context: context,
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(
                new Error(
                  "OpenAI translation failed: " +
                    chrome.runtime.lastError.message
                )
              );
            } else if (response && response.success) {
              resolve(response.text);
            } else {
              reject(
                new Error(
                  response && response.error
                    ? response.error
                    : "Unknown OpenAI error"
                )
              );
            }
          }
        );
      });
    }

    async translateWithDeepL(text, sourceLanguage, targetLanguage, context) {
      if (!this.apiKey) {
        throw new Error("DeepL API key is required");
      }
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            action: "deeplTranslate",
            text: text,
            sourceLanguage: sourceLanguage,
            targetLanguage: targetLanguage,
            apiKey: this.apiKey,
            context: context,
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(
                new Error(
                  "DeepL translation failed: " +
                    chrome.runtime.lastError.message
                )
              );
            } else if (response && response.success) {
              resolve(response.text);
            } else {
              reject(
                new Error(
                  response && response.error
                    ? response.error
                    : "Unknown DeepL error"
                )
              );
            }
          }
        );
      });
    }

    async translateWithAzure(text, sourceLanguage, targetLanguage, context) {
      if (!this.apiKey) {
        throw new Error("Azure Translator API key is required");
      }

      try {
        const response = await fetch(
          `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${sourceLanguage}&to=${targetLanguage}`,
          {
            method: "POST",
            headers: {
              "Ocp-Apim-Subscription-Key": this.apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify([{ text: text }]),
          }
        );

        if (!response.ok) {
          throw new Error(`Azure Translator error: ${response.status}`);
        }

        const data = await response.json();

        if (
          data &&
          data[0] &&
          data[0].translations &&
          data[0].translations[0]
        ) {
          return data[0].translations[0].text;
        }

        throw new Error("Invalid response from Azure Translator");
      } catch (error) {
        console.error("Azure Translator error:", error);
        throw new Error("Azure Translator failed: " + error.message);
      }
    }

    async translateWithDeepSeek(text, sourceLanguage, targetLanguage, context) {
      if (!this.apiKey) {
        throw new Error("DeepSeek API key is required");
      }
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            action: "deepseekTranslate",
            text: text,
            sourceLanguage: sourceLanguage,
            targetLanguage: targetLanguage,
            apiKey: this.apiKey,
            context: context,
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(
                new Error(
                  "DeepSeek translation failed: " +
                    chrome.runtime.lastError.message
                )
              );
            } else if (response && response.success) {
              resolve(response.text);
            } else {
              reject(
                new Error(
                  response && response.error
                    ? response.error
                    : "Unknown DeepSeek error"
                )
              );
            }
          }
        );
      });
    }
  }

  // Initialize the translator when the page loads
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      new PrismicTranslator();
    });
  } else {
    new PrismicTranslator();
  }
})();

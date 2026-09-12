import { t } from "../i18n";
import { api } from "../api";
import { router } from "../router";
import { getSavedUploadToken, saveUploadToken } from "../state";
import type { GalleryImageDto } from "../../shared/gallery-contracts";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function convertImageToWebp(
  file: File | Blob,
  quality = 0.85
): Promise<{ blob: Blob; filename: string }> {
  // Animated GIF is kept in its original format
  if (file.type === "image/gif") {
    return { blob: file, filename: file instanceof File ? file.name : "image" };
  }

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve({ blob: file, filename: file instanceof File ? file.name : "image" });
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(
        (blob) => {
          if (blob && blob.size < file.size) {
            const origName = file instanceof File ? file.name : "image";
            const baseName = origName.replace(/\.[^/.]+$/, "");
            resolve({ blob, filename: `${baseName}.webp` });
          } else {
            resolve({ blob: file, filename: file instanceof File ? file.name : "image" });
          }
        },
        "image/webp",
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ blob: file, filename: file instanceof File ? file.name : "image" });
    };

    img.src = url;
  });
}

export function createGalleryPage(): HTMLElement & { dispose?: () => void } {
  const container = document.createElement("div");
  container.className = "gallery-container";

  document.title = `${t("gallery.nav")} - ${t("app.name")}`;

  // 1. Header
  const header = document.createElement("div");
  header.className = "gallery-header";

  const headerInfo = document.createElement("div");
  headerInfo.className = "gallery-header-info";

  const title = document.createElement("h1");
  title.className = "gallery-title";
  title.textContent = t("gallery.title");

  const desc = document.createElement("p");
  desc.className = "gallery-desc";
  desc.textContent = t("gallery.subtitle");

  headerInfo.appendChild(title);
  headerInfo.appendChild(desc);

  const configBtn = document.createElement("button");
  configBtn.type = "button";
  configBtn.className = "gallery-config-btn";
  configBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </svg>
    <span>PicGo / Typora</span>
  `;
  configBtn.addEventListener("click", () => showPicGoModal());

  header.appendChild(headerInfo);
  header.appendChild(configBtn);
  container.appendChild(header);

  // 2. Controls (WebP compression toggle + Quality slider)
  const controls = document.createElement("div");
  controls.className = "gallery-controls";

  const webpGroup = document.createElement("label");
  webpGroup.className = "gallery-checkbox-label";
  const webpCheckbox = document.createElement("input");
  webpCheckbox.type = "checkbox";
  webpCheckbox.checked = true;
  const webpLabelText = document.createElement("span");
  webpLabelText.textContent = t("gallery.compressWebpLabel");
  webpGroup.appendChild(webpCheckbox);
  webpGroup.appendChild(webpLabelText);

  const qualityGroup = document.createElement("div");
  qualityGroup.className = "gallery-quality-group";
  const qualityLabel = document.createElement("span");
  qualityLabel.textContent = t("gallery.compressQualityLabel");
  const qualitySlider = document.createElement("input");
  qualitySlider.type = "range";
  qualitySlider.className = "gallery-quality-slider";
  qualitySlider.min = "50";
  qualitySlider.max = "100";
  qualitySlider.value = "85";
  const qualityVal = document.createElement("span");
  qualityVal.className = "gallery-quality-val";
  qualityVal.textContent = "85%";

  qualitySlider.addEventListener("input", () => {
    qualityVal.textContent = `${qualitySlider.value}%`;
  });

  qualityGroup.appendChild(qualityLabel);
  qualityGroup.appendChild(qualitySlider);
  qualityGroup.appendChild(qualityVal);

  controls.appendChild(webpGroup);
  controls.appendChild(qualityGroup);
  container.appendChild(controls);

  // 3. Dropzone
  const dropzone = document.createElement("div");
  dropzone.className = "gallery-dropzone";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.className = "gallery-file-input";
  fileInput.accept = "image/*";

  dropzone.innerHTML = `
    <svg class="gallery-dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <circle cx="8.5" cy="8.5" r="1.5"></circle>
      <polyline points="21 15 16 10 5 21"></polyline>
    </svg>
    <div class="gallery-dropzone-hint">${t("gallery.dropzoneHint")}</div>
    <div class="gallery-dropzone-subhint">${t("gallery.dropzoneSubhint")}</div>
  `;
  dropzone.appendChild(fileInput);

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) {
      handleImageUpload(fileInput.files[0]);
      fileInput.value = "";
    }
  });

  // Drag & drop handlers
  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("is-dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("is-dragging");
    });
  });

  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith("image/")) {
        handleImageUpload(file);
      }
    }
  });

  container.appendChild(dropzone);

  // 4. Progress / Result Area
  const actionArea = document.createElement("div");
  actionArea.className = "gallery-action-area";
  container.appendChild(actionArea);

  // 5. History section
  const historySection = document.createElement("div");
  historySection.className = "gallery-history";

  const historyHeader = document.createElement("div");
  historyHeader.className = "gallery-history-header";

  const historyTitle = document.createElement("h2");
  historyTitle.className = "gallery-history-title";
  historyTitle.textContent = t("gallery.historyTitle");

  const countBadge = document.createElement("span");
  countBadge.className = "gallery-badge";
  countBadge.textContent = "0";
  historyTitle.appendChild(countBadge);

  historyHeader.appendChild(historyTitle);
  historySection.appendChild(historyHeader);

  const grid = document.createElement("div");
  grid.className = "gallery-grid";
  historySection.appendChild(grid);

  container.appendChild(historySection);

  // Global Paste (Ctrl+V) handler
  const onPaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          handleImageUpload(file);
          break;
        }
      }
    }
  };

  window.addEventListener("paste", onPaste);

  // Function to upload
  async function handleImageUpload(rawFile: File | Blob) {
    actionArea.replaceChildren();

    const progressBox = document.createElement("div");
    progressBox.className = "gallery-uploading";
    progressBox.innerHTML = `
      <div class="gallery-uploading-text">${t("gallery.uploading")}</div>
      <div class="gallery-progress-track">
        <div class="gallery-progress-bar" style="width: 50%"></div>
      </div>
    `;
    actionArea.appendChild(progressBox);

    try {
      let uploadFile = rawFile;
      let targetName = rawFile instanceof File ? rawFile.name : "pasted_image.png";

      if (webpCheckbox.checked) {
        const quality = Number.parseInt(qualitySlider.value, 10) / 100;
        const converted = await convertImageToWebp(rawFile, quality);
        uploadFile = converted.blob;
        targetName = converted.filename;
      }

      const res = await api.uploadGalleryImage(uploadFile, targetName);
      renderResultCard(res, rawFile.size, uploadFile.size);
      loadHistory();
    } catch (err: any) {
      actionArea.replaceChildren();
      const errBox = document.createElement("div");
      errBox.className = "gallery-uploading";
      errBox.style.borderColor = "var(--danger)";
      const errMsg = document.createElement("span");
      errMsg.style.color = "var(--danger)";
      errMsg.style.fontWeight = "500";
      errMsg.textContent = err.message || t("errors.GALLERY_UPLOAD_FAILED");
      errBox.appendChild(errMsg);
      actionArea.appendChild(errBox);
    }
  }

  // Render Result Card with multi-format copy
  function renderResultCard(image: GalleryImageDto, originalBytes: number, uploadedBytes: number) {
    actionArea.replaceChildren();

    const card = document.createElement("div");
    card.className = "gallery-result-card";

    // Preview
    const preview = document.createElement("div");
    preview.className = "gallery-result-preview";

    const thumb = document.createElement("img");
    thumb.className = "gallery-result-thumb";
    thumb.src = image.url;
    thumb.alt = image.filename;

    const info = document.createElement("div");
    info.className = "gallery-result-info";
    const savedPct = originalBytes > uploadedBytes ? Math.round((1 - uploadedBytes / originalBytes) * 100) : 0;
    info.textContent = `${formatBytes(image.sizeBytes)}${savedPct > 0 ? ` (-${savedPct}%)` : ""}`;

    preview.appendChild(thumb);
    preview.appendChild(info);

    // Formats
    const formats = document.createElement("div");
    formats.className = "gallery-result-formats";

    const formatItems = [
      { label: t("gallery.copyUrl"), val: image.url },
      { label: t("gallery.copyMarkdown"), val: image.markdown },
      { label: t("gallery.copyHtml"), val: image.html },
      { label: t("gallery.copyBbcode"), val: image.bbcode }
    ];

    formatItems.forEach((fmt) => {
      const row = document.createElement("div");
      row.className = "gallery-format-row";

      const label = document.createElement("span");
      label.className = "gallery-format-label";
      label.textContent = fmt.label;

      const inputGroup = document.createElement("div");
      inputGroup.className = "gallery-format-input-group";

      const input = document.createElement("input");
      input.className = "gallery-format-input";
      input.type = "text";
      input.readOnly = true;
      input.value = fmt.val;
      input.addEventListener("click", () => input.select());

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "gallery-copy-btn";
      copyBtn.textContent = t("gallery.copy");

      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(fmt.val);
        copyBtn.textContent = t("gallery.copied");
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.textContent = t("gallery.copy");
          copyBtn.classList.remove("copied");
        }, 2000);
      });

      inputGroup.appendChild(input);
      inputGroup.appendChild(copyBtn);
      row.appendChild(label);
      row.appendChild(inputGroup);
      formats.appendChild(row);
    });

    card.appendChild(preview);
    card.appendChild(formats);
    actionArea.appendChild(card);
  }

  // Load History
  async function loadHistory() {
    try {
      const res = await api.listGalleryImages(60);
      countBadge.textContent = String(res.total);
      grid.replaceChildren();

      if (!res.items || res.items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "gallery-empty";
        empty.textContent = t("gallery.historyEmpty");
        grid.appendChild(empty);
        return;
      }

      res.items.forEach((item) => {
        const card = document.createElement("div");
        card.className = "gallery-card";

        const thumb = document.createElement("img");
        thumb.className = "gallery-card-thumb";
        thumb.src = item.url;
        thumb.alt = item.filename;
        thumb.loading = "lazy";

        const overlay = document.createElement("div");
        overlay.className = "gallery-card-overlay";

        const name = document.createElement("div");
        name.className = "gallery-card-name";
        name.textContent = item.filename;

        const actions = document.createElement("div");
        actions.className = "gallery-card-actions";

        const viewBtn = document.createElement("button");
        viewBtn.className = "gallery-card-btn";
        viewBtn.textContent = t("gallery.view");
        viewBtn.addEventListener("click", () => showLightbox(item));

        const copyMdBtn = document.createElement("button");
        copyMdBtn.className = "gallery-card-btn";
        copyMdBtn.textContent = "Markdown";
        copyMdBtn.addEventListener("click", async () => {
          await navigator.clipboard.writeText(item.markdown);
          copyMdBtn.textContent = t("gallery.copiedShort");
          setTimeout(() => (copyMdBtn.textContent = "Markdown"), 1500);
        });

        const copyUrlBtn = document.createElement("button");
        copyUrlBtn.className = "gallery-card-btn";
        copyUrlBtn.textContent = t("gallery.link");
        copyUrlBtn.addEventListener("click", async () => {
          await navigator.clipboard.writeText(item.url);
          copyUrlBtn.textContent = t("gallery.copiedShort");
          setTimeout(() => (copyUrlBtn.textContent = t("gallery.link")), 1500);
        });

        const delBtn = document.createElement("button");
        delBtn.className = "gallery-card-btn delete-btn";
        delBtn.textContent = t("gallery.delete");
        delBtn.addEventListener("click", async () => {
          if (confirm(t("gallery.deleteConfirm"))) {
            try {
              await api.deleteGalleryImage(item.id);
              card.remove();
              countBadge.textContent = String(Math.max(0, Number(countBadge.textContent) - 1));
            } catch (err: any) {
              alert(err.message || t("errors.GALLERY_DELETE_FAILED"));
            }
          }
        });

        actions.appendChild(viewBtn);
        actions.appendChild(copyMdBtn);
        actions.appendChild(copyUrlBtn);
        actions.appendChild(delBtn);

        overlay.appendChild(name);
        overlay.appendChild(actions);

        card.appendChild(thumb);
        card.appendChild(overlay);
        grid.appendChild(card);
      });
    } catch (err: any) {
      if (err.status === 401) {
        // Gallery history is restricted to administrators
        grid.replaceChildren();
        const notice = document.createElement("div");
        notice.className = "gallery-empty";
        notice.style.display = "flex";
        notice.style.flexDirection = "column";
        notice.style.alignItems = "center";
        notice.style.gap = "12px";

        const text = document.createElement("span");
        text.textContent = t("gallery.adminRestricted");

        const loginBtn = document.createElement("button");
        loginBtn.type = "button";
        loginBtn.className = "gallery-copy-btn";
        loginBtn.textContent = t("gallery.loginAdmin");
        loginBtn.addEventListener("click", () => router.navigate("/admin"));

        notice.appendChild(text);
        notice.appendChild(loginBtn);
        grid.appendChild(notice);
      }
    }
  }

  // Lightbox Modal
  function showLightbox(item: GalleryImageDto) {
    const backdrop = document.createElement("div");
    backdrop.className = "gallery-modal-backdrop";

    const content = document.createElement("div");
    content.className = "gallery-modal-content";
    content.style.maxWidth = "800px";

    const closeBtn = document.createElement("button");
    closeBtn.className = "gallery-modal-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => backdrop.remove());

    const title = document.createElement("h3");
    title.className = "gallery-modal-title";
    title.textContent = `${item.filename} (${formatBytes(item.sizeBytes)})`;

    const img = document.createElement("img");
    img.className = "gallery-lightbox-img";
    img.src = item.url;
    img.alt = item.filename;

    content.appendChild(closeBtn);
    content.appendChild(title);
    content.appendChild(img);
    backdrop.appendChild(content);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    document.body.appendChild(backdrop);
  }

  // PicGo Setup Guide Modal
  function showPicGoModal() {
    const origin = window.location.origin;
    const token = getSavedUploadToken() || "YOUR_UPLOAD_TOKEN";

    const backdrop = document.createElement("div");
    backdrop.className = "gallery-modal-backdrop";

    const content = document.createElement("div");
    content.className = "gallery-modal-content";

    const closeBtn = document.createElement("button");
    closeBtn.className = "gallery-modal-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => backdrop.remove());

    const title = document.createElement("h3");
    title.className = "gallery-modal-title";
    title.textContent = t("gallery.picgoGuideTitle");

    const intro = document.createElement("p");
    intro.style.fontSize = "0.9rem";
    intro.style.color = "var(--text-secondary)";
    intro.textContent = t("gallery.picgoGuideIntro");

    const pre = document.createElement("pre");
    pre.className = "gallery-modal-pre";
    pre.textContent = [
      `• ${t("gallery.picgoApiUrl")}: ${origin}/api/v1/gallery/upload`,
      `• ${t("gallery.picgoMethod")}`,
      `• ${t("gallery.picgoParamName")}`,
      `• ${t("gallery.picgoJsonPath")}`,
      `• ${t("gallery.picgoHeaders").replace("<您的上传口令>", token).replace("<your-upload-token>", token)}`
    ].join("\n");

    const copyBtn = document.createElement("button");
    copyBtn.className = "gallery-copy-btn";
    copyBtn.textContent = t("gallery.copy");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(pre.textContent || "");
      copyBtn.textContent = t("gallery.copiedShort");
      setTimeout(() => (copyBtn.textContent = t("gallery.copy")), 2000);
    });

    content.appendChild(closeBtn);
    content.appendChild(title);
    content.appendChild(intro);
    content.appendChild(pre);
    content.appendChild(copyBtn);
    backdrop.appendChild(content);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    document.body.appendChild(backdrop);
  }

  // Initial load
  loadHistory();

  const element = container as HTMLElement & { dispose?: () => void };
  element.dispose = () => {
    window.removeEventListener("paste", onPaste);
  };

  return element;
}

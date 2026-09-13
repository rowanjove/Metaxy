import { t, formatBytes } from "../i18n";
import { api } from "../api";
import { router } from "../router";
import { getSavedUploadToken } from "../state";
import type { GalleryImageDto, GalleryAlbumDto } from "../../shared/gallery-contracts";
import { GalleryUploadQueue } from "../gallery/upload-queue";
import type { GalleryUploadTask } from "../gallery/upload-task";

export function createGalleryPage(): HTMLElement & { dispose?: () => void } {
  const container = document.createElement("div");
  container.className = "gallery-container";

  document.title = `${t("gallery.nav")} - ${t("app.name")}`;

  // Page State
  let images: GalleryImageDto[] = [];
  let albums: GalleryAlbumDto[] = [];
  let selectedAlbumFilter: string = "ALL"; // "ALL" | "DEFAULT" | albumId
  let searchQuery = "";
  let favoriteOnly = false;
  let viewMode: "grid" | "list" = "grid";
  const selectedIds = new Set<string>();
  let isBatchMode = false;
  let activeDrawerItem: GalleryImageDto | null = null;
  let searchDebounceTimer: any = null;

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

  const headerActions = document.createElement("div");
  headerActions.style.display = "flex";
  headerActions.style.gap = "8px";
  headerActions.style.alignItems = "center";

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
  headerActions.appendChild(configBtn);

  header.appendChild(headerInfo);
  header.appendChild(headerActions);
  container.appendChild(header);

  // 2. Upload Controls
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
    syncPipelineOptions();
  });
  webpCheckbox.addEventListener("change", () => syncPipelineOptions());

  qualityGroup.appendChild(qualityLabel);
  qualityGroup.appendChild(qualitySlider);
  qualityGroup.appendChild(qualityVal);

  const concurrencyGroup = document.createElement("div");
  concurrencyGroup.className = "gallery-quality-group";
  const concurrencyLabel = document.createElement("span");
  concurrencyLabel.textContent = t("gallery.concurrency");
  const concurrencySelect = document.createElement("select");
  concurrencySelect.className = "gallery-select";
  [1, 2, 3, 4, 5].forEach((n) => {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = String(n);
    if (n === 3) opt.selected = true;
    concurrencySelect.appendChild(opt);
  });
  concurrencySelect.addEventListener("change", () => {
    uploadQueue.setConcurrency(Number(concurrencySelect.value));
  });
  concurrencyGroup.appendChild(concurrencyLabel);
  concurrencyGroup.appendChild(concurrencySelect);

  controls.appendChild(webpGroup);
  controls.appendChild(qualityGroup);
  controls.appendChild(concurrencyGroup);
  container.appendChild(controls);

  // 3. Upload Queue Instance & Dropzone
  const uploadQueue = new GalleryUploadQueue({
    concurrency: 3,
    onTaskUpdate: () => renderQueueSection(),
    onQueueComplete: () => {
      loadHistory();
      renderQueueSection();
    }
  });

  function syncPipelineOptions() {
    uploadQueue.setPipelineOptions({
      webpMode: webpCheckbox.checked ? "SMART" : "OFF",
      quality: Number.parseInt(qualitySlider.value, 10) / 100,
      generateThumbnail: true
    });
  }
  syncPipelineOptions();

  // Dropzone
  const dropzone = document.createElement("div");
  dropzone.className = "gallery-dropzone";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.className = "gallery-file-input";
  fileInput.accept = "image/*";
  fileInput.multiple = true;

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
    if (fileInput.files && fileInput.files.length > 0) {
      uploadQueue.addFiles(fileInput.files);
      fileInput.value = "";
    }
  });

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
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const validFiles: File[] = [];
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i];
        if (file.type.startsWith("image/")) {
          validFiles.push(file);
        }
      }
      if (validFiles.length > 0) {
        uploadQueue.addFiles(validFiles);
      }
    }
  });

  container.appendChild(dropzone);

  // 4. Queue UI Section
  const queueSection = document.createElement("div");
  queueSection.className = "gallery-queue-section";
  queueSection.style.display = "none";
  container.appendChild(queueSection);

  function renderQueueSection() {
    const tasks = uploadQueue.getTasks();
    if (tasks.length === 0) {
      queueSection.style.display = "none";
      queueSection.replaceChildren();
      return;
    }
    queueSection.style.display = "flex";
    queueSection.replaceChildren();

    const queueHeader = document.createElement("div");
    queueHeader.className = "gallery-queue-header";

    const titleEl = document.createElement("div");
    titleEl.className = "gallery-queue-title";
    titleEl.textContent = t("gallery.queueTitle", { count: tasks.length });

    const actionsEl = document.createElement("div");
    actionsEl.className = "gallery-queue-actions";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "gallery-btn gallery-btn-icon";
    clearBtn.textContent = t("gallery.queueClear");
    clearBtn.addEventListener("click", () => {
      uploadQueue.clearCompleted();
      renderQueueSection();
    });
    actionsEl.appendChild(clearBtn);

    queueHeader.appendChild(titleEl);
    queueHeader.appendChild(actionsEl);
    queueSection.appendChild(queueHeader);

    const listEl = document.createElement("div");
    listEl.className = "gallery-queue-list";

    tasks.forEach((task) => {
      const item = document.createElement("div");
      item.className = "gallery-queue-item";

      const thumb = document.createElement("img");
      thumb.className = "gallery-queue-item-thumb";
      if (task.thumbBlob) {
        thumb.src = URL.createObjectURL(task.thumbBlob);
      } else {
        thumb.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Crect x='3' y='3' width='18' height='18' rx='2' ry='2'/%3E%3Ccircle cx='8.5' cy='8.5' r='1.5'/%3E%3Cpolyline points='21 15 16 10 5 21'/%3E%3C/svg%3E";
      }

      const info = document.createElement("div");
      info.className = "gallery-queue-item-info";

      const nameRow = document.createElement("div");
      nameRow.className = "gallery-queue-item-name";
      nameRow.textContent = task.outputName || task.originalName;

      const metaRow = document.createElement("div");
      metaRow.className = "gallery-queue-item-meta";
      const sizeStr = task.outputBytes
        ? `${formatBytes(task.originalBytes)} → ${formatBytes(task.outputBytes)}`
        : formatBytes(task.originalBytes);
      metaRow.textContent = `${sizeStr} • ${task.progress}%`;

      const progressTrack = document.createElement("div");
      progressTrack.className = "gallery-queue-item-progress";
      const progressBar = document.createElement("div");
      progressBar.className = "gallery-queue-item-bar";
      progressBar.style.width = `${task.progress}%`;
      progressTrack.appendChild(progressBar);

      info.appendChild(nameRow);
      info.appendChild(metaRow);
      info.appendChild(progressTrack);

      const actionCol = document.createElement("div");
      actionCol.className = "gallery-queue-item-actions";

      const badge = document.createElement("span");
      badge.className = `gallery-queue-badge ${task.state}`;
      badge.textContent = task.state;
      actionCol.appendChild(badge);

      if (task.state === "error") {
        const retryBtn = document.createElement("button");
        retryBtn.className = "gallery-btn gallery-btn-icon";
        retryBtn.textContent = t("gallery.queueRetry");
        retryBtn.addEventListener("click", () => uploadQueue.retryTask(task.id));
        actionCol.appendChild(retryBtn);
      } else if (task.state === "uploading" || task.state === "processing" || task.state === "queued") {
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "gallery-btn gallery-btn-icon gallery-btn-danger";
        cancelBtn.textContent = t("gallery.queueCancel");
        cancelBtn.addEventListener("click", () => uploadQueue.cancelTask(task.id));
        actionCol.appendChild(cancelBtn);
      }

      item.appendChild(thumb);
      item.appendChild(info);
      item.appendChild(actionCol);
      listEl.appendChild(item);
    });

    queueSection.appendChild(listEl);
  }

  // 5. Result Card for latest upload
  const actionArea = document.createElement("div");
  actionArea.className = "gallery-action-area";
  container.appendChild(actionArea);

  function renderResultCard(image: GalleryImageDto, originalBytes: number, uploadedBytes: number) {
    actionArea.replaceChildren();

    const card = document.createElement("div");
    card.className = "gallery-result-card";

    const preview = document.createElement("div");
    preview.className = "gallery-result-preview";

    const thumb = document.createElement("img");
    thumb.className = "gallery-result-thumb";
    thumb.src = image.thumbUrl || image.url;
    thumb.alt = image.filename;

    const info = document.createElement("div");
    info.className = "gallery-result-info";
    const savedPct = originalBytes > uploadedBytes ? Math.round((1 - uploadedBytes / originalBytes) * 100) : 0;
    info.textContent = `${formatBytes(image.sizeBytes)}${savedPct > 0 ? ` (-${savedPct}%)` : ""}`;

    preview.appendChild(thumb);
    preview.appendChild(info);

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

  // 6. Gallery History & Library Section
  const historySection = document.createElement("div");
  historySection.className = "gallery-history";

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "gallery-toolbar";

  const toolbarLeft = document.createElement("div");
  toolbarLeft.className = "gallery-toolbar-left";

  // Search input
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "gallery-search-input";
  searchInput.placeholder = t("gallery.searchPlaceholder");
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchQuery = searchInput.value.trim();
      loadHistory();
    }, 300);
  });
  toolbarLeft.appendChild(searchInput);

  // Album dropdown
  const albumSelect = document.createElement("select");
  albumSelect.className = "gallery-select";
  albumSelect.addEventListener("change", () => {
    selectedAlbumFilter = albumSelect.value;
    uploadQueue.setAlbumId(selectedAlbumFilter === "ALL" || selectedAlbumFilter === "DEFAULT" ? null : selectedAlbumFilter);
    loadHistory();
  });
  toolbarLeft.appendChild(albumSelect);

  // New Album button
  const newAlbumBtn = document.createElement("button");
  newAlbumBtn.type = "button";
  newAlbumBtn.className = "gallery-btn";
  newAlbumBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
    <span>${t("gallery.newAlbum")}</span>
  `;
  newAlbumBtn.addEventListener("click", async () => {
    const name = window.prompt(t("gallery.albumNamePrompt"));
    if (name && name.trim()) {
      try {
        const created = await api.createGalleryAlbum(name.trim());
        await loadAlbums();
        selectedAlbumFilter = created.id;
        albumSelect.value = created.id;
        uploadQueue.setAlbumId(created.id);
        loadHistory();
      } catch (err: any) {
        alert(err.message || "Failed to create album");
      }
    }
  });
  toolbarLeft.appendChild(newAlbumBtn);

  // Favorites Filter Button
  const favFilterBtn = document.createElement("button");
  favFilterBtn.type = "button";
  favFilterBtn.className = "gallery-btn";
  favFilterBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
    </svg>
    <span>${t("gallery.onlyFavorites")}</span>
  `;
  favFilterBtn.addEventListener("click", () => {
    favoriteOnly = !favoriteOnly;
    favFilterBtn.classList.toggle("active", favoriteOnly);
    loadHistory();
  });
  toolbarLeft.appendChild(favFilterBtn);

  const toolbarRight = document.createElement("div");
  toolbarRight.className = "gallery-toolbar-right";

  // Batch Mode Toggle
  const batchBtn = document.createElement("button");
  batchBtn.type = "button";
  batchBtn.className = "gallery-btn";
  batchBtn.textContent = t("gallery.batchMode");
  batchBtn.addEventListener("click", () => {
    isBatchMode = !isBatchMode;
    batchBtn.classList.toggle("active", isBatchMode);
    batchBtn.textContent = isBatchMode ? t("gallery.batchCancel") : t("gallery.batchMode");
    container.classList.toggle("gallery-batch-mode", isBatchMode);
    if (!isBatchMode) {
      selectedIds.clear();
      updateBatchBar();
    }
    renderView();
  });
  toolbarRight.appendChild(batchBtn);

  // View Mode Switcher
  const viewGridBtn = document.createElement("button");
  viewGridBtn.type = "button";
  viewGridBtn.className = "gallery-btn gallery-btn-icon active";
  viewGridBtn.title = t("gallery.viewModeGrid");
  viewGridBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="7" height="7"></rect>
      <rect x="14" y="3" width="7" height="7"></rect>
      <rect x="14" y="14" width="7" height="7"></rect>
      <rect x="3" y="14" width="7" height="7"></rect>
    </svg>
  `;

  const viewListBtn = document.createElement("button");
  viewListBtn.type = "button";
  viewListBtn.className = "gallery-btn gallery-btn-icon";
  viewListBtn.title = t("gallery.viewModeList");
  viewListBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="8" y1="6" x2="21" y2="6"></line>
      <line x1="8" y1="12" x2="21" y2="12"></line>
      <line x1="8" y1="18" x2="21" y2="18"></line>
      <line x1="3" y1="6" x2="3.01" y2="6"></line>
      <line x1="3" y1="12" x2="3.01" y2="12"></line>
      <line x1="3" y1="18" x2="3.01" y2="18"></line>
    </svg>
  `;

  viewGridBtn.addEventListener("click", () => {
    viewMode = "grid";
    viewGridBtn.classList.add("active");
    viewListBtn.classList.remove("active");
    renderView();
  });

  viewListBtn.addEventListener("click", () => {
    viewMode = "list";
    viewListBtn.classList.add("active");
    viewGridBtn.classList.remove("active");
    renderView();
  });

  toolbarRight.appendChild(viewGridBtn);
  toolbarRight.appendChild(viewListBtn);

  toolbar.appendChild(toolbarLeft);
  toolbar.appendChild(toolbarRight);
  historySection.appendChild(toolbar);

  // Content Grid / List View Container
  const viewContainer = document.createElement("div");
  historySection.appendChild(viewContainer);
  container.appendChild(historySection);

  // Floating Batch Action Bar
  const batchBar = document.createElement("div");
  batchBar.className = "gallery-batch-bar";
  batchBar.style.display = "none";

  const batchInfo = document.createElement("div");
  batchInfo.className = "gallery-batch-info";

  const batchActions = document.createElement("div");
  batchActions.className = "gallery-batch-actions";

  const selectAllBtn = document.createElement("button");
  selectAllBtn.className = "gallery-btn";
  selectAllBtn.textContent = t("gallery.batchSelectAll");
  selectAllBtn.addEventListener("click", () => {
    images.forEach((img) => selectedIds.add(img.id));
    updateBatchBar();
    renderView();
  });

  const deselectBtn = document.createElement("button");
  deselectBtn.className = "gallery-btn";
  deselectBtn.textContent = t("gallery.batchDeselectAll");
  deselectBtn.addEventListener("click", () => {
    selectedIds.clear();
    updateBatchBar();
    renderView();
  });

  const copyUrlsBtn = document.createElement("button");
  copyUrlsBtn.className = "gallery-btn";
  copyUrlsBtn.textContent = t("gallery.batchCopyLinks");
  copyUrlsBtn.addEventListener("click", async () => {
    const urls = images.filter((img) => selectedIds.has(img.id)).map((img) => img.url).join("\n");
    await navigator.clipboard.writeText(urls);
    copyUrlsBtn.textContent = t("gallery.copiedShort");
    setTimeout(() => (copyUrlsBtn.textContent = t("gallery.batchCopyLinks")), 1500);
  });

  const copyMdBatchBtn = document.createElement("button");
  copyMdBatchBtn.className = "gallery-btn";
  copyMdBatchBtn.textContent = t("gallery.batchCopyMarkdown");
  copyMdBatchBtn.addEventListener("click", async () => {
    const mds = images.filter((img) => selectedIds.has(img.id)).map((img) => img.markdown).join("\n\n");
    await navigator.clipboard.writeText(mds);
    copyMdBatchBtn.textContent = t("gallery.copiedShort");
    setTimeout(() => (copyMdBatchBtn.textContent = t("gallery.batchCopyMarkdown")), 1500);
  });

  const moveAlbumBtn = document.createElement("button");
  moveAlbumBtn.className = "gallery-btn";
  moveAlbumBtn.textContent = t("gallery.batchMoveAlbum");
  moveAlbumBtn.addEventListener("click", async () => {
    if (albums.length === 0) {
      alert("No albums available");
      return;
    }
    const albumOptions = albums.map((a) => `${a.name} (${a.id})`).join("\n");
    const targetAlbumName = window.prompt(`Select album to move to:\n${albumOptions}\nOr leave empty for Default album:`);
    if (targetAlbumName === null) return;
    const foundAlbum = albums.find((a) => a.name.trim().toLowerCase() === targetAlbumName.trim().toLowerCase() || a.id === targetAlbumName.trim());
    const targetAlbumId = foundAlbum ? foundAlbum.id : null;

    try {
      await api.batchGalleryImages({
        ids: Array.from(selectedIds),
        operation: "move_album",
        albumId: targetAlbumId
      });
      selectedIds.clear();
      updateBatchBar();
      loadHistory();
    } catch (err: any) {
      alert(err.message || "Failed to move images");
    }
  });

  const deleteBatchBtn = document.createElement("button");
  deleteBatchBtn.className = "gallery-btn gallery-btn-danger";
  deleteBatchBtn.textContent = t("gallery.delete");
  deleteBatchBtn.addEventListener("click", async () => {
    const count = selectedIds.size;
    if (confirm(t("gallery.batchDeleteConfirm", { count }))) {
      try {
        await api.batchGalleryImages({
          ids: Array.from(selectedIds),
          operation: "delete"
        });
        selectedIds.clear();
        updateBatchBar();
        loadHistory();
      } catch (err: any) {
        alert(err.message || "Failed to batch delete");
      }
    }
  });

  batchActions.appendChild(selectAllBtn);
  batchActions.appendChild(deselectBtn);
  batchActions.appendChild(copyUrlsBtn);
  batchActions.appendChild(copyMdBatchBtn);
  batchActions.appendChild(moveAlbumBtn);
  batchActions.appendChild(deleteBatchBtn);

  batchBar.appendChild(batchInfo);
  batchBar.appendChild(batchActions);
  container.appendChild(batchBar);

  function updateBatchBar() {
    const count = selectedIds.size;
    if (count > 0 || isBatchMode) {
      batchBar.style.display = "flex";
      batchInfo.textContent = t("gallery.batchSelected", { count });
    } else {
      batchBar.style.display = "none";
    }
  }

  // Load Albums
  async function loadAlbums() {
    try {
      albums = await api.listGalleryAlbums();
      albumSelect.replaceChildren();

      const optAll = document.createElement("option");
      optAll.value = "ALL";
      optAll.textContent = t("gallery.allAlbums");
      albumSelect.appendChild(optAll);

      const optDef = document.createElement("option");
      optDef.value = "DEFAULT";
      optDef.textContent = t("gallery.uncategorized");
      albumSelect.appendChild(optDef);

      albums.forEach((alb) => {
        const opt = document.createElement("option");
        opt.value = alb.id;
        opt.textContent = `${alb.name} (${alb.imageCount ?? 0})`;
        if (alb.id === selectedAlbumFilter) opt.selected = true;
        albumSelect.appendChild(opt);
      });
    } catch {
      // Admin restricted or ignore
    }
  }

  // Load History Images
  async function loadHistory() {
    try {
      const queryOpts: any = { limit: 60 };
      if (searchQuery) queryOpts.search = searchQuery;
      if (favoriteOnly) queryOpts.favorite = true;
      if (selectedAlbumFilter === "DEFAULT") {
        queryOpts.album = "null";
      } else if (selectedAlbumFilter !== "ALL") {
        queryOpts.album = selectedAlbumFilter;
      }

      const res = await api.listGalleryImages(queryOpts);
      images = res.items || [];
      renderView();
    } catch (err: any) {
      if (err.status === 401) {
        viewContainer.replaceChildren();
        const notice = document.createElement("div");
        notice.className = "gallery-empty";
        notice.style.display = "flex";
        notice.style.flexDirection = "column";
        notice.style.alignItems = "center";
        notice.style.gap = "12px";

        const text = document.createElement("span");
        text.textContent = t("gallery.adminRestricted");
        notice.appendChild(text);
        viewContainer.appendChild(notice);
      }
    }
  }

  // Render Grid or List
  function renderView() {
    viewContainer.replaceChildren();

    if (images.length === 0) {
      const empty = document.createElement("div");
      empty.className = "gallery-empty";
      empty.textContent = searchQuery || favoriteOnly ? t("gallery.noResults") : t("gallery.historyEmpty");
      viewContainer.appendChild(empty);
      return;
    }

    if (viewMode === "grid") {
      renderGridView();
    } else {
      renderListView();
    }
  }

  // Grid View Renderer
  function renderGridView() {
    const grid = document.createElement("div");
    grid.className = "gallery-grid";

    images.forEach((item) => {
      const card = document.createElement("div");
      card.className = `gallery-card ${selectedIds.has(item.id) ? "selected" : ""}`;

      // Checkbox for batch
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "gallery-card-checkbox";
      checkbox.checked = selectedIds.has(item.id);
      checkbox.addEventListener("click", (e) => e.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedIds.add(item.id);
          card.classList.add("selected");
        } else {
          selectedIds.delete(item.id);
          card.classList.remove("selected");
        }
        updateBatchBar();
      });
      card.appendChild(checkbox);

      // Favorite button
      const favBtn = document.createElement("button");
      favBtn.type = "button";
      favBtn.className = `gallery-card-fav-btn ${item.favorite ? "is-fav" : ""}`;
      favBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${item.favorite ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
      favBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const nextState = !item.favorite;
        try {
          await api.toggleGalleryFavorite(item.id, nextState);
          item.favorite = nextState;
          favBtn.classList.toggle("is-fav", nextState);
          favBtn.querySelector("svg")?.setAttribute("fill", nextState ? "currentColor" : "none");
          if (favoriteOnly && !nextState) {
            loadHistory();
          }
        } catch (err: any) {
          alert(err.message || "Failed to update favorite");
        }
      });
      card.appendChild(favBtn);

      // Thumbnail (Strictly thumbUrl || url + loading="lazy")
      const thumb = document.createElement("img");
      thumb.className = "gallery-card-thumb";
      thumb.src = item.thumbUrl || item.url;
      thumb.alt = item.filename;
      thumb.loading = "lazy";
      card.appendChild(thumb);

      // Hover Overlay
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
      viewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openDrawer(item);
      });

      const copyMdBtn = document.createElement("button");
      copyMdBtn.className = "gallery-card-btn";
      copyMdBtn.textContent = "Markdown";
      copyMdBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(item.markdown);
        copyMdBtn.textContent = t("gallery.copiedShort");
        setTimeout(() => (copyMdBtn.textContent = "Markdown"), 1500);
      });

      const copyUrlBtn = document.createElement("button");
      copyUrlBtn.className = "gallery-card-btn";
      copyUrlBtn.textContent = t("gallery.link");
      copyUrlBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(item.url);
        copyUrlBtn.textContent = t("gallery.copiedShort");
        setTimeout(() => (copyUrlBtn.textContent = t("gallery.link")), 1500);
      });

      const delBtn = document.createElement("button");
      delBtn.className = "gallery-card-btn delete-btn";
      delBtn.textContent = t("gallery.delete");
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm(t("gallery.deleteConfirm"))) {
          try {
            await api.deleteGalleryImage(item.id);
            card.remove();
            images = images.filter((img) => img.id !== item.id);
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
      card.appendChild(overlay);

      card.addEventListener("click", () => {
        if (isBatchMode) {
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event("change"));
        } else {
          openDrawer(item);
        }
      });

      grid.appendChild(card);
    });

    viewContainer.appendChild(grid);
  }

  // List View Renderer
  function renderListView() {
    const list = document.createElement("div");
    list.className = "gallery-list";

    // Header
    const listHeader = document.createElement("div");
    listHeader.className = "gallery-list-header";
    listHeader.innerHTML = `
      <span></span>
      <span></span>
      <span>${t("gallery.detailTitle")}</span>
      <span>${t("gallery.dimensions")}</span>
      <span>${t("gallery.compressedSize")}</span>
      <span>${t("gallery.album")}</span>
      <span>${t("gallery.historyTitle")}</span>
    `;
    list.appendChild(listHeader);

    images.forEach((item) => {
      const row = document.createElement("div");
      row.className = `gallery-list-row ${selectedIds.has(item.id) ? "selected" : ""}`;

      // Checkbox
      const checkCell = document.createElement("div");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedIds.has(item.id);
      checkbox.addEventListener("click", (e) => e.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedIds.add(item.id);
          row.classList.add("selected");
        } else {
          selectedIds.delete(item.id);
          row.classList.remove("selected");
        }
        updateBatchBar();
      });
      checkCell.appendChild(checkbox);

      // Thumb
      const thumb = document.createElement("img");
      thumb.className = "gallery-list-thumb";
      thumb.src = item.thumbUrl || item.url;
      thumb.alt = item.filename;
      thumb.loading = "lazy";
      thumb.addEventListener("click", (e) => {
        e.stopPropagation();
        openDrawer(item);
      });

      // Name
      const name = document.createElement("div");
      name.className = "gallery-list-name";
      name.textContent = item.filename;
      name.addEventListener("click", () => openDrawer(item));

      // Dimensions
      const dim = document.createElement("div");
      dim.className = "gallery-list-meta";
      dim.textContent = item.width && item.height ? `${item.width}×${item.height}` : "-";

      // Size
      const size = document.createElement("div");
      size.className = "gallery-list-meta";
      size.textContent = formatBytes(item.sizeBytes);

      // Album
      const albumCell = document.createElement("div");
      albumCell.className = "gallery-list-meta";
      const targetAlbum = albums.find((a) => a.id === item.albumId);
      albumCell.textContent = targetAlbum ? targetAlbum.name : t("gallery.noAlbum");

      // Actions
      const actions = document.createElement("div");
      actions.className = "gallery-list-actions";

      const favBtn = document.createElement("button");
      favBtn.className = "gallery-btn gallery-btn-icon";
      favBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${item.favorite ? "#ef4444" : "none"}" stroke="${item.favorite ? "#ef4444" : "currentColor"}" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
      favBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const nextState = !item.favorite;
        try {
          await api.toggleGalleryFavorite(item.id, nextState);
          item.favorite = nextState;
          favBtn.querySelector("svg")?.setAttribute("fill", nextState ? "#ef4444" : "none");
          favBtn.querySelector("svg")?.setAttribute("stroke", nextState ? "#ef4444" : "currentColor");
        } catch (err: any) {
          alert(err.message || "Failed to update favorite");
        }
      });

      const copyUrlBtn = document.createElement("button");
      copyUrlBtn.className = "gallery-btn gallery-btn-icon";
      copyUrlBtn.title = t("gallery.link");
      copyUrlBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`;
      copyUrlBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(item.url);
      });

      const delBtn = document.createElement("button");
      delBtn.className = "gallery-btn gallery-btn-icon gallery-btn-danger";
      delBtn.title = t("gallery.delete");
      delBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm(t("gallery.deleteConfirm"))) {
          try {
            await api.deleteGalleryImage(item.id);
            row.remove();
            images = images.filter((img) => img.id !== item.id);
          } catch (err: any) {
            alert(err.message || t("errors.GALLERY_DELETE_FAILED"));
          }
        }
      });

      actions.appendChild(favBtn);
      actions.appendChild(copyUrlBtn);
      actions.appendChild(delBtn);

      row.appendChild(checkCell);
      row.appendChild(thumb);
      row.appendChild(name);
      row.appendChild(dim);
      row.appendChild(size);
      row.appendChild(albumCell);
      row.appendChild(actions);

      row.addEventListener("click", () => {
        if (isBatchMode) {
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event("change"));
        } else {
          openDrawer(item);
        }
      });

      list.appendChild(row);
    });

    viewContainer.appendChild(list);
  }

  // 7. Detail Drawer
  function openDrawer(item: GalleryImageDto) {
    activeDrawerItem = item;

    const backdrop = document.createElement("div");
    backdrop.className = "gallery-drawer-backdrop";

    const drawer = document.createElement("div");
    drawer.className = "gallery-drawer";

    const drawerHeader = document.createElement("div");
    drawerHeader.className = "gallery-drawer-header";

    const titleEl = document.createElement("h3");
    titleEl.className = "gallery-drawer-title";
    titleEl.textContent = t("gallery.detailTitle");

    const closeBtn = document.createElement("button");
    closeBtn.className = "gallery-btn gallery-btn-icon";
    closeBtn.innerHTML = `✕`;
    closeBtn.addEventListener("click", () => backdrop.remove());

    drawerHeader.appendChild(titleEl);
    drawerHeader.appendChild(closeBtn);
    drawer.appendChild(drawerHeader);

    const body = document.createElement("div");
    body.className = "gallery-drawer-body";

    // Big Image Preview
    const previewImg = document.createElement("img");
    previewImg.className = "gallery-drawer-preview";
    previewImg.src = item.url;
    previewImg.alt = item.filename;
    body.appendChild(previewImg);

    // Meta Table
    const metaTable = document.createElement("div");
    metaTable.className = "gallery-drawer-meta-table";

    // Helper row builder
    const addRow = (label: string, valContent: string | Node) => {
      const row = document.createElement("div");
      row.className = "gallery-drawer-meta-row";
      const lbl = document.createElement("span");
      lbl.className = "gallery-drawer-meta-label";
      lbl.textContent = label;
      const val = document.createElement("span");
      val.className = "gallery-drawer-meta-val";
      if (typeof valContent === "string") {
        val.textContent = valContent;
      } else {
        val.appendChild(valContent);
      }
      row.appendChild(lbl);
      row.appendChild(val);
      metaTable.appendChild(row);
    };

    addRow("ID", item.id);
    addRow(t("gallery.dimensions"), item.width && item.height ? `${item.width} × ${item.height} px` : "-");
    addRow(t("gallery.compressedSize"), formatBytes(item.sizeBytes));

    if (item.originalSizeBytes && item.originalSizeBytes > item.sizeBytes) {
      const pct = Math.round((1 - item.sizeBytes / item.originalSizeBytes) * 100);
      addRow(t("gallery.originalSize"), `${formatBytes(item.originalSizeBytes)} (${t("gallery.compressionRatio")} -${pct}%)`);
    }

    if (item.dominantColor) {
      const colorBox = document.createElement("div");
      colorBox.style.display = "flex";
      colorBox.style.alignItems = "center";
      colorBox.style.gap = "6px";
      const chip = document.createElement("span");
      chip.className = "gallery-color-chip";
      chip.style.backgroundColor = item.dominantColor;
      const text = document.createElement("span");
      text.textContent = item.dominantColor;
      colorBox.appendChild(chip);
      colorBox.appendChild(text);
      addRow(t("gallery.dominantColor"), colorBox);
    }

    addRow(t("gallery.uploadTime"), new Date(item.createdAt).toLocaleString());

    // Album Change Selector
    const albumSelectInDrawer = document.createElement("select");
    albumSelectInDrawer.className = "gallery-select";
    const optNone = document.createElement("option");
    optNone.value = "";
    optNone.textContent = t("gallery.noAlbum");
    albumSelectInDrawer.appendChild(optNone);

    albums.forEach((alb) => {
      const opt = document.createElement("option");
      opt.value = alb.id;
      opt.textContent = alb.name;
      if (alb.id === item.albumId) opt.selected = true;
      albumSelectInDrawer.appendChild(opt);
    });

    albumSelectInDrawer.addEventListener("change", async () => {
      const newAlbumId = albumSelectInDrawer.value ? albumSelectInDrawer.value : null;
      try {
        await api.setGalleryImageAlbum(item.id, newAlbumId);
        item.albumId = newAlbumId;
        loadAlbums();
      } catch (err: any) {
        alert(err.message || "Failed to update album");
      }
    });

    addRow(t("gallery.album"), albumSelectInDrawer);

    body.appendChild(metaTable);

    // Multi-format Copy Rows
    const formatItems = [
      { label: t("gallery.copyUrl"), val: item.url },
      { label: t("gallery.copyMarkdown"), val: item.markdown },
      { label: t("gallery.copyHtml"), val: item.html },
      { label: t("gallery.copyBbcode"), val: item.bbcode }
    ];

    const copySection = document.createElement("div");
    copySection.style.display = "flex";
    copySection.style.flexDirection = "column";
    copySection.style.gap = "8px";

    formatItems.forEach((fmt) => {
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
      copyBtn.textContent = fmt.label;

      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(fmt.val);
        copyBtn.textContent = t("gallery.copiedShort");
        setTimeout(() => (copyBtn.textContent = fmt.label), 1500);
      });

      inputGroup.appendChild(input);
      inputGroup.appendChild(copyBtn);
      copySection.appendChild(inputGroup);
    });

    body.appendChild(copySection);

    // Bottom Action buttons
    const bottomActions = document.createElement("div");
    bottomActions.style.display = "flex";
    bottomActions.style.gap = "10px";
    bottomActions.style.justifyContent = "space-between";

    const favToggleBtn = document.createElement("button");
    favToggleBtn.type = "button";
    favToggleBtn.className = `gallery-btn ${item.favorite ? "active" : ""}`;
    favToggleBtn.textContent = item.favorite ? t("gallery.unfavorite") : t("gallery.favorite");
    favToggleBtn.addEventListener("click", async () => {
      const nextState = !item.favorite;
      try {
        await api.toggleGalleryFavorite(item.id, nextState);
        item.favorite = nextState;
        favToggleBtn.classList.toggle("active", nextState);
        favToggleBtn.textContent = nextState ? t("gallery.unfavorite") : t("gallery.favorite");
        renderView();
      } catch (err: any) {
        alert(err.message || "Failed to update favorite");
      }
    });

    const delItemBtn = document.createElement("button");
    delItemBtn.type = "button";
    delItemBtn.className = "gallery-btn gallery-btn-danger";
    delItemBtn.textContent = t("gallery.delete");
    delItemBtn.addEventListener("click", async () => {
      if (confirm(t("gallery.deleteConfirm"))) {
        try {
          await api.deleteGalleryImage(item.id);
          backdrop.remove();
          images = images.filter((img) => img.id !== item.id);
          renderView();
        } catch (err: any) {
          alert(err.message || t("errors.GALLERY_DELETE_FAILED"));
        }
      }
    });

    bottomActions.appendChild(favToggleBtn);
    bottomActions.appendChild(delItemBtn);
    body.appendChild(bottomActions);

    drawer.appendChild(body);
    backdrop.appendChild(drawer);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    document.body.appendChild(backdrop);
  }

  // 8. Global Paste (Ctrl+V) handler supporting multiple images
  const onPaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const filesToUpload: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        const file = items[i].getAsFile();
        if (file) {
          filesToUpload.push(file);
        }
      }
    }

    if (filesToUpload.length > 0) {
      e.preventDefault();
      uploadQueue.addFiles(filesToUpload);
    }
  };

  window.addEventListener("paste", onPaste);

  // PicGo Setup Modal
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

    const modalTitle = document.createElement("h3");
    modalTitle.className = "gallery-modal-title";
    modalTitle.textContent = t("gallery.picgoGuideTitle");

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
    copyBtn.type = "button";
    copyBtn.className = "gallery-copy-btn";
    copyBtn.textContent = t("gallery.copy");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(pre.textContent || "");
      copyBtn.textContent = t("gallery.copiedShort");
      setTimeout(() => (copyBtn.textContent = t("gallery.copy")), 2000);
    });

    content.appendChild(closeBtn);
    content.appendChild(modalTitle);
    content.appendChild(intro);
    content.appendChild(pre);
    content.appendChild(copyBtn);
    backdrop.appendChild(content);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    document.body.appendChild(backdrop);
  }

  // Initial Load
  loadAlbums();
  loadHistory();

  const element = container as HTMLElement & { dispose?: () => void };
  element.dispose = () => {
    window.removeEventListener("paste", onPaste);
    uploadQueue.clearAll();
  };

  return element;
}

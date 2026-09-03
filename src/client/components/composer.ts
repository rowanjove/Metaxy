import { t, formatBytes } from "../i18n";
import { api, ApiClientError } from "../api";
import { getSavedUploadToken, saveUploadToken } from "../state";
import type { CommitDropData, MetaData } from "../../shared/contracts";

export interface PendingFile {
  id: string;
  file: File;
  sortOrder: number;
  status: "queued" | "preparing" | "uploading" | "verifying" | "complete" | "error";
  progress: number;
  preparedFileId?: string;
  errorMessage?: string;
}

export function createComposer(
  meta: MetaData,
  onSuccess: (result: CommitDropData) => void
): HTMLElement {
  const container = document.createElement("section");
  container.className = "pane-card compose-pane";

  const header = document.createElement("div");
  header.className = "pane-header";

  const title = document.createElement("h2");
  title.className = "pane-title";
  title.textContent = t("home.sendTitle");

  const intro = document.createElement("p");
  intro.className = "pane-intro";
  intro.textContent = t("home.sendIntro");

  header.appendChild(title);
  header.appendChild(intro);
  container.appendChild(header);

  const form = document.createElement("form");
  form.className = "composer-form";

  // Textarea and explicit clipboard action
  const textField = document.createElement("div");
  textField.className = "composer-text-field";

  const textarea = document.createElement("textarea");
  textarea.className = "composer-textarea";
  textarea.placeholder = t("home.textPlaceholder");
  textarea.setAttribute("aria-label", t("home.textPlaceholder"));

  const pasteButton = document.createElement("button");
  pasteButton.type = "button";
  pasteButton.className = "btn btn-ghost btn-sm composer-paste-button";
  pasteButton.textContent = t("home.pasteButton");
  pasteButton.setAttribute("aria-label", t("home.pasteButton"));

  textField.appendChild(textarea);
  textField.appendChild(pasteButton);

  // Drag and drop / file list
  const pendingFiles: PendingFile[] = [];
  let activeDraft: { dropId: string; draftToken: string } | null = null;
  const filesContainer = document.createElement("div");
  filesContainer.className = "pending-files-list";

  const dropzone = document.createElement("div");
  dropzone.className = "dropzone";
  dropzone.setAttribute("role", "button");
  dropzone.tabIndex = 0;
  dropzone.setAttribute("aria-label", t("home.dropFilesHint"));

  const dropzoneText = document.createElement("div");
  dropzoneText.className = "dropzone-text";
  dropzoneText.textContent = t("home.dropFilesHint");

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.className = "visually-hidden";
  fileInput.setAttribute("aria-label", t("home.dropFilesHint"));
  fileInput.addEventListener("click", (event) => event.stopPropagation());

  dropzone.appendChild(dropzoneText);
  dropzone.appendChild(fileInput);

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("is-dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("is-dragover");
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("is-dragover");
    if (e.dataTransfer?.files) {
      addFiles(Array.from(e.dataTransfer.files));
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files) {
      addFiles(Array.from(fileInput.files));
      fileInput.value = "";
    }
  });

  // Paste handler for images and text
  container.addEventListener("paste", (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const filesToAdd: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) filesToAdd.push(file);
      }
    }

    if (filesToAdd.length > 0) {
      addFiles(filesToAdd);
    }
  });

  function addFiles(files: File[]) {
    for (const f of files) {
      if (pendingFiles.length >= meta.limits.maxFilesPerDrop) {
        break;
      }
      pendingFiles.push({
        id: crypto.randomUUID(),
        file: f,
        sortOrder: pendingFiles.length + 1,
        status: "queued",
        progress: 0
      });
    }
    pendingFiles.forEach((file, index) => { file.sortOrder = index + 1; });
    renderFilesList();
    updateSubmitButtonState();
  }

  function renderFilesList() {
    filesContainer.replaceChildren();
    if (pendingFiles.length === 0) {
      filesContainer.style.display = "none";
      return;
    }

    filesContainer.style.display = "flex";
    for (const pf of pendingFiles) {
      const card = document.createElement("div");
      card.className = "pending-file-card";

      const infoRow = document.createElement("div");
      infoRow.className = "file-info-row";

      const nameSpan = document.createElement("span");
      nameSpan.className = "file-name";
      nameSpan.textContent = pf.file.name;

      const metaSpan = document.createElement("div");
      metaSpan.className = "file-meta";

      const sizeSpan = document.createElement("span");
      sizeSpan.textContent = formatBytes(pf.file.size);

      const statusText = document.createElement("span");
      statusText.textContent = getStatusLabel(pf.status);

      metaSpan.appendChild(sizeSpan);
      metaSpan.appendChild(statusText);

      if (pf.status === "queued") {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "btn btn-ghost btn-sm";
        removeBtn.textContent = t("fileList.remove");
        removeBtn.addEventListener("click", () => {
          const idx = pendingFiles.indexOf(pf);
          if (idx >= 0) {
            pendingFiles.splice(idx, 1);
            renderFilesList();
            updateSubmitButtonState();
          }
        });
        metaSpan.appendChild(removeBtn);
      } else if (pf.status === "error") {
        const retryBtn = document.createElement("button");
        retryBtn.type = "button";
        retryBtn.className = "btn btn-ghost btn-sm";
        retryBtn.textContent = t("fileList.retry");
        retryBtn.addEventListener("click", () => { void retryFile(pf); });
        metaSpan.appendChild(retryBtn);
      }

      infoRow.appendChild(nameSpan);
      infoRow.appendChild(metaSpan);
      card.appendChild(infoRow);

      if (pf.status !== "queued") {
        const track = document.createElement("div");
        track.className = "progress-track";

        const bar = document.createElement("div");
        bar.className = `progress-bar ${pf.status === "error" ? "is-error" : pf.status === "complete" ? "is-complete" : ""}`;
        bar.style.width = `${pf.progress}%`;

        track.appendChild(bar);
        card.appendChild(track);
      }

      filesContainer.appendChild(card);
    }
  }

  function getStatusLabel(status: PendingFile["status"]): string {
    switch (status) {
      case "queued": return t("fileList.statusQueued");
      case "preparing": return t("fileList.statusPreparing");
      case "uploading": return t("fileList.statusUploading");
      case "verifying": return t("fileList.statusVerifying");
      case "complete": return t("fileList.statusComplete");
      case "error": return t("fileList.statusError");
    }
  }

  // Controls row: Expiry + Token
  const controlsRow = document.createElement("div");
  controlsRow.className = "composer-controls";

  const expiryGroup = document.createElement("div");
  expiryGroup.className = "form-group";

  const expiryLabel = document.createElement("label");
  expiryLabel.className = "form-label";
  expiryLabel.textContent = t("home.expiryLabel");

  const expirySelect = document.createElement("select");
  expirySelect.id = `expiry-${crypto.randomUUID()}`;
  expiryLabel.htmlFor = expirySelect.id;
  const expiryMap: Record<number, string> = {
    600: t("home.expiryUnits.10m"),
    3600: t("home.expiryUnits.1h"),
    21600: t("home.expiryUnits.6h"),
    86400: t("home.expiryUnits.24h"),
    259200: t("home.expiryUnits.3d"),
    604800: t("home.expiryUnits.7d")
  };

  for (const opt of meta.expiryOptions) {
    const el = document.createElement("option");
    el.value = String(opt);
    el.textContent = expiryMap[opt] || `${opt}s`;
    if (opt === meta.defaultExpirySeconds) el.selected = true;
    expirySelect.appendChild(el);
  }

  expiryGroup.appendChild(expiryLabel);
  expiryGroup.appendChild(expirySelect);
  controlsRow.appendChild(expiryGroup);

  // Upload token input if token mode
  let tokenInput: HTMLInputElement | null = null;
  if (meta.uploadMode === "token") {
    const tokenGroup = document.createElement("div");
    tokenGroup.className = "form-group";

    const tokenLabel = document.createElement("label");
    tokenLabel.className = "form-label";
    tokenLabel.textContent = t("home.uploadTokenLabel");

    tokenInput = document.createElement("input");
    tokenInput.type = "password";
    tokenInput.id = `upload-token-${crypto.randomUUID()}`;
    tokenLabel.htmlFor = tokenInput.id;
    tokenInput.placeholder = t("home.uploadTokenPlaceholder");
    tokenInput.value = getSavedUploadToken();
    tokenInput.addEventListener("input", () => {
      saveUploadToken(tokenInput!.value);
    });

    tokenGroup.appendChild(tokenLabel);
    tokenGroup.appendChild(tokenInput);
    controlsRow.appendChild(tokenGroup);
  }

  // Submit button
  const actionsRow = document.createElement("div");
  actionsRow.className = "composer-actions";

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "btn btn-primary btn-lg";
  submitBtn.textContent = t("home.createButton");
  submitBtn.disabled = true;

  actionsRow.appendChild(submitBtn);

  const errorBanner = document.createElement("div");
  errorBanner.className = "notice-box is-error";
  errorBanner.style.display = "none";

  pasteButton.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.readText) {
        throw new Error("Clipboard API unavailable");
      }
      const clipboardText = await navigator.clipboard.readText();
      errorBanner.style.display = "none";
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      textarea.setRangeText(clipboardText, start, end, "end");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.focus();
    } catch {
      errorBanner.textContent = t("home.pasteFailed");
      errorBanner.style.display = "flex";
      textarea.focus();
    }
  });

  form.appendChild(textField);
  form.appendChild(dropzone);
  form.appendChild(filesContainer);
  form.appendChild(controlsRow);
  form.appendChild(actionsRow);
  form.appendChild(errorBanner);
  container.appendChild(form);

  function updateSubmitButtonState() {
    const hasText = textarea.value.trim().length > 0;
    const hasFiles = pendingFiles.length > 0;
    submitBtn.disabled = !hasText && !hasFiles;
  }

  textarea.addEventListener("input", updateSubmitButtonState);

  // Form submission & multi-file 3-concurrency upload queue
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBanner.style.display = "none";

    const textContent = textarea.value;
    const expirySeconds = Number.parseInt(expirySelect.value, 10);

    if (meta.uploadMode === "token" && !getSavedUploadToken().trim()) {
      errorBanner.textContent = t("errors.UNAUTHORIZED");
      errorBanner.style.display = "flex";
      tokenInput?.focus();
      return;
    }

    setComposerBusy(true);

    try {
      // 1. Create Draft
      const draft = await api.createDraft(expirySeconds);
      const { dropId, draftToken } = draft;
      activeDraft = { dropId, draftToken };

      // 2. Put text if present
      if (textContent.trim()) {
        await api.updateText(dropId, draftToken, textContent);
      }

      // 3. Upload files with concurrency = 3
      if (pendingFiles.length > 0) {
        await uploadFilesInQueue(dropId, draftToken, pendingFiles, renderFilesList);
      }

      // 4. Commit drop
      const result = await api.commitDrop(dropId, draftToken);
      activeDraft = null;
      onSuccess(result);
    } catch (err: any) {
      console.error("[Composer] Creation failed", err);
      // Keep the draft only when failed files can be retried in place. Other
      // failures should allow a fresh submission without reusing stale state.
      if (!pendingFiles.some((file) => file.status === "error")) {
        activeDraft = null;
      }
      errorBanner.textContent = err.message || t("errors.UNKNOWN_ERROR");
      errorBanner.style.display = "flex";
      setComposerBusy(false);
    }
  });

  return container;

  function setComposerBusy(busy: boolean): void {
    const waitingForFileRetry = Boolean(
      activeDraft && pendingFiles.some((file) => file.status === "error")
    );
    submitBtn.disabled = busy || waitingForFileRetry;
    submitBtn.textContent = busy ? t("home.creatingButton") : t("home.createButton");
    textarea.disabled = busy;
    pasteButton.disabled = busy;
    expirySelect.disabled = busy;
    fileInput.disabled = busy;
    dropzone.style.pointerEvents = busy ? "none" : "";
    if (tokenInput) tokenInput.disabled = busy;
  }

  async function retryFile(file: PendingFile): Promise<void> {
    if (!activeDraft || file.status !== "error") return;
    file.status = "queued";
    file.errorMessage = undefined;
    renderFilesList();
    setComposerBusy(true);
    try {
      await uploadFilesInQueue(activeDraft.dropId, activeDraft.draftToken, [file], renderFilesList);
      if (pendingFiles.every((pending) => pending.status === "complete")) {
        const result = await api.commitDrop(activeDraft.dropId, activeDraft.draftToken);
        onSuccess(result);
        activeDraft = null;
      }
    } catch (err: unknown) {
      file.status = "error";
      file.errorMessage = err instanceof Error ? err.message : t("errors.UNKNOWN_ERROR");
      renderFilesList();
    } finally {
      setComposerBusy(false);
    }
  }
}

type UploadQueueApi = Pick<
  typeof api,
  "prepareUpload" | "uploadFileToR2" | "completeUpload"
>;

const RECOVERABLE_COMPLETION_CODES = new Set([
  "FILE_OBJECT_MISSING",
  "FILE_SIZE_MISMATCH",
  "FILE_TYPE_MISMATCH"
]);

export async function uploadFilesInQueue(
  dropId: string,
  draftToken: string,
  files: PendingFile[],
  onUpdate: () => void,
  client: UploadQueueApi = api
): Promise<void> {
  const concurrency = 3;
  let index = 0;
  const failures: unknown[] = [];

  async function worker() {
    while (index < files.length) {
      const current = files[index++];
      if (!current) break;

      try {
        // A prior PUT or completion response may have succeeded even when the
        // browser observed a network failure. Verify first before re-uploading.
        if (current.preparedFileId) {
          current.status = "verifying";
          onUpdate();
          try {
            await client.completeUpload(dropId, draftToken, current.preparedFileId);
            current.status = "complete";
            current.progress = 100;
            onUpdate();
            continue;
          } catch (error) {
            if (
              !(error instanceof ApiClientError) ||
              !RECOVERABLE_COMPLETION_CODES.has(error.code)
            ) {
              throw error;
            }
          }
        }

        current.status = "preparing";
        onUpdate();

        const prepared = await client.prepareUpload(dropId, draftToken, {
          fileId: current.preparedFileId,
          filename: current.file.name,
          size: current.file.size,
          contentType: current.file.type || "application/octet-stream",
          sortOrder: current.sortOrder
        });
        current.preparedFileId = prepared.fileId;

        current.status = "uploading";
        current.progress = 0;
        onUpdate();

        await client.uploadFileToR2(
          prepared.uploadUrl,
          current.file,
          current.file.type || "application/octet-stream",
          (pct) => {
            current.progress = pct;
            onUpdate();
          }
        );

        current.status = "verifying";
        onUpdate();

        await client.completeUpload(dropId, draftToken, prepared.fileId);
        current.status = "complete";
        current.progress = 100;
        onUpdate();
      } catch (err: unknown) {
        current.status = "error";
        current.errorMessage = err instanceof Error ? err.message : t("errors.UNKNOWN_ERROR");
        onUpdate();
        failures.push(err);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);
  if (failures.length > 0) {
    throw failures[0];
  }
}

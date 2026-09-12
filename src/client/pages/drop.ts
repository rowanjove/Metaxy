import { t, formatBytes, formatRemainingTime } from "../i18n";
import { api } from "../api";
import { router } from "../router";
import { showImageLightbox } from "../components/dialog";
import type { DropDetailData, FileItemDetail } from "../../shared/contracts";

export async function createDropPage(params: { code?: string }): Promise<HTMLElement> {
  const code = params.code?.toUpperCase().replace(/[\s-]+/g, "") || "";
  const container = document.createElement("div");
  container.className = "detail-view";

  if (!code) {
    container.appendChild(renderExpiredState());
    return container;
  }

  let detail: DropDetailData;
  try {
    detail = await api.getDropDetail(code);
  } catch (err: any) {
    console.error("[DropPage] Failed to fetch drop", err);
    container.appendChild(renderExpiredState(err.message));
    return container;
  }

  // Header card: Code + Countdown timer
  const headerCard = document.createElement("div");
  headerCard.className = "detail-header-card";

  const codeBadge = document.createElement("span");
  codeBadge.className = "detail-code-badge";
  codeBadge.textContent = detail.code;

  const timerBadge = document.createElement("div");
  timerBadge.className = "detail-expiry-badge";

  let remainingSecs = Math.max(0, Math.floor((detail.expiresAt - Date.now()) / 1000));
  timerBadge.textContent = t("detail.expiresIn", { time: formatRemainingTime(remainingSecs) });

  headerCard.appendChild(codeBadge);
  headerCard.appendChild(timerBadge);
  container.appendChild(headerCard);

  // Content Container
  const contentWrapper = document.createElement("div");
  contentWrapper.style.display = "flex";
  contentWrapper.style.flexDirection = "column";
  contentWrapper.style.gap = "16px";
  container.appendChild(contentWrapper);

  // Countdown timer tick (clears content on zero)
  const timerInterval = setInterval(() => {
    if (!container.isConnected) {
      clearInterval(timerInterval);
      return;
    }
    remainingSecs = Math.max(0, Math.floor((detail.expiresAt - Date.now()) / 1000));
    timerBadge.textContent = t("detail.expiresIn", { time: formatRemainingTime(remainingSecs) });

    if (remainingSecs <= 0) {
      clearInterval(timerInterval);
      contentWrapper.replaceChildren(renderExpiredState());
    }
  }, 1000);

  // Render Items
  const fileItems: FileItemDetail[] = [];

  for (const item of detail.items) {
    if (item.type === "text") {
      contentWrapper.appendChild(renderTextViewer(item));
    } else if (item.type === "file") {
      fileItems.push(item.file);
    }
  }

  if (fileItems.length > 0) {
    contentWrapper.appendChild(renderFilesGrid(fileItems, code));
  }

  return container;
}

function renderTextViewer(item: { content: string | null; contentUrl: string | null; size: number }): HTMLElement {
  const card = document.createElement("div");
  card.className = "text-viewer-card";

  const header = document.createElement("div");
  header.className = "text-viewer-header";

  const title = document.createElement("h3");
  title.className = "pane-title";
  title.textContent = t("detail.textContentTitle");

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn btn-secondary btn-sm";
  copyBtn.textContent = t("detail.copyAllText");

  header.appendChild(title);
  header.appendChild(copyBtn);
  card.appendChild(header);

  const textBox = document.createElement("div");
  textBox.className = "text-content-box";

  if (item.content !== null) {
    renderFormattedTextToDom(textBox, item.content);
  } else if (item.contentUrl) {
    textBox.textContent = t("detail.loadingText");
    api.fetchR2Text(item.contentUrl).then((text) => {
      textBox.replaceChildren();
      renderFormattedTextToDom(textBox, text);
    }).catch(() => {
      textBox.textContent = "Error loading text content.";
    });
  }

  copyBtn.addEventListener("click", async () => {
    try {
      const textToCopy = textBox.textContent || "";
      await navigator.clipboard.writeText(textToCopy);
      copyBtn.textContent = t("detail.copiedText");
      setTimeout(() => {
        copyBtn.textContent = t("detail.copyAllText");
      }, 2000);
    } catch {
      // Fallback
    }
  });

  card.appendChild(textBox);
  return card;
}

/**
 * Render text with safe DOM URL detection without innerHTML
 */
function renderFormattedTextToDom(container: HTMLElement, rawText: string): void {
  const urlRegex = /(https?:\/\/[^\s<>]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(rawText)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(rawText.slice(lastIndex, match.index)));
    }

    const url = match[0];
    const link = document.createElement("a");
    link.href = url;
    link.textContent = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    container.appendChild(link);

    lastIndex = match.index + url.length;
  }

  if (lastIndex < rawText.length) {
    container.appendChild(document.createTextNode(rawText.slice(lastIndex)));
  }
}

function renderFilesGrid(files: FileItemDetail[], code: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "detail-files-card";

  const title = document.createElement("h3");
  title.className = "pane-title";
  title.textContent = t("detail.filesTitle", { count: files.length });
  card.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "files-grid";

  for (const file of files) {
    const itemCard = document.createElement("div");
    itemCard.className = "file-card-item";

    if (file.previewable) {
      const img = document.createElement("img");
      img.className = "file-thumbnail";
      img.src = file.contentUrl;
      img.alt = file.filename;
      img.addEventListener("click", () => {
        showImageLightbox(file.contentUrl, file.filename);
      });
      itemCard.appendChild(img);
    }

    const infoRow = document.createElement("div");
    infoRow.className = "file-info-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "file-name";
    nameSpan.textContent = file.filename;

    const sizeSpan = document.createElement("span");
    sizeSpan.className = "file-meta";
    sizeSpan.textContent = formatBytes(file.size);

    infoRow.appendChild(nameSpan);
    infoRow.appendChild(sizeSpan);
    itemCard.appendChild(infoRow);

    const downloadBtn = document.createElement("a");
    downloadBtn.href = file.downloadUrl;
    downloadBtn.className = "btn btn-primary btn-sm";
    downloadBtn.textContent = t("detail.download");
    downloadBtn.download = file.filename;

    itemCard.appendChild(downloadBtn);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn btn-secondary btn-sm";
    saveBtn.textContent = t("drive.saveToDrive");
    saveBtn.addEventListener("click", async () => {
      try {
        const parentId = await chooseDriveDestination();
        if (parentId === null) return;
        await api.saveDropFileToDrive(code, file.id, parentId);
        saveBtn.textContent = t("drive.saveToDriveSuccess");
        saveBtn.disabled = true;
      } catch (error) {
        saveBtn.textContent = error instanceof Error && "status" in error && (error as any).status === 401
          ? t("drive.loginRequired")
          : t("drive.saveToDriveFailed");
      }
    });
    itemCard.appendChild(saveBtn);

    grid.appendChild(itemCard);
  }

  card.appendChild(grid);
  return card;
}

async function chooseDriveDestination(): Promise<string | undefined | null> {
  const overlay = document.createElement("div");
  overlay.className = "drive-modal-backdrop";
  const dialog = document.createElement("div");
  dialog.className = "drive-modal";
  const title = document.createElement("h2");
  title.textContent = t("drive.saveToDrive");
  const select = document.createElement("select");
  select.className = "drive-folder-select";
  const root = document.createElement("option");
  root.value = "";
  root.textContent = t("drive.inboxDefault");
  select.appendChild(root);
  const folders: Array<{ id: string; label: string }> = [];
  const loadFolders = async (parentId: string, depth: number, prefix: string) => {
    if (depth > 20 || folders.length >= 2000) return;
    let cursor: string | undefined;
    do {
      const result = await api.listDrive(parentId, cursor, 200);
      for (const node of result.nodes.filter((item) => item.kind === "folder")) {
        folders.push({ id: node.id, label: `${prefix}${node.name}` });
        await loadFolders(node.id, depth + 1, `${prefix}  `);
        if (folders.length >= 2000) break;
      }
      cursor = result.nextCursor || undefined;
    } while (cursor && folders.length < 2000);
  };
  try {
    await loadFolders("drive-root", 0, "");
  } catch (error) {
    overlay.remove();
    throw error;
  }
  for (const folder of folders) {
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = folder.label;
    select.appendChild(option);
  }
  const actions = document.createElement("div");
  actions.className = "drive-modal-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("drive.cancel");
  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "primary-btn";
  confirmButton.textContent = t("drive.save");
  actions.appendChild(cancel);
  actions.appendChild(confirmButton);
  dialog.appendChild(title);
  dialog.appendChild(select);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  return new Promise((resolve) => {
    const close = (value: string | undefined | null) => { overlay.remove(); resolve(value); };
    cancel.addEventListener("click", () => close(null));
    confirmButton.addEventListener("click", () => close(select.value || undefined));
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(null); });
  });
}

function renderExpiredState(message?: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "pane-card";
  card.style.textAlign = "center";
  card.style.padding = "40px 20px";

  const notice = document.createElement("h3");
  notice.className = "pane-title";
  notice.textContent = message || t("detail.expiredNotice");
  notice.style.marginBottom = "16px";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn-primary";
  backBtn.textContent = t("detail.backHome");
  backBtn.addEventListener("click", () => router.navigate("/"));

  card.appendChild(notice);
  card.appendChild(backBtn);
  return card;
}

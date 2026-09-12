import { api, ApiClientError } from "../api";
import { t } from "../i18n";
import { router } from "../router";
import type { DriveListResult, DriveNodeDto } from "../../shared/drive-contracts";

type DriveMode = "browse" | "search" | "trash";
type UploadState = "queued" | "uploading" | "completed" | "failed" | "cancelled";
interface UploadItem { id: string; file: File; parentId: string; state: UploadState; progress: number; error?: string; controller?: AbortController; }

function bytes(value: number | null): string {
  if (value === null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function date(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function button(label: string, className = "secondary-btn"): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = label;
  return el;
}

function appendChildren(parent: { appendChild(child: Node): Node }, ...children: Node[]): void {
  for (const child of children) parent.appendChild(child);
}

export async function createDrivePage(): Promise<HTMLElement> {
  const container = document.createElement("section");
  container.className = "drive-page pane-card";
  document.title = `${t("app.name")} · Drive`;

  let currentParentId: string | undefined;
  let path: Array<{ id: string; name: string }> = [];
  let current: DriveListResult | null = null;
  let nextCursor: string | null = null;
  let mode: DriveMode = "browse";
  let searchQuery = "";
  let selected = new Set<string>();
  let uploads: UploadItem[] = [];
  let activeUploads = 0;
  let sortBy: "name" | "size" | "updated" = "name";
  let sortDirection: 1 | -1 = 1;
  let loading = false;
  let loadError: string | null = null;
  let loadErrorStatus: number | null = null;

  const activeUploadCount = () => uploads.filter((item) => item.state === "queued" || item.state === "uploading").length;
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (activeUploadCount() > 0) { event.preventDefault(); event.returnValue = ""; }
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  (container as HTMLElement & { dispose?: () => void }).dispose = () => {
    window.removeEventListener("beforeunload", onBeforeUnload);
  };

  const renderError = (message: string, status?: number) => {
    container.replaceChildren();
    const errorBox = document.createElement("div");
    errorBox.className = "drive-empty";
    errorBox.style.display = "flex";
    errorBox.style.flexDirection = "column";
    errorBox.style.alignItems = "center";
    errorBox.style.gap = "12px";

    const text = document.createElement("p");
    text.textContent = message;
    errorBox.appendChild(text);

    if (status === 401) {
      const loginBtn = button(t("drive.loginAdmin"), "primary-btn");
      loginBtn.addEventListener("click", () => router.navigate("/admin"));
      errorBox.appendChild(loginBtn);
    }
    container.appendChild(errorBox);
  };

  const load = async () => {
    loading = true;
    loadError = null;
    loadErrorStatus = null;
    try {
      if (mode === "browse") {
        current = await api.listDrive(currentParentId);
        nextCursor = current.nextCursor;
      } else { current = null; nextCursor = null; }
      selected = new Set<string>();
    } catch (error) {
      current = null;
      loadErrorStatus = error instanceof ApiClientError ? error.status : null;
      loadError = error instanceof Error ? error.message : t("drive.loadError");
    } finally {
      loading = false;
      await render();
    }
  };

  const loadMore = async () => {
    if (!current || !nextCursor || mode !== "browse") return;
    try {
      const result = await api.listDrive(currentParentId, nextCursor);
      current = { ...current, nodes: [...current.nodes, ...result.nodes], nextCursor: result.nextCursor };
      nextCursor = result.nextCursor;
      await render();
    } catch (error) { alert(error instanceof Error ? error.message : t("drive.loadMoreFailed")); }
  };

  const runUpload = async (item: UploadItem) => {
    item.state = "uploading";
    item.controller = new AbortController();
    void render();
    try {
      await api.uploadDriveFile(item.file, item.parentId, {
        signal: item.controller.signal,
        onProgress: (progress) => { item.progress = progress; void render(); }
      });
      item.progress = 100;
      item.state = "completed";
    } catch (error) {
      item.state = item.controller.signal.aborted ? "cancelled" : "failed";
      item.error = error instanceof Error ? error.message : t("drive.queueStateFailed");
    } finally {
      item.controller = undefined;
      activeUploads -= 1;
      void render();
      await load();
      pumpUploads();
    }
  };

  const pumpUploads = () => {
    while (activeUploads < 2) {
      const item = uploads.find((candidate) => candidate.state === "queued");
      if (!item) return;
      activeUploads += 1;
      void runUpload(item);
    }
  };

  const addFiles = (files: File[]) => {
    const parentId = current?.parent.id || currentParentId || "drive-root";
    uploads = [...uploads, ...files.map((file) => ({ id: crypto.randomUUID(), file, parentId, state: "queued" as UploadState, progress: 0 }))];
    void render();
    pumpUploads();
  };

  const chooseFolder = async (excludeId?: string): Promise<{ id: string; name: string } | null> => {
    const overlay = document.createElement("div"); overlay.className = "drive-modal-backdrop";
    const dialog = document.createElement("div"); dialog.className = "drive-modal";
    const heading = document.createElement("h2"); heading.textContent = t("drive.selectTargetFolder");
    const select = document.createElement("select"); select.className = "drive-folder-select";
    const rootOption = document.createElement("option"); rootOption.value = "drive-root"; rootOption.textContent = t("drive.rootFolder"); select.appendChild(rootOption);
    const folders: Array<{ id: string; name: string }> = [];
    const loadFolders = async (parentId: string, depth: number, prefix: string) => {
      if (depth > 20 || folders.length >= 2000) return;
      let cursor: string | undefined;
      do {
        const result = await api.listDrive(parentId, cursor, 200);
        for (const node of result.nodes.filter((candidate) => candidate.kind === "folder" && candidate.id !== excludeId)) {
          folders.push({ id: node.id, name: `${prefix}${node.name}` });
          await loadFolders(node.id, depth + 1, `${prefix}  `);
          if (folders.length >= 2000) break;
        }
        cursor = result.nextCursor || undefined;
      } while (cursor && folders.length < 2000);
    };
    try { await loadFolders("drive-root", 0, ""); } catch { /* root remains usable */ }
    for (const folder of folders) { const option = document.createElement("option"); option.value = folder.id; option.textContent = folder.name; select.appendChild(option); }
    const actions = document.createElement("div"); actions.className = "drive-modal-actions";
    const cancel = button(t("drive.cancel")); const confirmButton = button(t("drive.select"), "primary-btn"); appendChildren(actions, cancel, confirmButton);
    appendChildren(dialog, heading, select, actions); overlay.appendChild(dialog); document.body.appendChild(overlay);
    return new Promise((resolve) => {
      const close = (value: { id: string; name: string } | null) => { overlay.remove(); resolve(value); };
      cancel.addEventListener("click", () => close(null));
      confirmButton.addEventListener("click", () => { const option = select.selectedOptions[0]; close({ id: option.value, name: option.textContent || t("drive.folder") }); });
      overlay.addEventListener("click", (event) => { if (event.target === overlay) close(null); });
    });
  };

  const openDevices = async () => {
    const overlay = document.createElement("div"); overlay.className = "drive-modal-backdrop";
    const dialog = document.createElement("div"); dialog.className = "drive-modal";
    const heading = document.createElement("h2"); heading.textContent = t("drive.devicesTitle");
    const list = document.createElement("div"); list.className = "drive-device-list";
    try {
      const devices = await api.listDriveDevices();
      if (!devices.length) { const empty = document.createElement("p"); empty.textContent = t("drive.noDevices"); list.appendChild(empty); }
      for (const device of devices) {
        const row = document.createElement("div"); row.className = "drive-device-row";
        const label = document.createElement("span"); label.textContent = `${device.name} · ${device.username}`;
        const revoke = button(t("drive.revoke")); revoke.addEventListener("click", async () => { if (confirm(t("drive.revokeConfirm", { name: device.name }))) { await api.revokeDriveDevice(device.id); overlay.remove(); void openDevices(); } });
        appendChildren(row, label, revoke); list.appendChild(row);
      }
    } catch (error) { const message = document.createElement("p"); message.textContent = error instanceof Error ? error.message : t("drive.loadDevicesFailed"); list.appendChild(message); }
    const create = button(t("drive.addDevice"), "primary-btn");
    create.addEventListener("click", async () => {
      const name = prompt(t("drive.deviceNamePrompt"), "Windows PC"); if (!name) return;
      try {
        const device = await api.createDriveDevice(name);
        const credentials = t("drive.credentialsTemplate", {
          host: location.host,
          username: device.username,
          password: device.password
        });
        await navigator.clipboard?.writeText(credentials).catch(() => undefined);
        alert(t("drive.credentialsPrompt", { credentials })); overlay.remove();
      } catch (error) { alert(error instanceof Error ? error.message : t("drive.createDeviceFailed")); }
    });
    const close = button(t("drive.close")); close.addEventListener("click", () => overlay.remove());
    const actions = document.createElement("div"); actions.className = "drive-modal-actions"; appendChildren(actions, create, close);
    appendChildren(dialog, heading, list, actions); overlay.appendChild(dialog); document.body.appendChild(overlay);
  };

  const doAction = async (action: () => Promise<unknown>, message: string) => {
    try { await action(); await load(); }
    catch (error) { alert(error instanceof Error ? error.message : message); }
  };

  const appendNodeList = (nodes: DriveNodeDto[], listMode: "browse" | "trash" | null) => {
    const sorted = [...nodes].sort((a, b) => {
      const av = sortBy === "name" ? a.name.toLocaleLowerCase() : sortBy === "size" ? (a.size || 0) : a.updatedAt;
      const bv = sortBy === "name" ? b.name.toLocaleLowerCase() : sortBy === "size" ? (b.size || 0) : b.updatedAt;
      return (av < bv ? -1 : av > bv ? 1 : 0) * sortDirection;
    });
    const controls = document.createElement("div"); controls.className = "drive-list-controls";
    const selection = document.createElement("span"); selection.textContent = selected.size ? t("drive.selectedItems", { count: selected.size }) : t("drive.totalItems", { count: nodes.length });
    const selectAll = button(t("drive.selectAll")); selectAll.addEventListener("click", () => { selected = new Set(sorted.map((node) => node.id)); void render(); });
    const clear = button(t("drive.clearSelection")); clear.addEventListener("click", () => { selected.clear(); void render(); });
    const batchDelete = button(t("drive.batchDelete")); batchDelete.disabled = !selected.size || listMode !== "browse"; batchDelete.addEventListener("click", async () => { if (!confirm(t("drive.batchDeleteConfirm", { count: selected.size }))) return; for (const id of selected) await api.deleteDriveNode(id); await load(); });
    appendChildren(controls, selection, selectAll, clear, batchDelete);
    for (const [key, label] of [["name", t("drive.sortName")], ["size", t("drive.sortSize")], ["updated", t("drive.sortDate")]] as const) { const sort = button(label); sort.addEventListener("click", () => { if (sortBy === key) sortDirection = sortDirection === 1 ? -1 : 1; else { sortBy = key; sortDirection = 1; } void render(); }); controls.appendChild(sort); }
    container.appendChild(controls);
    const list = document.createElement("div"); list.className = "drive-list";
    if (!sorted.length) { const empty = document.createElement("p"); empty.className = "drive-empty"; empty.textContent = listMode === "trash" ? t("drive.emptyTrash") : t("drive.emptyFiles"); list.appendChild(empty); }
    for (const node of sorted) list.appendChild(renderNode(node, listMode));
    container.appendChild(list);
    if (listMode === "browse" && nextCursor) {
      const more = button(t("drive.loadMore"));
      more.addEventListener("click", () => void loadMore());
      container.appendChild(more);
    }
  };

  const renderNode = (node: DriveNodeDto, listMode: "browse" | "trash" | null): HTMLElement => {
    const row = document.createElement("div"); row.className = `drive-row is-${node.kind}`;
    const check = document.createElement("input"); check.type = "checkbox"; check.checked = selected.has(node.id); check.setAttribute("aria-label", `${t("drive.select")} ${node.name}`); check.addEventListener("change", () => { if (check.checked) selected.add(node.id); else selected.delete(node.id); void render(); });
    const name = button(`${node.kind === "folder" ? "📁" : "📄"} ${node.name}`); name.className = "drive-name";
    name.addEventListener("click", () => { if (node.kind === "folder" && listMode === "browse") { currentParentId = node.id; path = [...path, { id: node.id, name: node.name }]; nextCursor = null; void load(); } else if (node.kind === "file" && listMode !== "trash") window.open(`/api/v1/drive/files/${encodeURIComponent(node.id)}/content`, "_blank", "noopener"); });
    const size = document.createElement("span"); size.className = "drive-size"; size.textContent = bytes(node.size);
    const modified = document.createElement("span"); modified.className = "drive-date"; modified.textContent = date(node.updatedAt);
    const actions = document.createElement("div"); actions.className = "drive-row-actions";
    if (listMode === "trash") {
      const restore = button(t("drive.restore")); restore.addEventListener("click", () => void doAction(() => api.restoreDriveNode(node.id), t("drive.restoreFailed"))); actions.appendChild(restore);
    } else {
      if (node.kind === "file") { const download = button(t("drive.download")); download.addEventListener("click", () => window.open(`/api/v1/drive/files/${encodeURIComponent(node.id)}/content?download=1`, "_blank", "noopener")); actions.appendChild(download); }
      const rename = button(t("drive.rename")); rename.addEventListener("click", () => { const next = prompt(t("drive.renamePrompt"), node.name); if (next && next !== node.name) void doAction(() => api.renameDriveNode(node.id, next, node.version), t("drive.renameFailed")); }); actions.appendChild(rename);
      const move = button(t("drive.move")); move.addEventListener("click", async () => { const target = await chooseFolder(node.kind === "folder" ? node.id : undefined); if (target) await doAction(() => api.moveDriveNode(node.id, target.id, node.version), t("drive.moveFailed")); }); actions.appendChild(move);
      const copy = button(t("drive.copy")); copy.addEventListener("click", async () => { const target = await chooseFolder(); if (!target) return; const nameValue = prompt(t("drive.copyNamePrompt"), t("drive.copySuffix", { name: node.name })); if (nameValue) await doAction(() => api.copyDriveNode(node.id, target.id, nameValue), t("drive.copyFailed")); }); actions.appendChild(copy);
      if (node.kind === "file") { const share = button(t("drive.share")); share.addEventListener("click", async () => { try { const result = await api.shareDriveNode(node.id); await navigator.clipboard?.writeText(result.url); alert(t("drive.shareResult", { code: result.code, url: result.url })); } catch (error) { alert(error instanceof Error ? error.message : t("drive.shareFailed")); } }); actions.appendChild(share); }
      const info = button(t("drive.info")); info.addEventListener("click", () => alert(t("drive.infoAlert", { name: node.name, type: node.kind === "folder" ? t("drive.folder") : (node.contentType || t("drive.file")), size: bytes(node.size), date: date(node.updatedAt) }))); actions.appendChild(info);
      const remove = button(t("drive.delete")); remove.addEventListener("click", () => { if (confirm(t("drive.deleteConfirm", { name: node.name }))) void doAction(() => api.deleteDriveNode(node.id), t("drive.deleteFailed")); }); actions.appendChild(remove);
    }
    appendChildren(row, check, name, size, modified, actions); return row;
  };

  const render = async () => {
    container.replaceChildren();
    const header = document.createElement("div"); header.className = "drive-header";
    const heading = document.createElement("h1"); heading.textContent = mode === "trash" ? t("drive.trashTitle") : mode === "search" ? t("drive.searchTitle") : t("drive.title");
    const actions = document.createElement("div"); actions.className = "drive-actions";
    const fileInput = document.createElement("input"); fileInput.type = "file"; fileInput.multiple = true; fileInput.hidden = true; fileInput.addEventListener("change", () => addFiles(Array.from(fileInput.files || [])));
    const upload = button(t("drive.uploadButton"), "primary-btn"); upload.addEventListener("click", () => fileInput.click());
    const folder = button(t("drive.newFolderButton")); folder.disabled = mode !== "browse"; folder.addEventListener("click", async () => { const name = prompt(t("drive.newFolderNamePrompt")); if (name) await doAction(() => api.createDriveFolder(name, current?.parent.id), t("drive.createFailed")); });
    const refresh = button(t("drive.refreshButton")); refresh.addEventListener("click", () => void load());
    const devices = button(t("drive.devicesButton")); devices.addEventListener("click", () => void openDevices());
    const trash = button(mode === "trash" ? t("drive.backToFilesButton") : t("drive.trashButton")); trash.addEventListener("click", () => { mode = mode === "trash" ? "browse" : "trash"; currentParentId = undefined; path = []; nextCursor = null; void load(); });
    appendChildren(actions, upload, folder, refresh, devices, trash, fileInput); appendChildren(header, heading, actions); container.appendChild(header);

    const searchBar = document.createElement("div"); searchBar.className = "drive-search-bar";
    const searchInput = document.createElement("input"); searchInput.type = "search"; searchInput.placeholder = t("drive.searchPlaceholder"); searchInput.value = searchQuery;
    const searchButton = button(t("drive.searchButton"), "primary-btn"); const clearSearch = button(t("drive.clearSearch"));
    searchButton.addEventListener("click", () => { searchQuery = searchInput.value.trim(); mode = searchQuery ? "search" : "browse"; void load(); });
    clearSearch.addEventListener("click", () => { searchInput.value = ""; searchQuery = ""; mode = "browse"; currentParentId = undefined; path = []; nextCursor = null; void load(); });
    searchInput.addEventListener("keydown", (event) => { if (event.key === "Enter") searchButton.click(); }); appendChildren(searchBar, searchInput, searchButton, clearSearch); container.appendChild(searchBar);
    const dropZone = document.createElement("div"); dropZone.className = "drive-drop-zone"; dropZone.textContent = t("drive.dropzoneHint");
    dropZone.addEventListener("dragover", (event) => { event.preventDefault(); dropZone.classList.add("is-over"); }); dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-over")); dropZone.addEventListener("drop", (event) => { event.preventDefault(); dropZone.classList.remove("is-over"); addFiles(Array.from(event.dataTransfer?.files || [])); }); container.appendChild(dropZone);
    if (uploads.length) {
      const queue = document.createElement("div"); queue.className = "drive-upload-queue"; const queueTitle = document.createElement("strong"); queueTitle.textContent = t("drive.uploadQueueTitle", { count: uploads.length }); queue.appendChild(queueTitle);
      for (const item of uploads.slice(-8)) {
        const row = document.createElement("div"); row.className = "drive-upload-row"; const label = document.createElement("span"); label.textContent = item.file.name; const status = document.createElement("span");
        status.textContent = item.state === "uploading" ? `${item.progress}%` : item.state === "failed" ? item.error || t("drive.queueStateFailed") : item.state === "cancelled" ? t("drive.queueStateCancelled") : item.state === "completed" ? t("drive.queueStateCompleted") : t("drive.queueStateQueued");
        appendChildren(row, label, status);
        if (item.state === "uploading" || item.state === "queued") { const cancel = button(t("drive.cancel")); cancel.addEventListener("click", () => { if (item.state === "queued") item.state = "cancelled"; else item.controller?.abort(); void render(); }); row.appendChild(cancel); }
        if (item.state === "failed" || item.state === "cancelled") { const retry = button(t("drive.retry")); retry.addEventListener("click", () => { item.state = "queued"; item.progress = 0; item.error = undefined; void pumpUploads(); void render(); }); row.appendChild(retry); }
        queue.appendChild(row);
      }
      container.appendChild(queue);
    }
    if (loading) { const loadingText = document.createElement("p"); loadingText.textContent = t("drive.loading"); container.appendChild(loadingText); return; }
    if (loadError) {
      const errorBox = document.createElement("div");
      errorBox.className = "drive-empty";
      errorBox.style.display = "flex";
      errorBox.style.flexDirection = "column";
      errorBox.style.alignItems = "center";
      errorBox.style.gap = "12px";
      const message = document.createElement("p"); message.textContent = loadError; errorBox.appendChild(message);
      if (loadErrorStatus === 401) {
        const loginBtn = button(t("drive.loginAdmin"), "primary-btn");
        loginBtn.addEventListener("click", () => router.navigate("/admin"));
        errorBox.appendChild(loginBtn);
      }
      container.appendChild(errorBox);
      return;
    }
    if (mode === "search") { try { appendNodeList(await api.searchDrive(searchQuery), null); } catch (error) { renderError(error instanceof Error ? error.message : t("drive.searchFailed"), error instanceof ApiClientError ? error.status : undefined); } return; }
    if (mode === "trash") { try { appendNodeList(await api.listDriveTrash(), "trash"); } catch (error) { renderError(error instanceof Error ? error.message : t("drive.trashLoadFailed"), error instanceof ApiClientError ? error.status : undefined); } return; }
    if (!current) return;
    const breadcrumbs = document.createElement("div"); breadcrumbs.className = "drive-breadcrumbs"; const root = button(t("drive.rootFolder")); root.className = "drive-crumb"; root.addEventListener("click", () => { currentParentId = undefined; path = []; nextCursor = null; void load(); }); breadcrumbs.appendChild(root);
    for (const crumb of path) { const sep = document.createElement("span"); sep.textContent = " / "; breadcrumbs.appendChild(sep); const link = button(crumb.name); link.className = "drive-crumb"; link.addEventListener("click", () => { const index = path.findIndex((entry) => entry.id === crumb.id); path = path.slice(0, index + 1); currentParentId = crumb.id; nextCursor = null; void load(); }); breadcrumbs.appendChild(link); }
    container.appendChild(breadcrumbs); appendNodeList(current.nodes, "browse");
  };

  await render();
  await load();
  return container;
}

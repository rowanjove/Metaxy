import { t, formatBytes, formatDateTime } from "../i18n";
import { api, ApiClientError } from "../api";
import { router } from "../router";
import type {
  AdminDropRowDto,
  AdminOverviewData,
  AdminSettingsData,
  UpdateSettingsRequest
} from "../../shared/contracts";

export async function createAdminPage(): Promise<HTMLElement> {
  const container = document.createElement("div");
  container.className = "admin-view";

  // Check admin session by querying overview
  let overview: AdminOverviewData;
  try {
    overview = await api.getAdminOverview();
  } catch (err: any) {
    if (err instanceof ApiClientError && err.status === 401) {
      router.navigate("/admin/login");
      return container;
    }
    const errBox = document.createElement("div");
    errBox.className = "notice-box is-error";
    errBox.textContent = err.message || "Failed to load admin panel.";
    container.appendChild(errBox);
    return container;
  }

  // Top Nav Bar
  const nav = document.createElement("div");
  nav.className = "admin-nav";

  const tabsGroup = document.createElement("div");
  tabsGroup.className = "admin-tabs";

  const overviewTabBtn = document.createElement("button");
  overviewTabBtn.className = "admin-tab-btn is-active";
  overviewTabBtn.textContent = t("admin.overviewTab");

  const dropsTabBtn = document.createElement("button");
  dropsTabBtn.className = "admin-tab-btn";
  dropsTabBtn.textContent = t("admin.dropsTab");

  const settingsTabBtn = document.createElement("button");
  settingsTabBtn.className = "admin-tab-btn";
  settingsTabBtn.textContent = t("admin.settingsTab");

  tabsGroup.appendChild(overviewTabBtn);
  tabsGroup.appendChild(dropsTabBtn);
  tabsGroup.appendChild(settingsTabBtn);

  const authActions = document.createElement("div");
  authActions.style.display = "flex";
  authActions.style.gap = "8px";

  const logoutBtn = document.createElement("button");
  logoutBtn.className = "btn btn-secondary btn-sm";
  logoutBtn.textContent = t("admin.logoutButton");

  const logoutAllBtn = document.createElement("button");
  logoutAllBtn.className = "btn btn-danger btn-sm";
  logoutAllBtn.textContent = t("admin.logoutAllButton");

  logoutBtn.addEventListener("click", async () => {
    await api.adminLogout();
    router.navigate("/admin/login");
  });

  logoutAllBtn.addEventListener("click", async () => {
    await api.adminLogoutAll();
    router.navigate("/admin/login");
  });

  authActions.appendChild(logoutBtn);
  authActions.appendChild(logoutAllBtn);

  nav.appendChild(tabsGroup);
  nav.appendChild(authActions);
  container.appendChild(nav);

  // Tab Content Container
  const tabContent = document.createElement("div");
  container.appendChild(tabContent);
  let tabVersion = 0;

  // Render Tabs
  function showOverviewTab() {
    tabVersion++;
    overviewTabBtn.className = "admin-tab-btn is-active";
    dropsTabBtn.className = "admin-tab-btn";
    settingsTabBtn.className = "admin-tab-btn";

    const statsGrid = document.createElement("div");
    statsGrid.className = "stats-grid";

    const cards = [
      { label: t("admin.activeDrops"), val: String(overview.activeDropsCount) },
      { label: t("admin.createdToday"), val: String(overview.createdTodayCount) },
      { label: t("admin.totalStorage"), val: formatBytes(overview.activeTotalFileBytes) },
      { label: t("admin.expiring24h"), val: String(overview.expiringIn24hCount) }
    ];

    for (const c of cards) {
      const card = document.createElement("div");
      card.className = "stat-card";

      const label = document.createElement("span");
      label.className = "stat-label";
      label.textContent = c.label;

      const val = document.createElement("span");
      val.className = "stat-value";
      val.textContent = c.val;

      card.appendChild(label);
      card.appendChild(val);
      statsGrid.appendChild(card);
    }

    tabContent.replaceChildren(statsGrid);
  }

  async function showDropsTab() {
    const currentTabVersion = ++tabVersion;
    overviewTabBtn.className = "admin-tab-btn";
    dropsTabBtn.className = "admin-tab-btn is-active";
    settingsTabBtn.className = "admin-tab-btn";

    const pane = document.createElement("div");
    pane.style.display = "flex";
    pane.style.flexDirection = "column";
    pane.style.gap = "16px";

    const controls = document.createElement("div");
    controls.className = "table-controls";

    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "search-input";
    searchInput.placeholder = t("admin.searchPlaceholder");

    const statusSelect = document.createElement("select");
    statusSelect.innerHTML = `
      <option value="">${t("admin.allStatus")}</option>
      <option value="active">${t("admin.statusActive")}</option>
      <option value="expired">${t("admin.statusExpired")}</option>
      <option value="revoked">${t("admin.statusRevoked")}</option>
      <option value="deleting">${t("admin.statusDeleting")}</option>
    `;

    controls.appendChild(searchInput);
    controls.appendChild(statusSelect);
    pane.appendChild(controls);

    const tableWrapper = document.createElement("div");
    tableWrapper.className = "table-wrapper";
    pane.appendChild(tableWrapper);

    let tableRequestVersion = 0;
    async function loadTable(cursor?: string) {
      const requestVersion = ++tableRequestVersion;
      const res = await api.getAdminDrops({
        cursor,
        search: searchInput.value.trim(),
        status: statusSelect.value || undefined
      });

      if (currentTabVersion !== tabVersion || requestVersion !== tableRequestVersion) return;
      renderTableRows(tableWrapper, res.drops, loadTable);
    }

    searchInput.addEventListener("input", () => loadTable());
    statusSelect.addEventListener("change", () => loadTable());

    await loadTable();
    if (currentTabVersion !== tabVersion) return;
    tabContent.replaceChildren(pane);
  }

  async function showSettingsTab() {
    const currentTabVersion = ++tabVersion;
    overviewTabBtn.className = "admin-tab-btn";
    dropsTabBtn.className = "admin-tab-btn";
    settingsTabBtn.className = "admin-tab-btn is-active";

    const settingsData: AdminSettingsData = await api.getAdminSettings();
    if (currentTabVersion !== tabVersion) return;
    const { settings, readonly } = settingsData;

    const pane = document.createElement("div");
    pane.className = "pane-card";

    const form = document.createElement("form");
    form.className = "composer-form";

    const noticeBox = document.createElement("div");
    noticeBox.className = "notice-box";
    noticeBox.style.display = "none";

    const grid = document.createElement("div");
    grid.className = "settings-grid";

    // Site Name
    const siteNameGroup = createSettingInput("Site Name", "site_name", settings.site_name);
    // Default Expiry
    const defaultExpGroup = createSettingInput("Default Expiry (Seconds)", "default_expiry_seconds", String(settings.default_expiry_seconds), "number");
    // Max Expiry
    const maxExpGroup = createSettingInput("Max Expiry (Seconds)", "max_expiry_seconds", String(settings.max_expiry_seconds), "number");
    // Max File Bytes
    const maxFileGroup = createSettingInput("Max File Bytes", "max_file_bytes", String(settings.max_file_bytes), "number");
    // Max Drop File Bytes
    const maxDropFileGroup = createSettingInput("Max Drop File Bytes", "max_drop_file_bytes", String(settings.max_drop_file_bytes), "number");
    // Max Files Per Drop
    const maxFilesPerDropGroup = createSettingInput("Max Files Per Drop", "max_files_per_drop", String(settings.max_files_per_drop), "number");
    // Max Text Bytes
    const maxTextBytesGroup = createSettingInput("Max Text Bytes", "max_text_bytes", String(settings.max_text_bytes), "number");
    // Code Length
    const codeLenGroup = createSettingInput("Code Length (5-8)", "code_length", String(settings.code_length), "number");

    grid.appendChild(siteNameGroup);
    grid.appendChild(defaultExpGroup);
    grid.appendChild(maxExpGroup);
    grid.appendChild(maxFileGroup);
    grid.appendChild(maxDropFileGroup);
    grid.appendChild(maxFilesPerDropGroup);
    grid.appendChild(maxTextBytesGroup);
    grid.appendChild(codeLenGroup);

    // Risky Files checkbox
    const riskyCheckGroup = document.createElement("div");
    riskyCheckGroup.style.display = "flex";
    riskyCheckGroup.style.alignItems = "center";
    riskyCheckGroup.style.gap = "8px";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.id = "allow_risky";
    check.checked = settings.allow_public_risky_files;

    const checkLabel = document.createElement("label");
    checkLabel.htmlFor = "allow_risky";
    checkLabel.textContent = "Allow executable/risky files in Public upload mode";

    riskyCheckGroup.appendChild(check);
    riskyCheckGroup.appendChild(checkLabel);

    // Save Button
    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.className = "btn btn-primary";
    saveBtn.textContent = t("admin.saveSettings");

    form.appendChild(grid);
    form.appendChild(riskyCheckGroup);
    form.appendChild(noticeBox);
    form.appendChild(saveBtn);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      saveBtn.disabled = true;

      const payload: UpdateSettingsRequest = {
        site_name: (siteNameGroup.querySelector("input") as HTMLInputElement).value,
        default_expiry_seconds: Number((defaultExpGroup.querySelector("input") as HTMLInputElement).value),
        max_expiry_seconds: Number((maxExpGroup.querySelector("input") as HTMLInputElement).value),
        max_file_bytes: Number((maxFileGroup.querySelector("input") as HTMLInputElement).value),
        max_drop_file_bytes: Number((maxDropFileGroup.querySelector("input") as HTMLInputElement).value),
        max_files_per_drop: Number((maxFilesPerDropGroup.querySelector("input") as HTMLInputElement).value),
        max_text_bytes: Number((maxTextBytesGroup.querySelector("input") as HTMLInputElement).value),
        code_length: Number((codeLenGroup.querySelector("input") as HTMLInputElement).value),
        allow_public_risky_files: check.checked
      };

      try {
        await api.updateAdminSettings(payload);
        noticeBox.textContent = t("admin.settingsSaved");
        noticeBox.className = "notice-box is-success";
        noticeBox.style.display = "flex";
      } catch (err: any) {
        noticeBox.textContent = err.message || "Failed to update settings.";
        noticeBox.className = "notice-box is-error";
        noticeBox.style.display = "flex";
      } finally {
        saveBtn.disabled = false;
      }
    });

    pane.appendChild(form);
    tabContent.replaceChildren(pane);
  }

  overviewTabBtn.addEventListener("click", showOverviewTab);
  dropsTabBtn.addEventListener("click", showDropsTab);
  settingsTabBtn.addEventListener("click", showSettingsTab);

  // Default to overview tab
  showOverviewTab();

  return container;
}

function createSettingInput(label: string, name: string, value: string, type: string = "text"): HTMLElement {
  const group = document.createElement("div");
  group.className = "form-group";

  const lbl = document.createElement("label");
  lbl.className = "form-label";
  lbl.textContent = label;

  const input = document.createElement("input");
  input.type = type;
  input.name = name;
  input.value = value;

  group.appendChild(lbl);
  group.appendChild(input);
  return group;
}

function renderTableRows(
  container: HTMLElement,
  drops: AdminDropRowDto[],
  onRefresh: () => void
): void {
  const table = document.createElement("table");
  table.className = "admin-table";

  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>${t("admin.tableCode")}</th>
      <th>${t("admin.tableStatus")}</th>
      <th>${t("admin.tableContent")}</th>
      <th>${t("admin.tableSize")}</th>
      <th>${t("admin.tableCreated")}</th>
      <th>${t("admin.tableExpires")}</th>
      <th>${t("admin.tableViews")}</th>
      <th>${t("admin.tableActions")}</th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const drop of drops) {
    const tr = document.createElement("tr");

    const codeTd = document.createElement("td");
    const codeLink = document.createElement("a");
    codeLink.href = `/d/${drop.code}`;
    codeLink.target = "_blank";
    codeLink.style.fontFamily = "var(--font-mono)";
    codeLink.style.fontWeight = "600";
    codeLink.textContent = drop.code;
    codeTd.appendChild(codeLink);

    const statusTd = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge badge-${drop.status}`;
    badge.textContent = drop.status;
    statusTd.appendChild(badge);

    const contentTd = document.createElement("td");
    if (drop.hasText && drop.fileCount > 0) {
      contentTd.textContent = `混合 (${drop.fileCount} 文件)`;
    } else if (drop.hasText) {
      contentTd.textContent = "纯文本";
    } else if (drop.fileCount > 0) {
      contentTd.textContent = `${drop.fileCount} 个文件`;
    } else {
      contentTd.textContent = "-";
    }

    const sizeTd = document.createElement("td");
    sizeTd.textContent = formatBytes(drop.totalSize);

    const createdTd = document.createElement("td");
    createdTd.textContent = formatDateTime(drop.createdAt);

    const expiresTd = document.createElement("td");
    expiresTd.textContent = formatDateTime(drop.expiresAt);

    const viewsTd = document.createElement("td");
    viewsTd.textContent = String(drop.viewCount);

    const actionsTd = document.createElement("td");
    actionsTd.style.display = "flex";
    actionsTd.style.gap = "6px";

    if (drop.status === "active") {
      const extendBtn = document.createElement("button");
      extendBtn.className = "btn btn-secondary btn-sm";
      extendBtn.textContent = t("admin.extend24h");
      extendBtn.addEventListener("click", async () => {
        await api.patchAdminDrop(drop.id, "extend", 86400);
        onRefresh();
      });

      const revokeBtn = document.createElement("button");
      revokeBtn.className = "btn btn-danger btn-sm";
      revokeBtn.textContent = t("admin.revokeAction");
      revokeBtn.addEventListener("click", async () => {
        if (confirm(t("admin.confirmRevoke"))) {
          await api.patchAdminDrop(drop.id, "revoke");
          onRefresh();
        }
      });

      actionsTd.appendChild(extendBtn);
      actionsTd.appendChild(revokeBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-ghost btn-sm";
    deleteBtn.textContent = t("admin.deleteAction");
    deleteBtn.addEventListener("click", async () => {
      if (confirm(t("admin.confirmDelete"))) {
        await api.deleteAdminDrop(drop.id);
        onRefresh();
      }
    });
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(codeTd);
    tr.appendChild(statusTd);
    tr.appendChild(contentTd);
    tr.appendChild(sizeTd);
    tr.appendChild(createdTd);
    tr.appendChild(expiresTd);
    tr.appendChild(viewsTd);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  container.replaceChildren(table);
}

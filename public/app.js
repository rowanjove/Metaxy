const state = {
  config: {
    appName: "PocketRelay",
    archiveRetentionHours: 72,
    coolingAfterHours: 24,
    maxImageBytes: 10 * 1024 * 1024
  },
  cards: [],
  archiveItems: [],
  archivePassword: "",
  activeTab: "active",
  deleteCandidateId: null,
  archiveSearch: ""
};

const ui = {
  appName: document.querySelector("#app-name"),
  archiveStatus: document.querySelector("#archive-status"),
  statusMessage: document.querySelector("#status-message"),
  shortcutEndpoint: document.querySelector("#shortcut-endpoint"),
  shortcutStatus: document.querySelector("#shortcut-status"),
  composerForm: document.querySelector("#composer-form"),
  composerInput: document.querySelector("#composer-input"),
  refreshButton: document.querySelector("#refresh-button"),
  imageInput: document.querySelector("#image-input"),
  uploadHint: document.querySelector("#upload-hint"),
  activeList: document.querySelector("#active-list"),
  activeCount: document.querySelector("#active-count"),
  archiveList: document.querySelector("#archive-list"),
  archiveSearch: document.querySelector("#archive-search"),
  archivePasswordForm: document.querySelector("#archive-password-form"),
  archivePasswordInput: document.querySelector("#archive-password"),
  clearPasswordButton: document.querySelector("#clear-password-button"),
  tabActive: document.querySelector("#tab-active"),
  tabArchive: document.querySelector("#tab-archive"),
  activeView: document.querySelector("#active-view"),
  archiveView: document.querySelector("#archive-view"),
  lightbox: document.querySelector("#lightbox"),
  lightboxImage: document.querySelector("#lightbox-image"),
  emptyStateTemplate: document.querySelector("#empty-state-template")
};

let statusTimer = null;

boot().catch((error) => {
  console.error(error);
  notify("初始化失败，请刷新重试。", true);
});

async function boot() {
  bindEvents();
  await loadMeta();
  await loadCards();
  render();
}

function bindEvents() {
  ui.composerForm.addEventListener("submit", handlePushSubmit);
  ui.refreshButton.addEventListener("click", async () => {
    try {
      await loadCards();
      if (state.archivePassword) {
        await loadArchive();
      }
      render();
      notify("列表已刷新。");
    } catch (error) {
      console.error(error);
      notify(error instanceof Error ? error.message : "刷新失败。", true);
    }
  });

  ui.imageInput.addEventListener("change", handleImageUpload);
  ui.archivePasswordForm.addEventListener("submit", handleArchiveUnlock);
  ui.clearPasswordButton.addEventListener("click", () => {
    state.archivePassword = "";
    state.archiveItems = [];
    ui.archivePasswordInput.value = "";
    render();
  });

  ui.archiveSearch.addEventListener("input", (event) => {
    state.archiveSearch = event.currentTarget.value.trim().toLowerCase();
    renderArchive();
  });

  ui.tabActive.addEventListener("click", () => switchTab("active"));
  ui.tabArchive.addEventListener("click", async () => {
    switchTab("archive");
    if (state.archivePassword && !state.archiveItems.length) {
      try {
        await loadArchive();
        renderArchive();
      } catch (error) {
        console.error(error);
        notify(error instanceof Error ? error.message : "归档加载失败。", true);
      }
    }
  });

  ui.lightbox.addEventListener("click", (event) => {
    if (event.target === ui.lightbox) {
      ui.lightbox.close();
    }
  });
}

async function loadMeta() {
  const response = await fetchJson("/api/meta");
  state.config = response;
  document.title = response.appName;
  ui.appName.textContent = response.appName;
  ui.shortcutEndpoint.textContent = `${response.shortcutEndpoint}?token=YOUR_TOKEN`;
  ui.uploadHint.textContent = `单张 ${Math.round(response.maxImageBytes / 1024 / 1024)}MB 以内。启用归档密码后，会同步生成历史密文副本。`;
  ui.shortcutStatus.textContent = response.shortcutEnabled
    ? "快捷指令入口已启用，把你设置的 token 拼到上面的 URL 即可。"
    : "尚未检测到快捷指令 token，部署后请执行 `wrangler secret put SHORTCUT_TOKEN`。";
}

async function loadCards() {
  const response = await fetchJson("/api/cards");
  state.cards = response.items;
}

async function loadArchive() {
  disposeArchiveObjectUrls();
  const response = await fetchJson("/api/archive");
  const decrypted = [];

  for (const item of response.items) {
    if (!item.archiveCiphertext || !item.archiveSalt || !item.archiveIv) {
      continue;
    }

    const payload = await decryptJsonPayload(
      state.archivePassword,
      item.archiveSalt,
      item.archiveIv,
      item.archiveCiphertext
    );

    let imageUrl = null;
    if (item.archiveBlobUrl && item.archiveBlobIv) {
      const encryptedBlob = await fetch(item.archiveBlobUrl);
      if (encryptedBlob.ok) {
        const arrayBuffer = await encryptedBlob.arrayBuffer();
        const fileType = payload.fileType || "application/octet-stream";
        const plainBuffer = await decryptBytesPayload(
          state.archivePassword,
          item.archiveSalt,
          item.archiveBlobIv,
          arrayBuffer
        );
        const blob = new Blob([plainBuffer], { type: fileType });
        imageUrl = URL.createObjectURL(blob);
      }
    }

    decrypted.push({
      ...item,
      payload,
      imageUrl
    });
  }

  state.archiveItems = decrypted;
}

function switchTab(tab) {
  state.activeTab = tab;
  ui.tabActive.classList.toggle("is-active", tab === "active");
  ui.tabArchive.classList.toggle("is-active", tab === "archive");
  ui.activeView.classList.toggle("is-hidden", tab !== "active");
  ui.archiveView.classList.toggle("is-hidden", tab !== "archive");
}

async function handlePushSubmit(event) {
  event.preventDefault();

  const content = ui.composerInput.value.trim();
  if (!content) {
    notify("先输入一点内容。", true);
    return;
  }

  try {
    const archivePayload = state.archivePassword ? await buildTextArchivePayload(content) : null;

    await fetchJson("/api/push", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        content,
        archivePayload
      })
    });

    ui.composerInput.value = "";
    await loadCards();
    renderActive();
    notify("已推送。");
  } catch (error) {
    console.error(error);
    notify(error instanceof Error ? error.message : "推送失败。", true);
  }
}

async function handleImageUpload(event) {
  const files = [...(event.currentTarget.files || [])];
  if (!files.length) {
    return;
  }

  try {
    for (const file of files) {
      if (file.size > state.config.maxImageBytes) {
        notify(`${file.name} 超过大小限制，已跳过。`, true);
        continue;
      }

      const formData = new FormData();
      formData.append("file", file);

      if (state.archivePassword) {
        const imageArchive = await buildImageArchivePayload(file);
        formData.append("archiveSalt", imageArchive.salt);
        formData.append("archiveIv", imageArchive.metaIv);
        formData.append("archiveCiphertext", imageArchive.metaCiphertext);
        formData.append("archiveBlobIv", imageArchive.blobIv);
        formData.append("archiveBlob", new Blob([imageArchive.encryptedBytes]));
      }

      await fetchJson("/api/image", {
        method: "POST",
        body: formData
      });
    }

    ui.imageInput.value = "";
    await loadCards();
    renderActive();
    notify("图片已上传。");
  } catch (error) {
    console.error(error);
    notify(error instanceof Error ? error.message : "图片上传失败。", true);
  }
}

async function handleArchiveUnlock(event) {
  event.preventDefault();
  const password = ui.archivePasswordInput.value;
  if (!password) {
    notify("请输入归档密码。", true);
    return;
  }

  try {
    state.archivePassword = password;
    await loadArchive();
    const preparedCount = await prepareActiveArchiveMaterials();
    if (preparedCount > 0) {
      await loadCards();
    }
    render();
    notify(preparedCount > 0 ? `归档已启用，已补齐 ${preparedCount} 张现有卡片。` : "归档已解锁。");
  } catch (error) {
    console.error(error);
    state.archivePassword = "";
    state.archiveItems = [];
    notify(error instanceof Error ? error.message : "归档解锁失败。", true);
    render();
  }
}

function render() {
  renderActive();
  renderArchive();
  ui.archiveStatus.textContent = state.archivePassword ? "归档密码已启用" : "未启用归档密码";
}

function renderActive() {
  ui.activeCount.textContent = `${state.cards.length} 条`;
  ui.activeList.replaceChildren();

  if (!state.cards.length) {
    ui.activeList.append(ui.emptyStateTemplate.content.cloneNode(true));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const card of state.cards) {
    fragment.append(buildActiveCard(card));
  }
  ui.activeList.append(fragment);
  highlightCodeBlocks(ui.activeList);
}

function renderArchive() {
  ui.archiveList.replaceChildren();

  if (!state.archivePassword) {
    ui.archiveList.append(createMessageState("输入归档密码后才能查看历史。"));
    return;
  }

  if (!state.archiveItems.length) {
    ui.archiveList.append(createMessageState("还没有可解锁的历史内容。"));
    return;
  }

  const groups = groupArchiveItems();
  const fragment = document.createDocumentFragment();
  for (const [date, items] of groups) {
    const details = document.createElement("details");
    details.className = "archive-day";
    details.open = true;

    const summary = document.createElement("summary");
    summary.className = "archive-day-summary";
    summary.innerHTML = `
      <div class="card-summary-top">
        <strong>${date}</strong>
        <span class="hint-badge">${items.length} 条</span>
      </div>
    `;

    const content = document.createElement("div");
    content.className = "archive-day-content";
    for (const item of items) {
      content.append(buildArchiveCard(item));
    }

    details.append(summary, content);
    fragment.append(details);
  }

  ui.archiveList.append(fragment);
  highlightCodeBlocks(ui.archiveList);
}

function buildActiveCard(card) {
  const details = document.createElement("details");
  details.className = `relay-card ${card.phase === "cooling" ? "is-cooling" : ""}`;
  details.dataset.type = card.type;

  const summary = document.createElement("summary");
  summary.className = "card-summary";
  summary.innerHTML = `
    <div class="card-summary-top">
      <div class="card-meta">
        <span class="type-pill">${card.type}</span>
        <span title="${new Date(card.createdAt).toLocaleString()}">${timeAgo(card.createdAt)}</span>
      </div>
      ${card.phase === "cooling" ? '<span class="cooling-note">72h 后归档</span>' : ""}
    </div>
    <div class="card-preview">${escapeHtml(card.preview || "(空内容)")}</div>
  `;

  const body = document.createElement("div");
  body.className = "card-body";
  body.append(renderCardContent(card));

  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.append(
    actionButton("复制", async () => {
      await copyCard(card);
    }),
    actionButton("删除", () => {
      state.deleteCandidateId = state.deleteCandidateId === card.id ? null : card.id;
      renderActive();
    })
  );
  body.append(actions);

  if (state.deleteCandidateId === card.id) {
    const deleteRow = document.createElement("div");
    deleteRow.className = "delete-row";
    deleteRow.innerHTML = `<strong>确定删除？</strong><span>这张卡片和它的归档材料都会被移除。</span>`;
    deleteRow.append(
      actionButton("确认删除", async () => {
        try {
          await fetchJson(`/api/cards/${encodeURIComponent(card.id)}`, { method: "DELETE" });
          state.deleteCandidateId = null;
          await loadCards();
          if (state.archivePassword) {
            await loadArchive();
          }
          render();
          notify("已删除。");
        } catch (error) {
          console.error(error);
          notify(error instanceof Error ? error.message : "删除失败。", true);
        }
      }),
      actionButton("取消", () => {
        state.deleteCandidateId = null;
        renderActive();
      })
    );
    body.append(deleteRow);
  }

  details.append(summary, body);
  return details;
}

function buildArchiveCard(item) {
  const details = document.createElement("details");
  details.className = "relay-card";
  details.dataset.type = item.payload.type || item.type;

  const previewText =
    item.payload.type === "image"
      ? item.payload.fileName || "Archived image"
      : item.payload.title || item.payload.content || "(空内容)";

  const summary = document.createElement("summary");
  summary.className = "card-summary";
  summary.innerHTML = `
    <div class="card-summary-top">
      <div class="card-meta">
        <span class="type-pill">${item.payload.type || item.type}</span>
        <span>${new Date(item.createdAt).toLocaleString()}</span>
      </div>
    </div>
    <div class="card-preview">${escapeHtml(summarize(previewText))}</div>
  `;

  const body = document.createElement("div");
  body.className = "card-body";
  body.append(renderArchiveContent(item));
  body.append(
    actionButton("复制", async () => {
      const content =
        item.payload.type === "image"
          ? item.payload.fileName || "image"
          : item.payload.content || "";
      await copyText(content);
      notify("已复制。");
    })
  );

  details.append(summary, body);
  return details;
}

function renderCardContent(card) {
  if (card.type === "image" && card.imageUrl) {
    const wrapper = document.createElement("div");
    wrapper.className = "image-preview";

    const image = document.createElement("img");
    image.src = card.imageUrl;
    image.alt = card.title || "Image";
    image.addEventListener("click", () => openLightbox(card.imageUrl, card.title || "Image"));

    const buttonRow = document.createElement("div");
    buttonRow.className = "card-actions";
    buttonRow.append(
      actionButton("查看大图", () => openLightbox(card.imageUrl, card.title || "Image")),
      actionButton("下载原图", () => window.open(card.imageUrl, "_blank", "noopener"))
    );

    wrapper.append(image, buttonRow);
    return wrapper;
  }

  if (card.type === "code") {
    const pre = document.createElement("pre");
    pre.className = "card-code";

    const code = document.createElement("code");
    const language = normalizePrismLanguage(card.lang);
    if (language) {
      code.className = `language-${language}`;
    }
    code.textContent = card.content || "";
    pre.append(code);
    return pre;
  }

  const block = document.createElement(card.type === "link" ? "a" : "div");
  block.className = card.type === "link" ? "card-link" : "card-text";
  block.textContent = card.content || "";

  if (card.type === "link") {
    block.href = card.content || "#";
    block.target = "_blank";
    block.rel = "noopener noreferrer";
  }

  return block;
}

function renderArchiveContent(item) {
  if (item.payload.type === "image" && item.imageUrl) {
    const wrapper = document.createElement("div");
    wrapper.className = "image-preview";

    const image = document.createElement("img");
    image.src = item.imageUrl;
    image.alt = item.payload.fileName || "Archived image";
    image.addEventListener("click", () => openLightbox(item.imageUrl, item.payload.fileName || "Archived image"));

    wrapper.append(image);
    return wrapper;
  }

  if (item.payload.type === "code") {
    const pre = document.createElement("pre");
    pre.className = "card-code";
    const code = document.createElement("code");
    const language = normalizePrismLanguage(item.payload.lang);
    if (language) {
      code.className = `language-${language}`;
    }
    code.textContent = item.payload.content || "";
    pre.append(code);
    return pre;
  }

  const block = document.createElement(item.payload.type === "link" ? "a" : "div");
  block.className = item.payload.type === "link" ? "card-link" : "card-text";
  block.textContent = item.payload.content || "";

  if (item.payload.type === "link") {
    block.href = item.payload.content || "#";
    block.target = "_blank";
    block.rel = "noopener noreferrer";
  }

  return block;
}

function groupArchiveItems() {
  const filtered = state.archiveItems.filter((item) => {
    if (!state.archiveSearch) {
      return true;
    }

    const haystack = JSON.stringify(item.payload).toLowerCase();
    return haystack.includes(state.archiveSearch);
  });

  const groups = new Map();
  for (const item of filtered) {
    const date = item.archiveDate || new Date(item.createdAt).toISOString().slice(0, 10);
    const current = groups.get(date) || [];
    current.push(item);
    groups.set(date, current);
  }
  return groups;
}

function actionButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-action";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function createMessageState(message) {
  const wrapper = document.createElement("div");
  wrapper.className = "empty-state";
  wrapper.innerHTML = `<p>${escapeHtml(message)}</p>`;
  return wrapper;
}

async function prepareActiveArchiveMaterials() {
  const candidates = state.cards.filter((card) => !card.hasArchiveMaterial);
  if (!candidates.length) {
    return 0;
  }

  notify("正在为现有卡片补齐归档材料...");
  let preparedCount = 0;

  for (const card of candidates) {
    let prepared = false;
    if (card.type === "image") {
      prepared = await prepareImageArchiveMaterial(card);
    } else {
      await prepareTextArchiveMaterial(card);
      prepared = true;
    }

    if (prepared) {
      preparedCount += 1;
    }
  }

  return preparedCount;
}

async function prepareTextArchiveMaterial(card) {
  const archivePayload = await buildTextArchivePayloadFromCard(card);
  await fetchJson(`/api/cards/${encodeURIComponent(card.id)}/archive-material`, {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ archivePayload })
  });
}

async function prepareImageArchiveMaterial(card) {
  if (!card.imageUrl) {
    return false;
  }

  const response = await fetch(card.imageUrl);
  if (!response.ok) {
    throw new Error(`图片归档材料生成失败: ${response.status}`);
  }

  const blob = await response.blob();
  const imageArchive = await buildImageArchivePayloadFromBlob(
    blob,
    card.title || "image",
    response.headers.get("content-type") || blob.type || "application/octet-stream"
  );

  const formData = new FormData();
  formData.append("archiveSalt", imageArchive.salt);
  formData.append("archiveIv", imageArchive.metaIv);
  formData.append("archiveCiphertext", imageArchive.metaCiphertext);
  formData.append("archiveBlobIv", imageArchive.blobIv);
  formData.append("archiveBlob", new Blob([imageArchive.encryptedBytes]));

  await fetchJson(`/api/cards/${encodeURIComponent(card.id)}/archive-material`, {
    method: "PUT",
    body: formData
  });

  return true;
}

async function copyCard(card) {
  const content = card.type === "image" ? card.imageUrl || "" : card.content || "";
  await copyText(content);
  notify("已复制。");
}

async function copyText(value) {
  await navigator.clipboard.writeText(value);
}

function disposeArchiveObjectUrls() {
  for (const item of state.archiveItems) {
    if (item.imageUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(item.imageUrl);
    }
  }
}

function notify(message, isError = false) {
  if (statusTimer) {
    window.clearTimeout(statusTimer);
  }

  ui.statusMessage.textContent = message;
  ui.statusMessage.classList.toggle("is-error", isError);
  statusTimer = window.setTimeout(() => {
    ui.statusMessage.textContent = "";
    ui.statusMessage.classList.remove("is-error");
  }, isError ? 5000 : 3000);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function buildTextArchivePayload(content) {
  const type = detectTextType(content);
  const lang = type === "code" ? detectCodeLanguage(content) : null;
  return encryptJsonPayload(state.archivePassword, {
    type,
    content,
    lang
  });
}

async function buildTextArchivePayloadFromCard(card) {
  const content = card.content || "";
  const type = card.type === "link" || card.type === "code" ? card.type : detectTextType(content);
  return encryptJsonPayload(state.archivePassword, {
    type,
    content,
    title: card.title || null,
    lang: card.lang || (type === "code" ? detectCodeLanguage(content) : null)
  });
}

async function buildImageArchivePayload(file) {
  return buildImageArchivePayloadFromBlob(file, file.name, file.type || "application/octet-stream");
}

async function buildImageArchivePayloadFromBlob(blob, fileName, fileType) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveArchiveKey(state.archivePassword, salt);

  const metadataEncryption = await encryptWithKey(
    key,
    JSON.stringify({
      type: "image",
      fileName,
      fileType
    })
  );

  const bytesEncryption = await encryptBytesWithKey(key, await blob.arrayBuffer());

  return {
    salt: bytesToBase64(salt),
    metaIv: bytesToBase64(metadataEncryption.iv),
    metaCiphertext: bytesToBase64(metadataEncryption.ciphertext),
    blobIv: bytesToBase64(bytesEncryption.iv),
    encryptedBytes: bytesEncryption.ciphertext
  };
}

async function encryptJsonPayload(password, payload) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveArchiveKey(password, salt);
  const encrypted = await encryptWithKey(key, JSON.stringify(payload));
  return {
    salt: bytesToBase64(salt),
    iv: bytesToBase64(encrypted.iv),
    ciphertext: bytesToBase64(encrypted.ciphertext)
  };
}

async function decryptJsonPayload(password, saltB64, ivB64, ciphertextB64) {
  const key = await deriveArchiveKey(password, base64ToBytes(saltB64));
  const plainBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(ivB64)
    },
    key,
    base64ToBytes(ciphertextB64)
  );
  return JSON.parse(new TextDecoder().decode(plainBuffer));
}

async function decryptBytesPayload(password, saltB64, ivB64, ciphertextBuffer) {
  const key = await deriveArchiveKey(password, base64ToBytes(saltB64));
  return crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(ivB64)
    },
    key,
    ciphertextBuffer
  );
}

async function deriveArchiveKey(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 250000,
      hash: "SHA-256"
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptWithKey(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv
    },
    key,
    new TextEncoder().encode(text)
  );

  return {
    iv,
    ciphertext
  };
}

async function encryptBytesWithKey(key, buffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv
    },
    key,
    buffer
  );

  return {
    iv,
    ciphertext
  };
}

function detectTextType(content) {
  if (/^https?:\/\/\S+$/i.test(content)) {
    return "link";
  }
  if (looksLikeCode(content)) {
    return "code";
  }
  return "text";
}

function detectCodeLanguage(content) {
  const probes = [
    ["typescript", /\b(interface|type|implements|readonly)\b/],
    ["javascript", /\b(function|const|let|=>)\b/],
    ["python", /\b(def |import |from |print\()/],
    ["html", /<\/?[a-z][\s\S]*>/i],
    ["css", /[.#]?[a-z0-9_-]+\s*\{[\s\S]*:[\s\S]*\}/i]
  ];
  return probes.find(([, pattern]) => pattern.test(content))?.[0] || null;
}

function looksLikeCode(content) {
  if (!content.includes("\n")) {
    return false;
  }
  const patterns = [
    /\b(function|const|let|class|return|import|export)\b/,
    /\b(def|import|from|return|class)\b/,
    /(^|\n)\s{2,}\S+/,
    /<\/?[A-Za-z][^>]*>/,
    /[{};]{2,}/
  ];
  return patterns.filter((pattern) => pattern.test(content)).length >= 2;
}

function normalizePrismLanguage(language) {
  if (!language) {
    return null;
  }
  if (language === "javascript" || language === "typescript" || language === "python") {
    return language;
  }
  return "clike";
}

function highlightCodeBlocks(root) {
  if (!window.Prism) {
    return;
  }
  root.querySelectorAll("pre code").forEach((node) => window.Prism.highlightElement(node));
}

function openLightbox(src, alt) {
  ui.lightboxImage.src = src;
  ui.lightboxImage.alt = alt;
  ui.lightbox.showModal();
}

function timeAgo(timestamp) {
  const delta = Date.now() - timestamp;
  const hours = Math.floor(delta / 3600000);
  if (hours < 1) {
    const minutes = Math.max(1, Math.floor(delta / 60000));
    return `${minutes} 分钟前`;
  }
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  return `${Math.floor(hours / 24)} 天前`;
}

function summarize(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 100 ? `${compact.slice(0, 97)}...` : compact;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function bytesToBase64(bytes) {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let binary = "";
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

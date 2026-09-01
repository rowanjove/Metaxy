import { t } from "../i18n";
import { api } from "../api";
import { createComposer } from "../components/composer";
import { createRetrieveBox } from "../components/retrieve-box";
import { createResultPanel } from "../components/result-panel";
import type { CommitDropData, MetaData } from "../../shared/contracts";

export async function createHomePage(): Promise<HTMLElement> {
  const container = document.createElement("div");
  container.className = "home-page";

  let meta: MetaData;
  try {
    meta = await api.getMeta();
  } catch (err) {
    console.error("[HomePage] Failed to fetch meta", err);
    meta = {
      siteName: "PocketRelay",
      uploadMode: "token",
      limits: {
        maxTextBytes: 5242880,
        maxFileBytes: 52428800,
        maxDropFileBytes: 524288000,
        maxFilesPerDrop: 10
      },
      expiryOptions: [600, 3600, 21600, 86400, 259200, 604800],
      defaultExpirySeconds: 86400,
      codeLength: 6
    };
  }
  document.title = meta.siteName;

  // Mobile Tab Switcher
  const mobileTabs = document.createElement("div");
  mobileTabs.className = "mobile-tabs";

  const sendTabBtn = document.createElement("button");
  sendTabBtn.type = "button";
  sendTabBtn.className = "mobile-tab-btn is-active";
  sendTabBtn.textContent = t("home.sendTab");

  const retrieveTabBtn = document.createElement("button");
  retrieveTabBtn.type = "button";
  retrieveTabBtn.className = "mobile-tab-btn";
  retrieveTabBtn.textContent = t("home.retrieveTab");

  mobileTabs.appendChild(sendTabBtn);
  mobileTabs.appendChild(retrieveTabBtn);
  container.appendChild(mobileTabs);

  // Dual layout grid
  const layout = document.createElement("div");
  layout.className = "home-layout tab-send";

  const leftSlot = document.createElement("div");
  leftSlot.className = "left-pane-slot";

  function renderComposer() {
    leftSlot.replaceChildren(
      createComposer(meta, (result: CommitDropData) => {
        leftSlot.replaceChildren(createResultPanel(result, renderComposer));
      })
    );
  }

  renderComposer();

  const retrieveBox = createRetrieveBox(meta.codeLength);

  layout.appendChild(leftSlot);
  layout.appendChild(retrieveBox);
  container.appendChild(layout);

  // Mobile tab toggle events
  sendTabBtn.addEventListener("click", () => {
    sendTabBtn.classList.add("is-active");
    retrieveTabBtn.classList.remove("is-active");
    layout.className = "home-layout tab-send";
  });

  retrieveTabBtn.addEventListener("click", () => {
    retrieveTabBtn.classList.add("is-active");
    sendTabBtn.classList.remove("is-active");
    layout.className = "home-layout tab-retrieve";
  });

  return container;
}

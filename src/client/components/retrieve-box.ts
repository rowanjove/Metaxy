import { t } from "../i18n";
import { router } from "../router";

export function createRetrieveBox(codeLength = 6): HTMLElement {
  const container = document.createElement("section");
  container.className = "pane-card retrieve-pane";

  const header = document.createElement("div");
  header.className = "pane-header";

  const title = document.createElement("h2");
  title.className = "pane-title";
  title.textContent = t("home.retrieveTitle");

  const intro = document.createElement("p");
  intro.className = "pane-intro";
  intro.textContent = t("home.retrieveIntro", { length: codeLength });

  header.appendChild(title);
  header.appendChild(intro);
  container.appendChild(header);

  const form = document.createElement("form");
  form.className = "retrieve-form";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "retrieve-input";
  input.maxLength = 32;
  input.placeholder = t("retrieve.inputPlaceholder", { length: codeLength });
  input.autocomplete = "off";
  input.spellcheck = false;

  input.addEventListener("input", () => {
    input.value = input.value.replace(/[^a-zA-Z0-9]/g, "");
  });

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "btn btn-primary btn-lg";
  submitBtn.textContent = t("retrieve.retrieveButton");

  const errorBanner = document.createElement("div");
  errorBanner.className = "notice-box is-error";
  errorBanner.style.display = "none";

  form.appendChild(input);
  form.appendChild(submitBtn);
  form.appendChild(errorBanner);
  container.appendChild(form);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    errorBanner.style.display = "none";

    const code = input.value.trim();
    if (!code || code.length < 4 || code.length > 32) {
      errorBanner.textContent = t("retrieve.invalidCode");
      errorBanner.style.display = "flex";
      return;
    }

    router.navigate(`/d/${encodeURIComponent(code)}`);
  });

  return container;
}

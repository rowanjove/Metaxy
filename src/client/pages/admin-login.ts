import { t } from "../i18n";
import { api } from "../api";
import { router } from "../router";

export function createAdminLoginPage(): HTMLElement {
  const container = document.createElement("div");

  const card = document.createElement("div");
  card.className = "admin-login-card";

  const title = document.createElement("h2");
  title.className = "pane-title";
  title.textContent = t("admin.loginTitle");

  const form = document.createElement("form");
  form.className = "composer-form";

  const group = document.createElement("div");
  group.className = "form-group";

  const label = document.createElement("label");
  label.className = "form-label";
  label.textContent = t("admin.passwordLabel");

  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = t("admin.passwordPlaceholder");
  input.required = true;

  group.appendChild(label);
  group.appendChild(input);

  const errorBanner = document.createElement("div");
  errorBanner.className = "notice-box is-error";
  errorBanner.style.display = "none";

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "btn btn-primary btn-lg";
  submitBtn.textContent = t("admin.loginButton");

  form.appendChild(group);
  form.appendChild(errorBanner);
  form.appendChild(submitBtn);

  card.appendChild(title);
  card.appendChild(form);
  container.appendChild(card);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBanner.style.display = "none";
    submitBtn.disabled = true;

    try {
      await api.adminLogin(input.value);
      router.navigate("/admin");
    } catch (err: any) {
      errorBanner.textContent = err.message || t("errors.INVALID_CREDENTIALS");
      errorBanner.style.display = "flex";
      submitBtn.disabled = false;
    }
  });

  return container;
}

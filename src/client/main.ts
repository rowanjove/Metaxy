import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/admin.css";

import { t, getLocale, setLocale, onLocaleChange } from "./i18n";
import { getTheme, setTheme, applyThemeToDom, onThemeChange } from "./state";
import { router } from "./router";
import { createHomePage } from "./pages/home";
import { createDropPage } from "./pages/drop";
import { createAdminLoginPage } from "./pages/admin-login";
import { createAdminPage } from "./pages/admin";

// Initialize Theme
applyThemeToDom(getTheme());

function renderApp() {
  const root = document.getElementById("app");
  if (!root) return;

  root.replaceChildren();

  // Header
  const header = document.createElement("header");
  header.className = "app-header";

  const headerInner = document.createElement("div");
  headerInner.className = "header-inner";

  // Brand Link
  const brandLink = document.createElement("a");
  brandLink.href = "/";
  brandLink.className = "brand-link";

  const logoImg = document.createElement("img");
  logoImg.src = "/favicon.svg";
  logoImg.alt = "";
  logoImg.className = "brand-logo";

  const brandText = document.createElement("span");
  brandText.textContent = t("app.name");

  brandLink.appendChild(logoImg);
  brandLink.appendChild(brandText);
  brandLink.addEventListener("click", (e) => {
    e.preventDefault();
    router.navigate("/");
  });

  // Header Actions
  const actions = document.createElement("div");
  actions.className = "header-actions";

  // Locale Toggle Button
  const localeBtn = document.createElement("button");
  localeBtn.type = "button";
  localeBtn.className = "header-btn";
  localeBtn.textContent = getLocale() === "zh-CN" ? "EN" : "中文";
  localeBtn.addEventListener("click", () => {
    setLocale(getLocale() === "zh-CN" ? "en" : "zh-CN");
  });

  // Theme Toggle Button
  const themeBtn = document.createElement("button");
  themeBtn.type = "button";
  themeBtn.className = "header-btn";
  const currentTheme = getTheme();
  themeBtn.textContent = currentTheme === "dark" ? "☀️ " + t("app.lightTheme") : "🌙 " + t("app.darkTheme");
  themeBtn.addEventListener("click", () => {
    const nextTheme = getTheme() === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    themeBtn.textContent = nextTheme === "dark" ? "☀️ " + t("app.lightTheme") : "🌙 " + t("app.darkTheme");
  });

  // Admin Link
  const adminBtn = document.createElement("a");
  adminBtn.href = "/admin";
  adminBtn.className = "header-btn";
  adminBtn.textContent = t("app.admin");
  adminBtn.addEventListener("click", (e) => {
    e.preventDefault();
    router.navigate("/admin");
  });

  actions.appendChild(localeBtn);
  actions.appendChild(themeBtn);
  actions.appendChild(adminBtn);

  headerInner.appendChild(brandLink);
  headerInner.appendChild(actions);
  header.appendChild(headerInner);

  // Main Outlet
  const main = document.createElement("main");
  main.id = "app-outlet";
  main.className = "app-main";

  root.appendChild(header);
  root.appendChild(main);

  router.setOutlet(main);
}

// Register Routes
router
  .addRoute("/", () => createHomePage())
  .addRoute("/d/:code", (params) => createDropPage(params))
  .addRoute("/admin/login", () => createAdminLoginPage())
  .addRoute("/admin", () => createAdminPage());

// Re-render whole UI when locale changes
onLocaleChange(() => {
  renderApp();
  router.resolve();
});

onThemeChange((theme) => {
  applyThemeToDom(theme);
});

// Initial boot
renderApp();
router.resolve();

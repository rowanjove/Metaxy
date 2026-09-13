import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/admin.css";
import "./styles/drive.css";
import "./styles/gallery.css";

import { t, getLocale, setLocale, onLocaleChange } from "./i18n";
import { getTheme, setTheme, applyThemeToDom, onThemeChange } from "./state";
import { router } from "./router";
import { api } from "./api";
import { createHomePage } from "./pages/home";
import { createDropPage } from "./pages/drop";
import { createAdminLoginPage } from "./pages/admin-login";
import { createAdminPage } from "./pages/admin";
import { createDrivePage } from "./pages/drive";
import { createGalleryPage } from "./pages/gallery";

// Initialize Theme
applyThemeToDom(getTheme());

function renderApp() {
  const root = document.getElementById("app");
  if (!root) return;

  const previousOutlet = document.getElementById("app-outlet");
  (previousOutlet?.firstElementChild as (HTMLElement & { dispose?: () => void }) | null)?.dispose?.();
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
  themeBtn.className = "header-btn theme-toggle";
  const themeIcon = document.createElement("span");
  themeIcon.className = "theme-toggle-icon";
  themeIcon.setAttribute("aria-hidden", "true");
  themeBtn.appendChild(themeIcon);

  const isDarkTheme = () => {
    const theme = getTheme();
    return theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  };

  const updateThemeButton = () => {
    const isDark = isDarkTheme();
    const label = isDark ? t("app.lightTheme") : t("app.darkTheme");
    themeIcon.textContent = isDark ? "☀" : "☾";
    themeBtn.setAttribute("aria-label", label);
    themeBtn.title = label;
  };

  updateThemeButton();
  themeBtn.addEventListener("click", () => {
    const nextTheme = isDarkTheme() ? "light" : "dark";
    setTheme(nextTheme);
    updateThemeButton();
  });

  // Public header only contains locale and theme buttons
  actions.appendChild(localeBtn);
  actions.appendChild(themeBtn);

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

async function guardAdminRoute(renderPage: () => HTMLElement | Promise<HTMLElement>): Promise<HTMLElement> {
  try {
    const meta = await api.getMeta();
    if (meta.adminDomain) {
      const currentHost = window.location.hostname.toLowerCase();
      const targetHost = meta.adminDomain.toLowerCase().split(":")[0];
      if (currentHost !== targetHost) {
        router.navigate("/");
        return document.createElement("div");
      }
    }
  } catch {
    // Continue if meta fetch fails
  }
  return renderPage();
}

// Drive and Gallery are admin surfaces; direct navigation still passes through
// the same domain guard before the page can issue management API requests.
router
  .addRoute("/", () => createHomePage())
  .addRoute("/d/:code", (params) => createDropPage(params))
  .addRoute("/admin/login", () => guardAdminRoute(() => createAdminLoginPage()))
  .addRoute("/admin", () => guardAdminRoute(() => createAdminPage()))
  .addRoute("/drive", () => guardAdminRoute(() => createDrivePage()))
  .addRoute("/gallery", () => guardAdminRoute(() => createGalleryPage()));

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

import { STORAGE_KEYS } from "../shared/constants";

export type Theme = "light" | "dark" | "system";

let currentTheme: Theme = initTheme();
const themeListeners = new Set<(theme: Theme) => void>();

function initTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.THEME) as Theme;
    if (saved === "light" || saved === "dark" || saved === "system") {
      return saved;
    }
  } catch {
    // Ignore storage errors
  }
  return "system";
}

export function getTheme(): Theme {
  return currentTheme;
}

export function setTheme(theme: Theme): void {
  currentTheme = theme;
  try {
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
  } catch {
    // Ignore
  }
  applyThemeToDom(theme);
  themeListeners.forEach((fn) => fn(theme));
}

export function applyThemeToDom(theme: Theme): void {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

export function onThemeChange(fn: (theme: Theme) => void): () => void {
  themeListeners.add(fn);
  return () => themeListeners.delete(fn);
}

// Upload Token Management
export function getSavedUploadToken(): string {
  try {
    return localStorage.getItem(STORAGE_KEYS.UPLOAD_TOKEN) || "";
  } catch {
    return "";
  }
}

export function saveUploadToken(token: string): void {
  try {
    if (token) {
      localStorage.setItem(STORAGE_KEYS.UPLOAD_TOKEN, token.trim());
    } else {
      localStorage.removeItem(STORAGE_KEYS.UPLOAD_TOKEN);
    }
  } catch {
    // Ignore
  }
}

export function clearUploadToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.UPLOAD_TOKEN);
  } catch {
    // Ignore
  }
}

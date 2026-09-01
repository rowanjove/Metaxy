import { LEGACY_STORAGE_KEYS, STORAGE_KEYS } from "../../shared/constants";
import { zhCN, type TranslationDict } from "./zh-CN";
import { en } from "./en";

export type Locale = "zh-CN" | "en";

const dictionaries: Record<Locale, TranslationDict> = {
  "zh-CN": zhCN,
  en
};

let currentLocale: Locale = initLocale();
const listeners = new Set<(locale: Locale) => void>();

if (typeof document !== "undefined") {
  document.documentElement.lang = currentLocale;
}

function initLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.LOCALE) ||
      localStorage.getItem(LEGACY_STORAGE_KEYS.LOCALE);
    if (saved === "zh-CN" || saved === "en") {
      localStorage.setItem(STORAGE_KEYS.LOCALE, saved);
      localStorage.removeItem(LEGACY_STORAGE_KEYS.LOCALE);
      return saved;
    }
  } catch {
    // LocalStorage unavailable
  }

  if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("zh")) {
    return "zh-CN";
  }

  return "en";
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (locale !== "zh-CN" && locale !== "en") return;
  currentLocale = locale;
  try {
    localStorage.setItem(STORAGE_KEYS.LOCALE, locale);
    document.documentElement.lang = locale;
  } catch {
    // Ignore storage error
  }
  listeners.forEach((fn) => fn(locale));
}

export function onLocaleChange(fn: (locale: Locale) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Access nested dictionary path with string template replacement
 * Example: t("home.filesCount", { count: 3, size: "1.2 MB" })
 */
export function t(path: string, params?: Record<string, string | number>): string {
  const dict = dictionaries[currentLocale] || dictionaries.en;
  const parts = path.split(".");

  let current: unknown = dict;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      // Fallback to English
      let fallback: unknown = dictionaries.en;
      for (const p of parts) {
        if (fallback && typeof fallback === "object" && p in fallback) {
          fallback = (fallback as Record<string, unknown>)[p];
        } else {
          fallback = path;
          break;
        }
      }
      current = fallback;
      break;
    }
  }

  let text = typeof current === "string" ? current : path;
  if (params) {
    for (const [key, val] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${key}\\}`, "g"), String(val));
    }
  }
  return text;
}

/**
 * Format bytes into binary units KiB / MiB / GiB
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0 || !Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;

  const k = 1024;
  const sizes = ["B", "KiB", "MiB", "GiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = (bytes / Math.pow(k, i)).toFixed(i === 1 ? 1 : 2);
  return `${val} ${sizes[i]}`;
}

/**
 * Format seconds into a friendly human relative string
 */
export function formatRemainingTime(seconds: number): string {
  const unit = currentLocale === "zh-CN"
    ? { second: "秒", minute: "分", hour: "小时", day: "天" }
    : { second: "s", minute: "m", hour: "h", day: "d" };
  if (seconds <= 0) return `0${unit.second}`;
  const s = Math.floor(seconds);
  if (s < 60) return `${s}${unit.second}`;
  if (s < 3600) {
    const mins = Math.floor(s / 60);
    const remSecs = s % 60;
    return remSecs > 0 ? `${mins}${unit.minute} ${remSecs}${unit.second}` : `${mins}${unit.minute}`;
  }
  if (s < 86400) {
    const hours = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    return mins > 0 ? `${hours}${unit.hour} ${mins}${unit.minute}` : `${hours}${unit.hour}`;
  }
  const days = Math.floor(s / 86400);
  const remHours = Math.floor((s % 86400) / 3600);
  return remHours > 0 ? `${days}${unit.day} ${remHours}${unit.hour}` : `${days}${unit.day}`;
}

/**
 * Format timestamp using Intl.DateTimeFormat
 */
export function formatDateTime(timestamp: number): string {
  if (!timestamp) return "-";
  try {
    return new Intl.DateTimeFormat(currentLocale === "zh-CN" ? "zh-CN" : "en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

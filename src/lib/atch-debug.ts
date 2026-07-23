import { api } from "./api";

export const atchDebug = {
  log: (tag: string, message: string, data?: unknown) =>
    api.debugLog({ level: "info", tag, message, data }).catch(() => {}),
  warn: (tag: string, message: string, data?: unknown) =>
    api.debugLog({ level: "warn", tag, message, data }).catch(() => {}),
  error: (tag: string, message: string, data?: unknown) =>
    api.debugLog({ level: "error", tag, message, data }).catch(() => {}),
};
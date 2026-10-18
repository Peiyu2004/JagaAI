export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}
export const SESSION_EXPIRED = "jagaai:session-expired";
let sessionRevision = 0;
export const getSessionRevision = () => sessionRevision;
export const invalidateSession = () => { sessionRevision += 1; };
export function expireSession() {
  invalidateSession();
  window.dispatchEvent(new Event(SESSION_EXPIRED));
}
export async function checkSession() {
  const revision = sessionRevision;
  const result = await api<{ user: unknown }>("/auth/me");
  if (!result.user && revision === sessionRevision) expireSession();
}
export async function api<T = Record<string, unknown>>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const revision = sessionRevision;
  const assertCurrent = () => {
    if (revision !== sessionRevision)
      throw new ApiError("This request belongs to a previous session.", 401);
  };
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch("/api" + path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  assertCurrent();
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const error = await response.json();
      message =
        typeof error.detail === "string"
          ? error.detail
          : JSON.stringify(error.detail);
    } catch {
      /* Keep status on non-JSON network responses. */
    }
    assertCurrent();
    if (response.status === 401 && path !== "/auth/login" && path !== "/auth/resident") expireSession();
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  const result = await response.json();
  assertCurrent();
  return result;
}
export const json = (value: unknown) => JSON.stringify(value);
export const dateTime = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("en-MY", {
        timeZone: "Asia/Kuala_Lumpur",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "Not recorded";
export const relativeTime = (value?: string) => {
  if (!value) return "not recorded";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "not recorded";
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 172800) return "yesterday";
  return dateTime(value);
};
export const clockTime = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("en-MY", {
        timeZone: "Asia/Kuala_Lumpur",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "—";
export const localInput = (value?: string) => {
  const d = value ? new Date(value) : new Date();
  return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 16);
};
export const toUTC = (value: string) =>
  new Date(value + "+08:00").toISOString();
export const cameraName = (value?: string) =>
  (value || "Camera")
    .replace(/^Demo\s*·\s*/i, "")
    .replace(/\s*\(\d+\s*s demo threshold\)\s*$/i, "")
    .trim();
export const duration = (sec: number) =>
  `${Math.floor(sec / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(sec % 60)
    .toString()
    .padStart(2, "0")}`;
export const label = (value: string) =>
  ({
    vehicle_loitering: "Vehicle loitering",
    restricted_entry: "Restricted entry",
    in_progress: "In progress",
    received: "Received",
    resolved: "Resolved",
    pending: "Pending review",
    confirmed: "Confirmed",
    dismissed: "Dismissed",
    open: "Open",
    assigned: "Assigned",
    closed: "Closed",
  })[value] ||
  ((s) => s.charAt(0).toUpperCase() + s.slice(1))(value.replaceAll("_", " "));

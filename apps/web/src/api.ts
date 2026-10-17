export class ApiError extends Error {
  status: number;
  details: any;
  constructor(message: string, status: number, details: any) { super(message); this.status = status; this.details = details; }
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: options.body instanceof FormData ? options.headers : { 'Content-Type': 'application/json', ...options.headers },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(value.error || `Request failed (${response.status})`, response.status, value);
  return value as T;
}

export const post = <T = any>(path: string, body: any = {}) => api<T>(path, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body) });

export function localTime(value: string | undefined, options: Intl.DateTimeFormatOptions = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-MY', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...options }).format(date);
}

export const localInput = (date = new Date()) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16);
export const toInstant = (value: FormDataEntryValue | string | null) => value ? new Date(`${value}:00+08:00`).toISOString() : undefined;
export const label = (value = '') => value.replace(/[_-]/g, ' ').replace(/\b\w/g, char => char.toUpperCase());

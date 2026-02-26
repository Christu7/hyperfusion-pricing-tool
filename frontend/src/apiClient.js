const API_KEY = (import.meta.env.VITE_PRICING_API_KEY || "").trim();

export async function apiFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  if (API_KEY) {
    headers.set("x-api-key", API_KEY);
  }
  return fetch(url, { ...init, headers });
}

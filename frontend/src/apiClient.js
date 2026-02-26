function normalizeApiKey(value) {
  const raw = (value || "").trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

const API_KEY = normalizeApiKey(import.meta.env.VITE_PRICING_API_KEY);

export async function apiFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  if (API_KEY) {
    headers.set("x-api-key", API_KEY);
  }
  return fetch(url, { ...init, headers });
}

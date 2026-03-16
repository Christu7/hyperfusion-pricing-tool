const COMPETITOR_URLS = {
  "North America": import.meta.env.VITE_COMPETITORS_NA_CSV_URL,
  Europe: import.meta.env.VITE_COMPETITORS_EU_CSV_URL,
  "Asia-Pacific": import.meta.env.VITE_COMPETITORS_AP_CSV_URL,
};

const EMPTY_COMPETITOR_DATA = {
  "North America": [],
  Europe: [],
  "Asia-Pacific": [],
};

let cache = null;

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeGpuHeader(value) {
  return normalizeText(value).replace(/^NVIDIA\s+/i, "");
}

function toCsvUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return raw;
  if (raw.includes("/pubhtml")) {
    const converted = raw.replace("/pubhtml", "/pub");
    return converted.includes("output=csv")
      ? converted
      : `${converted}${converted.includes("?") ? "&" : "?"}output=csv`;
  }
  return raw;
}

function parsePrice(value) {
  let cleaned = String(value || "").trim().replace(/[$%\s]/g, "");
  if (!cleaned) return null;

  if (cleaned.includes(",") && !cleaned.includes(".")) {
    cleaned = cleaned.replace(",", ".");
  } else if (cleaned.includes(",") && cleaned.includes(".")) {
    cleaned = cleaned.replace(/,/g, "");
  }

  const numeric = Number.parseFloat(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

function detectDelimiter(text) {
  const firstLine = (text.split(/\r?\n/, 1)[0] || "").trim();
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  return semicolonCount > commaCount ? ";" : ",";
}

function parseCsv(text) {
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.length > 1 || row[0]?.trim()) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length || row.length) {
    row.push(cell);
    if (row.length > 1 || row[0]?.trim()) rows.push(row);
  }

  return rows;
}

function normalizeRegionCsv(csvText, providerRegion) {
  const matrix = parseCsv(csvText);
  if (!matrix.length) return [];

  const header = matrix[0].map((value) => normalizeText(value));
  const gpuColumns = [];
  for (let i = 1; i < header.length; i += 1) {
    const gpu = normalizeGpuHeader(header[i]);
    if (!gpu) continue;
    gpuColumns.push({ index: i, gpu });
  }

  const rows = [];
  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    const line = matrix[rowIndex];
    const provider = normalizeText(line[0]);
    if (!provider) continue;

    for (const gpuColumn of gpuColumns) {
      const price = parsePrice(line[gpuColumn.index] || "");
      if (price === null) continue;

      rows.push({
        provider,
        gpu: gpuColumn.gpu,
        price_per_hour: price,
        provider_region: providerRegion,
      });
    }
  }

  return rows;
}

export async function loadCompetitorOffers(forceRefresh = false) {
  if (!forceRefresh && cache) {
    return cache;
  }

  const results = { ...EMPTY_COMPETITOR_DATA };

  await Promise.all(
    Object.entries(COMPETITOR_URLS).map(async ([region, url]) => {
      const resolvedUrl = toCsvUrl(url);
      if (!resolvedUrl) return;

      try {
        const response = await fetch(resolvedUrl);
        if (!response.ok) return;

        const text = await response.text();
        if (/<!doctype html|<html/i.test(text.slice(0, 500))) return;

        results[region] = normalizeRegionCsv(text, region);
      } catch {
        results[region] = [];
      }
    }),
  );

  cache = results;
  return results;
}

const COMPETITOR_URLS = {
  "North America": import.meta.env.VITE_COMPETITORS_NA_CSV_URL,
  Europe: import.meta.env.VITE_COMPETITORS_EU_CSV_URL,
  "Asia-Pacific": import.meta.env.VITE_COMPETITORS_AP_CSV_URL,
};

const CACHE_TTL_MS = 15 * 60 * 1000;

let cache = {
  expiresAt: 0,
  data: null,
  lastGoodData: null,
};

function normalizeText(value) {
  return (value || "").trim().replace(/\s+/g, " ");
}

function normalizeKey(value) {
  return normalizeText(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeGpuKey(value) {
  return normalizeKey(value).replace(/^NVIDIA/, "");
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

  // Handle locale decimals like "1,89" and mixed thousand/decimal separators.
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

function parseRegionCsv(csvText) {
  const matrix = parseCsv(csvText);
  if (!matrix.length) return {};

  const header = matrix[0].map((h) => normalizeText(h));
  const gpuColumns = [];
  for (let i = 1; i < header.length; i += 1) {
    const key = normalizeGpuKey(header[i]);
    if (!key) continue;
    gpuColumns.push({ index: i, gpuKey: key });
  }

  const providers = {};
  for (let r = 1; r < matrix.length; r += 1) {
    const line = matrix[r];
    const displayName = normalizeText(line[0]);
    if (!displayName) continue;

    const providerKey = normalizeKey(displayName);
    const pricesByGpu = {};
    for (const col of gpuColumns) {
      const price = parsePrice(line[col.index] || "");
      if (price !== null) pricesByGpu[col.gpuKey] = price;
    }

    providers[providerKey] = {
      providerKey,
      displayName,
      pricesByGpu,
    };
  }

  return providers;
}

export async function loadCompetitorRates(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cache.data && now < cache.expiresAt) {
    return { data: cache.data, warnings: [] };
  }

  const warnings = [];
  const results = {};
  const entries = Object.entries(COMPETITOR_URLS);
  const fetches = await Promise.allSettled(
    entries.map(async ([region, url]) => {
      if (!url) throw new Error(`Missing CSV URL for ${region}`);
      const resp = await fetch(toCsvUrl(url));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      if (/<!doctype html|<html/i.test(text.slice(0, 500))) {
        throw new Error("Received HTML instead of CSV");
      }
      return [region, parseRegionCsv(text)];
    }),
  );

  let successCount = 0;
  fetches.forEach((result, idx) => {
    const [region] = entries[idx];
    if (result.status === "fulfilled") {
      successCount += 1;
      const [, parsed] = result.value;
      results[region] = parsed;
      if (Object.keys(parsed).length === 0) {
        warnings.push(`No competitor rows found for ${region}.`);
      }
      return;
    }
    warnings.push(`Could not load competitor rates for ${region}.`);
  });

  if (successCount > 0) {
    cache = {
      expiresAt: now + CACHE_TTL_MS,
      data: results,
      lastGoodData: results,
    };
    return { data: results, warnings };
  }

  if (cache.lastGoodData) {
    return {
      data: cache.lastGoodData,
      warnings: [...warnings, "Using last cached competitor rates."],
    };
  }

  return {
    data: {},
    warnings: [...warnings, "No competitor rates available right now."],
  };
}

export function buildCompetitorResults({ dataByRegion, selectedGPU, selectedRegion, hours }) {
  const gpuKey = normalizeGpuKey(selectedGPU);
  const numericHours = Number(hours) || 0;
  const providers = {};

  const regionList =
    selectedRegion === "All Regions"
      ? ["North America", "Europe", "Asia-Pacific"]
      : [selectedRegion];

  for (const regionName of regionList) {
    const regionProviders = dataByRegion[regionName] || {};
    for (const provider of Object.values(regionProviders)) {
      const hourlyPrice = provider.pricesByGpu[gpuKey];
      if (hourlyPrice === undefined) continue;

      if (!providers[provider.providerKey]) {
        providers[provider.providerKey] = {
          providerName: provider.displayName,
          hourlyPrice,
          totalCost: hourlyPrice * numericHours,
          regionSource: regionName,
        };
        continue;
      }

      if (selectedRegion === "All Regions" && hourlyPrice < providers[provider.providerKey].hourlyPrice) {
        providers[provider.providerKey] = {
          providerName: provider.displayName,
          hourlyPrice,
          totalCost: hourlyPrice * numericHours,
          regionSource: regionName,
        };
      }
    }
  }

  return Object.values(providers);
}

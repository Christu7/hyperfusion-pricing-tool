import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "./apiClient";
import {
  COUNTRY_LOCATION_OPTIONS,
  REGION_LOCATION_OPTIONS,
  locationZoneMap,
} from "./locationZones";
import { getEstimatedRttMs, getLatencyDeltaVsHyperfusionMs } from "./rttMatrix";
import { loadCompetitorOffers } from "./loadCompetitorOffers";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";
const GPU_TYPES = ["A100", "B200", "GH200", "H100", "H200", "L40S"];
const REGIONS = ["All Regions", "North America", "Europe", "Asia-Pacific"];
const RANK_OPTIONS = ["Best Overall", "Lowest Price", "Provider Name"];
const HYPERFUSION_PROVIDER = "Hyperfusion";

function getCheapestOffersForGpu(offers, gpu) {
  const cheapestByProvider = new Map();

  for (const offer of offers) {
    if (!offer || !offer.provider || offer.gpu !== gpu) continue;

    const current = cheapestByProvider.get(offer.provider);
    if (!current || offer.price_per_hour < current.price_per_hour) {
      cheapestByProvider.set(offer.provider, offer);
    }
  }

  return [...cheapestByProvider.values()];
}

function currency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(value ?? 0);
}

function units(value) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value ?? 0);
}

export default function App() {
  const [mode] = useState("use_case");
  const [skus, setSkus] = useState([]);
  const [uplifts, setUplifts] = useState([]);
  const [useCases, setUseCases] = useState([]);
  const [selectedSku, setSelectedSku] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [selectedUseCase, setSelectedUseCase] = useState("");
  const [hours, setHours] = useState(100);
  const [gpuType, setGpuType] = useState(GPU_TYPES[0]);
  const [region, setRegion] = useState(REGIONS[0]);
  const [selectedLocation, setSelectedLocation] = useState("India");
  const [rankResultsBy, setRankResultsBy] = useState(RANK_OPTIONS[0]);
  const [selectedUplifts, setSelectedUplifts] = useState(new Set());
  const [initialLoading, setInitialLoading] = useState(true);
  const [calcLoading, setCalcLoading] = useState(false);
  const [error, setError] = useState("");
  const [quote, setQuote] = useState(null);
  const [competitorOffersByRegion, setCompetitorOffersByRegion] = useState({
    "North America": [],
    Europe: [],
    "Asia-Pacific": [],
  });
  const selectedLatencyZone = locationZoneMap[selectedLocation] || "global";

  useEffect(() => {
    async function loadInitialData() {
      try {
        setInitialLoading(true);
        setError("");
        const [skusResp, upliftsResp, useCasesResp] = await Promise.all([
          apiFetch(`${API_BASE}/skus`),
          apiFetch(`${API_BASE}/uplifts`),
          apiFetch(`${API_BASE}/use-cases`),
        ]);
        if (!skusResp.ok || !upliftsResp.ok || !useCasesResp.ok) {
          const messages = [];
          for (const resp of [skusResp, upliftsResp, useCasesResp]) {
            if (!resp.ok) {
              let detail = "";
              try {
                const body = await resp.clone().json();
                detail = body?.detail || "";
              } catch {
                detail = "";
              }
              messages.push(`${resp.url} -> ${resp.status}${detail ? ` (${detail})` : ""}`);
            }
          }
          throw new Error(`Failed to load initial data. ${messages.join(" | ")}`);
        }

        const skusRaw = await skusResp.json();
        const upliftsRaw = await upliftsResp.json();
        const useCasesRaw = await useCasesResp.json();
        const skusData = Array.isArray(skusRaw) ? skusRaw : [];
        const upliftsData = Array.isArray(upliftsRaw) ? upliftsRaw : [];
        const useCasesData = Array.isArray(useCasesRaw) ? useCasesRaw : [];

        setSkus(skusData);
        setUplifts(upliftsData);
        setUseCases(useCasesData);

        if (skusData.length > 0) setSelectedSku(skusData[0].sku_code);
        if (useCasesData.length > 0) setSelectedUseCase(useCasesData[0]);

        setSelectedUplifts(
          new Set(
            upliftsData
              .filter((u) => u.enabled)
              .map((u) => u.uplift_name),
          ),
        );
      } catch (err) {
        setError(err.message || "Unable to load data");
      } finally {
        setInitialLoading(false);
      }
    }

    loadInitialData();
  }, []);

  const orderedUpliftNames = useMemo(() => Array.from(selectedUplifts.values()), [selectedUplifts]);

  function toggleUplift(name) {
    setSelectedUplifts((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function calculateQuote() {
    try {
      setCalcLoading(true);
      setError("");
      setQuote(null);

      const payload =
        mode === "sku"
          ? {
              mode: "sku",
              sku_code: selectedSku,
              quantity: Number(quantity),
              uplift_names: orderedUpliftNames,
            }
          : {
              mode: "use_case",
              use_case: selectedUseCase,
              hours: Number(hours),
              uplift_names: orderedUpliftNames,
              gpu_type: gpuType,
              region,
              rank_results_by: rankResultsBy,
            };

      const resp = await apiFetch(`${API_BASE}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.detail || "Quote request failed");
      }
      setQuote(data);

      if (mode === "use_case") {
        const competitorOffers = await loadCompetitorOffers();
        setCompetitorOffersByRegion(competitorOffers);
      }
    } catch (err) {
      setError(err.message || "Unable to calculate quote");
    } finally {
      setCalcLoading(false);
    }
  }

  const comparisonRows = useMemo(() => {
    if (!quote || mode !== "use_case") return [];

    const hyperfusionPricePerHour = (quote.grand_total_usd || 0) / Math.max(Number(hours) || 1, 1);
    const hyperfusionRow = {
      provider: HYPERFUSION_PROVIDER,
      gpu: gpuType,
      price_per_hour: hyperfusionPricePerHour,
      provider_region: "MENA",
    };

    const competitorRows =
      region === "All Regions"
        ? [
            ...(competitorOffersByRegion["North America"] || []),
            ...(competitorOffersByRegion.Europe || []),
            ...(competitorOffersByRegion["Asia-Pacific"] || []),
          ]
        : competitorOffersByRegion[region] || [];
    const filteredRows = getCheapestOffersForGpu([hyperfusionRow, ...competitorRows], gpuType);
    const hyperfusionLatencyMs = getEstimatedRttMs(selectedLatencyZone, "MENA");

    return filteredRows
      .map((row) => {
        const estimatedLatencyMs = getEstimatedRttMs(selectedLatencyZone, row.provider_region);

        return {
          ...row,
          estimated_latency_ms: estimatedLatencyMs,
          latency_delta_vs_hyperfusion_ms: getLatencyDeltaVsHyperfusionMs(estimatedLatencyMs, hyperfusionLatencyMs),
        };
      })
      .sort((a, b) => {
        if (a.provider === HYPERFUSION_PROVIDER) return -1;
        if (b.provider === HYPERFUSION_PROVIDER) return 1;
        if (a.price_per_hour == null) return 1;
        if (b.price_per_hour == null) return -1;
        if (a.price_per_hour !== b.price_per_hour) {
          return a.price_per_hour - b.price_per_hour;
        }
        if (a.estimated_latency_ms !== b.estimated_latency_ms) {
          return a.estimated_latency_ms - b.estimated_latency_ms;
        }
        return a.provider.localeCompare(b.provider);
      });
  }, [competitorOffersByRegion, gpuType, hours, mode, quote, region, selectedLatencyZone]);

  const sortedUseCaseBreakdown = useMemo(() => {
    if (!quote || !quote.breakdown) return [];
    return [...quote.breakdown].sort((a, b) => b.cost_usd - a.cost_usd);
  }, [quote]);

  if (initialLoading) {
    return <main className="dashboard-shell">Loading data...</main>;
  }

  const canCalculate =
    mode === "sku"
      ? Boolean(selectedSku) && Number(quantity) > 0
      : Boolean(selectedUseCase && gpuType && region && rankResultsBy) && Number(hours) > 0;

  return (
    <main className="dashboard-shell">
      <header className="header">
        <h1>Hyperfusion Pricing</h1>
      </header>

      <section className="panel-card">
        <div className="control-grid">
          {mode === "use_case" ? (
            <>
              <label>
                Use Case
                <select value={selectedUseCase} onChange={(e) => setSelectedUseCase(e.target.value)}>
                  {useCases.map((useCase) => (
                    <option key={useCase} value={useCase}>
                      {useCase}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                GPU Type
                <select value={gpuType} onChange={(e) => setGpuType(e.target.value)}>
                  {GPU_TYPES.map((gpu) => (
                    <option key={gpu} value={gpu}>
                      {gpu}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Region
                <select value={region} onChange={(e) => setRegion(e.target.value)}>
                  {REGIONS.map((regionOption) => (
                    <option key={regionOption} value={regionOption}>
                      {regionOption}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                User Location
                <select value={selectedLocation} onChange={(e) => setSelectedLocation(e.target.value)}>
                  {COUNTRY_LOCATION_OPTIONS.map((location) => (
                    <option key={location} value={location}>
                      {location}
                    </option>
                  ))}
                  <option disabled>──────────</option>
                  {REGION_LOCATION_OPTIONS.map((location) => (
                    <option key={location} value={location}>
                      {location}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Rank By
                <select value={rankResultsBy} onChange={(e) => setRankResultsBy(e.target.value)}>
                  {RANK_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Hours
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <label>
                SKU
                <select value={selectedSku} onChange={(e) => setSelectedSku(e.target.value)}>
                  {skus.map((sku) => (
                    <option key={sku.sku_code} value={sku.sku_code}>
                      {sku.sku_code} - {sku.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Quantity
                <input
                  type="number"
                  min="0.0001"
                  step="any"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </label>
            </>
          )}
        </div>

        <div className="uplift-grid">
          {uplifts.map((u) => (
            <label className="uplift-select-like" key={u.uplift_name}>
              <span className="uplift-label">Uplift</span>
              <span className="uplift-control">
                <input
                  type="checkbox"
                  checked={selectedUplifts.has(u.uplift_name)}
                  onChange={() => toggleUplift(u.uplift_name)}
                />
                <strong>{u.uplift_name}</strong>
                <em>{(u.percent_decimal * 100).toFixed(2)}%</em>
              </span>
            </label>
          ))}
        </div>

        <button className="run-button" disabled={calcLoading || !canCalculate} onClick={calculateQuote}>
          {calcLoading ? "Calculating..." : "Run Analysis"}
        </button>

        {error && <p className="error">{error}</p>}
      </section>

      {quote && mode === "use_case" && (
        <section className="panel-card">
          <header className="panel-head">
            <h2>Use Case Summary</h2>
          </header>
          <div className="summary-grid">
            <article>
              <h3>Total Cost (Hyperfusion)</h3>
              <p>{currency(quote.grand_total_usd)}</p>
            </article>
            <article>
              <h3>Hours</h3>
              <p>{units(quote.hours)}</p>
            </article>
            <article>
              <h3>Cost / Hour</h3>
              <p>{currency((quote.grand_total_usd || 0) / Math.max(quote.hours || 1, 1))}</p>
            </article>
          </div>
        </section>
      )}

      {comparisonRows.length > 0 && (
        <section className="panel-card">
          <header className="panel-head">
            <h2>Provider Pricing Results</h2>
          </header>
          <div className="table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Estimated Cost / Hour</th>
                  <th>Latency</th>
                  <th>Provider Region</th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((item) => (
                  <tr key={`${item.provider}-${item.gpu}-${item.provider_region}`} className={item.provider === HYPERFUSION_PROVIDER ? "provider-hyperfusion" : ""}>
                    <td>{item.provider}</td>
                    <td>{item.price_per_hour == null ? "N/A" : currency(item.price_per_hour)}</td>
                    <td>
                      <div className="latency-cell">
                        <span>{item.estimated_latency_ms} ms</span>
                        {item.provider !== HYPERFUSION_PROVIDER && item.latency_delta_vs_hyperfusion_ms > 0 ? (
                          <span className="latency-delta">+{item.latency_delta_vs_hyperfusion_ms} ms vs Hyperfusion</span>
                        ) : null}
                      </div>
                    </td>
                    <td>{item.provider_region}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="table-disclaimer">
            Estimated network RTT based on regional averages.
            Actual latency depends on network conditions.
          </p>
        </section>
      )}

      {quote && mode === "use_case" && comparisonRows.length === 0 && (
        <section className="panel-card">
          <header className="panel-head">
            <h2>Provider Pricing Results</h2>
          </header>
          <div className="table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Estimated Cost / Hour</th>
                  <th>Latency</th>
                  <th>Provider Region</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan="4">No provider offers are available for the selected GPU.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="table-disclaimer">
            Estimated network RTT based on regional averages.
            Actual latency depends on network conditions.
          </p>
        </section>
      )}

      {quote && mode === "use_case" && (
        <section className="panel-card">
          <header className="panel-head">
            <h2>Hyperfusion Estimated Cost Breakdown</h2>
          </header>
          <div className="table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th>Units/Hour</th>
                  <th>Units Total</th>
                  <th>Cost (USD)</th>
                </tr>
              </thead>
              <tbody>
                {sortedUseCaseBreakdown.map((item) => (
                  <tr key={item.sku_code}>
                    <td>{item.sku_code}</td>
                    <td>{item.sku_name}</td>
                    <td>{units(item.units_per_hour)}</td>
                    <td>{units(item.units_total)}</td>
                    <td>{currency(item.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {quote && mode === "sku" && (
        <section className="panel-card">
          <header className="panel-head">
            <h2>SKU Quote Breakdown</h2>
          </header>
          <div className="summary-grid">
            <article>
              <h3>SKU</h3>
              <p>{quote.sku.sku_code} - {quote.sku.name}</p>
            </article>
            <article>
              <h3>Quantity Raw</h3>
              <p>{units(quote.quantity_raw)}</p>
            </article>
            <article>
              <h3>Final Cost</h3>
              <p>{currency(quote.final_cost)}</p>
            </article>
          </div>
        </section>
      )}
    </main>
  );
}

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "./apiClient";
import { buildCompetitorResults, loadCompetitorRates } from "./data/competitorRates";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";
const GPU_TYPES = ["A100", "B200", "GH200", "H100", "H200", "L40S"];
const REGIONS = ["North America", "Europe", "Asia-Pacific", "All Regions"];
const RANK_OPTIONS = ["Best Overall", "Lowest Price", "Provider Name"];
const PROVIDER_LINKS = {
  thundercompute: "https://www.thundercompute.com",
  digitaloceanpaperspace: "https://www.digitalocean.com/products/paperspace",
  digitalocean: "https://www.digitalocean.com/products/paperspace",
  runpod: "https://www.runpod.io",
  lambdalabs: "https://lambdalabs.com",
  cudocompute: "https://www.cudocompute.com",
  hyperstack: "https://www.hyperstack.cloud",
  tensordock: "https://www.tensordock.com",
  datacrunch: "https://datacrunch.io",
  massedcompute: "https://massedcompute.com",
  voltagepark: "https://www.voltagepark.com",
  latitude: "https://www.latitude.sh",
  nebius: "https://nebius.com",
  vultr: "https://www.vultr.com",
  deepinfra: "https://deepinfra.com",
  fireworksai: "https://fireworks.ai",
  groq: "https://groq.com",
  huggingface: "https://huggingface.co",
  hyperscalers: "https://hyperscalers.com",
  replicate: "https://replicate.com",
  togetherai: "https://www.together.ai",
  hyperfusion: "https://www.hyperfusion.io",
};

function normalizeProviderName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function currency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(value ?? 0);
}

function getProviderLink(providerName) {
  return PROVIDER_LINKS[normalizeProviderName(providerName)] || "";
}

function units(value) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value ?? 0);
}

export default function App() {
  const [mode, setMode] = useState("use_case");
  const [skus, setSkus] = useState([]);
  const [uplifts, setUplifts] = useState([]);
  const [useCases, setUseCases] = useState([]);
  const [selectedSku, setSelectedSku] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [selectedUseCase, setSelectedUseCase] = useState("");
  const [hours, setHours] = useState(100);
  const [gpuType, setGpuType] = useState(GPU_TYPES[0]);
  const [region, setRegion] = useState(REGIONS[0]);
  const [rankResultsBy, setRankResultsBy] = useState(RANK_OPTIONS[0]);
  const [selectedUplifts, setSelectedUplifts] = useState(new Set());
  const [initialLoading, setInitialLoading] = useState(true);
  const [calcLoading, setCalcLoading] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [quote, setQuote] = useState(null);
  const [providerResults, setProviderResults] = useState([]);

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
      setWarning("");
      setQuote(null);
      setProviderResults([]);

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
        const { data: competitorData, warnings } = await loadCompetitorRates();
        const competitorResults = buildCompetitorResults({
          dataByRegion: competitorData,
          selectedGPU: gpuType,
          selectedRegion: region,
          hours: Number(hours),
        });

        const hyperfusionHourly = (data.grand_total_usd || 0) / Math.max(Number(hours) || 0, 1);
        const merged = [
          {
            providerName: "Hyperfusion",
            hourlyPrice: hyperfusionHourly,
            totalCost: data.grand_total_usd || 0,
            regionSource: region === "All Regions" ? "All Regions" : region,
          },
          ...competitorResults,
        ];
        setProviderResults(merged);
        if (warnings.length > 0) setWarning(warnings.join(" "));
      }
    } catch (err) {
      setError(err.message || "Unable to calculate quote");
    } finally {
      setCalcLoading(false);
    }
  }

  const sortedProviderResults = useMemo(() => {
    const cloned = [...providerResults];
    if (rankResultsBy === "Provider Name") {
      cloned.sort((a, b) => a.providerName.localeCompare(b.providerName));
      return cloned;
    }
    // "Best Overall" and "Lowest Price" currently both sort by lowest total cost.
    cloned.sort((a, b) => a.totalCost - b.totalCost);
    return cloned;
  }, [providerResults, rankResultsBy]);

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
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="use_case">Use Case</option>
              <option value="sku">SKU</option>
            </select>
          </label>

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
        {warning && <p className="warning">{warning}</p>}
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

      {providerResults.length > 0 && (
        <section className="panel-card">
          <header className="panel-head">
            <h2>Provider Pricing Overview</h2>
          </header>
          <div className="table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Hourly Price</th>
                  <th>Total Estimated Cost</th>
                  <th>Region Source</th>
                  <th>Visit</th>
                </tr>
              </thead>
              <tbody>
                {sortedProviderResults.map((item) => (
                  <tr key={item.providerName} className={item.providerName === "Hyperfusion" ? "provider-hyperfusion" : ""}>
                    <td>{item.providerName}</td>
                    <td>{currency(item.hourlyPrice)}</td>
                    <td>{currency(item.totalCost)}</td>
                    <td>
                      {item.providerName === "Hyperfusion"
                        ? "—"
                        : region === "All Regions"
                        ? `Best in ${item.regionSource}`
                        : item.regionSource}
                    </td>
                    <td>
                      {getProviderLink(item.providerName) ? (
                        <a href={getProviderLink(item.providerName)} target="_blank" rel="noreferrer">
                          Site
                        </a>
                      ) : (
                        <span className="muted">N/A</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {quote && mode === "use_case" && (
        <section className="panel-card">
          <header className="panel-head">
            <h2>SKU Cost Breakdown</h2>
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

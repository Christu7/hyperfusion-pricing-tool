import { useEffect, useMemo, useState } from "react";
import { buildCompetitorResults, loadCompetitorRates } from "./data/competitorRates";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";
const GPU_TYPES = ["A100", "B200", "GH200", "H100", "H200", "L40S"];
const REGIONS = ["North America", "Europe", "Asia-Pacific", "All Regions"];
const RANK_OPTIONS = ["Best Overall", "Lowest Price", "Provider Name"];
const PROVIDER_LINKS = {
  Runpod: "https://www.runpod.io",
  Latitude: "https://www.latitude.sh",
  Nebius: "https://nebius.com",
  Vultr: "https://www.vultr.com",
  Hyperfusion: "https://www.hyperfusion.io",
};

function currency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(value ?? 0);
}

function percent(value) {
  return `${((value ?? 0) * 100).toFixed(2)}%`;
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
          fetch(`${API_BASE}/skus`),
          fetch(`${API_BASE}/uplifts`),
          fetch(`${API_BASE}/use-cases`),
        ]);
        if (!skusResp.ok || !upliftsResp.ok || !useCasesResp.ok) {
          throw new Error("Failed to load initial data");
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
        if (skusData.length > 0) {
          setSelectedSku(skusData[0].sku_code);
        }
        if (useCasesData.length > 0) {
          setSelectedUseCase(useCasesData[0]);
        }
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

  const orderedUpliftNames = useMemo(
    () => Array.from(selectedUplifts.values()),
    [selectedUplifts],
  );

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
      const resp = await fetch(`${API_BASE}/quote`, {
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
        if (warnings.length > 0) {
          setWarning(warnings.join(" "));
        }
      }
    } catch (err) {
      setError(err.message || "Unable to calculate quote");
    } finally {
      setCalcLoading(false);
    }
  }

  const sortedUseCaseBreakdown = useMemo(() => {
    if (!quote || !quote.breakdown) return [];
    return [...quote.breakdown].sort((a, b) => b.cost_usd - a.cost_usd);
  }, [quote]);

  const sortedProviderResults = useMemo(() => {
    const cloned = [...providerResults];
    if (rankResultsBy === "Provider Name") {
      cloned.sort((a, b) => a.providerName.localeCompare(b.providerName));
      return cloned;
    }
    cloned.sort((a, b) => a.totalCost - b.totalCost);
    return cloned;
  }, [providerResults, rankResultsBy]);

  if (initialLoading) {
    return <main className="container">Loading catalog...</main>;
  }

  const canCalculate =
    mode === "sku"
      ? Boolean(selectedSku) && Number(quantity) > 0
      : Boolean(selectedUseCase && gpuType && region && rankResultsBy) && Number(hours) > 0;

  return (
    <main className="container">
      <h1>Pricing Tool</h1>
      <section className="card">
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="use_case">Use Case</option>
            <option value="sku">SKU</option>
          </select>
        </label>
      </section>

      <section className="card">
        {mode === "sku" ? (
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
        ) : (
          <>
            <label>
              Preset by Use Case
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
              Number of Hours
              <input
                type="range"
                min="1"
                max="10000"
                step="1"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
              <input
                type="number"
                min="1"
                step="1"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
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
              Rank Results By
              <select value={rankResultsBy} onChange={(e) => setRankResultsBy(e.target.value)}>
                {RANK_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        <fieldset>
          <legend>Uplifts</legend>
          {uplifts.map((u) => (
            <label className="checkbox" key={u.uplift_name}>
              <input
                type="checkbox"
                checked={selectedUplifts.has(u.uplift_name)}
                onChange={() => toggleUplift(u.uplift_name)}
              />
              {u.uplift_name} ({percent(u.percent_decimal)})
            </label>
          ))}
        </fieldset>

        <button disabled={calcLoading || !canCalculate} onClick={calculateQuote}>
          {calcLoading ? "Calculating..." : "Calculate"}
        </button>
      </section>

      {error && <p className="error">{error}</p>}
      {warning && <p className="warning">{warning}</p>}

      {quote && mode === "sku" && (
        <section className="card">
          <h2>Quote Breakdown</h2>
          <p>SKU: {quote.sku.sku_code} - {quote.sku.name}</p>
          <p>Quantity Raw: {units(quote.quantity_raw)}</p>
          <p>Unit Multiplier: {units(quote.unit_multiplier)}</p>
          <p>Relative Units: {units(quote.relative_units)}</p>
          <p>Base Unit Price: {currency(quote.base_unit_price)}</p>
          <p>Base Cost: {currency(quote.base_cost)}</p>
          <p>Discount: {percent(quote.discount_decimal)}</p>
          <p>Discounted Cost: {currency(quote.discounted_cost)}</p>
          <p>Total Uplift: {percent(quote.uplift_decimal)}</p>
          <p>Final Cost: <strong>{currency(quote.final_cost)}</strong></p>
          <p>
            Applied Uplifts:{" "}
            {quote.applied_uplifts.length
              ? quote.applied_uplifts.map((u) => u.uplift_name).join(", ")
              : "None"}
          </p>
        </section>
      )}

      {quote && mode === "use_case" && (
        <section className="card">
          <h2>Use Case Quote</h2>
          <p>Use Case: {quote.use_case}</p>
          <p>Hours: {units(quote.hours)}</p>
          <p>Total Cost (Hyperfusion): <strong>{currency(quote.grand_total_usd)}</strong></p>
          <p>Cost per Hour: <strong>{currency((quote.grand_total_usd || 0) / (quote.hours || 1))}</strong></p>

          <h3>Provider Results</h3>
          <table className="breakdown-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Hourly Price</th>
                <th>Total Estimated Cost</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              {sortedProviderResults.map((item) => (
                <tr
                  key={item.providerName}
                  className={item.providerName === "Hyperfusion" ? "provider-hyperfusion" : ""}
                >
                  <td>{item.providerName}</td>
                  <td>
                    {currency(item.hourlyPrice)}{" "}
                    {region === "All Regions" && item.providerName !== "Hyperfusion" ? (
                      <span className="best-region">Best in: {item.regionSource}</span>
                    ) : null}
                  </td>
                  <td>{currency(item.totalCost)}</td>
                  <td>
                    {PROVIDER_LINKS[item.providerName] ? (
                      <a href={PROVIDER_LINKS[item.providerName]} target="_blank" rel="noreferrer">
                        Visit Site
                      </a>
                    ) : (
                      <span className="muted">N/A</span>
                    )}
                  </td>
                </tr>
              ))}
              {sortedProviderResults.length === 0 && (
                <tr>
                  <td colSpan="4">No providers have pricing for this GPU/region selection.</td>
                </tr>
              )}
            </tbody>
          </table>

          <table className="breakdown-table">
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
              {sortedUseCaseBreakdown.length === 0 && (
                <tr>
                  <td colSpan="5">No SKU contributions for this use case/hours combination.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

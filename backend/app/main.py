import asyncio
import csv
import io
import logging
import os
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Annotated, Any, Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

REFRESH_SECONDS = 600
RATE_LIMIT_WINDOW_SECONDS = 60
DEFAULT_ALLOWED_ORIGINS = ("https://hyperfusion-pricing-tool.vercel.app",)
GPU_TYPES = ("A100", "B200", "GH200", "H100", "H200", "L40S")
REGIONS = ("All Regions", "North America", "Europe", "Asia-Pacific")
RANK_OPTIONS = ("Best Overall", "Lowest Price", "Provider Name")

logger = logging.getLogger(__name__)


@dataclass
class SKU:
    sku_code: str
    name: str
    unit_label: str
    base_unit_price: float
    unit: float


@dataclass
class VolumeDiscount:
    min_units: float
    discount_decimal: float


@dataclass
class Uplift:
    uplift_name: str
    percent_decimal: float
    enabled: bool


TrimmedString = Annotated[str, Field(min_length=1, max_length=200)]
UpliftName = Annotated[str, Field(min_length=1, max_length=100)]


class QuoteRequest(BaseModel):
    mode: Literal["sku", "use_case"] = "sku"
    sku_code: TrimmedString | None = None
    quantity: float | None = Field(default=None, gt=0, le=1000)
    use_case: TrimmedString | None = None
    hours: float | None = Field(default=None, gt=0, le=1000)
    customer: Annotated[str, Field(max_length=200)] | None = None
    gpu_type: Literal["A100", "B200", "GH200", "H100", "H200", "L40S"] | None = None
    region: Literal["All Regions", "North America", "Europe", "Asia-Pacific"] | None = None
    rank_results_by: Literal["Best Overall", "Lowest Price", "Provider Name"] | None = None
    uplift_names: list[UpliftName] | None = Field(default=None, max_length=100)

    @field_validator("sku_code", "use_case", "customer", mode="before")
    @classmethod
    def normalize_optional_string(cls, value: Any) -> Any:
        if value is None:
            return None
        normalized = str(value).strip()
        return normalized or None

    @field_validator("uplift_names", mode="before")
    @classmethod
    def normalize_uplift_names(cls, value: Any) -> Any:
        if value is None:
            return None
        if not isinstance(value, list):
            raise ValueError("Invalid request")
        normalized = []
        for item in value:
            name = str(item).strip()
            if not name:
                raise ValueError("Invalid request")
            normalized.append(name)
        return normalized


class DataStore:
    def __init__(self) -> None:
        self.skus: dict[str, SKU] = {}
        self.volume_discounts: list[VolumeDiscount] = []
        self.uplifts: dict[str, Uplift] = {}
        self.use_case_mappings: dict[str, dict[str, float]] = {}
        self.use_cases: list[str] = []
        self.last_refresh_utc: float | None = None
        self._refresh_lock = asyncio.Lock()

    async def _fetch_csv(self, client: httpx.AsyncClient, url: str) -> list[dict[str, str]]:
        resp = await client.get(url, timeout=30, follow_redirects=True)
        resp.raise_for_status()
        text = resp.text
        reader = csv.DictReader(io.StringIO(text))
        return [{k.strip(): (v or "").strip() for k, v in row.items()} for row in reader]

    @staticmethod
    def _parse_bool(value: str) -> bool:
        return value.strip().lower() in {"true", "1", "yes", "y"}

    @staticmethod
    def _parse_float(value: str) -> float:
        # Accept formatted numeric values from spreadsheets, e.g. "1,000,000", "$12.50", "5%".
        cleaned = value.strip().replace(",", "").replace("$", "").replace("%", "")
        if cleaned == "":
            return 0.0
        return float(cleaned)

    def _parse_use_case_mappings(
        self, rows: list[dict[str, str]]
    ) -> tuple[dict[str, dict[str, float]], list[str]]:
        if not rows:
            return {}, []

        headers = [h for h in rows[0].keys() if h is not None]
        use_cases = [h for h in headers if h != "SKU Code"]
        parsed: dict[str, dict[str, float]] = {}

        for row in rows:
            sku_code = (row.get("SKU Code") or "").strip()
            if not sku_code:
                continue
            parsed[sku_code] = {use_case: self._parse_float(row.get(use_case, "")) for use_case in use_cases}

        return parsed, use_cases

    async def refresh_once(self) -> None:
        async with self._refresh_lock:
            pricelist_url = os.getenv("PRICELIST_CSV_URL")
            volume_url = os.getenv("VOLUME_CSV_URL")
            uplifts_url = os.getenv("UPLIFTS_CSV_URL")
            use_case_mappings_url = os.getenv("USE_CASE_MAPPINGS_CSV_URL")
            if not pricelist_url or not volume_url or not uplifts_url or not use_case_mappings_url:
                raise RuntimeError(
                    "Missing required env vars: PRICELIST_CSV_URL, VOLUME_CSV_URL, UPLIFTS_CSV_URL, USE_CASE_MAPPINGS_CSV_URL"
                )

            async with httpx.AsyncClient() as client:
                price_rows, volume_rows, uplift_rows, use_case_rows = await asyncio.gather(
                    self._fetch_csv(client, pricelist_url),
                    self._fetch_csv(client, volume_url),
                    self._fetch_csv(client, uplifts_url),
                    self._fetch_csv(client, use_case_mappings_url),
                )

            parsed_skus: dict[str, SKU] = {}
            for row in price_rows:
                sku = SKU(
                    sku_code=row["SKU Code"],
                    name=row["Name"],
                    unit_label=row["Unit Label"],
                    base_unit_price=self._parse_float(row["Base Unit Price (USD)"]),
                    unit=self._parse_float(row["Unit"]),
                )
                parsed_skus[sku.sku_code] = sku

            parsed_discounts = sorted(
                [
                    VolumeDiscount(
                        min_units=self._parse_float(row["Min Units (Relative)"]),
                        discount_decimal=self._parse_float(row["Discount % (as decimal)"]),
                    )
                    for row in volume_rows
                ],
                key=lambda d: d.min_units,
            )

            parsed_uplifts: dict[str, Uplift] = {}
            for row in uplift_rows:
                uplift = Uplift(
                    uplift_name=row["Uplift Name"],
                    percent_decimal=self._parse_float(row["Percent (as decimal)"]),
                    enabled=self._parse_bool(row["Enabled (TRUE/FALSE)"]),
                )
                parsed_uplifts[uplift.uplift_name] = uplift
            parsed_use_case_mappings, parsed_use_cases = self._parse_use_case_mappings(use_case_rows)

            self.skus = parsed_skus
            self.volume_discounts = parsed_discounts
            self.uplifts = parsed_uplifts
            self.use_case_mappings = parsed_use_case_mappings
            self.use_cases = parsed_use_cases
            self.last_refresh_utc = time.time()

    async def ensure_fresh(self) -> None:
        now = time.time()
        if self.last_refresh_utc is None or (now - self.last_refresh_utc) >= REFRESH_SECONDS:
            await self.refresh_once()


store = DataStore()
app = FastAPI(title="Pricing Tool API", version="1.0.0")
rate_limit_store: dict[str, deque[float]] = defaultdict(deque)
rate_limit_lock = asyncio.Lock()


def _parse_allowed_origins() -> list[str]:
    raw = os.getenv("ALLOWED_ORIGINS", "")
    configured = [origin.strip() for origin in raw.split(",") if origin.strip()]
    if configured:
        return configured

    vercel_url = (os.getenv("VERCEL_URL") or "").strip()
    if vercel_url:
        return [f"https://{vercel_url}"]

    return list(DEFAULT_ALLOWED_ORIGINS)


def _get_client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip() or "unknown"

    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip

    if request.client and request.client.host:
        return request.client.host

    return "unknown"


async def _enforce_rate_limit(request: Request, limit_key: str, max_requests: int) -> None:
    # This limiter is instance-local and approximate. Move enforcement to shared
    # edge or infrastructure controls for stronger protection across replicas.
    ip_address = _get_client_ip(request)
    now = time.monotonic()
    window_start = now - RATE_LIMIT_WINDOW_SECONDS
    bucket = f"{limit_key}:{ip_address}"

    async with rate_limit_lock:
        timestamps = rate_limit_store[bucket]
        while timestamps and timestamps[0] <= window_start:
            timestamps.popleft()

        if len(timestamps) >= max_requests:
            logger.warning("Rate limit exceeded for %s on %s", ip_address, request.url.path)
            raise HTTPException(status_code=429, detail="Rate limit exceeded")

        timestamps.append(now)


def _build_rate_limiter(limit_key: str, max_requests: int):
    async def dependency(request: Request) -> None:
        await _enforce_rate_limit(request, limit_key, max_requests)

    return dependency


health_rate_limit = _build_rate_limiter("health", 30)
skus_rate_limit = _build_rate_limiter("skus", 60)
uplifts_rate_limit = _build_rate_limiter("uplifts", 60)
use_cases_rate_limit = _build_rate_limiter("use_cases", 60)
quote_rate_limit = _build_rate_limiter("quote", 20)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "x-api-key"],
)


@app.exception_handler(RequestValidationError)
async def handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    logger.warning("Invalid request validation for %s from %s", request.url.path, _get_client_ip(request))
    return JSONResponse(status_code=422, content={"detail": "Invalid request"})


def require_api_key(request: Request, x_api_key: str | None = Header(default=None, alias="x-api-key")) -> None:
    expected_key = (os.getenv("PRICING_API_KEY") or "").strip()
    if not expected_key:
        logger.error("API key check unavailable for %s", request.url.path)
        raise HTTPException(status_code=503, detail="Service unavailable")
    if not x_api_key or not secrets.compare_digest(x_api_key, expected_key):
        logger.warning("Invalid API key attempt from %s on %s", _get_client_ip(request), request.url.path)
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health", dependencies=[Depends(health_rate_limit)])
async def health() -> dict[str, Any]:
    return {"ok": True}


@app.get("/skus", dependencies=[Depends(skus_rate_limit), Depends(require_api_key)])
async def get_skus() -> list[dict[str, Any]]:
    await store.ensure_fresh()
    return [
        {
            "sku_code": sku.sku_code,
            "name": sku.name,
            "unit_label": sku.unit_label,
            "base_unit_price": sku.base_unit_price,
            "unit": sku.unit,
        }
        for sku in sorted(store.skus.values(), key=lambda x: x.sku_code)
    ]


@app.get("/uplifts", dependencies=[Depends(uplifts_rate_limit), Depends(require_api_key)])
async def get_uplifts() -> list[dict[str, Any]]:
    await store.ensure_fresh()
    return [
        {
            "uplift_name": uplift.uplift_name,
            "percent_decimal": uplift.percent_decimal,
            "enabled": uplift.enabled,
        }
        for uplift in sorted(store.uplifts.values(), key=lambda x: x.uplift_name)
    ]


@app.get("/use-cases", dependencies=[Depends(use_cases_rate_limit), Depends(require_api_key)])
async def get_use_cases() -> list[str]:
    await store.ensure_fresh()
    return store.use_cases


def _resolve_uplifts(uplift_names: list[str] | None) -> list[Uplift]:
    if uplift_names is None:
        return [u for u in store.uplifts.values() if u.enabled]

    missing = [name for name in uplift_names if name not in store.uplifts]
    if missing:
        raise HTTPException(status_code=400, detail="Invalid request")
    return [store.uplifts[name] for name in uplift_names]


def _calculate_sku_quote(sku_code: str, quantity: float, uplift_names: list[str] | None) -> dict[str, Any]:
    sku = store.skus.get(sku_code)
    if not sku:
        raise HTTPException(status_code=404, detail="Not found")

    relative_units = quantity / sku.unit
    base_cost = relative_units * sku.base_unit_price

    discount_decimal = 0.0
    for d in store.volume_discounts:
        if d.min_units <= relative_units and d.discount_decimal > discount_decimal:
            discount_decimal = d.discount_decimal

    discounted_cost = base_cost * (1 - discount_decimal)
    selected_uplifts = _resolve_uplifts(uplift_names)
    uplift_decimal = sum(u.percent_decimal for u in selected_uplifts)
    final_cost = discounted_cost * (1 + uplift_decimal)

    return {
        "sku": {
            "sku_code": sku.sku_code,
            "name": sku.name,
            "unit_label": sku.unit_label,
        },
        "quantity_raw": quantity,
        "unit_multiplier": sku.unit,
        "relative_units": relative_units,
        "base_unit_price": sku.base_unit_price,
        "base_cost": base_cost,
        "discount_decimal": discount_decimal,
        "discounted_cost": discounted_cost,
        "uplift_decimal": uplift_decimal,
        "final_cost": final_cost,
        "applied_uplifts": [
            {
                "uplift_name": u.uplift_name,
                "percent_decimal": u.percent_decimal,
            }
            for u in selected_uplifts
        ],
    }


@app.post("/quote", dependencies=[Depends(quote_rate_limit), Depends(require_api_key)])
async def quote(payload: QuoteRequest) -> dict[str, Any]:
    await store.ensure_fresh()
    if payload.mode == "sku":
        if not payload.sku_code:
            raise HTTPException(status_code=400, detail="Invalid request")
        if payload.quantity is None or payload.quantity <= 0:
            raise HTTPException(status_code=400, detail="Invalid request")
        return _calculate_sku_quote(payload.sku_code, payload.quantity, payload.uplift_names)

    if payload.mode == "use_case":
        if not payload.use_case:
            raise HTTPException(status_code=400, detail="Invalid request")
        if payload.use_case not in store.use_cases:
            raise HTTPException(status_code=400, detail="Invalid request")
        if payload.hours is None or payload.hours <= 0:
            raise HTTPException(status_code=400, detail="Invalid request")

        breakdown: list[dict[str, Any]] = []
        grand_total_usd = 0.0

        for sku_code, per_use_case in store.use_case_mappings.items():
            units_per_hour = per_use_case.get(payload.use_case, 0.0)
            units_total = units_per_hour * payload.hours
            if units_total <= 0:
                continue
            if sku_code not in store.skus:
                continue

            sku_quote = _calculate_sku_quote(sku_code, units_total, payload.uplift_names)
            cost_usd = sku_quote["final_cost"]
            grand_total_usd += cost_usd
            breakdown.append(
                {
                    "sku_code": sku_code,
                    "sku_name": sku_quote["sku"]["name"],
                    "unit_label": sku_quote["sku"]["unit_label"],
                    "units_per_hour": units_per_hour,
                    "units_total": units_total,
                    "cost_usd": cost_usd,
                }
            )

        breakdown.sort(key=lambda item: item["cost_usd"], reverse=True)
        return {
            "mode": "use_case",
            "use_case": payload.use_case,
            "hours": payload.hours,
            "grand_total_usd": grand_total_usd,
            "breakdown": breakdown,
        }

    raise HTTPException(status_code=400, detail="Invalid request")

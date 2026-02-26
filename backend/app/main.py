import asyncio
import csv
import io
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

REFRESH_SECONDS = 600


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


class QuoteRequest(BaseModel):
    mode: str = "sku"
    sku_code: str | None = None
    quantity: float | None = Field(default=None, gt=0)
    use_case: str | None = None
    hours: float | None = Field(default=None, gt=0)
    customer: str | None = None
    gpu_type: str | None = None
    region: str | None = None
    rank_results_by: str | None = None
    uplift_names: list[str] | None = None


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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_api_key(x_api_key: str | None = Header(default=None, alias="x-api-key")) -> None:
    expected_key = (os.getenv("PRICING_API_KEY") or "").strip()
    if not expected_key:
        raise HTTPException(status_code=500, detail="Server API key is not configured")
    if not x_api_key or not secrets.compare_digest(x_api_key, expected_key):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health")
async def health() -> dict[str, Any]:
    await store.ensure_fresh()
    return {
        "ok": True,
        "sku_count": len(store.skus),
        "uplift_count": len(store.uplifts),
        "use_case_count": len(store.use_cases),
    }


@app.get("/skus", dependencies=[Depends(require_api_key)])
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


@app.get("/uplifts", dependencies=[Depends(require_api_key)])
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


@app.get("/use-cases", dependencies=[Depends(require_api_key)])
async def get_use_cases() -> list[str]:
    await store.ensure_fresh()
    return store.use_cases


def _resolve_uplifts(uplift_names: list[str] | None) -> list[Uplift]:
    if uplift_names is None:
        return [u for u in store.uplifts.values() if u.enabled]

    missing = [name for name in uplift_names if name not in store.uplifts]
    if missing:
        raise HTTPException(status_code=400, detail=f"Unknown uplifts: {missing}")
    return [store.uplifts[name] for name in uplift_names]


def _calculate_sku_quote(sku_code: str, quantity: float, uplift_names: list[str] | None) -> dict[str, Any]:
    sku = store.skus.get(sku_code)
    if not sku:
        raise HTTPException(status_code=404, detail=f"Unknown sku_code: {sku_code}")

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


@app.post("/quote", dependencies=[Depends(require_api_key)])
async def quote(payload: QuoteRequest) -> dict[str, Any]:
    await store.ensure_fresh()
    if payload.mode == "sku":
        if not payload.sku_code:
            raise HTTPException(status_code=400, detail="sku_code is required for mode=sku")
        if payload.quantity is None or payload.quantity <= 0:
            raise HTTPException(status_code=400, detail="quantity must be > 0 for mode=sku")
        return _calculate_sku_quote(payload.sku_code, payload.quantity, payload.uplift_names)

    if payload.mode == "use_case":
        if not payload.use_case:
            raise HTTPException(status_code=400, detail="use_case is required for mode=use_case")
        if payload.use_case not in store.use_cases:
            raise HTTPException(
                status_code=400,
                detail=f"use_case not found: {payload.use_case}",
            )
        if payload.hours is None or payload.hours <= 0:
            raise HTTPException(status_code=400, detail="hours must be > 0 for mode=use_case")

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

    raise HTTPException(status_code=400, detail="mode must be either 'sku' or 'use_case'")

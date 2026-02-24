import asyncio

from app.main import DataStore, QuoteRequest, SKU, Uplift, VolumeDiscount, quote, store


def test_parse_use_case_mappings_headers_and_numeric_coercion() -> None:
    rows = [
        {
            "SKU Code": "SKU-A",
            "Early-Stage AI Startup": "1,200.5",
            "Academic Research": "",
        },
        {
            "SKU Code": "SKU-B",
            "Early-Stage AI Startup": "",
            "Academic Research": "3",
        },
    ]

    parsed, use_cases = DataStore()._parse_use_case_mappings(rows)

    assert use_cases == ["Early-Stage AI Startup", "Academic Research"]
    assert parsed["SKU-A"]["Early-Stage AI Startup"] == 1200.5
    assert parsed["SKU-A"]["Academic Research"] == 0.0
    assert parsed["SKU-B"]["Early-Stage AI Startup"] == 0.0
    assert parsed["SKU-B"]["Academic Research"] == 3.0


def test_use_case_quote_end_to_end_multiplier_behavior() -> None:
    original = (
        store.skus,
        store.volume_discounts,
        store.uplifts,
        store.use_case_mappings,
        store.use_cases,
    )

    try:
        store.skus = {
            "SKU-A": SKU(
                sku_code="SKU-A",
                name="A",
                unit_label="Tokens",
                base_unit_price=2.0,
                unit=1.0,
            ),
            "SKU-B": SKU(
                sku_code="SKU-B",
                name="B",
                unit_label="Jobs",
                base_unit_price=1.0,
                unit=2.0,
            ),
        }
        store.volume_discounts = [VolumeDiscount(min_units=10.0, discount_decimal=0.1)]
        store.uplifts = {"Default": Uplift(uplift_name="Default", percent_decimal=0.2, enabled=True)}
        store.use_cases = ["Early-Stage AI Startup"]
        store.use_case_mappings = {
            "SKU-A": {"Early-Stage AI Startup": 3.0},
            "SKU-B": {"Early-Stage AI Startup": 1.0},
        }

        result = asyncio.run(
            quote(
                QuoteRequest(
                    mode="use_case",
                    use_case="Early-Stage AI Startup",
                    hours=10.0,
                    uplift_names=[],
                )
            )
        )

        assert result["mode"] == "use_case"
        assert result["hours"] == 10.0
        assert len(result["breakdown"]) == 2
        assert result["breakdown"][0]["sku_code"] == "SKU-A"
        assert result["breakdown"][0]["units_per_hour"] == 3.0
        assert result["breakdown"][0]["units_total"] == 30.0
        assert result["breakdown"][0]["cost_usd"] == 54.0
        assert result["breakdown"][1]["sku_code"] == "SKU-B"
        assert result["breakdown"][1]["units_total"] == 10.0
        assert result["breakdown"][1]["cost_usd"] == 5.0
        assert result["grand_total_usd"] == 59.0
    finally:
        (
            store.skus,
            store.volume_discounts,
            store.uplifts,
            store.use_case_mappings,
            store.use_cases,
        ) = original

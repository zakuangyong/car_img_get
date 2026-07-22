from __future__ import annotations

from copy import deepcopy
from typing import Any, Optional


METADATA_SCHEMA_VERSION = 2

VEHICLE_CATEGORIES: dict[int, str] = {
    0: "未知",
    1: "轿车",
    2: "SUV",
    3: "MPV",
    4: "跑车",
    5: "微面",
    6: "轻客",
    7: "皮卡",
    8: "卡车",
    9: "客车",
}


def vehicle_category_from_level(level_name: Any) -> tuple[int, str]:
    name = str(level_name or "").strip()
    upper = name.upper()
    if "SUV" in upper:
        category_id = 2
    elif "MPV" in upper:
        category_id = 3
    elif "跑车" in name:
        category_id = 4
    elif "微面" in name:
        category_id = 5
    elif "轻客" in name:
        category_id = 6
    elif "皮卡" in name:
        category_id = 7
    elif "卡车" in name or "货车" in name or "微卡" in name:
        category_id = 8
    elif "客车" in name:
        category_id = 9
    elif name.endswith("车"):
        category_id = 1
    else:
        category_id = 0
    return category_id, VEHICLE_CATEGORIES[category_id]


def normalize_quality(quality: Any) -> tuple[Optional[dict[str, Any]], Optional[str]]:
    if not isinstance(quality, dict):
        return None, None

    result = deepcopy(quality)
    result.pop("view", None)

    models = result.get("models")
    view_model: Optional[str] = None
    if isinstance(models, dict):
        raw_model = models.pop("view", None)
        if raw_model:
            view_model = str(raw_model)
        if not models:
            result.pop("models", None)

    clean = result.get("clean")
    if isinstance(clean, dict):
        clean.pop("view", None)

    return result, view_model


def view_data_from_record(record: dict[str, Any]) -> tuple[str, Optional[float], Optional[str]]:
    raw_view = record.get("view")
    if isinstance(raw_view, dict):
        label = str(raw_view.get("label") or "").strip()
        confidence = _optional_float(raw_view.get("confidence"))
        model = str(raw_view.get("model") or "").strip() or None
    else:
        label = str(raw_view or record.get("view_raw") or "").strip()
        confidence = _optional_float(record.get("view_confidence"))
        model = str(record.get("view_model") or "").strip() or None

    quality = record.get("quality")
    if isinstance(quality, dict):
        quality_view = quality.get("view")
        if isinstance(quality_view, dict):
            label = str(quality_view.get("label") or label).strip()
            confidence = _optional_float(quality_view.get("confidence")) or confidence
        models = quality.get("models")
        if isinstance(models, dict):
            model = str(models.get("view") or model or "").strip() or None

    features = record.get("view_features")
    if confidence is None and isinstance(features, dict):
        confidence = _optional_float(features.get("confidence"))
    return label, confidence, model


def _optional_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any, Iterable, Optional

import numpy as np
from PIL import Image
from tqdm import tqdm

from .autohome_api import AutohomeClient
from .metadata_schema import (
    METADATA_SCHEMA_VERSION,
    normalize_quality,
    vehicle_category_from_level,
    view_data_from_record,
)
from .quality_pipeline import default_view_model_path


def main() -> None:
    parser = argparse.ArgumentParser(description="清洗 metadata.jsonl 并重新识别汽车角度")
    parser.add_argument("--input", type=Path, required=True, help="原 metadata.jsonl")
    parser.add_argument("--output", type=Path, default=None, help="清洗后的 JSONL")
    parser.add_argument("--model", type=Path, default=None, help="YOLO 汽车角度分类模型")
    parser.add_argument("--device", default="auto", help="auto/cpu/cuda:0")
    parser.add_argument("--batch-size", type=int, default=8, help="角度分类批量大小")
    parser.add_argument("--limit", type=int, default=0, help="仅处理前 N 条，0 表示全部")
    parser.add_argument("--no-fetch-series", action="store_true", help="不联网补充车系级别")
    parser.add_argument("--force", action="store_true", help="覆盖已存在的输出文件")
    args = parser.parse_args()

    input_path = args.input.resolve()
    output_path = (args.output or input_path.with_name(f"{input_path.stem}.cleaned.jsonl")).resolve()
    if output_path.exists() and not args.force:
        parser.error(f"输出文件已存在，请改用其他路径或增加 --force: {output_path}")

    work_root = input_path.parent / "_metadata_migration"
    work_root.mkdir(parents=True, exist_ok=True)
    source_records = read_jsonl(input_path, limit=max(0, int(args.limit)))
    records, duplicate_events = deduplicate_records(source_records)
    series_cache_path = work_root / "series_info.json"
    view_cache_path = work_root / "view_predictions.jsonl"
    error_path = output_path.with_suffix(".errors.jsonl")

    series_cache = enrich_series(
        records,
        load_json_object(series_cache_path),
        series_cache_path,
        fetch=not args.no_fetch_series,
    )
    model_path = (args.model or default_view_model_path()).resolve()
    view_cache = load_view_cache(view_cache_path)
    prediction_errors = predict_missing_views(
        records,
        input_path=input_path,
        model_path=model_path,
        device=str(args.device),
        batch_size=max(1, int(args.batch_size)),
        cache=view_cache,
        cache_path=view_cache_path,
    )

    migrated: list[dict[str, Any]] = []
    migration_errors: list[dict[str, Any]] = [*duplicate_events, *prediction_errors]
    for index, record in enumerate(records, start=1):
        key = record_key(record, index)
        prediction = view_cache.get(key)
        if prediction is None:
            old_label, old_confidence, old_model = view_data_from_record(record)
            prediction = {
                "label": old_label,
                "confidence": old_confidence,
                "model": old_model,
                "source": "existing_fallback",
            }
        series_info = series_cache.get(str(record.get("seriesid") or ""), {})
        migrated.append(normalize_record(record, prediction, series_info))

    write_jsonl_atomic(output_path, migrated)
    write_jsonl_atomic(error_path, migration_errors)
    validate_output(records, migrated, model_path)
    print_summary(output_path, error_path, len(source_records), migrated, duplicate_events, prediction_errors)


def read_jsonl(path: Path, *, limit: int = 0) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"第 {line_number} 行不是 JSON 对象")
            records.append(value)
            if limit and len(records) >= limit:
                break
    return records


def deduplicate_records(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    selected: dict[tuple[Any, ...], tuple[int, dict[str, Any]]] = {}
    events: list[dict[str, Any]] = []
    order: list[tuple[Any, ...]] = []
    for index, record in enumerate(records, start=1):
        identity = (record.get("seriesid"), record.get("specid"), record.get("picid"))
        key = identity if all(value is not None for value in identity) else ("line", index)
        current = selected.get(key)
        if current is None:
            selected[key] = (index, record)
            order.append(key)
            continue
        current_index, current_record = current
        if record_richness(record) > record_richness(current_record):
            selected[key] = (index, record)
            kept_index, removed_index = index, current_index
        else:
            kept_index, removed_index = current_index, index
        events.append(
            {
                "type": "duplicate_removed",
                "seriesid": identity[0],
                "specid": identity[1],
                "picid": identity[2],
                "kept_line": kept_index,
                "removed_line": removed_index,
                "md5": record.get("md5") or current_record.get("md5"),
            }
        )
    return [selected[key][1] for key in order], events


def record_richness(record: dict[str, Any]) -> tuple[int, int, int]:
    return (
        int(isinstance(record.get("quality"), dict)),
        int(isinstance(record.get("pipeline_artifacts"), dict)),
        len(record),
    )


def enrich_series(
    records: Iterable[dict[str, Any]],
    cache: dict[str, Any],
    cache_path: Path,
    *,
    fetch: bool,
) -> dict[str, Any]:
    series_ids = sorted({int(record["seriesid"]) for record in records if record.get("seriesid") is not None})
    missing = [series_id for series_id in series_ids if str(series_id) not in cache]
    if not fetch or not missing:
        return cache

    client = AutohomeClient(timeout_s=20.0, max_retries=3, sleep_s=0.2)
    for position, series_id in enumerate(tqdm(missing, desc="车型级别"), start=1):
        try:
            info = client.get_series_info(series_id)
            cache[str(series_id)] = {
                "seriesname": info.seriesname if info else "",
                "brandname": info.brandname if info else "",
                "levelid": info.levelid if info else 0,
                "levelname": info.levelname if info else "",
            }
        except Exception as exc:
            cache[str(series_id)] = {"levelid": 0, "levelname": "", "error": str(exc)}
        if position % 10 == 0 or position == len(missing):
            write_json_object_atomic(cache_path, cache)
        time.sleep(0.05)
    return cache


def predict_missing_views(
    records: list[dict[str, Any]],
    *,
    input_path: Path,
    model_path: Path,
    device: str,
    batch_size: int,
    cache: dict[str, Any],
    cache_path: Path,
) -> list[dict[str, Any]]:
    if not model_path.is_file():
        raise FileNotFoundError(f"角度分类模型不存在: {model_path}")

    pending = [(index, record) for index, record in enumerate(records, start=1) if record_key(record, index) not in cache]
    if not pending:
        return []

    from ultralytics import YOLO

    model = YOLO(str(model_path))
    errors: list[dict[str, Any]] = []
    for offset in tqdm(range(0, len(pending), batch_size), desc="角度修正"):
        batch = pending[offset : offset + batch_size]
        images: list[np.ndarray] = []
        valid: list[tuple[int, dict[str, Any], Path]] = []
        for index, record in batch:
            try:
                image_path = resolve_view_image(record, input_path)
                images.append(np.asarray(load_white_rgb(image_path)))
                valid.append((index, record, image_path))
            except Exception as exc:
                errors.append({"index": index, "key": record_key(record, index), "error": str(exc)})
        if not images:
            continue

        kwargs: dict[str, Any] = {"verbose": False}
        if device and device != "auto":
            kwargs["device"] = device
        try:
            results = model.predict(images, **kwargs)
        except Exception as exc:
            for index, record, image_path in valid:
                errors.append(
                    {"index": index, "key": record_key(record, index), "image": str(image_path), "error": str(exc)}
                )
            continue

        for (index, record, image_path), result in zip(valid, results):
            probs = getattr(result, "probs", None)
            if probs is None:
                errors.append({"index": index, "key": record_key(record, index), "error": "模型未返回分类概率"})
                continue
            top1 = int(probs.top1)
            names = getattr(result, "names", None) or getattr(model, "names", None) or {}
            label = names.get(top1, str(top1)) if isinstance(names, dict) else str(top1)
            key = record_key(record, index)
            cache[key] = {
                "label": normalize_label(label),
                "confidence": float(probs.top1conf),
                "model": str(model_path),
                "source": "yolo11_view_classifier",
                "image": str(image_path),
            }
            append_jsonl(cache_path, {"key": key, **cache[key]})
    return errors


def resolve_view_image(record: dict[str, Any], input_path: Path) -> Path:
    artifacts = record.get("pipeline_artifacts")
    candidates: list[Any] = []
    if isinstance(artifacts, dict):
        candidates.append(artifacts.get("birefnet"))
    candidates.append(record.get("saved_path"))
    project_root = input_path.parent.parent
    for raw_path in candidates:
        if not raw_path:
            continue
        path = Path(str(raw_path))
        paths = [path] if path.is_absolute() else [project_root / path, input_path.parent / path]
        for candidate in paths:
            if candidate.is_file():
                return candidate.resolve()
    raise FileNotFoundError(f"找不到角度分类图片: {candidates}")


def load_white_rgb(path: Path) -> Image.Image:
    with Image.open(path) as image:
        rgba = image.convert("RGBA")
        white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(white, rgba).convert("RGB")


def normalize_record(
    record: dict[str, Any],
    prediction: dict[str, Any],
    series_info: dict[str, Any],
) -> dict[str, Any]:
    quality, quality_view_model = normalize_quality(record.get("quality"))
    level_id = int(series_info.get("levelid") or 0)
    level_name = str(series_info.get("levelname") or "")
    category_id, category_name = vehicle_category_from_level(level_name)
    old_category_id = record.get("image_categoryid", record.get("categoryid"))
    old_type_id = record.get("image_typeid", record.get("typeid"))

    obsolete = {"view_raw", "view_scheme", "view_features", "typeid", "image_categoryid", "image_typeid"}
    remaining = {key: value for key, value in record.items() if key not in obsolete}
    remaining.update(
        {
            "metadata_schema_version": METADATA_SCHEMA_VERSION,
            "categoryid": category_id,
            "categoryname": category_name,
            "category_source": {
                "provider": "autohome",
                "levelid": level_id,
                "levelname": level_name,
            },
            "image_categoryid": old_category_id,
            "image_typeid": old_type_id,
            "view": str(prediction.get("label") or ""),
            "view_confidence": optional_float(prediction.get("confidence")),
            "view_model": str(prediction.get("model") or quality_view_model or "") or None,
            "view_source": str(prediction.get("source") or ""),
            "quality": quality,
        }
    )
    return {key: value for key, value in remaining.items() if value is not None}


def validate_output(original: list[dict[str, Any]], migrated: list[dict[str, Any]], model_path: Path) -> None:
    if len(original) != len(migrated):
        raise RuntimeError(f"记录数不一致: {len(original)} != {len(migrated)}")
    duplicate_picids = len(migrated) - len({(r.get("seriesid"), r.get("specid"), r.get("picid")) for r in migrated})
    if duplicate_picids:
        raise RuntimeError(f"发现 {duplicate_picids} 条重复 seriesid/specid/picid")
    for index, record in enumerate(migrated, start=1):
        forbidden = {"view_raw", "view_scheme", "view_features", "typeid"} & record.keys()
        if forbidden:
            raise RuntimeError(f"第 {index} 条仍含冗余字段: {sorted(forbidden)}")
        if record.get("view_model") == str(model_path) and not record.get("view"):
            raise RuntimeError(f"第 {index} 条模型角度标签为空")


def print_summary(
    output_path: Path,
    error_path: Path,
    source_count: int,
    records: list[dict[str, Any]],
    duplicate_events: list[dict[str, Any]],
    prediction_errors: list[dict[str, Any]],
) -> None:
    categories: dict[str, int] = {}
    views: dict[str, int] = {}
    sources: dict[str, int] = {}
    for record in records:
        category = f"{record.get('categoryid')}:{record.get('categoryname')}"
        categories[category] = categories.get(category, 0) + 1
        view = str(record.get("view") or "unknown")
        views[view] = views.get(view, 0) + 1
        source = str(record.get("view_source") or "unknown")
        sources[source] = sources.get(source, 0) + 1
    print(
        json.dumps(
            {
                "source_records": source_count,
                "records": len(records),
                "duplicates_removed": len(duplicate_events),
                "prediction_errors": len(prediction_errors),
                "categories": categories,
                "views": views,
                "view_sources": sources,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print(f"输出: {output_path}")
    print(f"迁移事件: {error_path} ({len(duplicate_events) + len(prediction_errors)} 条)")


def record_key(record: dict[str, Any], index: int) -> str:
    return str(record.get("md5") or f"{record.get('seriesid')}:{record.get('specid')}:{record.get('picid')}:{index}")


def normalize_label(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "")


def optional_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def load_json_object(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else {}


def load_view_cache(path: Path) -> dict[str, Any]:
    cache: dict[str, Any] = {}
    if not path.is_file():
        return cache
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            value = json.loads(line)
            key = str(value.get("key", ""))
            if key:
                cache[key] = {k: v for k, v in value.items() if k != "key"}
    return cache


def append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False) + "\n")
        handle.flush()


def write_json_object_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    replace_with_retry(temp_path, path)


def write_jsonl_atomic(path: Path, records: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    replace_with_retry(temp_path, path)


def replace_with_retry(source: Path, target: Path, attempts: int = 10) -> None:
    for attempt in range(attempts):
        try:
            source.replace(target)
            return
        except PermissionError:
            if attempt + 1 >= attempts:
                raise
            time.sleep(0.2 * (attempt + 1))


if __name__ == "__main__":
    main()

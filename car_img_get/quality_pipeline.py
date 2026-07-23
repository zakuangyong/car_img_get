from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

import numpy as np
from PIL import Image

from .subject_extractor import SubjectExtractor, default_checkpoint_path, project_root


@dataclass(frozen=True)
class QualityDecision:
    accepted: bool
    reason: str
    output_image: Optional[Image.Image]
    metadata: dict[str, Any]


def default_view_model_path() -> Path:
    model_root = project_root() / "models"
    canonical = model_root / "view-cls" / "yolo11m-cls-for-car-view-train7.pt"
    legacy = model_root / "yolo11m-cls-for-car-view-train7.pt"
    return canonical if canonical.is_file() or not legacy.is_file() else legacy


def default_clean_model_dir() -> Path:
    return project_root() / "models" / "view-clean"


def _normalize_label(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "")


@lru_cache(maxsize=16)
def _load_yolo_model(path: str) -> Any:
    from ultralytics import YOLO

    return YOLO(path)


def _predict_class(model_path: Path, image: Image.Image, device: str) -> tuple[str, float]:
    if not model_path.is_file():
        raise FileNotFoundError(f"classification model not found: {model_path}")
    model = _load_yolo_model(str(model_path.resolve()))
    kwargs: dict[str, Any] = {"verbose": False}
    if device and device != "auto":
        kwargs["device"] = device
    results = model.predict(np.asarray(image.convert("RGB")), **kwargs)
    if not results or getattr(results[0], "probs", None) is None:
        raise RuntimeError(f"classification model returned no probabilities: {model_path.name}")

    result = results[0]
    probs = result.probs
    top1 = int(probs.top1)
    confidence = float(probs.top1conf)
    names = getattr(result, "names", None) or getattr(model, "names", None) or {}
    label = names.get(top1, str(top1)) if isinstance(names, dict) else str(top1)
    return _normalize_label(label), confidence


def find_clean_model(view: str, model_dir: Optional[Path] = None) -> Optional[Path]:
    root = (model_dir or default_clean_model_dir()).resolve()
    normalized = _normalize_label(view)
    candidates = (
        root / f"{normalized}-view-clean.pt",
        root / f"{normalized}_view_clean.pt",
        root / f"{normalized}-clean.pt",
        root / f"{normalized}.pt",
    )
    return next((path for path in candidates if path.is_file()), None)


class ImageQualityPipeline:
    def __init__(
        self,
        *,
        birefnet_checkpoint: Optional[Path] = None,
        view_model: Optional[Path] = None,
        clean_model_dir: Optional[Path] = None,
        device: str = "auto",
        view_min_conf: float = 0.5,
        clean_min_conf: float = 0.5,
        mask_threshold: float = 0.5,
        birefnet_size: int = 0,
    ) -> None:
        self.birefnet_checkpoint = (birefnet_checkpoint or default_checkpoint_path()).resolve()
        self.view_model = (view_model or default_view_model_path()).resolve()
        self.clean_model_dir = (clean_model_dir or default_clean_model_dir()).resolve()
        self.device = str(device or "auto")
        self.view_min_conf = max(0.0, min(1.0, float(view_min_conf)))
        self.clean_min_conf = max(0.0, min(1.0, float(clean_min_conf)))
        self.subject_extractor = SubjectExtractor(
            self.birefnet_checkpoint,
            device=self.device,
            mask_threshold=mask_threshold,
            input_size=int(birefnet_size) or None,
        )

    def evaluate(
        self,
        image: Image.Image,
        *,
        view_filter: Optional[Callable[[str], bool]] = None,
    ) -> QualityDecision:
        metadata: dict[str, Any] = {
            "accepted": False,
            "reason": "pipeline_error",
            "models": {
                "birefnet": str(self.birefnet_checkpoint),
                "view": str(self.view_model),
            },
        }
        try:
            subject = self.subject_extractor.extract(image)
        except Exception as exc:
            metadata["reason"] = "subject_extraction_failed"
            metadata["error"] = str(exc)
            return QualityDecision(False, "subject_extraction_failed", None, metadata)

        width, height = image.size
        x1, y1, x2, y2 = subject.bbox_xyxy
        metadata["subject"] = {
            "mask_coverage": subject.mask_coverage,
            "bbox_xyxy": [x1, y1, x2, y2],
            "bbox_normalized": [x1 / width, y1 / height, x2 / width, y2 / height],
        }
        if subject.mask_coverage < 0.02 or subject.mask_coverage > 0.95:
            metadata["reason"] = "invalid_subject_mask"
            return QualityDecision(False, "invalid_subject_mask", subject.rgba, metadata)

        try:
            view, view_conf = _predict_class(self.view_model, subject.inference_rgb, self.device)
        except Exception as exc:
            metadata["reason"] = "view_classification_failed"
            metadata["error"] = str(exc)
            return QualityDecision(False, "view_classification_failed", subject.rgba, metadata)

        metadata["view"] = {"label": view, "confidence": view_conf}
        if view_conf < self.view_min_conf:
            metadata["reason"] = "view_low_confidence"
            return QualityDecision(False, "view_low_confidence", subject.rgba, metadata)

        if view_filter is not None and not view_filter(view):
            metadata["reason"] = "view_filtered"
            return QualityDecision(False, "view_filtered", subject.rgba, metadata)

        clean_model = find_clean_model(view, self.clean_model_dir)
        if clean_model is None:
            metadata["reason"] = "clean_model_missing"
            metadata["clean"] = {"view": view, "model": None}
            return QualityDecision(False, "clean_model_missing", subject.rgba, metadata)

        metadata["models"]["clean"] = str(clean_model)
        try:
            clean_label, clean_conf = _predict_class(clean_model, subject.inference_rgb, self.device)
        except Exception as exc:
            metadata["reason"] = "clean_classification_failed"
            metadata["error"] = str(exc)
            return QualityDecision(False, "clean_classification_failed", subject.rgba, metadata)

        metadata["clean"] = {"label": clean_label, "confidence": clean_conf, "view": view}
        if clean_conf < self.clean_min_conf:
            metadata["reason"] = "clean_low_confidence"
            return QualityDecision(False, "clean_low_confidence", subject.rgba, metadata)
        if clean_label != "1":
            metadata["reason"] = "clean_rejected"
            return QualityDecision(False, "clean_rejected", subject.rgba, metadata)

        metadata["accepted"] = True
        metadata["reason"] = "accepted"
        return QualityDecision(True, "accepted", subject.rgba, metadata)


@lru_cache(maxsize=8)
def get_quality_pipeline(
    *,
    device: str = "auto",
    view_min_conf: float = 0.5,
    clean_min_conf: float = 0.5,
    mask_threshold: float = 0.5,
    birefnet_size: int = 0,
) -> ImageQualityPipeline:
    return ImageQualityPipeline(
        device=device,
        view_min_conf=view_min_conf,
        clean_min_conf=clean_min_conf,
        mask_threshold=mask_threshold,
        birefnet_size=birefnet_size,
    )

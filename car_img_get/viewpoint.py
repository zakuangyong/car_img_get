from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


@dataclass(frozen=True)
class ViewFeatures:
    aspect_ratio: float
    symmetry: float
    red_ratio: float
    used_detector: str


def classify_view(image_rgb: "Any", prefer_yolo: bool = True, min_conf: float = 0.0) -> Tuple[str, ViewFeatures]:
    crop, used = _maybe_crop_car(image_rgb, prefer_yolo=prefer_yolo)
    label = _predict_view_by_model(crop, min_conf=float(min_conf))
    aspect_ratio = float(crop.shape[1]) / float(max(1, crop.shape[0]))
    symmetry = _symmetry_score(crop)
    red_ratio = _red_ratio(crop)

    if label is None:
        if aspect_ratio > 2.1 and symmetry < 0.78:
            label = "side"
        elif symmetry > 0.86:
            label = "back" if red_ratio > 0.045 else "front"
        else:
            label = "back45" if red_ratio > 0.045 else "front45"

    return label, ViewFeatures(
        aspect_ratio=aspect_ratio,
        symmetry=symmetry,
        red_ratio=red_ratio,
        used_detector=used,
    )


def _maybe_crop_car(image_rgb: "Any", prefer_yolo: bool = True) -> Tuple["Any", str]:
    np = _np()
    img = image_rgb
    if not isinstance(img, np.ndarray):
        img = np.asarray(img)

    if prefer_yolo:
        bbox = _yolo_car_bbox(img)
        if bbox is not None:
            x1, y1, x2, y2 = bbox
            return img[y1:y2, x1:x2].copy(), "yolo"

    return img, "full"


def _symmetry_score(img_rgb: "Any") -> float:
    np = _np()
    cv2 = _cv2()
    gray = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY)
    h, w = gray.shape[:2]
    mid = w // 2
    left = gray[:, :mid]
    right = gray[:, w - mid :]
    right = np.fliplr(right)
    diff = np.abs(left.astype("int16") - right.astype("int16")).mean()
    return float(max(0.0, min(1.0, 1.0 - diff / 255.0)))


def _red_ratio(img_rgb: "Any") -> float:
    np = _np()
    cv2 = _cv2()
    hsv = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2HSV)
    h = hsv[..., 0].astype("int16")
    s = hsv[..., 1].astype("int16")
    v = hsv[..., 2].astype("int16")
    m1 = (h <= 10) | (h >= 170)
    m2 = s >= 80
    m3 = v >= 50
    mask = m1 & m2 & m3
    return float(mask.mean())


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _default_view_model_path() -> Path:
    model_root = _project_root() / "models"
    canonical = model_root / "view-cls" / "yolo11m-cls-for-car-view-train7.pt"
    legacy = model_root / "yolo11m-cls-for-car-view-train7.pt"
    return canonical if canonical.is_file() or not legacy.is_file() else legacy


_ALLOWED_VIEWS: set[str] = {
    "front",
    "back",
    "right_side",
    "back_right_side45",
    "front_right_side45",
    "left_side",
    "back_left_side45",
    "front_left_side45",
}


def _normalize_view_label(s: str) -> Optional[str]:
    s = str(s or "").strip().lower()
    if not s:
        return None
    s = s.replace(" ", "").replace("-", "_")
    if s in _ALLOWED_VIEWS:
        return s
    return None


@lru_cache(maxsize=1)
def _load_view_model(model_path: str) -> "Any":
    from ultralytics import YOLO

    return YOLO(model_path)


def _predict_view_by_model(img_rgb: "Any", min_conf: float = 0.0) -> Optional[str]:
    try:
        from ultralytics import YOLO
    except Exception:
        return None
    _ = YOLO

    model_path = _default_view_model_path()
    if not model_path.exists():
        return None

    try:
        model = _load_view_model(str(model_path))
        res = model.predict(img_rgb, verbose=False)
        if not res:
            return None
        r0 = res[0]
        probs = getattr(r0, "probs", None)
        if probs is None:
            return None
        top1 = int(getattr(probs, "top1", -1))
        if top1 < 0:
            return None
        top1conf = float(getattr(probs, "top1conf", 0.0) or 0.0)
        if float(min_conf) > 0.0 and top1conf < float(min_conf):
            return None
        names = getattr(r0, "names", None) or getattr(model, "names", None) or {}
        name = names.get(top1) if isinstance(names, dict) else None
        return _normalize_view_label(str(name or ""))
    except Exception:
        return None


def _yolo_car_bbox(img_rgb: "Any") -> Optional[Tuple[int, int, int, int]]:
    try:
        from ultralytics import YOLO
    except Exception:
        return None

    np = _np()
    h, w = img_rgb.shape[:2]
    max_side = max(h, w)
    scale = 640 / float(max_side) if max_side > 640 else 1.0
    if scale != 1.0:
        cv2 = _cv2()
        img_small = cv2.resize(img_rgb, (int(w * scale), int(h * scale)))
    else:
        img_small = img_rgb

    model = YOLO("yolov8n.pt")
    res = model.predict(img_small, verbose=False)
    if not res:
        return None

    boxes = res[0].boxes
    if boxes is None or boxes.xyxy is None:
        return None

    cls = boxes.cls.cpu().numpy().astype("int32")
    xyxy = boxes.xyxy.cpu().numpy()
    conf = boxes.conf.cpu().numpy() if boxes.conf is not None else np.ones((xyxy.shape[0],), dtype="float32")

    candidates = []
    for i in range(xyxy.shape[0]):
        if int(cls[i]) not in {2, 5, 7}:
            continue
        x1, y1, x2, y2 = xyxy[i]
        area = max(0.0, (x2 - x1) * (y2 - y1))
        candidates.append((float(conf[i]) * area, x1, y1, x2, y2))
    if not candidates:
        return None

    _, x1, y1, x2, y2 = max(candidates, key=lambda t: t[0])
    if scale != 1.0:
        inv = 1.0 / scale
        x1, y1, x2, y2 = x1 * inv, y1 * inv, x2 * inv, y2 * inv

    x1 = int(max(0, min(w - 1, round(x1))))
    y1 = int(max(0, min(h - 1, round(y1))))
    x2 = int(max(x1 + 1, min(w, round(x2))))
    y2 = int(max(y1 + 1, min(h, round(y2))))
    return x1, y1, x2, y2


def _np() -> "Any":
    import numpy as np

    return np


def _cv2() -> "Any":
    import cv2

    return cv2

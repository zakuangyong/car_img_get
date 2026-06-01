from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional


@dataclass(frozen=True)
class DetectResult:
    bbox_xyxy: tuple[int, int, int, int]
    conf: float
    cls: int
    method: str
    mask: Optional["Any"] = None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", type=Path, default=Path("./dataset_ran_select"), help="输入目录（默认 ./data_ran_select）")
    parser.add_argument("--out", type=Path, default=Path("./result/recognize"), help="输出目录（默认 ./result/recognize）")
    parser.add_argument("--model", type=str, default="yolov8m.pt", help="检测模型：可填 YOLO 权重路径/名称；填 none 则仅用 GrabCut")
    args = parser.parse_args()

    try:
        _ = _np(), _cv2()
    except Exception:
        raise SystemExit("缺少依赖：请先安装 numpy 和 opencv-python，例如：pip install numpy opencv-python")

    src_root: Path = args.src
    out_root: Path = args.out
    src_root = src_root.resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    if not src_root.exists():
        raise SystemExit(f"src 目录不存在：{src_root}")

    model = str(args.model or "").strip()
    backend = "grabcut" if model.lower() in {"none", "grabcut", ""} else "auto"
    task = "detect"
    imgsz = 640
    conf = 0.25
    margin = 0.02
    refine = "grabcut"

    files = list(iter_images(src_root))

    manifest_path = out_root / "recognize.jsonl"
    processed = 0
    ok = 0
    with manifest_path.open("a", encoding="utf-8") as mf:
        for p in files:
            rel = p.relative_to(src_root)
            out_path = out_root / rel
            out_path = out_path.with_suffix(".png")
            out_path.parent.mkdir(parents=True, exist_ok=True)

            try:
                res = detect_car_bbox(
                    p,
                    backend=backend,
                    task=task,
                    model=model,
                    imgsz=imgsz,
                    conf=conf,
                )
                if res is None:
                    mf.write(
                        json.dumps({"src": str(p), "out": str(out_path), "status": "no_det"}, ensure_ascii=False) + "\n"
                    )
                    mf.flush()
                    processed += 1
                    continue

                saved = crop_and_save(
                    p,
                    out_path,
                    res.bbox_xyxy,
                    margin=margin,
                    mask=res.mask,
                    refine=refine,
                )
                mf.write(
                    json.dumps(
                        {
                            "src": str(p),
                            "out": str(out_path),
                            "status": "ok" if saved else "save_failed",
                            "bbox_xyxy": list(res.bbox_xyxy),
                            "conf": res.conf,
                            "cls": res.cls,
                            "method": res.method,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                mf.flush()
                processed += 1
                if saved:
                    ok += 1
            except Exception as e:
                mf.write(
                    json.dumps({"src": str(p), "out": str(out_path), "status": "error", "error": str(e)}, ensure_ascii=False)
                    + "\n"
                )
                mf.flush()
                processed += 1

    print(f"processed={processed}")
    print(f"ok={ok}")
    print(f"manifest={manifest_path}")


def iter_images(root: Path) -> Iterable[Path]:
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        ext = p.suffix.lower()
        if ext not in {".png", ".jpg", ".jpeg", ".bmp", ".webp"}:
            continue
        yield p


def detect_car_bbox(
    image_path: Path,
    *,
    backend: str,
    task: str,
    model: str,
    imgsz: int,
    conf: float,
) -> Optional[DetectResult]:
    backend = (backend or "auto").strip()
    if backend in {"auto", "yolo"}:
        res = _detect_yolo(image_path, model=model, imgsz=imgsz, conf=conf, task=task)
        if res is not None:
            return res
        if backend == "yolo":
            return None
    if backend in {"auto", "grabcut"}:
        res = _detect_grabcut(image_path)
        if res is not None:
            return res
        if backend == "grabcut":
            return None
    return _detect_contour(image_path)


def _detect_yolo(image_path: Path, *, model: str, imgsz: int, conf: float, task: str) -> Optional[DetectResult]:
    try:
        from ultralytics import YOLO
    except Exception:
        return None

    try:
        np = _np()
        cv2 = _cv2()

        img_bgr = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
        if img_bgr is None:
            return None
        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)

        m = YOLO(model)
        res = m.predict(img_rgb, imgsz=int(imgsz), conf=float(conf), verbose=False)
        if not res:
            return None
        r0 = res[0]
    except Exception:
        return None

    task = (task or "auto").strip()

    masks = getattr(r0, "masks", None)
    if task != "detect" and masks is not None and getattr(masks, "data", None) is not None:
        mdata = masks.data
        boxes = r0.boxes
        if boxes is None or boxes.xyxy is None:
            return None
        xyxy = boxes.xyxy.cpu().numpy()
        cls = boxes.cls.cpu().numpy().astype("int32") if boxes.cls is not None else np.zeros((xyxy.shape[0],), dtype="int32")
        scores = boxes.conf.cpu().numpy() if boxes.conf is not None else np.ones((xyxy.shape[0],), dtype="float32")

        m_arr = mdata.cpu().numpy()
        candidates = []
        for i in range(xyxy.shape[0]):
            c = int(cls[i])
            if c not in {2, 5, 7}:
                continue
            mask_i = m_arr[i]
            mask_bool = mask_i > 0.5
            area = float(mask_bool.sum())
            candidates.append((float(scores[i]) * area, float(scores[i]), c, mask_bool))
        if candidates:
            _, score, c, mask_bool = max(candidates, key=lambda t: t[0])
            ys, xs = np.where(mask_bool)
            if ys.size > 0 and xs.size > 0:
                x1, x2 = int(xs.min()), int(xs.max() + 1)
                y1, y2 = int(ys.min()), int(ys.max() + 1)
                x1 = int(max(0, min(w - 1, x1)))
                y1 = int(max(0, min(h - 1, y1)))
                x2 = int(max(x1 + 1, min(w, x2)))
                y2 = int(max(y1 + 1, min(h, y2)))
                return DetectResult(bbox_xyxy=(x1, y1, x2, y2), conf=float(score), cls=int(c), method="yolo_seg", mask=mask_bool)

        if task == "seg":
            return None

    if task == "seg":
        return None

    boxes = r0.boxes
    if boxes is None or boxes.xyxy is None:
        return None
    xyxy = boxes.xyxy.cpu().numpy()
    cls = boxes.cls.cpu().numpy().astype("int32") if boxes.cls is not None else np.zeros((xyxy.shape[0],), dtype="int32")
    scores = boxes.conf.cpu().numpy() if boxes.conf is not None else np.ones((xyxy.shape[0],), dtype="float32")

    h, w = img_rgb.shape[:2]
    candidates = []
    for i in range(xyxy.shape[0]):
        c = int(cls[i])
        if c not in {2, 5, 7}:
            continue
        x1, y1, x2, y2 = xyxy[i]
        x1 = float(max(0.0, min(float(w - 1), x1)))
        y1 = float(max(0.0, min(float(h - 1), y1)))
        x2 = float(max(0.0, min(float(w), x2)))
        y2 = float(max(0.0, min(float(h), y2)))
        area = max(0.0, (x2 - x1) * (y2 - y1))
        candidates.append((float(scores[i]) * area, float(scores[i]), c, x1, y1, x2, y2))
    if not candidates:
        return None

    _, score, c, x1, y1, x2, y2 = max(candidates, key=lambda t: t[0])
    bx = (int(round(x1)), int(round(y1)), int(round(x2)), int(round(y2)))
    return DetectResult(bbox_xyxy=bx, conf=float(score), cls=int(c), method="yolo")


def _detect_grabcut(image_path: Path) -> Optional[DetectResult]:
    np = _np()
    cv2 = _cv2()

    img_bgr = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if img_bgr is None:
        return None
    h, w = img_bgr.shape[:2]
    if h < 16 or w < 16:
        return None

    x1 = int(round(w * 0.10))
    y1 = int(round(h * 0.10))
    x2 = int(round(w * 0.90))
    y2 = int(round(h * 0.90))
    rect = (x1, y1, max(1, x2 - x1), max(1, y2 - y1))

    mask_gc = np.zeros((h, w), dtype=np.uint8)
    bgd = np.zeros((1, 65), dtype=np.float64)
    fgd = np.zeros((1, 65), dtype=np.float64)
    try:
        cv2.grabCut(img_bgr, mask_gc, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
    except Exception:
        return None

    fg = (mask_gc == cv2.GC_FGD) | (mask_gc == cv2.GC_PR_FGD)
    if float(fg.mean()) <= 0.01:
        return None
    ys, xs = np.where(fg)
    if ys.size == 0 or xs.size == 0:
        return None

    rx1, rx2 = int(xs.min()), int(xs.max() + 1)
    ry1, ry2 = int(ys.min()), int(ys.max() + 1)
    rx1 = int(max(0, min(w - 1, rx1)))
    ry1 = int(max(0, min(h - 1, ry1)))
    rx2 = int(max(rx1 + 1, min(w, rx2)))
    ry2 = int(max(ry1 + 1, min(h, ry2)))
    return DetectResult(bbox_xyxy=(rx1, ry1, rx2, ry2), conf=0.0, cls=-1, method="grabcut", mask=fg)


def _detect_contour(image_path: Path) -> Optional[DetectResult]:
    np = _np()
    cv2 = _cv2()
    img_bgr = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if img_bgr is None:
        return None
    h, w = img_bgr.shape[:2]
    if h < 8 or w < 8:
        return None

    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 40, 120)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    edges = cv2.dilate(edges, kernel, iterations=1)
    cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None

    best = None
    for c in cnts:
        x, y, ww, hh = cv2.boundingRect(c)
        area = float(ww * hh)
        if area < 0.05 * float(w * h):
            continue
        if best is None or area > best[0]:
            best = (area, x, y, x + ww, y + hh)
    if best is None:
        best2 = None
        for c in cnts:
            x, y, ww, hh = cv2.boundingRect(c)
            area = float(ww * hh)
            if best2 is None or area > best2[0]:
                best2 = (area, x, y, x + ww, y + hh)
        if best2 is None:
            return None
        _, x1, y1, x2, y2 = best2
        bx = (int(x1), int(y1), int(x2), int(y2))
        return DetectResult(bbox_xyxy=bx, conf=0.0, cls=-1, method="contour")

    _, x1, y1, x2, y2 = best
    bx = (int(x1), int(y1), int(x2), int(y2))
    return DetectResult(bbox_xyxy=bx, conf=0.0, cls=-1, method="contour")


def crop_and_save(
    image_path: Path,
    out_path: Path,
    bbox_xyxy: tuple[int, int, int, int],
    *,
    margin: float,
    mask: Optional["Any"] = None,
    refine: str = "grabcut",
) -> bool:
    np = _np()
    cv2 = _cv2()

    img_bgr = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if img_bgr is None:
        return False
    h, w = img_bgr.shape[:2]

    x1, y1, x2, y2 = bbox_xyxy
    x1 = int(max(0, min(w - 1, x1)))
    y1 = int(max(0, min(h - 1, y1)))
    x2 = int(max(x1 + 1, min(w, x2)))
    y2 = int(max(y1 + 1, min(h, y2)))

    mx = int(round((x2 - x1) * float(margin)))
    my = int(round((y2 - y1) * float(margin)))
    x1 = int(max(0, x1 - mx))
    y1 = int(max(0, y1 - my))
    x2 = int(min(w, x2 + mx))
    y2 = int(min(h, y2 + my))

    if mask is None and str(refine).strip() == "grabcut":
        try:
            mask_gc = np.zeros((h, w), dtype=np.uint8)
            area_ratio = float((x2 - x1) * (y2 - y1)) / float(max(1, w * h))
            if area_ratio > 0.90:
                rx1 = int(round(w * 0.10))
                ry1 = int(round(h * 0.10))
                rx2 = int(round(w * 0.90))
                ry2 = int(round(h * 0.90))
                rect = (rx1, ry1, max(1, rx2 - rx1), max(1, ry2 - ry1))
            else:
                rect = (int(x1), int(y1), int(x2 - x1), int(y2 - y1))
            bgd = np.zeros((1, 65), dtype=np.float64)
            fgd = np.zeros((1, 65), dtype=np.float64)
            cv2.grabCut(img_bgr, mask_gc, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
            fg = (mask_gc == cv2.GC_FGD) | (mask_gc == cv2.GC_PR_FGD)
            if float(fg.mean()) > 0.01:
                ys, xs = np.where(fg)
                if ys.size > 0 and xs.size > 0:
                    rx1, rx2 = int(xs.min()), int(xs.max() + 1)
                    ry1, ry2 = int(ys.min()), int(ys.max() + 1)
                    rx1 = int(max(0, min(w - 1, rx1)))
                    ry1 = int(max(0, min(h - 1, ry1)))
                    rx2 = int(max(rx1 + 1, min(w, rx2)))
                    ry2 = int(max(ry1 + 1, min(h, ry2)))
                    x1, y1, x2, y2 = rx1, ry1, rx2, ry2
                    mask = fg
        except Exception:
            pass

    crop = img_bgr[y1:y2, x1:x2]
    if crop.size == 0:
        return False

    ext = out_path.suffix.lower()
    if ext != ".png":
        out_path = out_path.with_suffix(".png")

    if mask is not None:
        try:
            m = mask[y1:y2, x1:x2]
            if m is not None:
                m = (m > 0).astype("uint8") * 255
                bgra = cv2.cvtColor(crop, cv2.COLOR_BGR2BGRA)
                bgra[:, :, 3] = m
                crop = bgra
        except Exception:
            pass

    out_path_tmp = out_path.with_suffix(out_path.suffix + ".part")
    ok, buf = cv2.imencode(out_path.suffix, crop)
    if not bool(ok) or buf is None:
        return False
    out_path_tmp.write_bytes(buf.tobytes())
    out_path_tmp.replace(out_path)
    return True


def _np() -> Any:
    import numpy as np

    return np


def _cv2() -> Any:
    import cv2

    return cv2


if __name__ == "__main__":
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    main()

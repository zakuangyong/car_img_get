from __future__ import annotations

import argparse
import hashlib
import io
import json
import time
import re
from pathlib import Path
from typing import Iterable, Optional, Tuple
from urllib.parse import urlparse

import requests
from PIL import Image
from tqdm import tqdm

from .autohome_api import AutohomeClient, PicItem
from .metadata_schema import METADATA_SCHEMA_VERSION, normalize_quality, vehicle_category_from_level


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--series", type=int, required=True, help="车系 seriesid，例如 6124")
    parser.add_argument("--spec", type=int, default=None, help="车型 specid；不填则自动拉取该车系所有 spec")
    parser.add_argument("--category", type=int, default=1, help="图片分类 categoryid，例如 1=外观")
    parser.add_argument("--pagesize", type=int, default=80, help="每页数量")
    parser.add_argument("--out", type=Path, required=True, help="输出目录")
    parser.add_argument("--metadata", type=Path, default=None, help="metadata.jsonl 输出路径")
    parser.add_argument("--max", type=int, default=0, help="最多下载多少张，0 表示不限制")
    parser.add_argument("--min-size", type=int, default=0, help="最小边长过滤：宽和高都要 >= 该值；0 不过滤")
    parser.add_argument("--min-year", type=int, default=0, help="最小年份（含），0 不过滤")
    parser.add_argument("--max-year", type=int, default=0, help="最大年份（含），0 不过滤")
    parser.add_argument(
        "--only-colors",
        type=str,
        default="",
        help="仅保留指定颜色，逗号分隔，例如 黑色,白色；为空不过滤",
    )
    parser.add_argument(
        "--max-colors-per-spec",
        type=int,
        default=0,
        help="每个 spec 最多保留多少种颜色，0 不限制；与 --only-colors 可叠加",
    )
    parser.add_argument("--sleep", type=float, default=0.2, help="请求间隔（秒）")
    parser.add_argument("--timeout", type=float, default=20.0, help="请求超时（秒）")
    parser.add_argument("--retries", type=int, default=3, help="失败重试次数")
    parser.add_argument(
        "--prefer",
        choices=["nowebppic", "originalpic"],
        default="nowebppic",
        help="优先使用的图片 URL 字段",
    )
    parser.add_argument(
        "--view-scheme",
        default="none",
        help="视角分类配置：可填方案名 none/front_back_45/front_back_front45_back45，或用逗号列出期望视角（如 front,back,side 或 front,back,side,side45）",
    )
    parser.add_argument(
        "--prefer-yolo",
        action="store_true",
        help="视角分类时优先用 YOLO 先裁出车辆区域（需要 ultralytics；会自动下载权重）",
    )
    parser.add_argument("--view-min-conf", type=float, default=0.5, help="视角分类模型最小置信度阈值（top1conf）")
    parser.add_argument("--clean-min-conf", type=float, default=0.5, help="对应视角清洗模型的最小置信度")
    parser.add_argument("--mask-threshold", type=float, default=0.5, help="BiRefNet 主体掩码阈值")
    parser.add_argument("--birefnet-size", type=int, default=768, help="BiRefNet 输入尺寸；0 表示 GPU=768、CPU=320")
    parser.add_argument("--device", type=str, default="auto", help="推理设备：auto/cpu/cuda:0")
    parser.add_argument(
        "--quality-gate",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="启用主体扣取、角度分类和对应角度清洗；默认启用",
    )
    parser.add_argument(
        "--keep-stage-images",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="保留原图、BiRefNet 输出和最终决策图；默认启用",
    )
    parser.add_argument(
        "--only-view",
        type=str,
        default="",
        help="仅保留指定视角，逗号分隔，例如 side 或 side45 或 front,back,side,side45（需要 --view-scheme != none）",
    )
    parser.add_argument(
        "--view-bins",
        choices=["raw", "front_back_side"],
        default="raw",
        help="视角归并方式：raw 保留细分；front_back_side 归并为 front/back/side（side45 也会归并到 side）",
    )
    parser.add_argument("--max-per-view", type=int, default=0, help="每个 spec 在每个视角最多保存多少张，0 不限制")
    parser.add_argument(
        "--required-views",
        type=str,
        default="",
        help="达到这些视角的配额后提前停止该 spec，逗号分隔，例如 front,back,side（需配合 --max-per-view）",
    )
    args = parser.parse_args()

    try:
        view_scheme, view_bins, auto_only_view = resolve_view_options(str(args.view_scheme), str(args.view_bins))
    except ValueError as e:
        parser.error(str(e))
        return

    out_root: Path = args.out
    out_root.mkdir(parents=True, exist_ok=True)

    metadata_path: Path = args.metadata or (out_root / "metadata.jsonl")

    client = AutohomeClient(timeout_s=args.timeout, max_retries=args.retries, sleep_s=args.sleep)
    dl_session = requests.Session()
    dl_session.headers.update({"User-Agent": "Mozilla/5.0", "Referer": "https://www.autohome.com.cn/"})

    min_year = int(args.min_year) if int(args.min_year) > 0 else None
    max_year = int(args.max_year) if int(args.max_year) > 0 else None

    if args.spec is not None:
        spec_ids = [int(args.spec)]
        if min_year is not None or max_year is not None:
            specs = client.get_specs(args.series)
            hit = next((s for s in specs if s.specid == int(args.spec)), None)
            if hit is None or hit.year is None:
                return
            if min_year is not None and hit.year < min_year:
                return
            if max_year is not None and hit.year > max_year:
                return
    else:
        specs = client.get_specs(args.series)
        if min_year is not None or max_year is not None:
            specs = [
                s
                for s in specs
                if s.year is not None
                and (min_year is None or s.year >= min_year)
                and (max_year is None or s.year <= max_year)
            ]
        spec_ids = [s.specid for s in specs]

    if not spec_ids:
        return

    total_downloaded = 0
    only_view = {s.strip() for s in str(args.only_view).split(",") if s.strip()}
    required_views = {s.strip() for s in str(args.required_views).split(",") if s.strip()}
    only_colors = {s.strip() for s in str(args.only_colors).split(",") if s.strip()}

    if auto_only_view is not None:
        only_view = (only_view & auto_only_view) if only_view else set(auto_only_view)
    series_info = client.get_series_info(args.series)
    brand_name = series_info.brandname if series_info else ""
    series_name = series_info.seriesname if series_info else ""
    rejected_path = out_root / "rejected.jsonl"
    with metadata_path.open("a", encoding="utf-8") as mf, rejected_path.open("a", encoding="utf-8") as rf:
        for spec_id in spec_ids:
            view_counts: dict[str, int] = {}
            seen_colors: set[str] = set()
            items = client.iter_pic_list(
                series_id=args.series,
                spec_id=spec_id,
                category_id=args.category,
                page_size=args.pagesize,
            )
            for item in tqdm(items, desc=f"series={args.series} spec={spec_id} cat={args.category}"):
                if args.max and total_downloaded >= args.max:
                    return
                saved, info = download_one(
                    item,
                    out_root,
                    prefer=args.prefer,
                    view_scheme=view_scheme,
                    prefer_yolo=args.prefer_yolo,
                    view_min_conf=float(args.view_min_conf),
                    clean_min_conf=float(args.clean_min_conf),
                    mask_threshold=float(args.mask_threshold),
                    birefnet_size=int(args.birefnet_size),
                    quality_gate=bool(args.quality_gate),
                    keep_stage_images=bool(args.keep_stage_images),
                    device=str(args.device),
                    only_view=only_view,
                    only_colors=only_colors,
                    max_colors_per_spec=int(args.max_colors_per_spec),
                    seen_colors=seen_colors,
                    view_bins=view_bins,
                    max_per_view=int(args.max_per_view),
                    view_counts=view_counts,
                    dl_session=dl_session,
                    timeout_s=float(args.timeout),
                    retries=int(args.retries),
                    sleep_s=float(args.sleep),
                    min_size=int(args.min_size),
                    brand_name=brand_name,
                    series_name=series_name,
                    series_levelid=series_info.levelid if series_info else 0,
                    series_levelname=series_info.levelname if series_info else "",
                )
                if not saved:
                    if info:
                        rf.write(json.dumps(info, ensure_ascii=False) + "\n")
                        rf.flush()
                    continue
                mf.write(json.dumps(info, ensure_ascii=False) + "\n")
                mf.flush()
                total_downloaded += 1
                time.sleep(float(args.sleep))
                if required_views and int(args.max_per_view) > 0:
                    if all(view_counts.get(v, 0) >= int(args.max_per_view) for v in required_views):
                        break


def download_one(
    item: PicItem,
    out_root: Path,
    prefer: str = "nowebppic",
    view_scheme: str = "none",
    prefer_yolo: bool = False,
    view_min_conf: float = 0.5,
    clean_min_conf: float = 0.5,
    mask_threshold: float = 0.5,
    birefnet_size: int = 0,
    quality_gate: bool = True,
    keep_stage_images: bool = True,
    device: str = "auto",
    only_view: Optional[set[str]] = None,
    only_colors: Optional[set[str]] = None,
    max_colors_per_spec: int = 0,
    seen_colors: Optional[set[str]] = None,
    view_bins: str = "raw",
    max_per_view: int = 0,
    view_counts: Optional[dict[str, int]] = None,
    dl_session: Optional[requests.Session] = None,
    timeout_s: float = 20.0,
    retries: int = 3,
    sleep_s: float = 0.2,
    min_size: int = 0,
    brand_name: str = "",
    series_name: str = "",
    series_levelid: int = 0,
    series_levelname: str = "",
) -> Tuple[bool, dict]:
    color = str(item.colorname or "").strip()

    def make_metadata(*args: object, **kwargs: object) -> dict:
        return build_metadata(
            *args,
            series_levelid=series_levelid,
            series_levelname=series_levelname,
            **kwargs,
        )
    if only_colors:
        if color not in only_colors:
            return False, {}
    if seen_colors is not None and int(max_colors_per_spec) > 0:
        if color and color not in seen_colors and len(seen_colors) >= int(max_colors_per_spec):
            return False, {}

    cat_dir = f"{_sanitize_component(brand_name)}_{_sanitize_component(series_name)}"
    base_dir = out_root / f"series_{item.seriesid}" / f"spec_{item.specid}" / cat_dir
    base_dir.mkdir(parents=True, exist_ok=True)
    out_file = _build_filename(
        picid=item.picid,
        brand_name=brand_name,
        series_name=series_name,
        specname=item.specname,
    )
    out_path = base_dir / out_file
    if not quality_gate and out_path.exists() and out_path.stat().st_size > 0:
        if min_size > 0:
            try:
                with Image.open(out_path) as im0:
                    w0, h0 = im0.size
                if w0 >= min_size and h0 >= min_size:
                    info = make_metadata(item, out_path, None, None, w0, h0, None, None, None, None, None)
                    if seen_colors is not None and color:
                        seen_colors.add(color)
                    return True, info
            except Exception:
                pass
            try:
                out_path.unlink(missing_ok=True)
            except Exception:
                return False, {}
        else:
            info = make_metadata(item, out_path, None, None, None, None, None, None, None, None, None)
            if seen_colors is not None and color:
                seen_colors.add(color)
            return True, info


    url = item.nowebppic if prefer == "nowebppic" else item.originalpic
    if not url:
        url = item.originalpic or item.nowebppic
    if not url:
        return False, {}

    content = fetch_bytes(url, session=dl_session, timeout_s=timeout_s, retries=retries, sleep_s=sleep_s)
    if content is None:
        return False, {}

    digest = hashlib.md5(content).hexdigest()
    stage_artifacts: dict = {}
    original_suffix = _original_image_suffix(content, url)

    def record_original(view: Optional[str]) -> None:
        if not keep_stage_images or "original" in stage_artifacts:
            return
        _record_stage_bytes(
            stage_artifacts,
            key="original",
            out_root=out_root,
            folders=("original", _stage_view_name(view)),
            digest=digest,
            suffix=original_suffix,
            content=content,
        )

    def record_birefnet(image: Optional[Image.Image], view: Optional[str]) -> None:
        if not keep_stage_images or image is None or "birefnet" in stage_artifacts:
            return
        _record_stage_image(
            stage_artifacts,
            key="birefnet",
            out_root=out_root,
            folders=("birefnet", _stage_view_name(view)),
            digest=digest,
            image=image,
        )

    try:
        im = Image.open(io.BytesIO(content))
        im = im.convert("RGB")
    except Exception as exc:
        record_original(None)
        info = make_metadata(item, out_path, url, digest, None, None, None, None, None, None, None)
        info["saved_path"] = None
        info["decision"] = "reject"
        info["reject_reason"] = "image_decode_failed"
        info["error"] = str(exc)
        if keep_stage_images:
            _record_stage_bytes(
                stage_artifacts,
                key="decision",
                out_root=out_root,
                folders=("rejected", "unknown", "image_decode_failed"),
                digest=digest,
                suffix=original_suffix,
                content=content,
            )
        _attach_stage_artifacts(info, stage_artifacts)
        return False, info

    width, height = im.size
    if min_size > 0 and (width < min_size or height < min_size):
        record_original(None)
        info = make_metadata(item, out_path, url, digest, width, height, im.mode, None, None, None, None)
        info["saved_path"] = None
        info["decision"] = "reject"
        info["reject_reason"] = "min_size_rejected"
        if keep_stage_images:
            _record_stage_image(
                stage_artifacts,
                key="decision",
                out_root=out_root,
                folders=("rejected", "unknown", "min_size_rejected"),
                digest=digest,
                image=im,
            )
        _attach_review_preview(info, im, out_root, digest)
        _attach_stage_artifacts(info, stage_artifacts)
        return False, info
    view_label, view_raw, view_scheme_label, view_features = None, None, None, None
    quality: Optional[dict] = None
    if quality_gate:
        from .quality_pipeline import get_quality_pipeline

        try:
            decision = get_quality_pipeline(
                device=str(device),
                view_min_conf=float(view_min_conf),
                clean_min_conf=float(clean_min_conf),
                mask_threshold=float(mask_threshold),
                birefnet_size=int(birefnet_size),
            ).evaluate(im)
            quality = decision.metadata
        except Exception as exc:
            record_original(None)
            quality = {
                "accepted": False,
                "reason": "pipeline_initialization_failed",
                "error": str(exc),
            }
            info = make_metadata(
                item, out_path, url, digest, width, height, im.mode, None, None, None, None, quality
            )
            info["saved_path"] = None
            info["decision"] = "reject"
            info["reject_reason"] = "pipeline_initialization_failed"
            if keep_stage_images:
                _record_stage_image(
                    stage_artifacts,
                    key="decision",
                    out_root=out_root,
                    folders=("rejected", "unknown", "pipeline_initialization_failed"),
                    digest=digest,
                    image=im,
                )
            _attach_review_preview(info, im, out_root, digest)
            _attach_stage_artifacts(info, stage_artifacts)
            return False, info
        decision_view = str((quality.get("view") or {}).get("label") or "") or None
        record_original(decision_view)
        record_birefnet(decision.output_image, decision_view)
        if not decision.accepted or decision.output_image is None:
            info = make_metadata(
                item,
                out_path,
                url,
                digest,
                width,
                height,
                im.mode,
                None,
                None,
                str((quality.get("view") or {}).get("label") or "") or None,
                None,
                quality,
            )
            info["saved_path"] = None
            info["decision"] = "reject"
            info["reject_reason"] = decision.reason
            if keep_stage_images:
                _record_stage_image(
                    stage_artifacts,
                    key="decision",
                    out_root=out_root,
                    folders=("rejected", _stage_view_name(decision_view), _sanitize_component(decision.reason)),
                    digest=digest,
                    image=decision.output_image or im,
                )
            _attach_review_preview(info, decision.output_image or im, out_root, digest)
            _attach_stage_artifacts(info, stage_artifacts)
            return False, info
        im = decision.output_image
        view_raw = str((quality.get("view") or {}).get("label") or "") or None
        view_features = {
            "confidence": float((quality.get("view") or {}).get("confidence") or 0.0),
            "used_detector": "birefnet",
        }

    if view_scheme != "none" or quality_gate:
        from .viewpoint import classify_view

        if view_raw is None:
            raw_label, feats = classify_view(im, prefer_yolo=prefer_yolo, min_conf=float(view_min_conf))
            view_raw = raw_label
            view_features = {
                "aspect_ratio": feats.aspect_ratio,
                "symmetry": feats.symmetry,
                "red_ratio": feats.red_ratio,
                "used_detector": feats.used_detector,
            }
        raw_label = view_raw
        if view_scheme == "front_back_45":
            if raw_label in {"front", "back"}:
                view_scheme_label = raw_label
            elif raw_label in {"side", "left_side", "right_side"}:
                view_scheme_label = "side"
            else:
                view_scheme_label = "side45"
        else:
            view_scheme_label = raw_label
        view_label = _apply_view_bins(view_scheme_label, view_bins=view_bins)
        record_original(view_label)
        if max_per_view > 0 and view_counts is not None:
            if view_counts.get(view_label, 0) >= max_per_view:
                info = make_metadata(
                    item,
                    out_path,
                    url,
                    digest,
                    width,
                    height,
                    im.mode,
                    view_label,
                    view_features,
                    view_raw,
                    view_scheme_label,
                    quality,
                )
                info["saved_path"] = None
                info["decision"] = "reject"
                info["reject_reason"] = "view_quota_reached"
                if keep_stage_images:
                    _record_stage_image(
                        stage_artifacts,
                        key="decision",
                        out_root=out_root,
                        folders=("rejected", _stage_view_name(view_label), "view_quota_reached"),
                        digest=digest,
                        image=im,
                    )
                _attach_review_preview(info, im, out_root, digest)
                _attach_stage_artifacts(info, stage_artifacts)
                return False, info
        if only_view and view_label not in only_view:
            info = make_metadata(
                item,
                out_path,
                url,
                digest,
                width,
                height,
                im.mode,
                view_label,
                view_features,
                view_raw,
                view_scheme_label,
                quality,
            )
            info["saved_path"] = None
            info["decision"] = "reject"
            info["reject_reason"] = "view_filtered"
            if keep_stage_images:
                _record_stage_image(
                    stage_artifacts,
                    key="decision",
                    out_root=out_root,
                    folders=("rejected", _stage_view_name(view_label), "view_filtered"),
                    digest=digest,
                    image=im,
                )
            _attach_review_preview(info, im, out_root, digest)
            _attach_stage_artifacts(info, stage_artifacts)
            return False, info
        out_path = (base_dir / f"view_{view_label}") / out_file
        out_path.parent.mkdir(parents=True, exist_ok=True)

    out_path_tmp = out_path.with_suffix(".png.part")
    im.save(out_path_tmp, format="PNG", optimize=True)
    out_path_tmp.replace(out_path)
    record_original(view_label or view_raw)
    if keep_stage_images:
        _record_stage_image(
            stage_artifacts,
            key="decision",
            out_root=out_root,
            folders=("accepted", _stage_view_name(view_label or view_raw)),
            digest=digest,
            image=im,
        )

    if view_label is not None and max_per_view > 0 and view_counts is not None:
        view_counts[view_label] = view_counts.get(view_label, 0) + 1
    if seen_colors is not None and color:
        seen_colors.add(color)
    info = make_metadata(
        item,
        out_path,
        url,
        digest,
        width,
        height,
        im.mode,
        view_label,
        view_features,
        view_raw,
        view_scheme_label,
        quality,
    )
    info["decision"] = "accept"
    _attach_stage_artifacts(info, stage_artifacts)
    return True, info


def _original_image_suffix(content: bytes, url: str) -> str:
    signatures = (
        (b"\xff\xd8\xff", ".jpg"),
        (b"\x89PNG\r\n\x1a\n", ".png"),
        (b"GIF87a", ".gif"),
        (b"GIF89a", ".gif"),
        (b"BM", ".bmp"),
        (b"II*\x00", ".tif"),
        (b"MM\x00*", ".tif"),
    )
    for signature, suffix in signatures:
        if content.startswith(signature):
            return suffix
    if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return ".webp"

    suffix = Path(urlparse(str(url)).path).suffix.lower()
    if suffix == ".jpeg":
        suffix = ".jpg"
    return suffix if suffix in {".jpg", ".png", ".gif", ".bmp", ".tif", ".webp"} else ".img"


def _stage_view_name(view: Optional[str]) -> str:
    return _sanitize_component(str(view or "unknown").strip().lower() or "unknown")


def _write_stage_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > 0:
        return
    temp_path = path.with_name(f"{path.name}.part")
    temp_path.write_bytes(content)
    temp_path.replace(path)


def _write_stage_image(path: Path, image: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > 0:
        return
    temp_path = path.with_name(f"{path.name}.part")
    image.save(temp_path, format="PNG", optimize=True)
    temp_path.replace(path)


def _record_stage_bytes(
    artifacts: dict,
    *,
    key: str,
    out_root: Path,
    folders: tuple[str, ...],
    digest: str,
    suffix: str,
    content: bytes,
) -> None:
    try:
        root = out_root / "_pipeline_stages"
        path = root.joinpath(*folders, f"{digest}{suffix}")
        _write_stage_bytes(path, content)
        artifacts["root"] = str(root.as_posix())
        artifacts[key] = str(path.as_posix())
    except Exception as exc:
        artifacts.setdefault("errors", {})[key] = str(exc)


def _record_stage_image(
    artifacts: dict,
    *,
    key: str,
    out_root: Path,
    folders: tuple[str, ...],
    digest: str,
    image: Image.Image,
) -> None:
    try:
        root = out_root / "_pipeline_stages"
        path = root.joinpath(*folders, f"{digest}.png")
        _write_stage_image(path, image)
        artifacts["root"] = str(root.as_posix())
        artifacts[key] = str(path.as_posix())
    except Exception as exc:
        artifacts.setdefault("errors", {})[key] = str(exc)


def _attach_stage_artifacts(info: dict, artifacts: dict) -> None:
    if artifacts:
        info["pipeline_artifacts"] = artifacts


def _attach_review_preview(info: dict, image: Image.Image, out_root: Path, digest: str) -> None:
    try:
        preview_dir = out_root / "_review" / "rejected"
        preview_dir.mkdir(parents=True, exist_ok=True)
        preview_path = preview_dir / f"{digest}.jpg"
        if not preview_path.exists():
            preview = image.copy()
            if preview.mode == "RGBA":
                background = Image.new("RGB", preview.size, "white")
                background.paste(preview, mask=preview.getchannel("A"))
                preview = background
            else:
                preview = preview.convert("RGB")
            preview.thumbnail((480, 360), Image.Resampling.LANCZOS)
            preview.save(preview_path, format="JPEG", quality=82, optimize=True)
        info["preview_path"] = str(preview_path.as_posix())
    except Exception as exc:
        info["preview_error"] = str(exc)


def fetch_bytes(
    url: str,
    *,
    session: Optional[requests.Session] = None,
    timeout_s: float = 30.0,
    retries: int = 3,
    sleep_s: float = 0.2,
) -> Optional[bytes]:
    sess = session or requests.Session()
    last: Optional[Exception] = None
    for i in range(max(1, int(retries))):
        try:
            r = sess.get(url, timeout=timeout_s)
            r.raise_for_status()
            return r.content
        except Exception as e:
            last = e
            time.sleep(sleep_s * (2**i))
    _ = last
    return None


def build_metadata(
    item: PicItem,
    out_path: Path,
    url: Optional[str],
    md5: Optional[str],
    width: Optional[int],
    height: Optional[int],
    mode: Optional[str],
    view_label: Optional[str],
    view_features: Optional[dict],
    view_raw: Optional[str],
    view_scheme: Optional[str],
    quality: Optional[dict] = None,
    *,
    series_levelid: int = 0,
    series_levelname: str = "",
) -> dict:
    quality_view = quality.get("view") if isinstance(quality, dict) else None
    quality_view = quality_view if isinstance(quality_view, dict) else {}
    canonical_view = str(view_label or view_raw or quality_view.get("label") or "").strip()
    confidence = quality_view.get("confidence")
    if confidence is None and isinstance(view_features, dict):
        confidence = view_features.get("confidence")
    normalized_quality, quality_view_model = normalize_quality(quality)
    category_id, category_name = vehicle_category_from_level(series_levelname)
    record = {
        "metadata_schema_version": METADATA_SCHEMA_VERSION,
        "seriesid": item.seriesid,
        "specid": item.specid,
        "picid": item.picid,
        "categoryid": category_id,
        "categoryname": category_name,
        "category_source": {
            "provider": "autohome",
            "levelid": int(series_levelid or 0),
            "levelname": str(series_levelname or ""),
        },
        "image_categoryid": item.categoryid,
        "image_typeid": item.typeid,
        "specname": item.specname,
        "url": url,
        "saved_path": str(out_path.as_posix()),
        "md5": md5,
        "width": width,
        "height": height,
        "mode": mode,
        "view": canonical_view,
        "view_confidence": float(confidence) if confidence is not None else None,
        "view_model": quality_view_model,
        "view_source": "yolo11_view_classifier" if quality_view_model else None,
        "quality": normalized_quality,
        "tag": item.tag,
        "pointname": item.pointname,
        "colorname": item.colorname,
    }
    return {key: value for key, value in record.items() if value is not None}


def _sanitize_component(s: str, max_len: int = 64) -> str:
    s = str(s or "").strip()
    if not s:
        return "unknown"
    s = re.sub(r"\s+", "_", s)
    s = re.sub(r'[\\\\/:*?"<>|]+', "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    if not s:
        return "unknown"
    if len(s) > max_len:
        s = s[:max_len].rstrip("_")
    return s


def _build_filename(
    *,
    picid: int,
    brand_name: str,
    series_name: str,
    specname: str,
) -> str:
    year = _parse_year_from_specname(specname)
    year_s = str(year) if year is not None else "unknown"
    stem = f"{_sanitize_component(brand_name)}_{_sanitize_component(series_name)}_{year_s}_{picid}"
    if len(stem) > 120:
        stem = stem[:120].rstrip("_")
    return f"{stem}.png"


def _parse_year_from_specname(specname: str) -> Optional[int]:
    m = re.search(r"(19\d{2}|20\d{2})\s*款", str(specname))
    if not m:
        m = re.search(r"\b(19\d{2}|20\d{2})\b", str(specname))
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


def _apply_view_bins(view: str, *, view_bins: str) -> str:
    if view_bins == "front_back_side":
        return view if view in {"front", "back"} else "side"
    return view


def resolve_view_options(view_scheme: str, view_bins: str) -> tuple[str, str, Optional[set[str]]]:
    view_scheme = str(view_scheme or "").strip()
    view_bins = str(view_bins or "").strip()
    if "," in view_scheme:
        views = {s.strip() for s in view_scheme.split(",") if s.strip()}
        allowed = {
            "front",
            "back",
            "side",
            "side45",
            "front45",
            "back45",
            "right_side",
            "back_right_side45",
            "front_right_side45",
            "left_side",
            "back_left_side45",
            "front_left_side45",
        }
        unknown = sorted(v for v in views if v not in allowed)
        if unknown:
            raise ValueError(f"--view-scheme 逗号列表包含未知视角：{','.join(unknown)}")

        if "side45" in views and ("front45" in views or "back45" in views):
            raise ValueError("--view-scheme 同时包含 side45 与 front45/back45 会产生歧义")

        if views.issubset({"front", "back", "side"}):
            return "front_back_front45_back45", "front_back_side", views
        if "side45" in views:
            return "front_back_45", "raw", views
        return "front_back_front45_back45", "raw", views

    allowed_schemes = {"none", "front_back_45", "front_back_front45_back45"}
    if view_scheme not in allowed_schemes:
        raise ValueError(
            "--view-scheme 仅支持 none/front_back_45/front_back_front45_back45，或用逗号列出期望视角（如 front,back,side）"
        )
    allowed_bins = {"raw", "front_back_side"}
    if view_bins not in allowed_bins:
        raise ValueError("--view-bins 仅支持 raw/front_back_side")
    return view_scheme, view_bins, None


if __name__ == "__main__":
    main()

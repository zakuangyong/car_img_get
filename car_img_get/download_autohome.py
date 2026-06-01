from __future__ import annotations

import argparse
import hashlib
import io
import json
import time
import re
from pathlib import Path
from typing import Iterable, Optional, Tuple

import requests
from PIL import Image
from tqdm import tqdm

from .autohome_api import AutohomeClient, PicItem


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
    parser.add_argument("--view-min-conf", type=float, default=0.0, help="视角分类模型最小置信度阈值（top1conf）")
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
    with metadata_path.open("a", encoding="utf-8") as mf:
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
                )
                if not saved:
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
    view_min_conf: float = 0.0,
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
) -> Tuple[bool, dict]:
    color = str(item.colorname or "").strip()
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
    if out_path.exists() and out_path.stat().st_size > 0:
        if min_size > 0:
            try:
                with Image.open(out_path) as im0:
                    w0, h0 = im0.size
                if w0 >= min_size and h0 >= min_size:
                    info = build_metadata(item, out_path, None, None, w0, h0, None, None, None, None, None)
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
            info = build_metadata(item, out_path, None, None, None, None, None, None, None, None, None)
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

    try:
        im = Image.open(io.BytesIO(content))
        im = im.convert("RGB")
    except Exception:
        return False, {}

    width, height = im.size
    if min_size > 0 and (width < min_size or height < min_size):
        return False, {}
    view_label, view_raw, view_scheme_label, view_features = None, None, None, None
    if view_scheme != "none":
        from .viewpoint import classify_view

        raw_label, feats = classify_view(im, prefer_yolo=prefer_yolo, min_conf=float(view_min_conf))
        view_raw = raw_label
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
        if max_per_view > 0 and view_counts is not None:
            if view_counts.get(view_label, 0) >= max_per_view:
                info = build_metadata(
                    item, out_path, url, digest, width, height, im.mode, view_label, None, view_raw, view_scheme_label
                )
                return False, info
        if only_view and view_label not in only_view:
            info = build_metadata(item, out_path, url, digest, width, height, im.mode, view_label, None, view_raw, view_scheme_label)
            return False, info
        view_features = {
            "aspect_ratio": feats.aspect_ratio,
            "symmetry": feats.symmetry,
            "red_ratio": feats.red_ratio,
            "used_detector": feats.used_detector,
        }
        out_path = (base_dir / f"view_{view_label}") / out_file
        out_path.parent.mkdir(parents=True, exist_ok=True)

    out_path_tmp = out_path.with_suffix(".png.part")
    im.save(out_path_tmp, format="PNG", optimize=True)
    out_path_tmp.replace(out_path)

    if view_label is not None and max_per_view > 0 and view_counts is not None:
        view_counts[view_label] = view_counts.get(view_label, 0) + 1
    if seen_colors is not None and color:
        seen_colors.add(color)
    info = build_metadata(item, out_path, url, digest, width, height, im.mode, view_label, view_features, view_raw, view_scheme_label)
    return True, info


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
) -> dict:
    return {
        "seriesid": item.seriesid,
        "specid": item.specid,
        "categoryid": item.categoryid,
        "typeid": item.typeid,
        "picid": item.picid,
        "specname": item.specname,
        "url": url,
        "saved_path": str(out_path.as_posix()),
        "md5": md5,
        "width": width,
        "height": height,
        "mode": mode,
        "view": view_label,
        "view_raw": view_raw,
        "view_scheme": view_scheme,
        "view_features": view_features,
        "tag": item.tag,
        "pointname": item.pointname,
        "colorname": item.colorname,
    }


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


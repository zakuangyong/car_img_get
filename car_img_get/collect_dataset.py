from __future__ import annotations

import argparse
import csv
import json
import random
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional


@dataclass(frozen=True)
class CollectedItem:
    src_path: Path
    rel_path: str
    view: str
    brand: str
    series: str
    specname: str
    year: Optional[int]
    seriesid: Optional[int]
    specid: Optional[int]
    colorname: str


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", type=Path, default=Path("./dataset_png"), help="源数据集目录（默认 ./dataset_png）")
    parser.add_argument("--dst", type=Path, default=None, help="扁平化输出目录；不填则只生成清单")
    parser.add_argument("--manifest", type=Path, default=None, help="清单输出路径；不填则写到 dst 或 src 下")
    parser.add_argument("--format", choices=["csv", "jsonl"], default="csv", help="清单格式")
    parser.add_argument("--views", type=str, default="", help="仅保留指定视角，逗号分隔，例如 front,back,side")
    parser.add_argument(
        "--reclassify-view",
        choices=["none", "model"],
        default="none",
        help="重新用内置视角分类模型判定 view（models/yolo11m-cls-for-car-view-train7.pt）；配合 --views 使用以修正历史 view 不准的问题",
    )
    parser.add_argument("--view-min-conf", type=float, default=0.0, help="视角分类模型最小置信度阈值（top1conf）")
    parser.add_argument("--only-seriesid", type=str, default="", help="仅保留指定 seriesid，逗号分隔，例如 197,6124")
    parser.add_argument("--only-specid", type=str, default="", help="仅保留指定 specid，逗号分隔，例如 68837,65520")
    parser.add_argument("--only-brand", type=str, default="", help="仅保留指定品牌（目录名中的品牌），逗号分隔")
    parser.add_argument("--only-series", type=str, default="", help="仅保留指定车系（目录名中的车系），逗号分隔")
    parser.add_argument("--only-specname", type=str, default="", help="仅保留指定车型名（metadata 的 specname），逗号分隔")
    parser.add_argument("--specname-contains", type=str, default="", help="仅保留 specname 包含该子串的样本")
    parser.add_argument("--specname-regex", type=str, default="", help="仅保留 specname 匹配该正则的样本（re.search）")
    parser.add_argument(
        "--group-by",
        type=str,
        default="",
        help="分组键，逗号分隔，可选 brand,series,year；配合 --max-per-group 限定每组数量",
    )
    parser.add_argument("--max-per-group", type=int, default=0, help="每个分组最多保留多少张，0 不限制")
    parser.add_argument(
        "--max-per-bsy",
        type=int,
        default=0,
        help="每个 品牌+车系+年份 最多保留多少张，0 不限制；等价于 --group-by brand,series,year --max-per-group N",
    )
    parser.add_argument("--sample", type=int, default=0, help="随机抽样多少张，0 不抽样")
    parser.add_argument("--sample-specs", type=int, default=0, help="随机抽取多少个车型（spec），0 不抽样")
    parser.add_argument("--per-spec", type=int, default=0, help="每个车型（spec）固定抽取多少张，0 表示不限制")
    parser.add_argument("--seed", type=int, default=0, help="随机种子（用于可复现抽样）；0 表示不设种子")
    parser.add_argument("--limit", type=int, default=0, help="最多处理多少张，0 不限制")
    parser.add_argument("--mode", choices=["copy", "none"], default="none", help="是否复制到 dst：copy 或 none")
    parser.add_argument(
        "--layout",
        choices=["flat", "spec", "spec-flat", "mirror"],
        default="flat",
        help="复制到 dst 的目录布局：flat=扁平化；spec=按 spec_xxx 分目录；spec-flat=不分目录但文件名带 spec；mirror=保留原始相对路径",
    )
    args = parser.parse_args()

    src_root: Path = args.src
    if not src_root.exists():
        raise SystemExit(f"src 目录不存在：{src_root}")

    dst_root: Optional[Path] = args.dst
    if str(args.mode) == "copy" and dst_root is None:
        raise SystemExit("mode=copy 时必须提供 --dst")

    if dst_root is not None:
        dst_root.mkdir(parents=True, exist_ok=True)

    allowed_views = {s.strip() for s in str(args.views).split(",") if s.strip()}
    allowed_views = _expand_requested_views(allowed_views)

    sample_handled = False
    items = list(iter_collect_items(src_root))
    items.sort(key=lambda it: it.rel_path)
    if (
        str(args.reclassify_view) == "model"
        and allowed_views
        and int(args.sample) > 0
        and int(args.sample_specs) <= 0
        and int(args.max_per_group) <= 0
        and int(args.max_per_bsy) <= 0
        and int(args.limit) <= 0
    ):
        items = _apply_filters(items, args)
        rnd = random.Random(int(args.seed) if int(args.seed) != 0 else None)
        rnd.shuffle(items)
        items = _sample_first_k_views_by_model(items, allowed_views=allowed_views, k=int(args.sample), min_conf=float(args.view_min_conf))
        sample_handled = True
    else:
        if str(args.reclassify_view) == "model" and allowed_views:
            items = _reclassify_views_by_model(items, min_conf=float(args.view_min_conf))
        if allowed_views:
            items = [it for it in items if it.view in allowed_views]
        items = _apply_filters(items, args)

    group_by_s = str(args.group_by).strip()
    max_per_group = int(args.max_per_group)
    if int(args.max_per_bsy) > 0 and max_per_group <= 0:
        max_per_group = int(args.max_per_bsy)
        group_by_s = group_by_s or "brand,series,year"

    if max_per_group > 0:
        if not group_by_s:
            group_by_s = "brand,series,year"
        items = _apply_group_quota(items, group_by_s, max_per_group)

    if not sample_handled:
        rnd = random.Random(int(args.seed) if int(args.seed) != 0 else None)
        if int(args.sample_specs) > 0:
            items = _sample_by_spec(items, sample_specs=int(args.sample_specs), per_spec=int(args.per_spec), rnd=rnd)
        elif int(args.sample) > 0:
            rnd.shuffle(items)
            items = items[: int(args.sample)]
        elif int(args.limit) > 0:
            items = items[: int(args.limit)]

    if dst_root is not None and str(args.mode) == "copy":
        copied: list[tuple[CollectedItem, Path]] = []
        used: set[str] = set()
        for it in items:
            out_path = _build_dst_path(dst_root, it, layout=str(args.layout))
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_name = out_path.name
            out_name = _ensure_unique_name(out_name, used)
            out_path = out_path.with_name(out_name)
            shutil.copy2(it.src_path, out_path)
            copied.append((it, out_path))
        items_out = [
            CollectedItem(
                src_path=out_path,
                rel_path=str(out_path.relative_to(dst_root).as_posix()),
                view=it.view,
                brand=it.brand,
                series=it.series,
                specname=it.specname,
                year=it.year,
                seriesid=it.seriesid,
                specid=it.specid,
                colorname=it.colorname,
            )
            for it, out_path in copied
        ]
        items = items_out
        out_base = dst_root
    else:
        out_base = src_root

    manifest_path: Path = args.manifest or (out_base / ("manifest.jsonl" if args.format == "jsonl" else "manifest.csv"))
    if str(args.format) == "jsonl":
        write_jsonl(items, manifest_path)
    else:
        write_csv(items, manifest_path)

    print(f"total={len(items)}")
    print(f"manifest={manifest_path}")


def iter_collect_items(src_root: Path) -> Iterable[CollectedItem]:
    meta_path = src_root / "metadata.jsonl"
    if meta_path.exists():
        yield from _iter_from_metadata(src_root, meta_path)
        return
    for p in src_root.rglob("*.png"):
        if p.name.endswith(".png.part"):
            continue
        rel = str(p.relative_to(src_root).as_posix())
        view = _guess_view_from_path(p)
        brand, series = _parse_brand_series_from_path(p)
        year = _parse_year_from_filename(p)
        seriesid, specid = _parse_ids_from_path(p)
        yield CollectedItem(
            src_path=p,
            rel_path=rel,
            view=view,
            brand=brand,
            series=series,
            specname="",
            year=year,
            seriesid=seriesid,
            specid=specid,
            colorname="",
        )


def _iter_from_metadata(src_root: Path, meta_path: Path) -> Iterable[CollectedItem]:
    for line in meta_path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s:
            continue
        try:
            rec = json.loads(s)
        except Exception:
            continue

        saved_path = str(rec.get("saved_path") or "").strip()
        if not saved_path:
            continue
        p = _resolve_saved_path(saved_path, src_root)
        if p is None or not p.exists() or p.suffix.lower() != ".png":
            continue

        rel = str(p.relative_to(src_root).as_posix())
        view = str(rec.get("view") or "") or _guess_view_from_path(p)
        brand, series = _parse_brand_series_from_path(p)
        specname = str(rec.get("specname") or "")
        year = _parse_year_from_specname(specname) or _parse_year_from_filename(p)
        seriesid = _to_int(rec.get("seriesid")) or _parse_ids_from_path(p)[0]
        specid = _to_int(rec.get("specid")) or _parse_ids_from_path(p)[1]
        colorname = str(rec.get("colorname") or "")
        yield CollectedItem(
            src_path=p,
            rel_path=rel,
            view=view,
            brand=brand,
            series=series,
            specname=specname,
            year=year,
            seriesid=seriesid,
            specid=specid,
            colorname=colorname,
        )


def _resolve_saved_path(saved_path: str, src_root: Path) -> Optional[Path]:
    p = Path(saved_path)
    if p.is_absolute():
        return p

    parts = [x for x in p.parts if x not in {".", ""}]
    src_name = src_root.name
    try:
        idx = parts.index(src_name)
        rel_parts = parts[idx + 1 :]
    except Exception:
        rel_parts = parts
    cand = src_root.joinpath(*rel_parts)
    if cand.exists():
        return cand
    cand2 = (src_root.parent / p).resolve()
    if cand2.exists():
        return cand2
    return None


def _guess_view_from_path(p: Path) -> str:
    for part in p.parts:
        if part.startswith("view_"):
            return part[len("view_") :]
    return ""


def _parse_ids_from_path(p: Path) -> tuple[Optional[int], Optional[int]]:
    seriesid = None
    specid = None
    for part in p.parts:
        m = re.fullmatch(r"series_(\d+)", part)
        if m:
            seriesid = _to_int(m.group(1))
        m = re.fullmatch(r"spec_(\d+)", part)
        if m:
            specid = _to_int(m.group(1))
    return seriesid, specid


def _parse_brand_series_from_path(p: Path) -> tuple[str, str]:
    parts = list(p.parts)
    spec_idx = None
    for i, part in enumerate(parts):
        if re.fullmatch(r"spec_(\d+)", part):
            spec_idx = i
            break
    if spec_idx is None:
        return "", ""
    if spec_idx + 1 >= len(parts):
        return "", ""
    cat_dir = parts[spec_idx + 1]
    if cat_dir.startswith("view_"):
        return "", ""

    if "_" not in cat_dir:
        return cat_dir, ""
    brand, series = cat_dir.split("_", 1)
    return brand, series


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


def _parse_year_from_filename(p: Path) -> Optional[int]:
    stem = p.stem
    m = re.search(r"_(19\d{2}|20\d{2})_", stem)
    if not m:
        m = re.search(r"\b(19\d{2}|20\d{2})\b", stem)
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


def _to_int(v: Any) -> Optional[int]:
    try:
        if v is None:
            return None
        return int(v)
    except Exception:
        return None


def _suggest_flat_name(it: CollectedItem) -> str:
    view = it.view or "unknown"
    year_s = str(it.year) if it.year is not None else "unknown"
    prefix = "_".join([x for x in [it.brand, it.series, year_s, view] if x])
    stem = it.src_path.stem
    s = f"{prefix}_{stem}.png" if prefix else f"{view}_{stem}.png"
    s = re.sub(r"\s+", "_", s)
    s = re.sub(r"[\\/:*?\"<>|]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s


def _suggest_spec_flat_name(it: CollectedItem) -> str:
    spec_s = f"spec_{it.specid}" if it.specid is not None else "spec_unknown"
    name = _suggest_flat_name(it)
    if name.startswith(f"{spec_s}_"):
        return name
    return f"{spec_s}_{name}"


def _split_csv(s: str) -> list[str]:
    return [x.strip() for x in str(s or "").split(",") if x.strip()]


def _parse_int_set(s: str) -> set[int]:
    out: set[int] = set()
    for x in _split_csv(s):
        v = _to_int(x)
        if v is not None:
            out.add(int(v))
    return out


def _parse_str_set(s: str) -> set[str]:
    return set(_split_csv(s))


def _expand_requested_views(views: set[str]) -> set[str]:
    out = set(views)
    if "side" in out:
        out.discard("side")
        out.update({"left_side", "right_side"})
    if "side45" in out:
        out.discard("side45")
        out.update({"front_left_side45", "front_right_side45", "back_left_side45", "back_right_side45"})
    if "front45" in out:
        out.discard("front45")
        out.update({"front_left_side45", "front_right_side45"})
    if "back45" in out:
        out.discard("back45")
        out.update({"back_left_side45", "back_right_side45"})
    return out


def _with_view(it: CollectedItem, view: str) -> CollectedItem:
    return CollectedItem(
        src_path=it.src_path,
        rel_path=it.rel_path,
        view=view,
        brand=it.brand,
        series=it.series,
        specname=it.specname,
        year=it.year,
        seriesid=it.seriesid,
        specid=it.specid,
        colorname=it.colorname,
    )


def _reclassify_views_by_model(items: list[CollectedItem], *, min_conf: float = 0.0) -> list[CollectedItem]:
    Image = None
    cv2 = None
    try:
        import cv2 as _cv2

        cv2 = _cv2
    except Exception:
        cv2 = None

    try:
        from PIL import Image as _Image

        Image = _Image
    except Exception:
        Image = None

    if cv2 is None and Image is None:
        raise SystemExit("reclassify-view=model 需要安装 opencv-python 或 pillow")

    try:
        from .viewpoint import classify_view
    except Exception as e:
        raise SystemExit(f"reclassify-view=model 无法加载视角分类模块：{e}")

    out: list[CollectedItem] = []
    for it in items:
        try:
            if cv2 is not None:
                img_bgr = cv2.imread(str(it.src_path), cv2.IMREAD_COLOR)
                if img_bgr is None:
                    raise ValueError("opencv read failed")
                h, w = img_bgr.shape[:2]
                max_side = max(h, w)
                if max_side > 640:
                    scale = 640.0 / float(max_side)
                    img_bgr = cv2.resize(img_bgr, (int(w * scale), int(h * scale)))
                img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
                label, _ = classify_view(img_rgb, prefer_yolo=False, min_conf=float(min_conf))
            else:
                with Image.open(it.src_path) as im:
                    im = im.convert("RGB")
                    if max(im.size) > 640:
                        im.thumbnail((640, 640))
                    label, _ = classify_view(im, prefer_yolo=False, min_conf=float(min_conf))
        except Exception:
            label = ""
        out.append(_with_view(it, label))
    return out


def _sample_first_k_views_by_model(
    items: list[CollectedItem], *, allowed_views: set[str], k: int, min_conf: float = 0.0
) -> list[CollectedItem]:
    Image = None
    cv2 = None
    try:
        import cv2 as _cv2

        cv2 = _cv2
    except Exception:
        cv2 = None

    try:
        from PIL import Image as _Image

        Image = _Image
    except Exception:
        Image = None

    if cv2 is None and Image is None:
        raise SystemExit("reclassify-view=model 需要安装 opencv-python 或 pillow")

    try:
        from .viewpoint import classify_view
    except Exception as e:
        raise SystemExit(f"reclassify-view=model 无法加载视角分类模块：{e}")

    out: list[CollectedItem] = []
    for it in items:
        if len(out) >= int(k):
            break
        try:
            if cv2 is not None:
                img_bgr = cv2.imread(str(it.src_path), cv2.IMREAD_COLOR)
                if img_bgr is None:
                    continue
                h, w = img_bgr.shape[:2]
                max_side = max(h, w)
                if max_side > 640:
                    scale = 640.0 / float(max_side)
                    img_bgr = cv2.resize(img_bgr, (int(w * scale), int(h * scale)))
                img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
                label, _ = classify_view(img_rgb, prefer_yolo=False, min_conf=float(min_conf))
            else:
                with Image.open(it.src_path) as im:
                    im = im.convert("RGB")
                    if max(im.size) > 640:
                        im.thumbnail((640, 640))
                    label, _ = classify_view(im, prefer_yolo=False, min_conf=float(min_conf))
        except Exception:
            continue
        if label in allowed_views:
            out.append(_with_view(it, label))
    return out


def _apply_filters(items: list[CollectedItem], args: Any) -> list[CollectedItem]:
    only_seriesid = _parse_int_set(getattr(args, "only_seriesid", ""))
    only_specid = _parse_int_set(getattr(args, "only_specid", ""))
    only_brand = _parse_str_set(getattr(args, "only_brand", ""))
    only_series = _parse_str_set(getattr(args, "only_series", ""))
    only_specname = _parse_str_set(getattr(args, "only_specname", ""))
    specname_contains = str(getattr(args, "specname_contains", "") or "").strip()
    specname_regex = str(getattr(args, "specname_regex", "") or "").strip()

    rx = None
    if specname_regex:
        try:
            rx = re.compile(specname_regex)
        except Exception as e:
            raise SystemExit(f"specname-regex 无效：{e}")

    if (
        not only_seriesid
        and not only_specid
        and not only_brand
        and not only_series
        and not only_specname
        and not specname_contains
        and rx is None
    ):
        return items

    out: list[CollectedItem] = []
    for it in items:
        if only_seriesid and (it.seriesid is None or int(it.seriesid) not in only_seriesid):
            continue
        if only_specid and (it.specid is None or int(it.specid) not in only_specid):
            continue
        if only_brand and it.brand not in only_brand:
            continue
        if only_series and it.series not in only_series:
            continue
        if only_specname and it.specname not in only_specname:
            continue
        if specname_contains and specname_contains not in (it.specname or ""):
            continue
        if rx is not None and rx.search(it.specname or "") is None:
            continue
        out.append(it)
    return out


def _apply_group_quota(items: list[CollectedItem], group_by: str, max_per_group: int) -> list[CollectedItem]:
    keys = [s.strip() for s in str(group_by).split(",") if s.strip()]
    allowed = {"brand", "series", "year"}
    unknown = sorted(k for k in keys if k not in allowed)
    if unknown:
        raise SystemExit(f"group-by 不支持：{','.join(unknown)}")

    counts: dict[tuple, int] = {}
    out: list[CollectedItem] = []
    for it in items:
        key_parts: list[Any] = []
        for k in keys:
            if k == "brand":
                key_parts.append(it.brand)
            elif k == "series":
                key_parts.append(it.series)
            elif k == "year":
                key_parts.append(it.year)
        key = tuple(key_parts)
        n = counts.get(key, 0)
        if n >= int(max_per_group):
            continue
        counts[key] = n + 1
        out.append(it)
    return out


def _sample_by_spec(items: list[CollectedItem], *, sample_specs: int, per_spec: int, rnd: random.Random) -> list[CollectedItem]:
    buckets: dict[int, list[CollectedItem]] = {}
    unknown_bucket: list[CollectedItem] = []
    for it in items:
        if it.specid is None:
            unknown_bucket.append(it)
            continue
        buckets.setdefault(int(it.specid), []).append(it)

    spec_ids = sorted(buckets.keys())
    rnd.shuffle(spec_ids)
    if int(sample_specs) > 0:
        spec_ids = spec_ids[: int(sample_specs)]

    out: list[CollectedItem] = []
    for sid in spec_ids:
        its = buckets.get(sid) or []
        rnd.shuffle(its)
        if int(per_spec) > 0:
            its = its[: int(per_spec)]
        out.extend(its)

    _ = unknown_bucket
    out.sort(key=lambda it: it.rel_path)
    return out


def _ensure_unique_name(name: str, used: set[str]) -> str:
    if name not in used:
        used.add(name)
        return name
    p = Path(name)
    base = p.stem
    ext = p.suffix
    i = 2
    while True:
        cand = f"{base}_{i}{ext}"
        if cand not in used:
            used.add(cand)
            return cand
        i += 1


def _build_dst_path(dst_root: Path, it: CollectedItem, *, layout: str) -> Path:
    layout = str(layout or "flat").strip() or "flat"
    if layout == "mirror":
        return dst_root / Path(it.rel_path)
    if layout == "spec":
        spec_dir = f"spec_{it.specid}" if it.specid is not None else "spec_unknown"
        return dst_root / spec_dir / _suggest_flat_name(it)
    if layout == "spec-flat":
        return dst_root / _suggest_spec_flat_name(it)
    return dst_root / _suggest_flat_name(it)


def write_csv(items: Iterable[CollectedItem], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["path", "view", "brand", "series", "year", "seriesid", "specid", "colorname"])
        w.writeheader()
        for it in items:
            w.writerow(
                {
                    "path": it.rel_path,
                    "view": it.view,
                    "brand": it.brand,
                    "series": it.series,
                    "year": "" if it.year is None else str(it.year),
                    "seriesid": "" if it.seriesid is None else str(it.seriesid),
                    "specid": "" if it.specid is None else str(it.specid),
                    "colorname": it.colorname,
                }
            )


def write_jsonl(items: Iterable[CollectedItem], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for it in items:
            f.write(
                json.dumps(
                    {
                        "path": it.rel_path,
                        "view": it.view,
                        "brand": it.brand,
                        "series": it.series,
                        "year": it.year,
                        "seriesid": it.seriesid,
                        "specid": it.specid,
                        "colorname": it.colorname,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import requests

from .autohome_api import AutohomeClient
from .download_autohome import download_one, resolve_view_options


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True, help="输出目录")
    parser.add_argument("--category", type=int, default=1, help="图片分类 categoryid，例如 1=外观")
    parser.add_argument("--pagesize", type=int, default=80, help="每页数量")
    parser.add_argument("--max-series", type=int, default=0, help="最多处理多少个车系，0 不限制")
    parser.add_argument("--max-per-series", type=int, default=0, help="每个车系最多下载多少张，0 不限制")
    parser.add_argument("--max-total", type=int, default=0, help="最多下载多少张（全局），0 不限制")
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
        "--series-file",
        type=Path,
        default=None,
        help="车系列表文件（每行一个 seriesid）；不填则自动抓取全量车系",
    )
    parser.add_argument(
        "--done-file",
        type=Path,
        default=None,
        help="已完成车系记录文件（每行一个 seriesid），用于断点续跑",
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

    done_path: Path = args.done_file or (out_root / "done_series.txt")
    done_series = _load_done(done_path)

    client = AutohomeClient(timeout_s=args.timeout, max_retries=args.retries, sleep_s=args.sleep)

    if args.series_file:
        series_ids = _load_series_ids(args.series_file)
        series_meta = None
    else:
        series_meta = client.get_all_series()
        series_ids = [s.seriesid for s in series_meta]

    only_view = {s.strip() for s in str(args.only_view).split(",") if s.strip()}
    required_views = {s.strip() for s in str(args.required_views).split(",") if s.strip()}
    if auto_only_view is not None:
        only_view = (only_view & auto_only_view) if only_view else set(auto_only_view)
    only_colors = {s.strip() for s in str(args.only_colors).split(",") if s.strip()}

    dl_session = requests.Session()
    dl_session.headers.update({"User-Agent": "Mozilla/5.0", "Referer": "https://www.autohome.com.cn/"})

    metadata_path = out_root / "metadata.jsonl"
    processed = 0
    total_downloaded = 0
    min_year = int(args.min_year) if int(args.min_year) > 0 else None
    max_year = int(args.max_year) if int(args.max_year) > 0 else None
    with metadata_path.open("a", encoding="utf-8") as mf:
        for idx, series_id in enumerate(series_ids, start=1):
            if series_id in done_series:
                continue

            if args.max_series and processed >= args.max_series:
                return

            specs = client.get_specs(series_id)
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
                _append_done(done_path, series_id)
                done_series.add(series_id)
                processed += 1
                time.sleep(float(args.sleep))
                continue

            si = client.get_series_info(series_id)
            brand_name = si.brandname if si else ""
            series_name = si.seriesname if si else ""

            downloaded_in_series = 0
            for spec_id in spec_ids:
                view_counts: dict[str, int] = {}
                seen_colors: set[str] = set()
                for item in client.iter_pic_list(
                    series_id=series_id,
                    spec_id=spec_id,
                    category_id=args.category,
                    page_size=args.pagesize,
                ):
                    if args.max_total and total_downloaded >= args.max_total:
                        return
                    saved, info = download_one(
                        item,
                        out_root,
                        prefer=args.prefer,
                        view_scheme=view_scheme,
                        prefer_yolo=args.prefer_yolo,
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
                    if saved:
                        mf.write(json.dumps(info, ensure_ascii=False) + "\n")
                        mf.flush()
                        downloaded_in_series += 1
                        total_downloaded += 1
                        time.sleep(float(args.sleep))
                        if required_views and int(args.max_per_view) > 0:
                            if all(view_counts.get(v, 0) >= int(args.max_per_view) for v in required_views):
                                break

                    if args.max_per_series and downloaded_in_series >= args.max_per_series:
                        break
                if args.max_per_series and downloaded_in_series >= args.max_per_series:
                    break
                if required_views and int(args.max_per_view) > 0:
                    if all(view_counts.get(v, 0) >= int(args.max_per_view) for v in required_views):
                        continue

            _append_done(done_path, series_id)
            done_series.add(series_id)
            processed += 1

            _ = idx, series_meta
            time.sleep(float(args.sleep))


def _load_series_ids(path: Path) -> list[int]:
    ids: list[int] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        try:
            ids.append(int(s))
        except Exception:
            continue
    return ids


def _load_done(path: Path) -> set[int]:
    if not path.exists():
        return set()
    done: set[int] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s:
            continue
        try:
            done.add(int(s))
        except Exception:
            continue
    return done


def _append_done(path: Path, series_id: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(f"{series_id}\n")


if __name__ == "__main__":
    main()


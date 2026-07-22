from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


HASH_RE = re.compile(r"^[0-9a-f]{32}$", re.IGNORECASE)
INVALID_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
WHITESPACE_RE = re.compile(r"\s+")


def find_hash_stem(path: Path) -> str | None:
    stem = path.stem.strip()
    if not HASH_RE.fullmatch(stem):
        return None
    return stem.lower()


def load_metadata_index(metadata_path: Path) -> dict[str, list[dict[str, Any]]]:
    index: dict[str, list[dict[str, Any]]] = {}
    with metadata_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            try:
                record = json.loads(text)
            except Exception:
                continue
            if not isinstance(record, dict):
                continue
            key = str(record.get("md5") or "").strip().lower()
            if not HASH_RE.fullmatch(key):
                continue
            index.setdefault(key, []).append(record)
    for records in index.values():
        records.sort(key=lambda record: str(record.get("saved_path") or ""))
    return index


def sanitize_filename_part(value: str) -> str:
    text = INVALID_CHARS_RE.sub("_", str(value).strip())
    return WHITESPACE_RE.sub(" ", text).strip(" .")


def _build_fallback_stem(record: dict[str, Any]) -> str:
    parts = [
        sanitize_filename_part(str(record.get("specname") or "")),
        sanitize_filename_part(str(record.get("seriesid") or "")),
        sanitize_filename_part(str(record.get("specid") or "")),
        sanitize_filename_part(str(record.get("picid") or "")),
    ]
    return "_".join(part for part in parts if part)


def build_target_filename(record: dict[str, Any], *, source_suffix: str) -> str:
    saved_path = str(record.get("saved_path") or "").strip()
    if saved_path:
        stem = sanitize_filename_part(Path(saved_path).stem)
        if not stem:
            stem = _build_fallback_stem(record)
    else:
        stem = _build_fallback_stem(record)
    if not stem:
        md5_value = str(record.get("md5") or "").strip().lower()
        stem = f"mapped_{md5_value[:8]}" if md5_value else "mapped_unknown"
    return f"{stem}{source_suffix}"


def _normalize_conflict_name(name: str) -> str:
    return name.lower()


def resolve_conflict_path(path: Path, *, reserved_names: set[str] | None = None) -> Path:
    reserved = reserved_names if reserved_names is not None else set()
    reserved_normalized = {_normalize_conflict_name(name) for name in reserved}
    if not path.exists() and _normalize_conflict_name(path.name) not in reserved_normalized:
        reserved.add(path.name)
        return path
    for index in range(1, 10000):
        candidate = path.with_name(f"{path.stem}_{index:03d}{path.suffix}")
        if not candidate.exists() and _normalize_conflict_name(candidate.name) not in reserved_normalized:
            reserved.add(candidate.name)
            return candidate
    raise RuntimeError(f"unable to resolve name conflict for {path}")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Restore readable names for hash-named pipeline stage images")
    parser.add_argument("--input-dir", type=Path, required=True, help="Pipeline stage directory to scan recursively")
    parser.add_argument("--metadata", type=Path, help="Path to metadata.jsonl")
    parser.add_argument(
        "--rejected",
        type=Path,
        help="Optional rejected.jsonl; defaults to the file beside metadata.jsonl when present",
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview renames without touching files")
    return parser


def _iter_input_files(input_dir: Path) -> list[Path]:
    return sorted((path for path in input_dir.rglob("*") if path.is_file()), key=lambda path: str(path))


def _default_metadata_path(input_dir: Path) -> Path:
    for candidate in (input_dir, *input_dir.parents):
        if candidate.name == "dataset_png":
            return candidate / "metadata.jsonl"
    return input_dir / "metadata.jsonl"


def _merge_fallback_index(
    primary: dict[str, list[dict[str, Any]]],
    fallback: dict[str, list[dict[str, Any]]],
) -> None:
    for md5_value, records in fallback.items():
        primary.setdefault(md5_value, []).extend(records)


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    input_dir = args.input_dir
    metadata_path = args.metadata or _default_metadata_path(input_dir)
    if not input_dir.exists():
        print(f"ERROR input directory not found: {input_dir}", file=sys.stderr)
        return 2
    if not input_dir.is_dir():
        print(f"ERROR input path is not a directory: {input_dir}", file=sys.stderr)
        return 2
    if not metadata_path.exists():
        print(f"ERROR metadata file not found: {metadata_path}", file=sys.stderr)
        return 2

    metadata_index = load_metadata_index(metadata_path)
    rejected_path = args.rejected or metadata_path.with_name("rejected.jsonl")
    if args.rejected and not rejected_path.exists():
        print(f"ERROR rejected metadata file not found: {rejected_path}", file=sys.stderr)
        return 2
    if rejected_path.exists():
        _merge_fallback_index(metadata_index, load_metadata_index(rejected_path))

    reserved_by_directory: dict[Path, set[str]] = {}
    scanned = 0
    matched = 0
    renamed = 0
    unmatched = 0
    skipped = 0
    conflicted = 0
    errors = 0

    for source_path in _iter_input_files(input_dir):
        scanned += 1
        md5_value = find_hash_stem(source_path)
        if not md5_value:
            skipped += 1
            continue
        records = metadata_index.get(md5_value)
        if not records:
            unmatched += 1
            continue

        matched += 1
        try:
            target_name = build_target_filename(records[0], source_suffix=source_path.suffix)
            if target_name.lower() == source_path.name.lower():
                skipped += 1
                continue
            reserved_names = reserved_by_directory.setdefault(source_path.parent.resolve(), set())
            target_path = resolve_conflict_path(
                source_path.with_name(target_name),
                reserved_names=reserved_names,
            )
            if target_path.name != target_name:
                conflicted += 1
            if args.dry_run:
                print(f"DRY-RUN {source_path} -> {target_path.name}")
            else:
                source_path.rename(target_path)
                print(f"RENAMED {source_path} -> {target_path.name}")
                renamed += 1
        except Exception as exc:
            errors += 1
            print(f"ERROR {source_path}: {exc}", file=sys.stderr)

    mode = "dry-run" if args.dry_run else "rename"
    print(
        "SUMMARY "
        f"mode={mode} scanned={scanned} matched={matched} renamed={renamed} "
        f"unmatched={unmatched} skipped={skipped} conflicted={conflicted} errors={errors}"
    )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

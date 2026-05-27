#!/usr/bin/env python3
"""
Build a summary.json for a HuggingFace dataset.

The web app's HFDataSource fetches this file from the HF Hub at
    https://huggingface.co/datasets/<repo>/resolve/main/summary.<split>.json
falling back to summary.json, to power the sky map, class filter, and
class-balanced random sampling without downloading the full dataset.

classIndices holds split-specific row offsets, so multi-split datasets need one
file per split. By default this builds every split, writing summary.<split>.json
for each; pass --split to build just one. Upload each file to the repo root. The
app falls back to a plain summary.json when summary.<split>.json is absent, so
single-split datasets can keep using summary.json.

Schema (matches HFDiskDataSource._scan output):
    {
      "version": 1,
      "totalRows": int,
      "bands": [str, ...],
      "classCounts": {cls: count, ...},      // sorted desc
      "classIndices": {cls: [row_idx, ...]}, // sorted desc by count
      "skyPoints": [{"ra", "dec", "cls"}, ...]
    }

The dataset format is auto-detected: legacy datasets (a `bands_data` struct
with bare ZTF band keys and `ra`/`dec` columns) are mapped to the canonical
schema, matching normalizeRow in src/data/DataSource.js. Datasets without sky
coordinates still produce a valid summary with an empty "skyPoints".

Examples:
    # Build every split (writes summary.<split>.json for each)
    python scripts/build_summary.py --dataset nabeelr/SE_test

    # Build a single split
    python scripts/build_summary.py --dataset nabeelr/SE_test --split test

Then upload each file to the dataset repo root:
    huggingface-cli upload nabeelr/SE_test summary.train.json summary.train.json --repo-type=dataset
    huggingface-cli upload nabeelr/SE_test summary.test.json  summary.test.json  --repo-type=dataset
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path


def build_split(ds, split_name: str, output: str | None, args) -> None:
    # Legacy (GluonTS-style) datasets use `bands_data` with bare ZTF band keys
    # and `ra`/`dec` instead of the canonical `lightcurve` + `gaia_dr3_*` names.
    # Mirror the JS normalizer (src/data/DataSource.js) so summaries match.
    feats = ds.features
    is_legacy = "bands_data" in feats and "lightcurve" not in feats
    band_key_map = {"g": "g_ZTF", "r": "r_ZTF", "i": "i_ZTF"} if is_legacy else {}
    lc_key = "bands_data" if is_legacy else "lightcurve"
    class_key = "class_str"
    ra_key, dec_key = ("ra", "dec") if is_legacy else ("gaia_dr3_ra", "gaia_dr3_dec")

    bands = [band_key_map.get(k, k) for k in feats[lc_key].keys()]
    has_coords = ra_key in feats and dec_key in feats

    cols = [class_key] + ([ra_key, dec_key] if has_coords else [])
    sub = ds.select_columns(cols)
    class_indices: dict[str, list[int]] = {}
    class_coords: dict[str, list[tuple[float, float]]] = {}
    i = 0
    for batch in sub.iter(batch_size=10_000):
        classes = batch[class_key]
        ras = batch[ra_key] if has_coords else [None] * len(classes)
        decs = batch[dec_key] if has_coords else [None] * len(classes)
        for cls, ra, dec in zip(classes, ras, decs):
            key = cls if cls is not None else "(none)"
            class_indices.setdefault(key, []).append(i)
            if ra is not None and dec is not None:
                class_coords.setdefault(key, []).append((float(ra), float(dec)))
            i += 1
    total = i

    sorted_items = sorted(class_indices.items(), key=lambda kv: -len(kv[1]))
    class_indices_sorted = {k: v for k, v in sorted_items}
    class_counts = {k: len(v) for k, v in sorted_items}

    # Class-balanced sky sampling: each class gets at least sky_floor points
    # (or all of them if smaller), plus a proportional share of the budget.
    # Total may slightly exceed sky_sample when many classes have <floor rows.
    rng = random.Random(args.seed)
    total_with_coords = sum(len(v) for v in class_coords.values())
    sky_points = []
    for cls, coords in class_coords.items():
        n_class = len(coords)
        proportional = round(n_class / total_with_coords * args.sky_sample) if total_with_coords else 0
        target = max(args.sky_floor, proportional)
        actual = min(target, n_class)
        idxs = list(range(n_class))
        for k in range(actual):
            j = k + rng.randrange(n_class - k)
            idxs[k], idxs[j] = idxs[j], idxs[k]
            ra, dec = coords[idxs[k]]
            sky_points.append({"ra": ra, "dec": dec, "cls": cls})

    summary = {
        "version": 1,
        "totalRows": total,
        "bands": bands,
        "classCounts": class_counts,
        "classIndices": class_indices_sorted,
        "skyPoints": sky_points,
    }

    out = Path(output or f"summary.{split_name}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as f:
        json.dump(summary, f, separators=(",", ":"))
    print(f"Wrote {out}: {total} rows, {len(class_counts)} classes, {len(sky_points)} sky points, {len(bands)} bands")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--dataset",
        required=True,
        help="Path to a local on-disk dataset OR a HF Hub repo (e.g. user/name)",
    )
    parser.add_argument("--split", default=None, help="Split to build; omit to build all splits")
    parser.add_argument("--config", default="default", help="Config name (default: default)")
    parser.add_argument(
        "--output",
        default=None,
        help="Output path (default: summary.<split>.json, e.g. summary.train.json)",
    )
    parser.add_argument("--sky-sample", type=int, default=20_000, help="Target sky points budget (default: 20000)")
    parser.add_argument("--sky-floor", type=int, default=100, help="Min sky points per class (default: 100, capped by class size)")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed for sky sampling")
    args = parser.parse_args()

    try:
        from datasets import load_from_disk, load_dataset, get_dataset_split_names
    except ImportError as e:
        raise SystemExit("Missing dependency. Install with: pip install datasets") from e

    if args.output and args.split is None:
        raise SystemExit(
            "--output names a single file; pass --split to use it, "
            "or omit --output to build all splits as summary.<split>.json"
        )

    # Resolve {split_name: Dataset} to build. Default (no --split) is every split.
    src = Path(args.dataset)
    if src.exists():
        loaded = load_from_disk(str(src))
        if hasattr(loaded, "keys"):  # DatasetDict
            names = [args.split] if args.split else list(loaded.keys())
            missing = [s for s in names if s not in loaded]
            if missing:
                raise SystemExit(f"Split(s) {missing} not found; available: {list(loaded.keys())}")
            split_datasets = {s: loaded[s] for s in names}
        else:  # bare Dataset with no split concept
            split_datasets = {args.split or "train": loaded}
    else:
        names = [args.split] if args.split else get_dataset_split_names(args.dataset, args.config)
        split_datasets = {s: load_dataset(args.dataset, args.config, split=s) for s in names}

    for split_name, ds in split_datasets.items():
        build_split(ds, split_name, args.output, args)


if __name__ == "__main__":
    main()

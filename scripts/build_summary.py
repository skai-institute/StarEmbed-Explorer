#!/usr/bin/env python3
"""
Build a summary.json for a HuggingFace dataset.

The web app's HFDataSource fetches this file from the HF Hub at
    https://huggingface.co/datasets/<repo>/resolve/main/summary.json
to power the sky map, class filter, and class-balanced random sampling
without downloading the full dataset.

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
    # From a local on-disk dataset
    python scripts/build_summary.py \\
        --dataset /path/to/local/dataset \\
        --output summary.json

    # From the HuggingFace Hub
    python scripts/build_summary.py \\
        --dataset nabeelr/SE_test \\
        --output summary.json

Then upload to the dataset repo:
    huggingface-cli upload nabeelr/SE_test summary.json summary.json --repo-type=dataset
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path


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
    parser.add_argument("--split", default="train", help="Split (default: train)")
    parser.add_argument("--config", default="default", help="Config name (default: default)")
    parser.add_argument("--output", default="summary.json", help="Output path (default: summary.json)")
    parser.add_argument("--sky-sample", type=int, default=10_000, help="Target sky points budget (default: 10000)")
    parser.add_argument("--sky-floor", type=int, default=100, help="Min sky points per class (default: 100, capped by class size)")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed for sky sampling")
    args = parser.parse_args()

    try:
        from datasets import load_from_disk, load_dataset
    except ImportError as e:
        raise SystemExit("Missing dependency. Install with: pip install datasets") from e

    src = Path(args.dataset)
    if src.exists():
        ds = load_from_disk(str(src))
        if hasattr(ds, "keys") and args.split in ds:
            ds = ds[args.split]
    else:
        ds = load_dataset(args.dataset, args.config, split=args.split)

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

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as f:
        json.dump(summary, f, separators=(",", ":"))
    print(f"Wrote {out}: {total} rows, {len(class_counts)} classes, {len(sky_points)} sky points, {len(bands)} bands")


if __name__ == "__main__":
    main()

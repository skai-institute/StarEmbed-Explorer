# CLAUDE.md

Notes for working on this codebase. Things that aren't obvious from reading the code.

## Stack

Vite + React 18, no TypeScript, no router. Plotly.js (`react-plotly.js` + `plotly.js-dist-min`) for sky map and lightcurves. apache-arrow for reading IPC shards. Inline `style={...}` only — no global CSS framework, no styled-components.

## Data architecture

`DataSource` ([src/data/DataSource.js](src/data/DataSource.js)) is an abstract interface with three async methods:

- `getInfo()` → `{ source, numRows, columns }`
- `getRows({ offset, length })` → array of plain row objects
- `getSummary()` → `{ totalRows, classCounts, classIndices, bands, skyPoints }` or `null`

Two implementations swap behind it:

| Source | Origin | When it's used |
|---|---|---|
| `HFDataSource` | HF Datasets Server REST API | `source: "hf"`, or `?dataset=user/name` URL param, or custom user/name typed in the welcome modal |
| `HFDiskDataSource` | Arrow IPC shards via browser file picker | "Select local dataset" button (welcome modal or header) |

Factory at [src/data/index.js](src/data/index.js) dispatches by `descriptor.source`.

## Dataset formats (current vs legacy)

Two on-disk schemas carry the same information under different names. The rest of the app only ever sees the **canonical (current)** shape — `lightcurve` struct of bands → `{mjd, mag, mag_unc, ...}`, `gaia_dr3_*` astrometry, `class_str`. The **legacy** GluonTS-style schema (e.g. [StarEmbed/ZTF_40k](https://huggingface.co/datasets/StarEmbed/ZTF_40k)) uses a `bands_data` struct with per-band `target` (mag), `past_feat_dynamic_real` (mag error), `mjd`; bare ZTF band keys `g`/`r`/`i`; `sourceid`; and `ra`/`dec`.

`ROW_FORMATS` / `detectFormat` / `normalizeRow` in [src/data/DataSource.js](src/data/DataSource.js) own this. Detection is automatic (a schema with `bands_data` and no `lightcurve` is legacy). `normalizeRow` rewrites legacy rows into the canonical shape at the data-source boundary, so **no rendering component knows the legacy layout exists**. Both `HFDataSource` and `HFDiskDataSource` normalize in `getRows`/`findBySourceId`, and resolve format-specific column names (`idKey`, `raKey`, `decKey`, `classKey`) from the spec. The legacy band remap `g`→`g_ZTF` lives inside `normalizeRow` and is gated on the legacy format — modern datasets never have a survey assumed. [scripts/build_summary.py](scripts/build_summary.py) mirrors the same detection + remap so remote summaries match.

## Dataset selection (three ways)

1. **Welcome modal** — on every page load, the user picks a dataset before the app loads anything. Lists known HF datasets from `DATASETS` in [src/datasets.js](src/datasets.js), accepts a custom `user/dataset_name`, or accepts a local Arrow shard directory when self-hosting.
2. **URL override** — `?dataset=user/name` (optional `&config=`, `&split=`, `&label=`) prepends a synthetic descriptor and pre-selects it in the modal. Logic in `descriptorFromURL()` at the top of [src/App.jsx](src/App.jsx).

A descriptor's `split` may be a single name (`"train"`), an array, or `"*"` (every split, merged — see *The summary.json mechanism*). The custom-input and URL-override defaults are `"*"`, which gracefully reduces to whatever splits exist (a single-split dataset behaves exactly as before); pass `&split=train` to pin one. The bundled `ZTF_40k` entry uses `"*"` so all four splits (train/validation/test/anom, ~42.5k rows) load as one dataset.
3. **File picker** — disabled in deployed builds via `IS_DEPLOYED`. **Brittleness**: this currently checks `import.meta.env.BASE_URL !== '/'`, which works for the github.io subpath deploy but would falsely re-enable the picker for a custom-domain build (`BASE_PATH=/`). Switch to a dedicated env var like `VITE_DEPLOY_TARGET=pages` set only in the workflow if adding a custom domain.

## The summary.json mechanism

`HFDataSource.getSummary()` fetches a pre-computed summary from `https://huggingface.co/datasets/<repo>/resolve/main/summary.<split>.json`, falling back to `summary.json` if that 404s. **Without it the app degrades**: no sky map, no class filter, no class-balanced random sampling. Falls back gracefully to global random offset.

**Per-split naming matters**: `classIndices` holds split-local row offsets that `getRows({ offset })` relies on, so a `train`-built summary must not be served when viewing another split. Multi-split datasets need one file per split (`summary.<split>.json`); the `summary.json` fallback keeps existing single-split datasets working unchanged.

**Merging splits into one view**: a descriptor's `split` may be a single name, an array, or `"*"` (every split in the config) — see *Dataset selection*. When more than one split is in play, `HFDataSource` treats them as one contiguous dataset: `getInfo` resolves the split list and computes per-split global base offsets (`_splitEnds`) from each split's `num_examples`; `getRows({ offset })` maps a global offset back to the owning split + local offset (`_splitForOffset`); and `getSummary` → `_mergeSummaries` fetches every `summary.<split>.json`, sums `classCounts`, concatenates `classIndices` **shifted by each split's global base** so they index the same concatenated space, unions `bands`, and re-runs `sampleSkyPointsByClass` over the pooled sky points (the per-split files are already sampled, so this is approximate but within the render budget). A split whose summary is missing is skipped — its rows stay reachable via global random sampling but won't appear in the sky map or class counts. This is purely client-side; the per-split files and `build_summary.py` are unchanged, so the base offsets only line up because each `summary.totalRows` equals that split's `num_examples`.

Why pre-computed: `HFDiskDataSource` builds the summary by scanning the entire dataset. Impossible for a multi-GB remote dataset, and HF's datasets-server doesn't expose per-row sky positions.

Generate with [scripts/build_summary.py](scripts/build_summary.py) (run once per `--split`; `--output` defaults to `summary.<split>.json`), upload via `huggingface-cli upload <repo> summary.<split>.json summary.<split>.json --repo-type=dataset`. Schema matches what `HFDiskDataSource._scan` produces in-memory ([src/data/HFDiskDataSource.js](src/data/HFDiskDataSource.js)) — keep them in sync.

Size scales with row count: ~1 MB for 50k rows, ~7 MB for 1M (mostly `classIndices`). The `skyPoints` budget (20k, below) adds ~0.6-0.8 MB at the cap. Tolerable through ~1M rows; past that, rethink the summary shape.

## Class-balanced sky sampling

The sky map is capped at ~20k points (`SKY_SAMPLE`). The live renderer is a `<canvas>` RAF loop ([src/components/SkyMapCanvas.jsx](src/components/SkyMapCanvas.jsx)) — not the older Plotly `scattergeo` ([SkyPlot.jsx](src/components/SkyPlot.jsx), now unused). Projection is precomputed per resize (behind a dirty flag), so the per-frame cost is ~one canvas arc-fill per point; **canvas fill throughput is the ceiling**, not SVG node count. Each class contributes `min(class_size, max(SKY_FLOOR, proportional_share))`. Floor (default 100) ensures rare classes are visible; proportional share keeps common classes from dominating; min cap handles classes smaller than the floor. Total may slightly exceed budget when many small classes exist — acceptable.

Helper `sampleSkyPointsByClass()` is exported from [src/data/HFDiskDataSource.js](src/data/HFDiskDataSource.js). The Python script [scripts/build_summary.py](scripts/build_summary.py) implements the same algorithm so summaries built locally match what the JS source would produce.

## Lightcurve / band registry

Each row's `lightcurve` field is a struct of bands → `{mjd, mag, mag_unc, ...}`. Band keys are arbitrary strings (e.g. `g_ZTF`, `clear_CSS`). [src/bands.js](src/bands.js) maps known keys to display label, color, and survey grouping. Unknown bands fall back to `key` as label and a fallback palette color. To add a band, edit `SURVEY_LIBRARY` in that file.

The HF `/rows` endpoint returns nested struct/list data already in the schema-native shape; the only transformation is `normalizeRow` (see *Dataset formats* above), which is a no-op for current-format datasets.

## Build / deploy

- `npm run build` — base path `/`, suitable for self-host or custom-domain deploy.
- `npm run build:gh` — base path `/<package_name>/` for github.io subpath. Note: `npm_package_name` from `package.json` is `timeseries-explorer`, but the GH Actions workflow overrides this with the actual repo name via `BASE_PATH=/${{ github.event.repository.name }}/`.
- [.github/workflows/deploy.yml](.github/workflows/deploy.yml) — auto-deploys to GitHub Pages on push to `main`.

## Style

- No comments unless the *why* is non-obvious. Don't describe what the code does.
- No new files unless necessary. Prefer extending existing modules.
- Inline styles only. The `GLASS` and `KICKER` design tokens at the top of [App.jsx](src/App.jsx) capture the recurring visual treatments.

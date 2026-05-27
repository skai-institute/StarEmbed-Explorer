import { DataSource, detectFormat, normalizeRow } from "./DataSource.js";
import { sampleSkyPointsByClass } from "./HFDiskDataSource.js";

/**
 * Reads from the HuggingFace Datasets Server API.
 * https://huggingface.co/docs/dataset-viewer
 *
 * Public datasets work without auth. Private datasets would need an API token,
 * which is NOT safe to ship in a static GitHub Pages build — keep the dataset
 * public, or switch to a different deployment that can hold a secret.
 *
 * Note: the /rows endpoint caps `length` at 100 per request. For more rows we
 * paginate.
 *
 * Multi-split: `split` may be a single name ("train"), an array of names, or
 * "*" (every split in the config). When more than one split is in play the
 * source presents them as one contiguous dataset — getRows maps a global offset
 * to the split that owns it, and getSummary merges the per-split summary files,
 * shifting each split's classIndices by its global base offset. Single-split
 * behaviour is unchanged.
 */
const BASE = "https://datasets-server.huggingface.co";
const ROWS_PER_REQUEST = 100;
const MAX_RETRIES = 3; // attempts after the first, for transient 429/5xx
const RETRY_BASE_MS = 500; // exponential backoff base
const RETRY_MAX_MS = 8000; // cap any single wait (incl. a large Retry-After)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse a Retry-After header (delta-seconds or HTTP-date) into ms, or null.
function retryAfterMs(res) {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  if (/^\d+$/.test(h.trim())) return Number(h) * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

export class HFDataSource extends DataSource {
  constructor({ dataset, config = "default", split = "train" }) {
    super();
    if (!dataset) {
      throw new Error(
        "HFDataSource requires a `dataset` (e.g. 'username/name').",
      );
    }
    this.dataset = dataset;
    this.config = config;
    this.split = split; // "name" | ["a","b"] | "*" — resolved in getInfo
    this._infoCache = null;
    this._format = null;
    this._summaryCache = undefined; // distinct from null: caches the "no summary" answer too
    this._splits = null; // resolved split names, in global-offset order
    this._splitEnds = null; // cumulative row counts → global offset boundaries
    this._numRows = null; // total rows across all resolved splits
  }

  _qs(params) {
    return new URLSearchParams(params).toString();
  }

  // fetch that rides through transient rate-limit (429) and server (5xx)
  // responses with exponential backoff, honoring Retry-After when present.
  // Network errors (fetch rejecting) are retried too. Returns the final
  // Response for the caller to interpret (.ok / .status) — it never throws on
  // an HTTP status, so a single rate-limited request no longer aborts a load.
  async _fetchRetry(url) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url);
      } catch (e) {
        if (attempt >= MAX_RETRIES) throw e;
        await sleep(Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS));
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const wait = retryAfterMs(res) ?? RETRY_BASE_MS * 2 ** attempt;
        await sleep(Math.min(wait, RETRY_MAX_MS));
        continue;
      }
      return res;
    }
  }

  async getInfo() {
    if (this._infoCache) return this._infoCache;

    const url = `${BASE}/info?${this._qs({ dataset: this.dataset })}`;
    const res = await this._fetchRetry(url);
    if (!res.ok) {
      throw new Error(`HF info request failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const cfg = data?.dataset_info?.[this.config];
    const columns = cfg?.features ? Object.keys(cfg.features) : [];
    this._format = detectFormat(columns);

    const available = cfg?.splits ? Object.keys(cfg.splits) : [];
    let splits;
    if (Array.isArray(this.split)) {
      splits = this.split.filter((s) => available.includes(s));
    } else if (this.split === "*") {
      splits = available;
    } else {
      splits = [this.split];
    }
    if (splits.length === 0) splits = [this.split].flat();
    this._splits = splits;

    const counts = splits.map((s) => cfg?.splits?.[s]?.num_examples ?? 0);
    // A lone split keeps an open-ended boundary so a caller can request any
    // offset without us knowing num_examples up front (matches old behaviour).
    let acc = 0;
    this._splitEnds =
      splits.length === 1 ? [Infinity] : counts.map((n) => (acc += n));
    this._numRows =
      splits.length === 1
        ? cfg?.splits?.[splits[0]]?.num_examples
        : counts.reduce((a, b) => a + b, 0);

    this._infoCache = {
      source: "hf",
      dataset: this.dataset,
      config: this.config,
      split: splits.length === 1 ? splits[0] : splits,
      splits,
      numRows: this._numRows,
      columns,
      raw: data,
    };
    return this._infoCache;
  }

  // Global offset → index of the split that owns it (-1 past the end).
  _splitForOffset(offset) {
    return this._splitEnds.findIndex((end) => end > offset);
  }

  async getRows({ offset = 0, length = ROWS_PER_REQUEST } = {}) {
    await this.getInfo(); // resolves this._splits / this._splitEnds
    const collected = [];
    let remaining = length;
    let cursor = offset; // global offset across the concatenated splits

    while (remaining > 0) {
      const si = this._splitForOffset(cursor);
      if (si === -1) break; // past the end of the last split
      const base = si === 0 ? 0 : this._splitEnds[si - 1];
      const room = this._splitEnds[si] - cursor; // rows left in this split
      const take = Math.min(remaining, room, ROWS_PER_REQUEST);
      const url = `${BASE}/rows?${this._qs({
        dataset: this.dataset,
        config: this.config,
        split: this._splits[si],
        offset: String(cursor - base),
        length: String(take),
      })}`;
      const res = await this._fetchRetry(url);
      if (!res.ok) {
        throw new Error(`HF rows request failed: ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      const rows = (data?.rows || []).map((r) => normalizeRow(r.row));
      if (rows.length === 0) break;
      collected.push(...rows);
      cursor += rows.length;
      remaining -= rows.length;
      if (rows.length < take) break; // short read → end of this split's data
    }

    return collected;
  }

  // Uses the datasets-server /filter endpoint so the lookup happens server-side
  // at full int64 precision (gaia_dr3_source_id is 19 digits; JS Number rounds).
  // Datasets store the id as either int64 or string; DuckDB's WHERE is type-
  // strict, so we try the quoted-string form first then the bare-int form.
  async findBySourceId(id) {
    const numeric = String(id).trim();
    if (!/^\d+$/.test(numeric)) {
      throw new Error("Source ID must be numeric");
    }
    await this.getInfo(); // resolves this._format and this._splits
    const idKey = this._format.idKey;
    let lastErr = null;
    for (const split of this._splits) {
      for (const literal of [`'${numeric}'`, numeric]) {
        const url = `${BASE}/filter?${this._qs({
          dataset: this.dataset,
          config: this.config,
          split,
          where: `${idKey}=${literal}`,
          length: "1",
        })}`;
        const res = await this._fetchRetry(url);
        if (!res.ok) {
          lastErr = `Search failed: ${res.status} ${res.statusText}`;
          continue;
        }
        const data = await res.json();
        const rows = (data?.rows || []).map((r) => normalizeRow(r.row));
        if (rows[0]) return rows[0];
        lastErr = null;
      }
    }
    if (lastErr) throw new Error(lastErr);
    return null;
  }

  // Fetches a single summary file. Returns the parsed summary, undefined if the
  // file is absent (404, so the caller can try a fallback), or null if present
  // but unusable (unsupported version).
  async _fetchSummary(url) {
    const res = await this._fetchRetry(url);
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new Error(`summary fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    if (data.version !== 1) {
      console.warn("HF summary: unsupported version", data.version);
      return null;
    }
    return data;
  }

  // Fetches a pre-computed summary from the dataset repo. Build/upload via
  // scripts/build_summary.py. Each split carries one file (summary.<split>.json)
  // because classIndices holds split-local row offsets. For a single split we
  // serve it directly (falling back to a plain summary.json so older
  // single-file datasets keep working). For multiple splits we merge them into
  // one unified summary (see _mergeSummaries). Returns null gracefully if absent
  // so the app degrades to global random sampling without sky map or class
  // filter.
  async getSummary() {
    if (this._summaryCache !== undefined) return this._summaryCache;
    await this.getInfo(); // resolves this._splits / this._splitEnds
    const base = `https://huggingface.co/datasets/${this.dataset}/resolve/main`;
    try {
      let data;
      if (this._splits.length === 1) {
        data = await this._fetchSummary(`${base}/summary.${this._splits[0]}.json`);
        if (data === undefined) {
          data = await this._fetchSummary(`${base}/summary.json`);
        }
      } else {
        data = await this._mergeSummaries(base);
      }
      this._summaryCache = data ?? null;
      return this._summaryCache;
    } catch (e) {
      console.warn("HF summary unavailable:", e.message);
      this._summaryCache = null;
      return null;
    }
  }

  // Merges the per-split summary files into a single view. Each split's
  // classIndices are shifted by its global base offset (the cumulative row
  // count of the splits before it) so they index into the same concatenated
  // space getRows walks. A split whose summary is missing or unreadable is
  // skipped — its rows stay reachable through global random sampling, they just
  // won't appear on the sky map or in the class counts. Returns null only if no
  // split yielded a usable summary.
  async _mergeSummaries(base) {
    const perSplit = await Promise.all(
      this._splits.map((sp) =>
        this._fetchSummary(`${base}/summary.${sp}.json`).catch(() => undefined),
      ),
    );

    const classCounts = {};
    const classIndices = {};
    const bands = new Set();
    let skyByClass = new Map();
    let any = false;

    this._splits.forEach((sp, i) => {
      const s = perSplit[i];
      if (!s) return;
      any = true;
      const splitBase = i === 0 ? 0 : this._splitEnds[i - 1];
      for (const b of s.bands ?? []) bands.add(b);
      for (const [cls, n] of Object.entries(s.classCounts ?? {})) {
        classCounts[cls] = (classCounts[cls] ?? 0) + n;
      }
      for (const [cls, idxs] of Object.entries(s.classIndices ?? {})) {
        const shifted = idxs.map((o) => o + splitBase);
        classIndices[cls] = (classIndices[cls] ?? []).concat(shifted);
      }
      for (const p of s.skyPoints ?? []) {
        if (!skyByClass.has(p.cls)) skyByClass.set(p.cls, []);
        skyByClass.get(p.cls).push({ ra: p.ra, dec: p.dec });
      }
    });

    if (!any) return null;

    // Sort by count descending to match the single-split convention.
    const sortedClasses = Object.keys(classCounts).sort(
      (a, b) => classCounts[b] - classCounts[a],
    );
    const sortedCounts = {};
    const sortedIndices = {};
    for (const c of sortedClasses) {
      sortedCounts[c] = classCounts[c];
      sortedIndices[c] = classIndices[c] ?? [];
    }

    return {
      version: 1,
      totalRows: this._numRows,
      classCounts: sortedCounts,
      classIndices: sortedIndices,
      bands: [...bands],
      // Concatenating per-split sky samples can exceed the render budget, so
      // re-sample class-balanced over the merged points (approximate — the
      // inputs are already per-split samples — but fine for the sky map).
      skyPoints: sampleSkyPointsByClass(skyByClass),
    };
  }
}

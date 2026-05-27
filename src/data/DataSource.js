/**
 * Abstract interface for a time-series dataset source.
 *
 * Concrete implementations:
 *   - HFDataSource:     hits the HuggingFace Datasets Server API
 *   - HFDiskDataSource: reads Arrow IPC shards from the user's filesystem
 *
 * As we learn more about the dataset schema, we can grow this interface
 * (e.g., getSeries(id), search(query), getColumn(name)). For now it stays
 * minimal: enough to confirm the pipeline works.
 */
export class DataSource {
  /**
   * @returns {Promise<{
   *   source: "hf" | "hf-disk",
   *   numRows?: number,
   *   columns?: string[],
   *   [key: string]: any
   * }>}
   */
  async getInfo() {
    throw new Error("DataSource.getInfo not implemented");
  }

  /**
   * @param {{ offset?: number, length?: number }} opts
   * @returns {Promise<object[]>} array of row objects
   */
  // eslint-disable-next-line no-unused-vars
  async getRows(opts = {}) {
    throw new Error("DataSource.getRows not implemented");
  }

  /**
   * @returns {Promise<{
   *   totalRows: number,
   *   classCounts: Record<string, number>,  // sorted descending
   *   bands: string[],
   * } | null>}  null if the source can't produce a summary cheaply
   */
  async getSummary() {
    return null;
  }

  /**
   * Find a row by its gaia_dr3_source_id. Returns the row object or null.
   * @param {string|number|bigint} id
   * @returns {Promise<object|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async findBySourceId(id) {
    throw new Error("DataSource.findBySourceId not implemented");
  }
}

/**
 * Dataset schema formats. The rest of the app reads the "current" (canonical)
 * field names; `normalizeRow` rewrites legacy rows into that shape so no
 * rendering component needs to know about the legacy layout.
 *
 * Legacy is the GluonTS-style forecasting schema (e.g. StarEmbed/ZTF_40k):
 * a `bands_data` struct whose per-band fields are `target` (mag),
 * `past_feat_dynamic_real` (mag error), and `mjd`. Its bands are bare ZTF
 * filters (`g`/`r`/`i`) — remapped to the canonical `*_ZTF` keys here, which
 * is safe precisely because the remap is gated on the legacy format and never
 * runs for modern datasets.
 */
export const ROW_FORMATS = {
  current: {
    name: "current",
    lightcurveKey: "lightcurve",
    idKey: "gaia_dr3_source_id",
    raKey: "gaia_dr3_ra",
    decKey: "gaia_dr3_dec",
    classKey: "class_str",
  },
  legacy: {
    name: "legacy",
    lightcurveKey: "bands_data",
    idKey: "sourceid",
    raKey: "ra",
    decKey: "dec",
    classKey: "class_str",
    band: { mjd: "mjd", mag: "target", mag_unc: "past_feat_dynamic_real" },
    bandKeyMap: { g: "g_ZTF", r: "r_ZTF", i: "i_ZTF" },
  },
};

// A dataset is legacy when it carries `bands_data` and no canonical `lightcurve`.
export function detectFormat(columns = []) {
  return columns.includes("bands_data") && !columns.includes("lightcurve")
    ? ROW_FORMATS.legacy
    : ROW_FORMATS.current;
}

// Rewrite a legacy row into the canonical shape. No-op for canonical rows.
export function normalizeRow(row) {
  if (!row || !row.bands_data || row.lightcurve) return row;
  const fmt = ROW_FORMATS.legacy;

  const lightcurve = {};
  for (const [band, bd] of Object.entries(row.bands_data)) {
    if (!bd || !bd[fmt.band.mjd]?.length) continue;
    const key = fmt.bandKeyMap[band] ?? band;
    lightcurve[key] = {
      mjd: bd[fmt.band.mjd],
      mag: bd[fmt.band.mag],
      mag_unc: bd[fmt.band.mag_unc],
    };
  }

  const { bands_data, ra, dec, ...rest } = row;
  const out = { ...rest, lightcurve };
  if (ra != null && out.gaia_dr3_ra == null) out.gaia_dr3_ra = ra;
  if (dec != null && out.gaia_dr3_dec == null) out.gaia_dr3_dec = dec;
  return out;
}

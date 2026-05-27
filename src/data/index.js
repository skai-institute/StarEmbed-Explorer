import { HFDataSource } from "./HFDataSource.js";
import { HFDiskDataSource } from "./HFDiskDataSource.js";

export function createDataSource(descriptor) {
  if (descriptor.source === "hf") {
    return new HFDataSource({
      dataset: descriptor.dataset,
      config: descriptor.config ?? "default",
      split: descriptor.split ?? "train",
    });
  }
  if (descriptor.source === "hf-disk") {
    return new HFDiskDataSource(descriptor.files);
  }
  throw new Error(`Unknown data source: ${descriptor.source}`);
}

export { DataSource, detectFormat, normalizeRow, ROW_FORMATS } from "./DataSource.js";
export { HFDataSource, HFDiskDataSource };

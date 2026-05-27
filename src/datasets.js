/**
 * Datasets shown by default in the welcome modal and header dropdown.
 *
 * Entry shape:
 *   { id, label, source: "hf", dataset, config?, split? }
 *   dataset is "username/repo-name" on the HF Hub
 *   split may be a name ("train"), an array of names, or "*" for every split
 *   in the config (merged into one contiguous dataset).
 *
 * Users can also load arbitrary HF datasets by typing user/name in the
 * welcome modal, or load a local Arrow shard directory when self-hosting.
 */
export const DATASETS = [
  {
    id: "ztf-40k",
    label: "ZTF 40k",
    source: "hf",
    dataset: "StarEmbed/ZTF_40k",
    config: "default",
    split: "*",
  },
];

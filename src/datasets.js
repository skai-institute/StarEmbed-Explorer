/**
 * Datasets shown by default in the welcome modal and header dropdown.
 *
 * Entry shape:
 *   { id, label, source: "hf", dataset, config?, split? }
 *   dataset is "username/repo-name" on the HF Hub
 *
 * Users can also load arbitrary HF datasets by typing user/name in the
 * welcome modal, or load a local Arrow shard directory when self-hosting.
 */
export const DATASETS = [
  {
    id: "se-test-hf",
    label: "SE test",
    source: "hf",
    dataset: "nabeelr/SE_test",
    config: "default",
    split: "train",
  },
];

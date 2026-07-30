import type { RetrievalMode } from "./types";

export const DEFAULT_RETRIEVAL_MODE: RetrievalMode = "keyword";

export const SUPPORTED_RETRIEVAL_MODES: RetrievalMode[] = [
  "keyword",
  "bm25",
];

export function resolveRetrievalMode(value: unknown): RetrievalMode {
  if (value === undefined) {
    return DEFAULT_RETRIEVAL_MODE;
  }

  if (
    typeof value === "string" &&
    SUPPORTED_RETRIEVAL_MODES.includes(value as RetrievalMode)
  ) {
    return value as RetrievalMode;
  }

  throw new Error(
    `Unsupported retrieval_mode. Expected one of: ${SUPPORTED_RETRIEVAL_MODES.join(", ")}.`,
  );
}

export const TOKENIZER_VERSION = "unicode-word-v1";

/**
 * Deterministic tokenizer used during both indexing and retrieval.
 *
 * Steps:
 * 1. Normalize Unicode using NFKC.
 * 2. Convert text to lowercase.
 * 3. Extract sequences containing Unicode letters or numbers.
 *
 * Do not modify this tokenizer between index creation and retrieval.
 */
export function tokenize(text: string): string[] {
  const normalizedText = text.normalize("NFKC").toLowerCase();

  return normalizedText.match(/[\p{L}\p{N}]+/gu) ?? [];
}

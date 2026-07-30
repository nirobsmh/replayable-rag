import { createHash } from "node:crypto";

import type {
  DocumentChunk,
  IndexedChunk,
  IndexMetadata,
  RetrievalIndex,
} from "./types";
import { TOKENIZER_VERSION, tokenize } from "./tokenizer";

const INDEX_VERSION = "1.0";

const BM25_PARAMETERS = {
  k1: 1.2,
  b: 0.75,
} as const;

function createSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Creates a normal object whose keys are inserted alphabetically.
 *
 * JSON object key order should not be relied upon semantically, but sorting
 * makes the generated artifact easy to compare between repeated runs.
 */
function sortNumericRecord(
  record: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([firstTerm], [secondTerm]) =>
      firstTerm.localeCompare(secondTerm),
    ),
  );
}

function sortChunks(chunks: DocumentChunk[]): DocumentChunk[] {
  return [...chunks].sort((firstChunk, secondChunk) => {
    const documentComparison = firstChunk.document_name.localeCompare(
      secondChunk.document_name,
    );

    if (documentComparison !== 0) {
      return documentComparison;
    }

    if (firstChunk.start_char !== secondChunk.start_char) {
      return firstChunk.start_char - secondChunk.start_char;
    }

    return firstChunk.chunk_id.localeCompare(secondChunk.chunk_id);
  });
}

function validateChunk(
  value: unknown,
  index: number,
): asserts value is DocumentChunk {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Chunk at index ${index} must be an object.`);
  }

  const chunk = value as Partial<DocumentChunk>;

  if (typeof chunk.chunk_id !== "string" || chunk.chunk_id.length === 0) {
    throw new Error(`Chunk at index ${index} has an invalid chunk_id.`);
  }

  if (
    typeof chunk.document_name !== "string" ||
    chunk.document_name.length === 0
  ) {
    throw new Error(`Chunk ${chunk.chunk_id} has an invalid document_name.`);
  }

  if (!Number.isInteger(chunk.start_char) || (chunk.start_char ?? -1) < 0) {
    throw new Error(`Chunk ${chunk.chunk_id} has an invalid start_char.`);
  }

  if (!Number.isInteger(chunk.end_char) || (chunk.end_char ?? -1) < 0) {
    throw new Error(`Chunk ${chunk.chunk_id} has an invalid end_char.`);
  }

  if ((chunk.end_char as number) < (chunk.start_char as number)) {
    throw new Error(`Chunk ${chunk.chunk_id} has end_char before start_char.`);
  }

  if (typeof chunk.text !== "string") {
    throw new Error(`Chunk ${chunk.chunk_id} has invalid text.`);
  }
}

function validateChunks(values: unknown): asserts values is DocumentChunk[] {
  if (!Array.isArray(values)) {
    throw new Error("chunks.json must contain a JSON array.");
  }

  if (values.length === 0) {
    throw new Error("chunks.json does not contain any chunks.");
  }

  const chunkIds = new Set<string>();

  values.forEach((value, index) => {
    validateChunk(value, index);

    if (chunkIds.has(value.chunk_id)) {
      throw new Error(`Duplicate chunk_id found: ${value.chunk_id}`);
    }

    chunkIds.add(value.chunk_id);
  });
}

function countTerms(tokens: string[]): Record<string, number> {
  const termFrequencies: Record<string, number> = {};

  for (const token of tokens) {
    termFrequencies[token] = (termFrequencies[token] ?? 0) + 1;
  }

  return sortNumericRecord(termFrequencies);
}

export function buildRetrievalIndex(input: unknown): {
  index: RetrievalIndex;
  metadata: IndexMetadata;
} {
  validateChunks(input);

  const chunks = sortChunks(input);

  const indexedChunks: IndexedChunk[] = [];
  const documentFrequencies: Record<string, number> = {};

  let totalTokenCount = 0;

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    const termFrequencies = countTerms(tokens);

    totalTokenCount += tokens.length;

    for (const term of Object.keys(termFrequencies)) {
      documentFrequencies[term] = (documentFrequencies[term] ?? 0) + 1;
    }

    indexedChunks.push({
      chunk_id: chunk.chunk_id,
      document_name: chunk.document_name,
      token_count: tokens.length,
      term_frequencies: termFrequencies,
    });
  }

  const averageChunkLength = Number(
    (totalTokenCount / indexedChunks.length).toFixed(6),
  );

  const sortedDocumentFrequencies = sortNumericRecord(documentFrequencies);

  const retrievalIndex: RetrievalIndex = {
    version: INDEX_VERSION,
    algorithm: "bm25",
    parameters: {
      k1: BM25_PARAMETERS.k1,
      b: BM25_PARAMETERS.b,
    },
    tokenizer: {
      version: TOKENIZER_VERSION,
      normalization: "Unicode NFKC followed by lowercase",
      token_pattern: "[Unicode letters or numbers]+",
    },
    corpus: {
      chunk_count: indexedChunks.length,
      total_token_count: totalTokenCount,
      average_chunk_length: averageChunkLength,
    },
    document_frequencies: sortedDocumentFrequencies,
    chunks: indexedChunks,
  };

  /*
   * Compact JSON is used for hashing. Because chunks and object keys were
   * sorted, the same input produces the same hash.
   */
  const sourceChunksJson = JSON.stringify(chunks);
  const indexJson = JSON.stringify(retrievalIndex);

  const sourceChunksHash = createSha256(sourceChunksJson);
  const indexHash = createSha256(indexJson);

  const metadata: IndexMetadata = {
    index_id: `index_${indexHash.slice(0, 16)}`,
    version: INDEX_VERSION,
    algorithm: "bm25",
    source_file: "chunks.json",
    source_chunks_sha256: sourceChunksHash,
    index_sha256: indexHash,
    chunk_count: indexedChunks.length,
    unique_term_count: Object.keys(sortedDocumentFrequencies).length,
    total_token_count: totalTokenCount,
    average_chunk_length: averageChunkLength,
    tokenizer_version: TOKENIZER_VERSION,
    parameters: {
      k1: BM25_PARAMETERS.k1,
      b: BM25_PARAMETERS.b,
    },
  };

  return {
    index: retrievalIndex,
    metadata,
  };
}

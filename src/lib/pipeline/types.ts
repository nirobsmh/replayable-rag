export type DocumentChunk = {
  chunk_id: string;
  document_name: string;
  start_char: number;
  end_char: number;
  text: string;
};

export type ChunkingOptions = {
  chunkSize: number;
  chunkOverlap: number;
};

export type IndexedChunk = {
  chunk_id: string;
  document_name: string;
  token_count: number;
  term_frequencies: Record<string, number>;
};

export type RetrievalIndex = {
  version: string;
  algorithm: "bm25";
  parameters: {
    k1: number;
    b: number;
  };
  tokenizer: {
    version: string;
    normalization: string;
    token_pattern: string;
  };
  corpus: {
    chunk_count: number;
    total_token_count: number;
    average_chunk_length: number;
  };
  document_frequencies: Record<string, number>;
  chunks: IndexedChunk[];
};

export type IndexMetadata = {
  index_id: string;
  version: string;
  algorithm: "bm25";
  source_file: string;
  source_chunks_sha256: string;
  index_sha256: string;
  chunk_count: number;
  unique_term_count: number;
  total_token_count: number;
  average_chunk_length: number;
  tokenizer_version: string;
  parameters: {
    k1: number;
    b: number;
  };
};

export type QueryInput = {
  query_id: string;
  question: string;
};

export type Policy = {
  top_k: number;
};

export type RetrievedChunk = {
  chunk_id: string;
  document_name: string;
  rank: number;
  retrieval_score: number;
};

export type QueryRetrievalResult = {
  query_id: string;
  question: string;
  retrieved_chunks: RetrievedChunk[];
};

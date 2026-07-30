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

export type RetrievalMode = "keyword" | "bm25";

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
  retrieval_mode?: RetrievalMode;
  retrieval_modes_supported?: RetrievalMode[];
  source_file: string;
  source_chunks_sha256: string;
  index_sha256: string;
  chunk_count: number;
  unique_term_count: number;
  total_token_count: number;
  average_chunk_length: number;
  top_k?: number;
  tokenizer_version: string;
  parameters: {
    k1: number;
    b: number;
  };
};

export type QueryInput = {
  query_id: string;
  question: string;
  expected_evidence_chunk_ids?: string[];
};

export type Policy = {
  top_k: number;
  retrieval_mode?: RetrievalMode;
  answer_policy?: string;
  allowed_labels?: string[];
  citation_required?: boolean;
  forbidden_behaviours?: string[];
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

export type RetrievalMetricEntry = {
  query_id: string;
  expected_evidence_chunk_ids: string[];
  retrieved_chunk_ids: string[];
  matched_chunk_ids: string[];
  hit_at_k: boolean;
  recall_at_k: number;
};

export type RetrievalMetricsArtifact =
  | {
      status: "skipped";
      retrieval_mode: RetrievalMode;
      top_k: number;
      reason: string;
    }
  | {
      status: "computed";
      retrieval_mode: RetrievalMode;
      top_k: number;
      annotated_query_count: number;
      hit_rate_at_k: number;
      average_recall_at_k: number;
      per_query: RetrievalMetricEntry[];
    };

export type RevisedAnswer = {
  query_id: string;
  answer: string;
  label: string;
  citations: string[];
  reasoning_summary: string;
  trigger_audit_label: "pass" | "fail";
  trigger_hallucination_risk: "low" | "medium" | "high";
};

export type RetrievalFailureType =
  | "ranking"
  | "chunking"
  | "ambiguity"
  | "corpus_gap";

export type RetrievalErrorAnalysisEntry = {
  query_id: string;
  failure_type: RetrievalFailureType;
  description: string;
};

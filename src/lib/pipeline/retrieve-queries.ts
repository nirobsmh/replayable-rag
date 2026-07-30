import MiniSearch from "minisearch";

import { tokenize } from "./tokenizer";
import type {
  DocumentChunk,
  QueryInput,
  QueryRetrievalResult,
  RetrievalIndex,
  RetrievalMetricEntry,
  RetrievalMetricsArtifact,
  RetrievalMode,
} from "./types";

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
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

function createFallbackResults(chunks: DocumentChunk[]) {
  return chunks.map((chunk) => ({
    chunk_id: chunk.chunk_id,
    document_name: chunk.document_name,
    score: 0,
  }));
}

function retrieveWithKeywordSearch(params: {
  chunks: DocumentChunk[];
  queries: QueryInput[];
  topK: number;
}): QueryRetrievalResult[] {
  const sortedChunks = sortChunks(params.chunks);
  const fallbackResults = createFallbackResults(sortedChunks);

  const search = new MiniSearch<DocumentChunk>({
    idField: "chunk_id",
    fields: ["text"],
    storeFields: ["chunk_id", "document_name"],
  });

  search.addAll(sortedChunks);

  return params.queries.map((query) => {
    let matches = search
      .search(query.question, {
        prefix: true,
      })
      .map((match) => ({
        chunk_id: String(match.chunk_id),
        document_name: String(match.document_name),
        score: Number(match.score),
      }));

    if (matches.length === 0) {
      matches = fallbackResults;
    } else {
      matches.sort(
        (firstMatch, secondMatch) =>
          secondMatch.score - firstMatch.score ||
          firstMatch.chunk_id.localeCompare(secondMatch.chunk_id),
      );
    }

    const topMatches = matches.slice(0, Math.min(params.topK, sortedChunks.length));

    return {
      query_id: query.query_id,
      question: query.question,
      retrieved_chunks: topMatches.map((match, index) => ({
        chunk_id: match.chunk_id,
        document_name: match.document_name,
        rank: index + 1,
        retrieval_score: roundMetric(match.score),
      })),
    };
  });
}

function retrieveWithBm25(params: {
  index: RetrievalIndex;
  queries: QueryInput[];
  topK: number;
}): QueryRetrievalResult[] {
  const { index, queries, topK } = params;
  const sortedChunks = [...index.chunks].sort((firstChunk, secondChunk) =>
    firstChunk.chunk_id.localeCompare(secondChunk.chunk_id),
  );
  const fallbackResults = sortedChunks.map((chunk) => ({
    chunk_id: chunk.chunk_id,
    document_name: chunk.document_name,
    score: 0,
  }));
  const averageChunkLength =
    index.corpus.average_chunk_length > 0
      ? index.corpus.average_chunk_length
      : 1;

  return queries.map((query) => {
    const queryTerms = [...new Set(tokenize(query.question))];

    const scoredChunks = sortedChunks
      .map((chunk) => {
        let score = 0;

        for (const term of queryTerms) {
          const termFrequency = chunk.term_frequencies[term];

          if (!termFrequency) {
            continue;
          }

          const documentFrequency = index.document_frequencies[term] ?? 0;
          const idf = Math.log(
            1 +
              (index.corpus.chunk_count - documentFrequency + 0.5) /
                (documentFrequency + 0.5),
          );
          const normalization =
            index.parameters.k1 *
            (1 -
              index.parameters.b +
              index.parameters.b * (chunk.token_count / averageChunkLength));

          score +=
            idf *
            ((termFrequency * (index.parameters.k1 + 1)) /
              (termFrequency + normalization));
        }

        return {
          chunk_id: chunk.chunk_id,
          document_name: chunk.document_name,
          score,
        };
      })
      .filter((chunk) => chunk.score > 0);

    const rankedChunks =
      scoredChunks.length > 0
        ? scoredChunks.sort(
            (firstChunk, secondChunk) =>
              secondChunk.score - firstChunk.score ||
              firstChunk.chunk_id.localeCompare(secondChunk.chunk_id),
          )
        : fallbackResults;

    return {
      query_id: query.query_id,
      question: query.question,
      retrieved_chunks: rankedChunks
        .slice(0, Math.min(topK, sortedChunks.length))
        .map((chunk, index) => ({
          chunk_id: chunk.chunk_id,
          document_name: chunk.document_name,
          rank: index + 1,
          retrieval_score: roundMetric(chunk.score),
        })),
    };
  });
}

export function retrieveQueries(params: {
  chunks: DocumentChunk[];
  queries: QueryInput[];
  topK: number;
  retrievalMode: RetrievalMode;
  index?: RetrievalIndex;
}): QueryRetrievalResult[] {
  if (params.retrievalMode === "keyword") {
    return retrieveWithKeywordSearch({
      chunks: params.chunks,
      queries: params.queries,
      topK: params.topK,
    });
  }

  if (!params.index) {
    throw new Error("BM25 retrieval requires index.json.");
  }

  return retrieveWithBm25({
    index: params.index,
    queries: params.queries,
    topK: params.topK,
  });
}

export function computeRetrievalMetrics(params: {
  queries: QueryInput[];
  retrievals: QueryRetrievalResult[];
  topK: number;
  retrievalMode: RetrievalMode;
}): RetrievalMetricsArtifact {
  const annotatedQueries = params.queries.filter(
    (query) =>
      Array.isArray(query.expected_evidence_chunk_ids) &&
      query.expected_evidence_chunk_ids.length > 0,
  );

  if (annotatedQueries.length === 0) {
    return {
      status: "skipped",
      retrieval_mode: params.retrievalMode,
      top_k: params.topK,
      reason: "No expected_evidence_chunk_ids annotations were provided in queries.json.",
    };
  }

  const retrievalByQuery = new Map(
    params.retrievals.map((retrieval) => [retrieval.query_id, retrieval]),
  );

  const perQuery: RetrievalMetricEntry[] = annotatedQueries.map((query) => {
    const retrieval = retrievalByQuery.get(query.query_id);

    if (!retrieval) {
      throw new Error(`Missing retrieval result for annotated query ${query.query_id}.`);
    }

    const expectedEvidenceChunkIds = [...new Set(query.expected_evidence_chunk_ids)];
    const retrievedChunkIds = retrieval.retrieved_chunks.map((chunk) => chunk.chunk_id);
    const retrievedChunkIdSet = new Set(retrievedChunkIds);
    const matchedChunkIds = expectedEvidenceChunkIds.filter((chunkId) =>
      retrievedChunkIdSet.has(chunkId),
    );

    return {
      query_id: query.query_id,
      expected_evidence_chunk_ids: expectedEvidenceChunkIds,
      retrieved_chunk_ids: retrievedChunkIds,
      matched_chunk_ids: matchedChunkIds,
      hit_at_k: matchedChunkIds.length > 0,
      recall_at_k: roundMetric(
        matchedChunkIds.length / expectedEvidenceChunkIds.length,
      ),
    };
  });

  const hitRateAtK =
    perQuery.filter((entry) => entry.hit_at_k).length / perQuery.length;
  const averageRecallAtK =
    perQuery.reduce((total, entry) => total + entry.recall_at_k, 0) /
    perQuery.length;

  return {
    status: "computed",
    retrieval_mode: params.retrievalMode,
    top_k: params.topK,
    annotated_query_count: perQuery.length,
    hit_rate_at_k: roundMetric(hitRateAtK),
    average_recall_at_k: roundMetric(averageRecallAtK),
    per_query: perQuery,
  };
}

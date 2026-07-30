import fs from "node:fs/promises";

import { tokenize } from "../src/lib/pipeline/tokenizer";
import type {
  DocumentChunk,
  QueryInput,
  QueryRetrievalResult,
  RetrievalErrorAnalysisEntry,
  RetrievalMetricsArtifact,
} from "../src/lib/pipeline/types";

type DraftAnswer = {
  query_id: string;
  label: string;
};

type ReviewResult = {
  query_id: string;
  overridden: boolean;
  original_chunk_ids: string[];
  final_chunk_ids: string[];
};

type AnswerAudit = {
  query_id: string;
  audit_label: "pass" | "fail";
  hallucination_risk: "low" | "medium" | "high";
};

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

async function readJson<T>(fileName: string): Promise<T> {
  const content = await fs.readFile(fileName, "utf8");

  return JSON.parse(content) as T;
}

function countTokenOverlap(question: string, chunk: DocumentChunk): number {
  const queryTokens = new Set(tokenize(question));
  const chunkTokens = new Set(tokenize(chunk.text));

  let overlap = 0;

  for (const token of queryTokens) {
    if (chunkTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function hasTightScoreCluster(retrieval: QueryRetrievalResult): boolean {
  if (retrieval.retrieved_chunks.length < 2) {
    return false;
  }

  const [firstChunk, secondChunk] = retrieval.retrieved_chunks;

  if (firstChunk.retrieval_score <= 0) {
    return false;
  }

  return secondChunk.retrieval_score / firstChunk.retrieval_score >= 0.95;
}

function looksChunkBoundaryHeavy(chunks: DocumentChunk[]): boolean {
  return chunks.some((chunk) => /^[a-z0-9]/.test(chunk.text) || /[a-z0-9]$/.test(chunk.text));
}

async function main(): Promise<void> {
  const queries = await readJson<QueryInput[]>("queries.json");
  const chunks = await readJson<DocumentChunk[]>("chunks.json");
  const retrievals = await readJson<QueryRetrievalResult[]>("retrieval_results.json");
  const drafts = await readJson<DraftAnswer[]>("draft_answers.json");
  const reviews = await readJson<ReviewResult[]>("review_overrides.json");
  const audits = await readJson<AnswerAudit[]>("answer_audit.json");
  const metrics = await readJson<RetrievalMetricsArtifact>("retrieval_metrics.json");

  const queryById = new Map(queries.map((query) => [query.query_id, query]));
  const chunkById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const draftByQueryId = new Map(drafts.map((draft) => [draft.query_id, draft]));
  const reviewByQueryId = new Map(
    reviews.map((review) => [review.query_id, review]),
  );
  const auditByQueryId = new Map(audits.map((audit) => [audit.query_id, audit]));
  const metricByQueryId =
    metrics.status === "computed"
      ? new Map(metrics.per_query.map((entry) => [entry.query_id, entry]))
      : new Map();

  const analyses: RetrievalErrorAnalysisEntry[] = [];

  for (const retrieval of retrievals) {
    const query = queryById.get(retrieval.query_id);
    const draft = draftByQueryId.get(retrieval.query_id);
    const review = reviewByQueryId.get(retrieval.query_id);
    const audit = auditByQueryId.get(retrieval.query_id);

    if (!query || !draft || !review || !audit) {
      throw new Error(`Incomplete artifacts for ${retrieval.query_id}.`);
    }

    const metricEntry = metricByQueryId.get(retrieval.query_id);
    const retrievedChunkIds = new Set(
      retrieval.retrieved_chunks.map((chunk) => chunk.chunk_id),
    );
    const retrievedChunks = retrieval.retrieved_chunks.map((retrievedChunk) => {
      const chunk = chunkById.get(retrievedChunk.chunk_id);

      if (!chunk) {
        throw new Error(`Unknown retrieved chunk ID: ${retrievedChunk.chunk_id}`);
      }

      return chunk;
    });

    const bestRetrievedOverlap = Math.max(
      ...retrievedChunks.map((chunk) => countTokenOverlap(query.question, chunk)),
    );

    const bestMissedChunk = chunks
      .filter((chunk) => !retrievedChunkIds.has(chunk.chunk_id))
      .map((chunk) => ({
        chunk,
        overlap: countTokenOverlap(query.question, chunk),
      }))
      .sort(
        (firstChunk, secondChunk) =>
          secondChunk.overlap - firstChunk.overlap ||
          firstChunk.chunk.chunk_id.localeCompare(secondChunk.chunk.chunk_id),
      )[0];

    const needsAnalysis =
      (metricEntry !== undefined && !metricEntry.hit_at_k) ||
      audit.audit_label === "fail" ||
      audit.hallucination_risk !== "low" ||
      draft.label !== "supported";

    if (!needsAnalysis) {
      continue;
    }

    if (metricEntry && !metricEntry.hit_at_k) {
      analyses.push({
        query_id: retrieval.query_id,
        failure_type: "ranking",
        description:
          `Expected evidence ${metricEntry.expected_evidence_chunk_ids.join(", ")} ` +
          `was not retrieved in top-${metrics.top_k}; matched evidence count was ` +
          `${metricEntry.matched_chunk_ids.length}.`,
      });
      continue;
    }

    if (
      review.overridden &&
      review.original_chunk_ids.join(",") !== review.final_chunk_ids.join(",")
    ) {
      analyses.push({
        query_id: retrieval.query_id,
        failure_type: "ranking",
        description:
          `Human review replaced the original retrieval set ` +
          `(${review.original_chunk_ids.join(", ")}) with ` +
          `(${review.final_chunk_ids.join(", ")}), indicating ranking failure in the original top-k.`,
      });
      continue;
    }

    if (
      bestMissedChunk &&
      bestMissedChunk.overlap > bestRetrievedOverlap &&
      bestMissedChunk.overlap > 0
    ) {
      analyses.push({
        query_id: retrieval.query_id,
        failure_type: "ranking",
        description:
          `Top retrieved overlap was ${bestRetrievedOverlap}, but non-retrieved chunk ` +
          `${bestMissedChunk.chunk.chunk_id} had overlap ${bestMissedChunk.overlap} with the question.`,
      });
      continue;
    }

    if (hasTightScoreCluster(retrieval) && draft.label === "partially_supported") {
      analyses.push({
        query_id: retrieval.query_id,
        failure_type: "ambiguity",
        description:
          `Top retrieval scores were tightly clustered ` +
          `(${retrieval.retrieved_chunks
            .slice(0, 2)
            .map((chunk) => roundMetric(chunk.retrieval_score))
            .join(", ")}), and the answer remained only partially supported.`,
      });
      continue;
    }

    if (looksChunkBoundaryHeavy(retrievedChunks) && draft.label !== "supported") {
      analyses.push({
        query_id: retrieval.query_id,
        failure_type: "chunking",
        description:
          "Retrieved context relied on boundary-heavy chunks that begin or end mid-token, which suggests the evidence may have been split across chunk boundaries.",
      });
      continue;
    }

    analyses.push({
      query_id: retrieval.query_id,
      failure_type: "corpus_gap",
      description:
        `The retrieved and reviewed context did not yield a supported answer for ${retrieval.query_id}, and no stronger missed evidence was detected in the corpus.`,
    });
  }

  await fs.writeFile(
    "retrieval_error_analysis.json",
    `${JSON.stringify(analyses, null, 2)}\n`,
    "utf8",
  );

  console.log(`Saved ${analyses.length} retrieval error analyses.`);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? `Retrieval error analysis failed: ${error.message}`
      : "Retrieval error analysis failed.",
  );

  process.exitCode = 1;
});

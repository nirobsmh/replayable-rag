import fs from "node:fs/promises";

type Query = {
  query_id: string;
  question: string;
};

type Policy = {
  allowed_labels: string[];
};

type Chunk = {
  chunk_id: string;
};

type RetrievalResult = {
  query_id: string;
  retrieved_chunks: Array<{
    chunk_id: string;
  }>;
};

type DraftAnswer = {
  query_id: string;
  label: string;
  citations: string[];
};

type ReviewResult = {
  query_id: string;
  overridden: boolean;
  original_chunk_ids: string[];
  final_chunk_ids: string[];
};

type AuditResult = {
  query_id: string;
};

type LlmLog = {
  stage: string;
  query_id: string | null;
  timestamp?: string;
  provider?: string;
  model: string;
  prompt_hash?: string;
  input_artifacts?: string[];
  output_artifact?: string;
  response_id?: string;
  retrieved_chunk_ids?: string[];
  draft_citations?: string[];
  final_chunk_ids?: string[];
  context_overridden?: boolean;
};

const requiredFiles = [
  "documents",
  "queries.json",
  "policy.json",
  "chunks.json",
  "index_metadata.json",
  "retrieval_results.json",
  "draft_answers.json",
  "review_overrides.json",
  "answer_audit.json",
  "final_report.md",
  "llm_calls.jsonl",
];

async function assertExists(path: string): Promise<void> {
  try {
    await fs.access(path);
  } catch {
    throw new Error(`Missing required artifact: ${path}`);
  }
}

async function readJson<T>(path: string): Promise<T> {
  const text = await fs.readFile(path, "utf8");

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON: ${path}`);
  }
}

async function readJsonLines(path: string): Promise<LlmLog[]> {
  const text = await fs.readFile(path, "utf8");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as LlmLog;
    } catch {
      throw new Error(`Invalid JSONL record at ${path}:${index + 1}`);
    }
  });
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function validateLlmLog(log: LlmLog, index: number): void {
  const recordLabel = `LLM log record ${index + 1}`;
  const hasStructuredMetadata =
    log.timestamp !== undefined ||
    log.provider !== undefined ||
    log.prompt_hash !== undefined ||
    log.input_artifacts !== undefined ||
    log.output_artifact !== undefined;

  if (!log.stage || typeof log.stage !== "string") {
    throw new Error(`${recordLabel} is missing stage.`);
  }

  if (log.query_id !== null && typeof log.query_id !== "string") {
    throw new Error(`${recordLabel} has an invalid query_id.`);
  }

  if (!log.model || typeof log.model !== "string") {
    throw new Error(`${recordLabel} is missing model.`);
  }

  if (hasStructuredMetadata) {
    if (
      !log.timestamp ||
      !log.provider ||
      !log.prompt_hash ||
      !isStringArray(log.input_artifacts) ||
      !log.output_artifact
    ) {
      throw new Error(`${recordLabel} is missing required structured fields.`);
    }

    if (Number.isNaN(Date.parse(log.timestamp))) {
      throw new Error(`Invalid LLM timestamp: ${log.timestamp}`);
    }

    return;
  }

  if (!log.response_id || typeof log.response_id !== "string") {
    throw new Error(
      `${recordLabel} must include either structured metadata or a response_id.`,
    );
  }

  if (
    log.stage === "draft_answer_generation" &&
    !isStringArray(log.retrieved_chunk_ids)
  ) {
    throw new Error(
      `${recordLabel} is missing retrieved_chunk_ids for a legacy draft log.`,
    );
  }

  if (log.stage === "answer_audit" && !isStringArray(log.final_chunk_ids)) {
    throw new Error(
      `${recordLabel} is missing final_chunk_ids for a legacy audit log.`,
    );
  }
}

async function main(): Promise<void> {
  for (const file of requiredFiles) {
    await assertExists(file);
  }

  const queries = await readJson<Query[]>("queries.json");
  const policy = await readJson<Policy>("policy.json");
  const chunks = await readJson<Chunk[]>("chunks.json");
  const retrievals = await readJson<RetrievalResult[]>(
    "retrieval_results.json",
  );
  const drafts = await readJson<DraftAnswer[]>("draft_answers.json");
  const reviews = await readJson<ReviewResult[]>("review_overrides.json");
  const audits = await readJson<AuditResult[]>("answer_audit.json");
  const logs = await readJsonLines("llm_calls.jsonl");
  const report = await fs.readFile("final_report.md", "utf8");

  if (
    !Array.isArray(policy.allowed_labels) ||
    policy.allowed_labels.some((label) => typeof label !== "string")
  ) {
    throw new Error(
      "policy.json must define allowed_labels as a string array.",
    );
  }

  logs.forEach((log, index) => {
    validateLlmLog(log, index);
  });

  const chunkIds = new Set(chunks.map((chunk) => chunk.chunk_id));

  const retrievalByQuery = new Map(
    retrievals.map((result) => [result.query_id, result]),
  );

  const draftByQuery = new Map(drafts.map((draft) => [draft.query_id, draft]));

  const reviewByQuery = new Map(
    reviews.map((review) => [review.query_id, review]),
  );

  const auditQueryIds = new Set(audits.map((audit) => audit.query_id));

  for (const query of queries) {
    const retrieval = retrievalByQuery.get(query.query_id);
    const draft = draftByQuery.get(query.query_id);
    const review = reviewByQuery.get(query.query_id);

    if (!retrieval) {
      throw new Error(`Missing retrieval result for ${query.query_id}`);
    }

    if (retrieval.retrieved_chunks.length === 0) {
      throw new Error(`No retrieved chunks for ${query.query_id}`);
    }

    if (!draft) {
      throw new Error(`Missing draft answer for ${query.query_id}`);
    }

    if (!policy.allowed_labels.includes(draft.label)) {
      throw new Error(
        `Invalid draft label for ${query.query_id}: ${draft.label}`,
      );
    }

    const retrievedIds = new Set(
      retrieval.retrieved_chunks.map((chunk) => chunk.chunk_id),
    );

    for (const citation of draft.citations) {
      if (!retrievedIds.has(citation)) {
        throw new Error(
          `Draft ${query.query_id} cites non-retrieved chunk ${citation}`,
        );
      }
    }

    if (!review) {
      throw new Error(`Missing human review for ${query.query_id}`);
    }

    for (const chunkId of review.final_chunk_ids) {
      if (!chunkIds.has(chunkId)) {
        throw new Error(
          `Review ${query.query_id} uses unknown chunk ${chunkId}`,
        );
      }
    }

    if (!auditQueryIds.has(query.query_id)) {
      throw new Error(`Missing audit for ${query.query_id}`);
    }

    const draftLogs = logs.filter(
      (log) =>
        log.stage === "draft_answer_generation" &&
        log.query_id === query.query_id,
    );

    if (draftLogs.length !== 1) {
      throw new Error(
        `Expected one draft LLM log for ${query.query_id}, found ${draftLogs.length}`,
      );
    }

    const auditLogs = logs.filter(
      (log) => log.stage === "answer_audit" && log.query_id === query.query_id,
    );

    if (auditLogs.length !== 1) {
      throw new Error(
        `Expected one audit LLM log for ${query.query_id}, found ${auditLogs.length}`,
      );
    }

    const auditLog = auditLogs[0];

    const auditUsesReviewedContext = isStringArray(auditLog.input_artifacts)
      ? auditLog.input_artifacts.includes("review_overrides.json")
      : isStringArray(auditLog.final_chunk_ids);

    if (!auditUsesReviewedContext) {
      throw new Error(
        `Audit log for ${query.query_id} does not use reviewed context`,
      );
    }

    if (!report.includes(query.question)) {
      throw new Error(`Final report is missing question ${query.query_id}`);
    }

    for (const chunkId of review.final_chunk_ids) {
      if (!report.includes(chunkId)) {
        throw new Error(
          `Final report does not include final context ${chunkId} for ${query.query_id}`,
        );
      }
    }
  }

  console.log("Validation complete.");
  console.log(`Queries validated: ${queries.length}`);
  console.log(`LLM calls validated: ${logs.length}`);
  console.log("All required pipeline checks passed.");
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? `Validation failed: ${error.message}`
      : "Validation failed.",
  );

  process.exitCode = 1;
});

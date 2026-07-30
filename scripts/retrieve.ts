import fs from "node:fs/promises";
import path from "node:path";

import { resolveRetrievalMode } from "../src/lib/pipeline/retrieval-config";
import {
  computeRetrievalMetrics,
  retrieveQueries,
} from "../src/lib/pipeline/retrieve-queries";
import type {
  DocumentChunk,
  Policy,
  QueryInput,
  RetrievalIndex,
} from "../src/lib/pipeline/types";

const root = process.cwd();

async function readJson<T>(fileName: string): Promise<T> {
  const filePath = path.join(root, fileName);
  const content = await fs.readFile(filePath, "utf8");

  return JSON.parse(content) as T;
}

async function writeJson(fileName: string, data: unknown): Promise<void> {
  const filePath = path.join(root, fileName);

  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const chunks = await readJson<DocumentChunk[]>("chunks.json");

  const queries = await readJson<QueryInput[]>("queries.json");

  const policy = await readJson<Policy>("policy.json");
  const retrievalMode = resolveRetrievalMode(policy.retrieval_mode);

  if (!Number.isInteger(policy.top_k) || policy.top_k <= 0) {
    throw new Error("policy.json must contain a positive top_k.");
  }

  const retrievalIndex =
    retrievalMode === "bm25"
      ? await readJson<RetrievalIndex>("index.json")
      : undefined;

  const retrievalResults = retrieveQueries({
    chunks,
    queries,
    topK: policy.top_k,
    retrievalMode,
    index: retrievalIndex,
  });

  await writeJson("retrieval_results.json", retrievalResults);
  await writeJson(
    "retrieval_metrics.json",
    computeRetrievalMetrics({
      queries,
      retrievals: retrievalResults,
      topK: policy.top_k,
      retrievalMode,
    }),
  );

  console.log(
    `Retrieved results for ${queries.length} queries using ${retrievalMode} mode.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Retrieval failed.");

  process.exitCode = 1;
});

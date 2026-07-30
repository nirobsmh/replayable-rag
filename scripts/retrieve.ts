import fs from "node:fs/promises";
import path from "node:path";
import MiniSearch from "minisearch";

import type {
  DocumentChunk,
  Policy,
  QueryInput,
  QueryRetrievalResult,
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

  if (!Number.isInteger(policy.top_k) || policy.top_k <= 0) {
    throw new Error("policy.json must contain a positive top_k.");
  }

  const sortedChunks = [...chunks].sort((a, b) =>
    a.chunk_id.localeCompare(b.chunk_id),
  );

  const search = new MiniSearch<DocumentChunk>({
    idField: "chunk_id",
    fields: ["text"],
    storeFields: ["chunk_id", "document_name"],
  });

  search.addAll(sortedChunks);

  const retrievalResults: QueryRetrievalResult[] = queries.map((query) => {
    let matches = search.search(query.question, {
      prefix: true,
    });

    /*
     * The requirement says every query must return at least one
     * chunk unless the corpus is empty.
     *
     * When nothing matches, fall back to the first chunks using
     * stable chunk_id ordering.
     */
    if (matches.length === 0) {
      matches = sortedChunks.map((chunk) => ({
        id: chunk.chunk_id,
        score: 0,
        match: {},
        terms: [],
        queryTerms: [],
        chunk_id: chunk.chunk_id,
        document_name: chunk.document_name,
      }));
    }

    const topMatches = matches.slice(
      0,
      Math.min(policy.top_k, sortedChunks.length),
    );

    return {
      query_id: query.query_id,
      question: query.question,
      retrieved_chunks: topMatches.map((match, index) => ({
        chunk_id: String(match.chunk_id),
        document_name: String(match.document_name),
        rank: index + 1,
        retrieval_score: Number(match.score.toFixed(6)),
      })),
    };
  });

  await writeJson("retrieval_results.json", retrievalResults);

  const indexMetadata = {
    engine: "minisearch",
    indexed_fields: ["text"],
    chunk_count: chunks.length,
    top_k: policy.top_k,
  };

  await writeJson("index_metadata.json", indexMetadata);

  console.log(`Retrieved results for ${queries.length} queries.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Retrieval failed.");

  process.exitCode = 1;
});

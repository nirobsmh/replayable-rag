import { promises as fs } from "node:fs";
import path from "node:path";

import { buildRetrievalIndex } from "../src/lib/pipeline/build-index";
import { resolveRetrievalMode, SUPPORTED_RETRIEVAL_MODES } from "../src/lib/pipeline/retrieval-config";
import type { Policy } from "../src/lib/pipeline/types";

const CHUNKS_FILE = path.resolve(process.cwd(), "chunks.json");

const INDEX_FILE = path.resolve(process.cwd(), "index.json");

const METADATA_FILE = path.resolve(process.cwd(), "index_metadata.json");

const POLICY_FILE = path.resolve(process.cwd(), "policy.json");

async function readJsonFile(filePath: string): Promise<unknown> {
  let fileContent: string;

  try {
    fileContent = await fs.readFile(filePath, "utf8");
  } catch {
    throw new Error(`Could not read file: ${filePath}`);
  }

  try {
    return JSON.parse(fileContent) as unknown;
  } catch {
    throw new Error(`File does not contain valid JSON: ${filePath}`);
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const serializedValue = `${JSON.stringify(value, null, 2)}\n`;

  await fs.writeFile(filePath, serializedValue, "utf8");
}

async function main(): Promise<void> {
  console.log("Starting deterministic index build...");
  console.log(`Reading chunks from: ${CHUNKS_FILE}`);

  const chunks = await readJsonFile(CHUNKS_FILE);
  const policy = (await readJsonFile(POLICY_FILE)) as Policy;

  if (!Number.isInteger(policy.top_k) || policy.top_k <= 0) {
    throw new Error("policy.json must contain a positive top_k.");
  }

  const retrievalMode = resolveRetrievalMode(policy.retrieval_mode);

  const { index, metadata } = buildRetrievalIndex(chunks);
  const metadataWithRetrievalMode = {
    ...metadata,
    retrieval_mode: retrievalMode,
    retrieval_modes_supported: SUPPORTED_RETRIEVAL_MODES,
    top_k: policy.top_k,
  };

  await Promise.all([
    writeJsonFile(INDEX_FILE, index),
    writeJsonFile(METADATA_FILE, metadataWithRetrievalMode),
  ]);

  console.log("");
  console.log("Index build complete.");
  console.log(`Index ID: ${metadata.index_id}`);
  console.log(`Chunks indexed: ${metadata.chunk_count}`);
  console.log(`Unique terms: ${metadata.unique_term_count}`);
  console.log(`Total tokens: ${metadata.total_token_count}`);
  console.log(`Configured retrieval mode: ${retrievalMode}`);
  console.log(`Index written to: ${INDEX_FILE}`);
  console.log(`Metadata written to: ${METADATA_FILE}`);
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "An unknown error occurred.";

  console.error(`Index build failed: ${message}`);
  process.exitCode = 1;
});

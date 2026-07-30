import fs from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

type Chunk = {
  chunk_id: string;
  document_name: string;
  text: string;
};

type RetrievalResult = {
  query_id: string;
  question: string;
  retrieved_chunks: Array<{
    chunk_id: string;
    document_name: string;
    rank: number;
    retrieval_score: number;
  }>;
};

type DraftAnswer = {
  query_id: string;
  answer: string;
  label: string;
  citations: string[];
  reasoning_summary: string;
};

type ReviewResult = {
  query_id: string;
  overridden: boolean;
  original_chunk_ids: string[];
  final_chunk_ids: string[];
};

async function readJson<T>(fileName: string): Promise<T> {
  const content = await fs.readFile(fileName, "utf8");
  return JSON.parse(content) as T;
}

async function main(): Promise<void> {
  const chunks = await readJson<Chunk[]>("chunks.json");
  const retrievalResults = await readJson<RetrievalResult[]>(
    "retrieval_results.json",
  );
  const drafts = await readJson<DraftAnswer[]>("draft_answers.json");

  const validChunkIds = new Set(chunks.map((chunk) => chunk.chunk_id));

  const validQueryIds = new Set(
    retrievalResults.map((result) => result.query_id),
  );

  const draftByQueryId = new Map(
    drafts.map((draft) => [draft.query_id, draft]),
  );

  const reviews = new Map<string, ReviewResult>();

  // Start with the original retrieval context.
  for (const result of retrievalResults) {
    const originalChunkIds = result.retrieved_chunks.map(
      (chunk) => chunk.chunk_id,
    );

    reviews.set(result.query_id, {
      query_id: result.query_id,
      overridden: false,
      original_chunk_ids: originalChunkIds,
      final_chunk_ids: originalChunkIds,
    });
  }

  console.log("\n=== Human Review Checkpoint ===\n");

  for (const result of retrievalResults) {
    const draft = draftByQueryId.get(result.query_id);

    console.log(`Query ID: ${result.query_id}`);
    console.log(`Question: ${result.question}`);
    console.log(`Draft label: ${draft?.label ?? "missing"}`);
    console.log("Retrieved chunks:");

    for (const chunk of result.retrieved_chunks) {
      console.log(
        `  ${chunk.rank}. ${chunk.chunk_id} ` +
          `(${chunk.document_name}, score: ${chunk.retrieval_score})`,
      );
    }

    console.log("");
  }

  const readline = createInterface({
    input: stdin,
    output: stdout,
  });

  console.log(
    "Do you want to override retrieved chunks for any query before audit?",
  );
  console.log(
    "Enter query_id and comma-separated chunk_ids to force as final context, or press Enter to continue.",
  );
  console.log("Example: q1 chunk_123,chunk_456\n");

  while (true) {
    const input = (await readline.question("Override: ")).trim();

    if (!input) {
      break;
    }

    const firstSpace = input.indexOf(" ");

    if (firstSpace === -1) {
      console.log("Invalid format. Use: query_id chunk_id,chunk_id");
      continue;
    }

    const queryId = input.slice(0, firstSpace).trim();

    const chunkIds = input
      .slice(firstSpace + 1)
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (!validQueryIds.has(queryId)) {
      console.log(`Unknown query_id: ${queryId}`);
      continue;
    }

    if (chunkIds.length === 0) {
      console.log("Provide at least one chunk ID.");
      continue;
    }

    const invalidChunkId = chunkIds.find(
      (chunkId) => !validChunkIds.has(chunkId),
    );

    if (invalidChunkId) {
      console.log(`Unknown chunk_id: ${invalidChunkId}`);
      continue;
    }

    const currentReview = reviews.get(queryId);

    if (!currentReview) {
      throw new Error(`Review state missing for ${queryId}`);
    }

    reviews.set(queryId, {
      ...currentReview,
      overridden: true,
      final_chunk_ids: [...new Set(chunkIds)],
    });

    console.log(`Override saved for ${queryId}.`);
  }

  readline.close();

  const output = retrievalResults.map((result) => {
    const review = reviews.get(result.query_id);

    if (!review) {
      throw new Error(`Review result missing for ${result.query_id}`);
    }

    return review;
  });

  await fs.writeFile(
    "review_overrides.json",
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );

  console.log("\nHuman review complete. Saved review_overrides.json");
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Human review failed.",
  );

  process.exitCode = 1;
});

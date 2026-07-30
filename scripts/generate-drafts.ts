import "dotenv/config";

import fs from "node:fs/promises";
import OpenAI from "openai";

import { hashPrompt, logLlmCall } from "../src/lib/pipeline/llm-log";

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

type Policy = {
  answer_policy: string;
  allowed_labels: string[];
  citation_required: boolean;
};

type DraftAnswer = {
  query_id: string;
  answer: string;
  label: string;
  citations: string[];
  reasoning_summary: string;
};

const client = new OpenAI();

const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

async function readJson<T>(fileName: string): Promise<T> {
  const content = await fs.readFile(fileName, "utf8");

  return JSON.parse(content) as T;
}

async function main(): Promise<void> {
  const chunks = await readJson<Chunk[]>("chunks.json");

  const retrievalResults = await readJson<RetrievalResult[]>(
    "retrieval_results.json",
  );

  const policy = await readJson<Policy>("policy.json");

  if (
    !Array.isArray(policy.allowed_labels) ||
    policy.allowed_labels.length === 0
  ) {
    throw new Error("policy.json must define allowed_labels.");
  }

  const chunkById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));

  const drafts: DraftAnswer[] = [];

  /*
   * Start a fresh LLM log for the full pipeline run.
   *
   * Important:
   * Do not clear this file in audit-answers.ts.
   */
  await fs.writeFile("llm_calls.jsonl", "", "utf8");

  for (const retrieval of retrievalResults) {
    const retrievedChunks = retrieval.retrieved_chunks.map((retrievedChunk) => {
      const chunk = chunkById.get(retrievedChunk.chunk_id);

      if (!chunk) {
        throw new Error(
          `Chunk ${retrievedChunk.chunk_id} was not found in chunks.json.`,
        );
      }

      return chunk;
    });

    if (retrievedChunks.length === 0) {
      throw new Error(`Query ${retrieval.query_id} has no retrieved chunks.`);
    }

    const allowedChunkIds = retrievedChunks.map((chunk) => chunk.chunk_id);

    const context = retrievedChunks
      .map((chunk) =>
        [
          `[${chunk.chunk_id}]`,
          `Document: ${chunk.document_name}`,
          chunk.text,
        ].join("\n"),
      )
      .join("\n\n---\n\n");

    const prompt = `
You are generating a grounded draft answer.

Question:
${retrieval.question}

Retrieved context:
${context}

Answer policy:
${policy.answer_policy}

Allowed labels:
${policy.allowed_labels.join(", ")}

Citation requirement:
${
  policy.citation_required
    ? "Citations are required when the context supports the answer."
    : "Citations are optional."
}

Rules:
- Use only the retrieved context.
- Do not use outside knowledge as a grounded fact.
- Cite only these chunk IDs: ${allowedChunkIds.join(", ")}.
- If evidence is weak or incomplete, explicitly say so.
- If the context cannot answer the question, use the unsupported label.
- Keep reasoning_summary brief and based only on the context.
`.trim();

    const response = await client.responses.create({
      model,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "draft_answer",
          strict: true,
          schema: {
            type: "object",
            properties: {
              answer: {
                type: "string",
              },
              label: {
                type: "string",
                enum: policy.allowed_labels,
              },
              citations: {
                type: "array",
                items: {
                  type: "string",
                  enum: allowedChunkIds,
                },
              },
              reasoning_summary: {
                type: "string",
              },
            },
            required: ["answer", "label", "citations", "reasoning_summary"],
            additionalProperties: false,
          },
        },
      },
    });

    if (!response.output_text) {
      throw new Error(`No output returned for query ${retrieval.query_id}.`);
    }

    const generated = JSON.parse(response.output_text) as Omit<
      DraftAnswer,
      "query_id"
    >;

    if (!policy.allowed_labels.includes(generated.label)) {
      throw new Error(
        `Invalid label returned for query ${retrieval.query_id}.`,
      );
    }

    const invalidCitation = generated.citations.find(
      (citation) => !allowedChunkIds.includes(citation),
    );

    if (invalidCitation) {
      throw new Error(
        `Query ${retrieval.query_id} cited an invalid chunk: ${invalidCitation}`,
      );
    }

    drafts.push({
      query_id: retrieval.query_id,
      ...generated,
    });

    await logLlmCall({
      stage: "draft_answer_generation",
      query_id: retrieval.query_id,
      provider: "openai",
      model,
      prompt_hash: hashPrompt(prompt),
      input_artifacts: [
        "queries.json",
        "policy.json",
        "chunks.json",
        "retrieval_results.json",
      ],
      output_artifact: "draft_answers.json",
    });

    console.log(`Generated draft for ${retrieval.query_id}`);
  }

  await fs.writeFile(
    "draft_answers.json",
    `${JSON.stringify(drafts, null, 2)}\n`,
    "utf8",
  );

  console.log(`Saved ${drafts.length} drafts to draft_answers.json`);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? `Draft generation failed: ${error.message}`
      : "Draft generation failed.",
  );

  process.exitCode = 1;
});

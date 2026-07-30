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

type Policy = {
  answer_policy: string;
  citation_required: boolean;
  forbidden_behaviours: string[];
};

type AnswerAudit = {
  query_id: string;
  audit_label: "pass" | "fail";
  support_assessment: string;
  citation_check: string;
  hallucination_risk: "low" | "medium" | "high";
  recommended_fix: string;
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

  const drafts = await readJson<DraftAnswer[]>("draft_answers.json");

  const reviews = await readJson<ReviewResult[]>("review_overrides.json");

  const policy = await readJson<Policy>("policy.json");

  const chunkById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));

  const draftByQueryId = new Map(
    drafts.map((draft) => [draft.query_id, draft]),
  );

  const reviewByQueryId = new Map(
    reviews.map((review) => [review.query_id, review]),
  );

  const audits: AnswerAudit[] = [];

  for (const retrieval of retrievalResults) {
    const draft = draftByQueryId.get(retrieval.query_id);

    const review = reviewByQueryId.get(retrieval.query_id);

    if (!draft) {
      throw new Error(`Missing draft answer for ${retrieval.query_id}.`);
    }

    if (!review) {
      throw new Error(`Missing human review for ${retrieval.query_id}.`);
    }

    if (review.final_chunk_ids.length === 0) {
      throw new Error(`Final context is empty for ${retrieval.query_id}.`);
    }

    const finalChunks = review.final_chunk_ids.map((chunkId) => {
      const chunk = chunkById.get(chunkId);

      if (!chunk) {
        throw new Error(`Unknown final chunk ID: ${chunkId}`);
      }

      return chunk;
    });

    const finalContext = finalChunks
      .map((chunk) =>
        [
          `[${chunk.chunk_id}]`,
          `Document: ${chunk.document_name}`,
          chunk.text,
        ].join("\n"),
      )
      .join("\n\n---\n\n");

    const forbiddenBehaviours =
      policy.forbidden_behaviours?.map((rule) => `- ${rule}`).join("\n") ||
      "- Do not use unsupported facts.\n- Do not cite chunks outside the final context.";

    const prompt = `
You are auditing a draft answer after human review.

Original question:
${retrieval.question}

Draft answer:
${draft.answer}

Draft label:
${draft.label}

Draft cited chunk IDs:
${draft.citations.join(", ") || "None"}

Final context chunk IDs after review:
${review.final_chunk_ids.join(", ")}

Was retrieval overridden?
${review.overridden ? "Yes" : "No"}

Final context:
${finalContext}

Answer policy:
${policy.answer_policy}

Citation requirement:
${
  policy.citation_required
    ? "Supported claims should have valid citations."
    : "Citations are optional."
}

Forbidden behaviours:
${forbiddenBehaviours}

Audit rules:
- Evaluate the draft only against the final reviewed context.
- Do not evaluate it against the original retrieval when an override exists.
- Check whether every important claim is supported.
- Check whether cited chunk IDs belong to the final context.
- Check whether the draft overclaims beyond the corpus.
- Use "fail" for material unsupported claims or invalid citations.
- Use "pass" only when the answer is adequately grounded.
- Use an empty recommended_fix when no fix is needed.
`.trim();

    const response = await client.responses.create({
      model,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "answer_audit",
          strict: true,
          schema: {
            type: "object",
            properties: {
              audit_label: {
                type: "string",
                enum: ["pass", "fail"],
              },
              support_assessment: {
                type: "string",
              },
              citation_check: {
                type: "string",
              },
              hallucination_risk: {
                type: "string",
                enum: ["low", "medium", "high"],
              },
              recommended_fix: {
                type: "string",
              },
            },
            required: [
              "audit_label",
              "support_assessment",
              "citation_check",
              "hallucination_risk",
              "recommended_fix",
            ],
            additionalProperties: false,
          },
        },
      },
    });

    if (!response.output_text) {
      throw new Error(`No audit output returned for ${retrieval.query_id}.`);
    }

    const generated = JSON.parse(response.output_text) as Omit<
      AnswerAudit,
      "query_id"
    >;

    audits.push({
      query_id: retrieval.query_id,
      ...generated,
    });

    await logLlmCall({
      stage: "answer_audit",
      query_id: retrieval.query_id,
      provider: "openai",
      model,
      prompt_hash: hashPrompt(prompt),
      input_artifacts: [
        "queries.json",
        "policy.json",
        "chunks.json",
        "retrieval_results.json",
        "draft_answers.json",
        "review_overrides.json",
      ],
      output_artifact: "answer_audit.json",
    });

    console.log(`Audited ${retrieval.query_id}`);
  }

  await fs.writeFile(
    "answer_audit.json",
    `${JSON.stringify(audits, null, 2)}\n`,
    "utf8",
  );

  console.log(`Saved ${audits.length} audits to answer_audit.json`);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? `Answer audit failed: ${error.message}`
      : "Answer audit failed.",
  );

  process.exitCode = 1;
});

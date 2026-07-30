import "dotenv/config";

import fs from "node:fs/promises";
import OpenAI from "openai";

import { hashPrompt, logLlmCall } from "../src/lib/pipeline/llm-log";
import type {
  Policy,
  QueryInput,
  RevisedAnswer,
} from "../src/lib/pipeline/types";

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
  final_chunk_ids: string[];
};

type AnswerAudit = {
  query_id: string;
  audit_label: "pass" | "fail";
  hallucination_risk: "low" | "medium" | "high";
  support_assessment: string;
  citation_check: string;
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
  const queries = await readJson<QueryInput[]>("queries.json");
  const drafts = await readJson<DraftAnswer[]>("draft_answers.json");
  const retrievals = await readJson<RetrievalResult[]>("retrieval_results.json");
  const reviews = await readJson<ReviewResult[]>("review_overrides.json");
  const audits = await readJson<AnswerAudit[]>("answer_audit.json");
  const policy = await readJson<Policy>("policy.json");

  if (
    !Array.isArray(policy.allowed_labels) ||
    policy.allowed_labels.length === 0
  ) {
    throw new Error("policy.json must define allowed_labels.");
  }

  const chunkById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
  const queryById = new Map(queries.map((query) => [query.query_id, query]));
  const retrievalByQueryId = new Map(
    retrievals.map((retrieval) => [retrieval.query_id, retrieval]),
  );
  const draftByQueryId = new Map(
    drafts.map((draft) => [draft.query_id, draft]),
  );
  const reviewByQueryId = new Map(
    reviews.map((review) => [review.query_id, review]),
  );

  const flaggedAudits = audits.filter(
    (audit) =>
      audit.audit_label === "fail" || audit.hallucination_risk === "high",
  );

  if (flaggedAudits.length === 0) {
    await fs.writeFile("revised_answers.json", "[]\n", "utf8");
    console.log("No failed or high-risk audits. Saved empty revised_answers.json");
    return;
  }

  const revisedAnswers: RevisedAnswer[] = [];

  for (const audit of flaggedAudits) {
    const query = queryById.get(audit.query_id);
    const retrieval = retrievalByQueryId.get(audit.query_id);
    const draft = draftByQueryId.get(audit.query_id);
    const review = reviewByQueryId.get(audit.query_id);

    if (!query || !retrieval || !draft || !review) {
      throw new Error(`Incomplete artifacts for ${audit.query_id}.`);
    }

    if (review.final_chunk_ids.length === 0) {
      throw new Error(`Final context is empty for ${audit.query_id}.`);
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

    const prompt = `
You are revising a RAG answer after an audit flagged it as risky.

Question:
${retrieval.question}

Original draft answer:
${draft.answer}

Original draft label:
${draft.label}

Original draft citations:
${draft.citations.join(", ") || "None"}

Audit label:
${audit.audit_label}

Hallucination risk:
${audit.hallucination_risk}

Audit support assessment:
${audit.support_assessment}

Audit citation check:
${audit.citation_check}

Recommended fix:
${audit.recommended_fix || "None"}

Final reviewed context chunk IDs:
${review.final_chunk_ids.join(", ")}

Final reviewed context:
${finalContext}

Answer policy:
${policy.answer_policy ?? "Answer only from the provided context."}

Rules:
- Use only the final reviewed context.
- Be more conservative than the original draft.
- Do not infer missing product details.
- Cite only these chunk IDs: ${review.final_chunk_ids.join(", ")}.
- If the final reviewed context is insufficient, explicitly say so and use the unsupported label.
- Preserve citation discipline.
- Keep reasoning_summary brief and grounded in the final reviewed context.
`.trim();

    const response = await client.responses.create({
      model,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "revised_answer",
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
                  enum: review.final_chunk_ids,
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
      throw new Error(`No revised answer returned for ${audit.query_id}.`);
    }

    const generated = JSON.parse(response.output_text) as Omit<
      RevisedAnswer,
      "query_id" | "trigger_audit_label" | "trigger_hallucination_risk"
    >;

    revisedAnswers.push({
      query_id: query.query_id,
      ...generated,
      trigger_audit_label: audit.audit_label,
      trigger_hallucination_risk: audit.hallucination_risk,
    });

    await logLlmCall({
      stage: "revised_answer_generation",
      query_id: query.query_id,
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
        "answer_audit.json",
      ],
      output_artifact: "revised_answers.json",
    });

    console.log(`Generated revised answer for ${query.query_id}`);
  }

  await fs.writeFile(
    "revised_answers.json",
    `${JSON.stringify(revisedAnswers, null, 2)}\n`,
    "utf8",
  );

  console.log(`Saved ${revisedAnswers.length} revised answers to revised_answers.json`);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? `Revised answer generation failed: ${error.message}`
      : "Revised answer generation failed.",
  );

  process.exitCode = 1;
});

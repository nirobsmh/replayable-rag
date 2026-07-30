import fs from "node:fs/promises";

import type {
  RetrievalErrorAnalysisEntry,
  RetrievalMetricsArtifact,
  RevisedAnswer,
} from "../src/lib/pipeline/types";

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

type AnswerAudit = {
  query_id: string;
  audit_label: "pass" | "fail";
  support_assessment: string;
  citation_check: string;
  hallucination_risk: "low" | "medium" | "high";
  recommended_fix: string;
};

async function readJson<T>(fileName: string): Promise<T> {
  const content = await fs.readFile(fileName, "utf8");
  return JSON.parse(content) as T;
}

function formatChunkIds(chunkIds: string[]): string {
  return chunkIds.length > 0
    ? chunkIds.map((id) => `\`${id}\``).join(", ")
    : "None";
}

async function main(): Promise<void> {
  const retrievals = await readJson<RetrievalResult[]>(
    "retrieval_results.json",
  );

  const drafts = await readJson<DraftAnswer[]>("draft_answers.json");

  const reviews = await readJson<ReviewResult[]>("review_overrides.json");

  const audits = await readJson<AnswerAudit[]>("answer_audit.json");
  const retrievalMetrics =
    await readJson<RetrievalMetricsArtifact>("retrieval_metrics.json");
  const revisedAnswers = await readJson<RevisedAnswer[]>("revised_answers.json");
  const retrievalErrorAnalysis = await readJson<RetrievalErrorAnalysisEntry[]>(
    "retrieval_error_analysis.json",
  );

  const draftByQueryId = new Map(
    drafts.map((draft) => [draft.query_id, draft]),
  );

  const reviewByQueryId = new Map(
    reviews.map((review) => [review.query_id, review]),
  );

  const auditByQueryId = new Map(
    audits.map((audit) => [audit.query_id, audit]),
  );
  const revisedAnswerByQueryId = new Map(
    revisedAnswers.map((answer) => [answer.query_id, answer]),
  );
  const retrievalErrorByQueryId = new Map(
    retrievalErrorAnalysis.map((entry) => [entry.query_id, entry]),
  );

  const passedCount = audits.filter(
    (audit) => audit.audit_label === "pass",
  ).length;

  const failedCount = audits.length - passedCount;

  const overrideCount = reviews.filter((review) => review.overridden).length;

  const lowRiskCount = audits.filter(
    (audit) => audit.hallucination_risk === "low",
  ).length;

  const mediumRiskCount = audits.filter(
    (audit) => audit.hallucination_risk === "medium",
  ).length;

  const highRiskCount = audits.filter(
    (audit) => audit.hallucination_risk === "high",
  ).length;

  const report: string[] = [];

  report.push("# RAG Pipeline Final Evaluation Report");
  report.push("");

  /*
   * 1. Retrieval Summary
   */
  report.push("## Retrieval Summary");
  report.push("");
  report.push(`- Queries processed: ${retrievals.length}`);
  report.push(
    `- Total retrieved chunks: ${retrievals.reduce(
      (total, result) => total + result.retrieved_chunks.length,
      0,
    )}`,
  );
  report.push(`- Human overrides applied: ${overrideCount}`);
  report.push(`- Audit passes: ${passedCount}`);
  report.push(`- Audit failures: ${failedCount}`);
  report.push(
    `- Hallucination risk: ${lowRiskCount} low, ${mediumRiskCount} medium, ${highRiskCount} high`,
  );
  report.push(
    `- Retrieval mode: ${
      retrievalMetrics.retrieval_mode
    }`,
  );

  if (retrievalMetrics.status === "computed") {
    report.push(
      `- Retrieval metrics@${retrievalMetrics.top_k}: hit rate ${retrievalMetrics.hit_rate_at_k}, average recall ${retrievalMetrics.average_recall_at_k}`,
    );
  } else {
    report.push(`- Retrieval metrics: ${retrievalMetrics.reason}`);
  }

  report.push(`- Revised answers generated: ${revisedAnswers.length}`);
  report.push("");

  /*
   * 2. Query-by-Query Results
   */
  report.push("## Query-by-Query Results");
  report.push("");

  for (const retrieval of retrievals) {
    const draft = draftByQueryId.get(retrieval.query_id);
    const review = reviewByQueryId.get(retrieval.query_id);
    const audit = auditByQueryId.get(retrieval.query_id);
    const revisedAnswer = revisedAnswerByQueryId.get(retrieval.query_id);
    const retrievalError = retrievalErrorByQueryId.get(retrieval.query_id);

    if (!draft || !review || !audit) {
      throw new Error(`Incomplete artifacts for query ${retrieval.query_id}`);
    }

    const status = audit.audit_label === "pass" ? "GROUNDED" : "NEEDS REVIEW";

    const recommendation =
      audit.recommended_fix.trim() || "No change required.";

    report.push(`### ${retrieval.query_id}: ${status}`);
    report.push("");
    report.push(`**Question:** ${retrieval.question}`);
    report.push("");
    report.push(
      `**Final context chunk IDs:** ${formatChunkIds(review.final_chunk_ids)}`,
    );
    report.push("");
    report.push(`**Draft answer:** ${draft.answer}`);
    report.push("");
    report.push(`**Draft label:** ${draft.label}`);
    report.push("");
    report.push(`**Draft citations:** ${formatChunkIds(draft.citations)}`);
    report.push("");
    report.push(`**Audit label:** ${audit.audit_label}`);
    report.push("");
    report.push(`**Hallucination risk:** ${audit.hallucination_risk}`);
    report.push("");
    report.push(`**Support assessment:** ${audit.support_assessment}`);
    report.push("");
    report.push(`**Citation check:** ${audit.citation_check}`);
    report.push("");

    if (revisedAnswer) {
      report.push(`**Revised answer:** ${revisedAnswer.answer}`);
      report.push("");
      report.push(
        `**Revised citations:** ${formatChunkIds(revisedAnswer.citations)}`,
      );
      report.push("");
    }

    if (retrievalError) {
      report.push(`**Retrieval error analysis:** ${retrievalError.failure_type}`);
      report.push("");
      report.push(retrievalError.description);
      report.push("");
    }

    report.push(`**Final recommendation:** ${recommendation}`);
    report.push("");
  }

  /*
   * 3. Reviewed Overrides
   */
  report.push("## Reviewed Overrides");
  report.push("");

  const overriddenReviews = reviews.filter((review) => review.overridden);

  if (overriddenReviews.length === 0) {
    report.push("No retrieval overrides were applied.");
  } else {
    for (const review of overriddenReviews) {
      report.push(`### ${review.query_id}`);
      report.push("");
      report.push(
        `- Original context: ${formatChunkIds(review.original_chunk_ids)}`,
      );
      report.push(`- Final context: ${formatChunkIds(review.final_chunk_ids)}`);
      report.push("");
    }
  }

  report.push("");

  /*
   * 4. Audit Findings
   */
  report.push("## Audit Findings");
  report.push("");

  for (const audit of audits) {
    report.push(
      `- **${audit.query_id} — ${audit.audit_label.toUpperCase()}**: ` +
        `${audit.support_assessment} ` +
        `Hallucination risk: ${audit.hallucination_risk}.`,
    );
  }

  report.push("");

  /*
   * 5. Failure Modes
   */
  report.push("## Failure Modes Observed");
  report.push("");

  const failedAudits = audits.filter((audit) => audit.audit_label === "fail");

  if (failedAudits.length === 0) {
    report.push("No major answer-grounding failures were observed.");
  } else {
    for (const audit of failedAudits) {
      report.push(`- **${audit.query_id}:** ${audit.support_assessment}`);
      report.push(`  - Citation finding: ${audit.citation_check}`);
      report.push(`  - Hallucination risk: ${audit.hallucination_risk}`);
    }
  }

  report.push("");

  /*
   * 6. Retrieval Error Analysis
   */
  report.push("## Retrieval Error Analysis");
  report.push("");

  if (retrievalErrorAnalysis.length === 0) {
    report.push("No retrieval error patterns required follow-up analysis.");
  } else {
    for (const entry of retrievalErrorAnalysis) {
      report.push(
        `- **${entry.query_id} — ${entry.failure_type}**: ${entry.description}`,
      );
    }
  }

  report.push("");

  /*
   * 7. Recommendations
   */
  report.push("## Recommended Improvements");
  report.push("");

  const recommendations = audits
    .map((audit) => audit.recommended_fix.trim())
    .filter(Boolean);

  if (recommendations.length === 0) {
    report.push("- Continue using the current retrieval and grounding policy.");
  } else {
    const uniqueRecommendations = [...new Set(recommendations)];

    for (const recommendation of uniqueRecommendations) {
      report.push(`- ${recommendation}`);
    }
  }

  report.push("");
  report.push(
    "- Reject citations that do not appear in the final reviewed context.",
  );
  report.push(
    "- Preserve retrieval scores and intermediate artifacts for replayability.",
  );
  report.push(
    "- Return an unsupported answer instead of using outside knowledge.",
  );
  report.push("");

  await fs.writeFile("final_report.md", `${report.join("\n")}\n`, "utf8");

  console.log("Generated final_report.md");
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Report generation failed.",
  );

  process.exitCode = 1;
});

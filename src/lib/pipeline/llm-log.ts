import fs from "node:fs/promises";
import { createHash } from "node:crypto";

type LlmLogRecord = {
  stage: string;
  query_id: string | null;
  timestamp: string;
  provider: string;
  model: string;
  prompt_hash: string;
  input_artifacts: string[];
  output_artifact: string;
};

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

export async function logLlmCall(
  record: Omit<LlmLogRecord, "timestamp">,
): Promise<void> {
  const entry: LlmLogRecord = {
    ...record,
    timestamp: new Date().toISOString(),
  };

  await fs.appendFile("llm_calls.jsonl", `${JSON.stringify(entry)}\n`, "utf8");
}

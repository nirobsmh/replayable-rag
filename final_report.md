# RAG Pipeline Final Evaluation Report

## Retrieval Summary

- Queries processed: 2
- Total retrieved chunks: 6
- Human overrides applied: 0
- Audit passes: 2
- Audit failures: 0
- Hallucination risk: 2 low, 0 medium, 0 high

## Query-by-Query Results

### q1: GROUNDED

**Question:** What features does InsightBoard provide?

**Final context chunk IDs:** `chunk_4bd3e144c20afe74`, `chunk_6e6428e7fc21e9af`, `chunk_bd68fd559fe1b481`

**Draft answer:** The retrieved context does not describe any features of InsightBoard. The available chunks only state that "InsightBoard is a business" and contain no information about features, so I cannot list its features from the provided context.

**Draft label:** unsupported

**Draft citations:** `chunk_4bd3e144c20afe74`, `chunk_6e6428e7fc21e9af`, `chunk_bd68fd559fe1b481`

**Audit label:** pass

**Hallucination risk:** low

**Support assessment:** The draft answer is supported by the final context. All three provided chunks only state that 'InsightBoard is a business' and contain no information about product features. The draft correctly refrains from inventing features and clearly says the evidence is insufficient to list features.

**Citation check:** All cited chunk IDs (chunk_4bd3e144c20afe74, chunk_6e6428e7fc21e9af, chunk_bd68fd559fe1b481) are present in the final context and accurately reflect the content used.

**Final recommendation:** No change required.

### q2: GROUNDED

**Question:** Does the product support role-based access?

**Final context chunk IDs:** `chunk_136f470ab2fed43c`, `chunk_8e69f777585b633a`, `chunk_a90931ad404f5189`

**Draft answer:** Yes — the retrieved context mentions "role-based access control," indicating the product supports role-based access.

**Draft label:** supported

**Draft citations:** `chunk_136f470ab2fed43c`, `chunk_8e69f777585b633a`, `chunk_a90931ad404f5189`

**Audit label:** pass

**Hallucination risk:** low

**Support assessment:** Supported. The provided context explicitly contains the phrase "role-based access control" in the cited chunks, which supports the draft answer that the product supports role-based (role-based access) access.

**Citation check:** All cited chunk IDs (chunk_136f470ab2fed43c, chunk_8e69f777585b633a, chunk_a90931ad404f5189) are present in the final context.

**Final recommendation:** No change required.

## Reviewed Overrides

No retrieval overrides were applied.

## Audit Findings

- **q1 — PASS**: The draft answer is supported by the final context. All three provided chunks only state that 'InsightBoard is a business' and contain no information about product features. The draft correctly refrains from inventing features and clearly says the evidence is insufficient to list features. Hallucination risk: low.
- **q2 — PASS**: Supported. The provided context explicitly contains the phrase "role-based access control" in the cited chunks, which supports the draft answer that the product supports role-based (role-based access) access. Hallucination risk: low.

## Failure Modes Observed

No major answer-grounding failures were observed.

## Recommended Improvements

- Continue using the current retrieval and grounding policy.

- Reject citations that do not appear in the final reviewed context.
- Preserve retrieval scores and intermediate artifacts for replayability.
- Return an unsupported answer instead of using outside knowledge.


import { promises as fs } from "node:fs";
import path from "node:path";

import { chunkDocumentsDirectory } from "../src/lib/pipeline/chunk-documents";

const DOCUMENTS_DIRECTORY = path.resolve(process.cwd(), "documents");

const OUTPUT_FILE = path.resolve(process.cwd(), "chunks.json");

const CHUNK_SIZE = 50;
const CHUNK_OVERLAP = 15;

async function main(): Promise<void> {
  console.log("Starting deterministic document chunking...");
  console.log(`Documents directory: ${DOCUMENTS_DIRECTORY}`);
  console.log(`Chunk size: ${CHUNK_SIZE}`);
  console.log(`Chunk overlap: ${CHUNK_OVERLAP}`);

  const chunks = await chunkDocumentsDirectory({
    documentsDirectory: DOCUMENTS_DIRECTORY,
    options: {
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    },
  });

  const serializedChunks = `${JSON.stringify(chunks, null, 2)}\n`;

  await fs.writeFile(OUTPUT_FILE, serializedChunks, "utf8");

  const documentNames = new Set(chunks.map((chunk) => chunk.document_name));

  console.log("");
  console.log("Chunking complete.");
  console.log(`Documents processed: ${documentNames.size}`);
  console.log(`Chunks generated: ${chunks.length}`);
  console.log(`Output written to: ${OUTPUT_FILE}`);
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "An unknown error occurred.";

  console.error(`Chunking failed: ${message}`);
  process.exitCode = 1;
});

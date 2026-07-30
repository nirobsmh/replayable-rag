import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ChunkingOptions, DocumentChunk } from "./types";

const DEFAULT_OPTIONS: ChunkingOptions = {
  chunkSize: 1000,
  chunkOverlap: 150,
};

/**
 * Convert Windows path separators to forward slashes.
 *
 * This ensures document names remain deterministic across
 * Windows, macOS, and Linux.
 */
function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/**
 * Recursively finds all .txt files under the supplied directory.
 *
 * The final result is sorted so filesystem ordering cannot affect
 * the order of chunks.
 */
async function findTextFiles(directoryPath: string): Promise<string[]> {
  const entries = await fs.readdir(directoryPath, {
    withFileTypes: true,
  });

  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      const nestedFiles = await findTextFiles(absolutePath);
      files.push(...nestedFiles);
      continue;
    }

    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".txt") {
      files.push(absolutePath);
    }
  }

  return files.sort((first, second) =>
    normalizePath(first).localeCompare(normalizePath(second)),
  );
}

/**
 * Generates a stable ID based on the document, character offsets,
 * and exact chunk text.
 */
function createChunkId(params: {
  documentName: string;
  startChar: number;
  endChar: number;
  text: string;
}): string {
  const input = [
    params.documentName,
    params.startChar.toString(),
    params.endChar.toString(),
    params.text,
  ].join("\u0000");

  const hash = createHash("sha256")
    .update(input, "utf8")
    .digest("hex")
    .slice(0, 16);

  return `chunk_${hash}`;
}

/**
 * Splits one document into fixed-size overlapping chunks.
 *
 * end_char is exclusive, meaning:
 *
 * documentText.slice(start_char, end_char) === chunk.text
 */
export function chunkDocument(params: {
  documentName: string;
  text: string;
  options?: Partial<ChunkingOptions>;
}): DocumentChunk[] {
  const options: ChunkingOptions = {
    ...DEFAULT_OPTIONS,
    ...params.options,
  };

  if (!Number.isInteger(options.chunkSize) || options.chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer.");
  }

  if (!Number.isInteger(options.chunkOverlap) || options.chunkOverlap < 0) {
    throw new Error("chunkOverlap must be a non-negative integer.");
  }

  if (options.chunkOverlap >= options.chunkSize) {
    throw new Error("chunkOverlap must be smaller than chunkSize.");
  }

  if (params.text.length === 0) {
    return [];
  }

  const chunks: DocumentChunk[] = [];
  const stepSize = options.chunkSize - options.chunkOverlap;

  for (
    let startChar = 0;
    startChar < params.text.length;
    startChar += stepSize
  ) {
    const endChar = Math.min(startChar + options.chunkSize, params.text.length);

    const chunkText = params.text.slice(startChar, endChar);

    chunks.push({
      chunk_id: createChunkId({
        documentName: params.documentName,
        startChar,
        endChar,
        text: chunkText,
      }),
      document_name: params.documentName,
      start_char: startChar,
      end_char: endChar,
      text: chunkText,
    });

    if (endChar === params.text.length) {
      break;
    }
  }

  return chunks;
}

/**
 * Reads every .txt document and returns all generated chunks.
 */
export async function chunkDocumentsDirectory(params: {
  documentsDirectory: string;
  options?: Partial<ChunkingOptions>;
}): Promise<DocumentChunk[]> {
  const documentsDirectory = path.resolve(params.documentsDirectory);

  let directoryStats;

  try {
    directoryStats = await fs.stat(documentsDirectory);
  } catch {
    throw new Error(
      `Documents directory does not exist: ${documentsDirectory}`,
    );
  }

  if (!directoryStats.isDirectory()) {
    throw new Error(`Documents path is not a directory: ${documentsDirectory}`);
  }

  const textFiles = await findTextFiles(documentsDirectory);

  if (textFiles.length === 0) {
    throw new Error(`No .txt files were found in ${documentsDirectory}`);
  }

  const allChunks: DocumentChunk[] = [];

  for (const absoluteFilePath of textFiles) {
    const documentName = normalizePath(
      path.relative(documentsDirectory, absoluteFilePath),
    );

    const documentText = await fs.readFile(absoluteFilePath, "utf8");

    const documentChunks = chunkDocument({
      documentName,
      text: documentText,
      options: params.options,
    });

    allChunks.push(...documentChunks);
  }

  return allChunks;
}

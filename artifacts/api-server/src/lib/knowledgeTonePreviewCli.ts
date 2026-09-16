import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  enrichKnowledgeDrafts,
  MAX_TONE_RECOVERY_TEXT_CHARS,
  MAX_TONE_BODY_CHARS,
  previewToneRecoveryFromText,
} from "./knowledgeToneRecovery";
import { chunkExtractedText } from "./knowledgeSourceImport";

const filePath = process.argv[2];
const mode = process.argv[3] === "--all" ? "all" : "tone";
if (!filePath) {
  console.error("Usage: preview-knowledge-tone-recovery.mjs <extracted-text-file> [--all]");
  process.exit(2);
}

try {
  const text = await readFile(filePath, "utf8");
  if (text.length > MAX_TONE_RECOVERY_TEXT_CHARS) {
    throw new Error(
      `Input exceeds the ${MAX_TONE_RECOVERY_TEXT_CHARS}-character bounded preview limit`,
    );
  }
  const preview =
    mode === "all"
      ? {
          candidates: await enrichKnowledgeDrafts(
            chunkExtractedText(text),
            path.basename(filePath),
          ),
          excludedDateBound: [],
        }
      : await previewToneRecoveryFromText(text, path.basename(filePath));
  // This CLI intentionally only prints model output. It does not import the
  // Express router or call the database, so it cannot persist recovery rows.
  process.stdout.write(
    `${JSON.stringify(
      {
        sourceFile: filePath,
        extractedCharacters: text.length,
        mode,
        candidateCount: preview.candidates.length,
        excludedDateBound: preview.excludedDateBound,
        candidates: preview.candidates,
        toneBodyCharacterLimit: MAX_TONE_BODY_CHARS,
        retrievalAssessment:
          mode === "tone" && preview.candidates.length > 3
            ? "Existing Brand/Voice retrieval caps at 3; review all candidates before deciding what to approve."
            : mode === "tone"
              ? "Review candidates as wording guidance only; example prices/timelines are not facts."
              : "Facts use the existing category-default policy; only candidateType=tone is eligible for brand_voice.",
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
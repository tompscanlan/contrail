/**
 * Generates lexicon files and lex.config.js from config.
 *
 * Usage: npx tsx examples/cloudflare-workers/generate.ts
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "./config";
import { generateLexicons } from "../../src/generate";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");

generateLexicons({
  config,
  rootDir: ROOT_DIR,
  outputDir: join(ROOT_DIR, "lexicons-generated"),
  writeRuntimeFiles: true,
});

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveConfigDir } from "../utils.js";

export function parseTrustedDotEnvContent(content: string): Record<string, string> {
  // Match whole dotenv assignments, including quoted multiline values. A line-by-line
  // override would incorrectly interpret assignments inside those values.
  const assignments =
    /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^\r\n]+)?\s*(?:#.*)?$/gm;
  const parsed: Record<string, string> = {};
  for (const match of content.replace(/\r\n?/g, "\n").matchAll(assignments)) {
    const entry = dotenv.parse(match[0]);
    const value = (match[2] ?? "").trim();
    if (value && !/^["'`]/.test(value)) {
      // In trusted state files, only whitespace-separated hashes start comments.
      // Keep a leading hash as dotenv's empty-value comment syntax.
      entry[match[1]] = value.replace(/(?:^|\s+)#.*$/, "").trimEnd();
    }
    Object.assign(parsed, entry);
  }
  return parsed;
}

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Load from process CWD first (dotenv default).
  dotenv.config({ quiet });

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(globalEnvPath, "utf8");
  } catch {
    // Preserve dotenv.config's non-throwing behavior for unreadable fallback files.
    return;
  }
  dotenv.populate(process.env, parseTrustedDotEnvContent(content), { override: false });
}

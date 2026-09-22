/**
 * `jev-triage` CLI — one JSON decision per line for a file (or stdin) of messages.
 *
 * Usage:
 *   pnpm jev:triage MESSAGES.json [--env-file PATH] [--log PATH] [--no-log]
 *                                 [--model NAME] [--hit 0.7] [--miss 0.3]
 *   cat MESSAGES.json | pnpm jev:triage -
 *
 * Input is either a JSON array of messages, an object with a `messages` array,
 * a single message object, or JSONL (one message per line). Each message is
 * `{ "from": ..., "subject": ..., "body": ..., "received_at": <ISO-8601>,
 * "id": optional }`.
 *
 * Output is JSONL on stdout: `{index, id, route, answers, decision_id, ...}`.
 * Exit codes: 0 ok · 2 bad input/usage · 3 not configured (missing key, or
 * disabled by JEV_TRIAGE_DISABLED) · 4 decision failed · 5 input unreadable.
 */

import { readFile } from "node:fs/promises";
import { JevDecisionError, JevError, JevNotConfigured } from "./decision-layer.js";
import {
  JevTriageDisabled,
  normalizeTriageMessage,
  triageMessage,
  type NormalizedTriageMessage,
  type TriageMessageOptions,
  type TriageResult,
} from "./triage.js";

/** Exit codes, mirrored from the portable `jev-decide` CLI contract. */
export const TRIAGE_EXIT = {
  ok: 0,
  badInput: 2,
  notConfigured: 3,
  decisionFailed: 4,
  inputUnreadable: 5,
} as const;

/** Injectable seams so the CLI is testable without network, key, or stdin. */
export type TriageCliDeps = {
  triage: (input: NormalizedTriageMessage, options?: TriageMessageOptions) => Promise<TriageResult>;
  env: NodeJS.ProcessEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readTextFile: (filePath: string) => Promise<string>;
  readStdin: () => Promise<string>;
};

const USAGE = [
  "Usage: jev-triage MESSAGES.json [--env-file PATH] [--log PATH] [--no-log]",
  "                            [--model NAME] [--hit 0.7] [--miss 0.3]",
  "       cat MESSAGES.json | jev-triage -",
  "",
  "Input: JSON array, {messages: [...]}, one message object, or JSONL.",
  "Message fields: from, subject, body, received_at (ISO-8601), optional id.",
  "Exit codes: 0 ok · 2 bad input/usage · 3 not configured · 4 decision failed · 5 input unreadable.",
].join("\n");

function defaultDeps(overrides: Partial<TriageCliDeps>): TriageCliDeps {
  return {
    triage: overrides.triage ?? ((input, options) => triageMessage(input, options)),
    env: overrides.env ?? process.env,
    stdout: overrides.stdout ?? ((line) => process.stdout.write(`${line}\n`)),
    stderr: overrides.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
    readTextFile: overrides.readTextFile ?? ((filePath) => readFile(filePath, "utf8")),
    readStdin:
      overrides.readStdin ??
      (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        return Buffer.concat(chunks).toString("utf8");
      }),
  };
}

/**
 * Load TYPESAFE_API_KEY from an env file into the process environment when it
 * is not already set. The value is never printed or returned.
 */
export async function loadEnvFile(
  filePath: string,
  env: NodeJS.ProcessEnv,
  readTextFile: (path: string) => Promise<string>,
): Promise<boolean | undefined> {
  if ((env.TYPESAFE_API_KEY ?? "").trim().length > 0) {
    return true;
  }
  let text: string;
  try {
    text = await readTextFile(filePath);
  } catch (error) {
    throw new EnvFileUnreadableError(
      `env file not readable: ${filePath} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  for (const rawLine of text.split(/\r?\n/u)) {
    let line = rawLine.trim();
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trim();
    }
    if (line.startsWith("TYPESAFE_API_KEY=")) {
      env.TYPESAFE_API_KEY = line
        .slice("TYPESAFE_API_KEY=".length)
        .trim()
        .replace(/^["']|["']$/gu, "");
      return undefined;
    }
  }
  return undefined;
}

class EnvFileUnreadableError extends Error {}

/** Parse the message list from JSON, `{messages: [...]}`, or JSONL text. */
export function parseTriageMessages(text: string): NormalizedTriageMessage[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("input is empty");
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed !== null &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { messages?: unknown }).messages)
        ? ((parsed as { messages: unknown[] }).messages as unknown[])
        : [parsed];
    if (entries.length === 0) {
      throw new Error("input contains no messages");
    }
    return entries.map((entry, index) => withIndexContext(entry, index));
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }
  const lines = text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
  if (lines.length === 0) {
    throw new Error("input contains no messages");
  }
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `input line ${index + 1} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }
    return withIndexContext(parsed, index);
  });
}

function withIndexContext(entry: unknown, index: number): NormalizedTriageMessage {
  try {
    return normalizeTriageMessage(entry);
  } catch (error) {
    throw new Error(
      `message ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

type ParsedArgs = {
  inputPath?: string;
  envFile?: string;
  logPath?: string;
  noLog: boolean;
  model?: string;
  hit?: number;
  miss?: number;
  help: boolean;
};

function parseNumber(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} expects a number, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { noLog: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    const next = (): string => {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      return value;
    };
    if (arg === "--env-file") {
      parsed.envFile = next();
    } else if (arg === "--log") {
      parsed.logPath = next();
    } else if (arg === "--no-log") {
      parsed.noLog = true;
    } else if (arg === "--model") {
      parsed.model = next();
    } else if (arg === "--hit") {
      parsed.hit = parseNumber("--hit", next());
    } else if (arg === "--miss") {
      parsed.miss = parseNumber("--miss", next());
    } else if (arg === "-h" || arg === "--help") {
      parsed.help = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (parsed.inputPath === undefined) {
      parsed.inputPath = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return parsed;
}

function errorExitCode(error: unknown): { code: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof EnvFileUnreadableError) {
    return { code: TRIAGE_EXIT.inputUnreadable, message };
  }
  if (error instanceof JevTriageDisabled) {
    return { code: TRIAGE_EXIT.notConfigured, message };
  }
  if (error instanceof JevNotConfigured) {
    return { code: TRIAGE_EXIT.notConfigured, message };
  }
  if (error instanceof JevDecisionError || error instanceof JevError) {
    return { code: TRIAGE_EXIT.decisionFailed, message };
  }
  return { code: TRIAGE_EXIT.badInput, message };
}

/** Run the CLI; returns the process exit code instead of exiting. */
export async function runTriageCli(
  argv: readonly string[],
  overrides: Partial<TriageCliDeps> = {},
): Promise<number> {
  const deps = defaultDeps(overrides);
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    deps.stderr(`error: ${error instanceof Error ? error.message : String(error)}`);
    return TRIAGE_EXIT.badInput;
  }
  if (args.help) {
    deps.stdout(USAGE);
    return TRIAGE_EXIT.ok;
  }

  if (args.envFile !== undefined) {
    try {
      await loadEnvFile(args.envFile, deps.env, deps.readTextFile);
    } catch (error) {
      const { code, message } = errorExitCode(error);
      deps.stderr(`error: ${message}`);
      return code;
    }
  }

  let text: string;
  try {
    text =
      args.inputPath === undefined || args.inputPath === "-"
        ? await deps.readStdin()
        : await deps.readTextFile(args.inputPath);
  } catch (error) {
    deps.stderr(
      `error: cannot read input: ${error instanceof Error ? error.message : String(error)}`,
    );
    return TRIAGE_EXIT.inputUnreadable;
  }

  let messages: NormalizedTriageMessage[];
  try {
    messages = parseTriageMessages(text);
  } catch (error) {
    const { code, message } = errorExitCode(error);
    deps.stderr(`error: bad input: ${message}`);
    return code;
  }

  const options: TriageMessageOptions = {
    env: deps.env,
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.hit === undefined ? {} : { hit: args.hit }),
    ...(args.miss === undefined ? {} : { miss: args.miss }),
    ...(args.noLog ? { log: false } : {}),
    ...(args.logPath === undefined ? {} : { logPath: args.logPath }),
  };

  for (const [index, message] of messages.entries()) {
    let result: TriageResult;
    try {
      result = await deps.triage(message, options);
    } catch (error) {
      const { code, message: errorMessage } = errorExitCode(error);
      deps.stderr(`error: message ${index + 1}: ${errorMessage}`);
      return code;
    }
    deps.stdout(
      JSON.stringify({
        index,
        id: result.message.id ?? null,
        from: result.message.from,
        route: result.route,
        answers: {
          actionable: result.answers.actionable.probability,
          category: {
            label: result.answers.category.label,
            confidence: result.answers.category.confidence,
          },
          priority: {
            value: result.answers.priority.value,
            confidence: result.answers.priority.confidence,
          },
        },
        model: result.decision.model,
        latency_ms: result.decision.latencyMs,
        state_sha256: result.decision.stateSha256,
        decision_id: result.record?.decision_id ?? null,
        logged_to: result.logPath ?? null,
      }),
    );
  }
  return TRIAGE_EXIT.ok;
}

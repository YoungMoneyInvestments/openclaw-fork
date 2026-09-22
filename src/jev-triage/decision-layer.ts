/**
 * Jev (TypeSafe System One) decision layer — typed, calibrated branch judgments.
 *
 * TypeScript port of the estate-wide decision-layer contract (Python reference:
 * `~/Projects/jev-decision-layer/jev_decision_layer`; BrokerBridge Retail
 * `jev_decisions.py` remains the reference for that lane). Small, repetitive
 * judgments go to System One as typed questions (`noul` / `choice` / `score`)
 * with explicit criteria; code branches on the calibrated probability through
 * {@link route}; {@link recordDecision} appends a bounded, redacted record that
 * doubles as labeled data for the improvement loop.
 *
 * Guarantees — do not weaken these when adding callers:
 * - Advisory / branch-only. This layer never gates execution, money paths, or
 *   approvals; every caller keeps its canonical gates.
 * - Math, dates, and evidence checks stay in code. Jev judges only the
 *   judgment-shaped dimension (its documented weak spots are arithmetic,
 *   counting, date comparisons, indirect questions, and adversarial input).
 * - Fail closed per call. A missing key throws {@link JevNotConfigured} and any
 *   transport failure throws {@link JevDecisionError}. There is never a silent
 *   fallback value.
 * - No secrets in `state`, and the decision log never stores raw states: it
 *   stores a `state_sha256` plus a bounded, redacted `state_excerpt`.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  TypeSafeClient,
  choice as sdkChoice,
  noul as sdkNoul,
  score as sdkScore,
} from "@typesafe-ai/sdk";
import type {
  Fetch as SdkFetch,
  Logger as SdkLogger,
  LogLevel as SdkLogLevel,
  Question,
} from "@typesafe-ai/sdk";

export const JEV_DECISION_LOG_VERSION = "jev_decision_log.v1";

/** Question/answer caps shared with the Python core so logs stay comparable. */
export const JEV_LIMITS = {
  maxQuestionsPerDecision: 24,
  maxInstructionsChars: 2_000,
  maxExcerptChars: 500,
  maxRedactedStringChars: 2_000,
  maxRedactedListItems: 200,
  maxRedactDepth: 6,
} as const;

const QUESTION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|passwd|credential|authorization)/iu;

/** JSON-compatible value; the shape `state` accepts. */
export type JevJson = string | number | boolean | null | JevJson[] | { [key: string]: JevJson };

/** Base class for decision-layer failures. */
export class JevError extends Error {}

/** Raised when no TYPESAFE_API_KEY is available and no client was injected. */
export class JevNotConfigured extends JevError {}

/** Raised when the System One call failed or returned no usable answers. */
export class JevDecisionError extends JevError {}

/** Question kinds System One answers. */
export type JevQuestionKind = "noul" | "choice" | "score";

/** One validated typed question. Build through {@link noulQuestion} and friends. */
export type JevQuestion = {
  readonly name: string;
  readonly kind: JevQuestionKind;
  readonly instructions: string;
  readonly criteria?: Readonly<Record<string, string>> | readonly string[];
};

function assertQuestionName(name: string): void {
  if (!QUESTION_NAME_PATTERN.test(name)) {
    throw new Error(
      "question name must be lowercase [a-z0-9_] starting with a letter, max 64 chars",
    );
  }
}

function assertInstructions(instructions: string): void {
  if (typeof instructions !== "string" || instructions.trim().length === 0) {
    throw new Error("instructions are required");
  }
  if (instructions.length > JEV_LIMITS.maxInstructionsChars) {
    throw new Error(`instructions exceed ${JEV_LIMITS.maxInstructionsChars} characters`);
  }
}

/** Build a yes/no question whose answer is a calibrated probability. */
export function noulQuestion(
  name: string,
  instructions: string,
  criteria?: { true?: string; false?: string },
): JevQuestion {
  assertQuestionName(name);
  assertInstructions(instructions);
  const descriptions: Record<string, string> = {};
  for (const key of ["true", "false"] as const) {
    const value = criteria?.[key];
    if (value !== undefined) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("noul criteria descriptions must be non-blank strings");
      }
      descriptions[key] = value;
    }
  }
  return Object.freeze({
    name,
    kind: "noul" as const,
    instructions,
    ...(Object.keys(descriptions).length > 0 ? { criteria: Object.freeze(descriptions) } : {}),
  });
}

/** Build a question that selects one label from an explicit set. */
export function choiceQuestion(
  name: string,
  instructions: string,
  criteria: Readonly<Record<string, string>>,
): JevQuestion {
  assertQuestionName(name);
  assertInstructions(instructions);
  const labels = Object.keys(criteria);
  const descriptions = Object.values(criteria);
  if (
    labels.length < 2 ||
    descriptions.some((value) => typeof value !== "string" || value.trim().length === 0) ||
    labels.some((label) => label.trim().length === 0)
  ) {
    throw new Error("choice criteria must be >=2 non-blank label -> description strings");
  }
  return Object.freeze({
    name,
    kind: "choice" as const,
    instructions,
    criteria: Object.freeze({ ...criteria }),
  });
}

/** Build a question that scores against an ordered rubric starting at zero. */
export function scoreQuestion(
  name: string,
  instructions: string,
  criteria: readonly string[],
): JevQuestion {
  assertQuestionName(name);
  assertInstructions(instructions);
  if (
    criteria.length < 2 ||
    criteria.some((value) => typeof value !== "string" || value.trim().length === 0)
  ) {
    throw new Error("score criteria must be >=2 non-blank ordered level descriptions");
  }
  return Object.freeze({
    name,
    kind: "score" as const,
    instructions,
    criteria: Object.freeze([...criteria]),
  });
}

/** Validate questions and convert them into the SDK form, keyed by name. */
export function buildQuestions(questions: readonly JevQuestion[]): Record<string, Question> {
  if (questions.length === 0) {
    throw new Error("at least one question is required");
  }
  if (questions.length > JEV_LIMITS.maxQuestionsPerDecision) {
    throw new Error(`at most ${JEV_LIMITS.maxQuestionsPerDecision} questions per decision`);
  }
  const built: Record<string, Question> = {};
  for (const question of questions) {
    if (Object.hasOwn(built, question.name)) {
      throw new Error(`duplicate question name: ${question.name}`);
    }
    built[question.name] = toSdkQuestion(question);
  }
  return built;
}

function toSdkQuestion(question: JevQuestion): Question {
  if (question.kind === "noul") {
    const criteria = question.criteria as Readonly<Record<string, string>> | undefined;
    return criteria === undefined
      ? sdkNoul(question.instructions)
      : sdkNoul(question.instructions, { ...criteria });
  }
  if (question.kind === "choice") {
    return sdkChoice(question.instructions, {
      ...(question.criteria as Readonly<Record<string, string>>),
    });
  }
  const rubric = question.criteria as readonly string[];
  const [firstLevel, secondLevel, ...restLevels] = rubric;
  if (firstLevel === undefined || secondLevel === undefined) {
    throw new Error("score criteria must be >=2 non-blank ordered level descriptions");
  }
  return sdkScore(question.instructions, [firstLevel, secondLevel, ...restLevels]);
}

/**
 * Branch a calibrated probability: `hit` / `miss` by threshold, else `escalate`.
 *
 * The uncertain band (`miss < p < hit`) is the caller's escalation lane —
 * typically a bigger reasoning model or a human review, never silent action.
 */
export function route(
  probability: number,
  thresholds: { hit?: number; miss?: number } = {},
): "hit" | "miss" | "escalate" {
  const hit = thresholds.hit ?? 0.7;
  const miss = thresholds.miss ?? 0.3;
  if (!(miss >= 0 && miss < hit && hit <= 1)) {
    throw new Error("require 0 <= miss < hit <= 1");
  }
  if (
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  ) {
    throw new Error("probability must be a finite number in [0, 1]");
  }
  if (probability >= hit) {
    return "hit";
  }
  if (probability <= miss) {
    return "miss";
  }
  return "escalate";
}

/** One normalized answer: noul -> probability, choice -> label, score -> value. */
export type JevAnswer = {
  readonly name: string;
  readonly kind: JevQuestionKind;
  readonly value: number | string;
  readonly confidence?: number;
  readonly probabilities?: Record<string, number>;
};

/** One System One call's normalized outcome. Advisory data, never authority. */
export type JevDecision = {
  readonly model: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number;
  readonly stateSha256: string;
};

/** Minimal transport contract; the SDK client satisfies it structurally. */
export type JevClient = {
  systemOne: (
    request: { state: JevJson | null; questions: Record<string, Question>; model?: string },
    options?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<unknown>;
};

/** Response fields this layer reads; extra SDK fields are ignored on purpose. */
type RawSystemOneResponse = {
  model?: unknown;
  answers?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown } | null;
};

/** True when a TYPESAFE_API_KEY is present (never returns or logs the value). */
export function hasJevApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return readJevApiKey(env) !== undefined;
}

/**
 * Read the API key out of an environment, or `undefined` when absent/blank.
 * Only {@link createJevClient} consumes the return value; it is never logged,
 * recorded, or returned to callers.
 */
export function readJevApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = (env.TYPESAFE_API_KEY ?? "").trim();
  return key.length > 0 ? key : undefined;
}

function requireApiKey(env: NodeJS.ProcessEnv): void {
  if (!hasJevApiKey(env)) {
    throw new JevNotConfigured(
      "TYPESAFE_API_KEY is not set; export it (or pass --env-file to the CLI) before Jev decisions can run.",
    );
  }
}

/** Transport override for tests and callers that bring their own fetch. */
export type JevFetch = SdkFetch;

/** SDK log levels, re-exported so callers can opt into more or less noise. */
export type JevLogLevel = SdkLogLevel;

/** The accepted SDK log levels, in escalating verbosity order. */
export const JEV_LOG_LEVELS: readonly JevLogLevel[] = ["off", "error", "warn", "info", "debug"];

/**
 * SDK log level used unless a caller overrides it, pinned explicitly because
 * the SDK otherwise resolves `config.logLevel` -> ambient `TYPESAFE_LOG_LEVEL`
 * -> its own default: `info`/`debug` write to stdout through
 * `console.info`/`console.debug` (breaking the CLI's one-JSON-object-per-line
 * contract) and `debug` logs request bodies, i.e. message text. `off` cannot be
 * raised by the ambient environment.
 */
export const JEV_SDK_LOG_LEVEL_DEFAULT: JevLogLevel = "off";

/**
 * SDK logger routed to stderr, so no SDK diagnostic can ever contaminate the
 * stdout decision stream regardless of the configured level.
 */
const stderrSdkLogger: SdkLogger = {
  debug: (message, ...args) => writeSdkDiagnostic("debug", message, args),
  info: (message, ...args) => writeSdkDiagnostic("info", message, args),
  warn: (message, ...args) => writeSdkDiagnostic("warn", message, args),
  error: (message, ...args) => writeSdkDiagnostic("error", message, args),
};

function writeSdkDiagnostic(level: string, message: string, args: readonly unknown[]): void {
  const detail = args
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return "<unserializable>";
      }
    })
    .join(" ");
  process.stderr.write(`[jev-sdk] ${level} ${message}${detail.length > 0 ? ` ${detail}` : ""}\n`);
}

/** Transport knobs shared by {@link createJevClient}, {@link decide}, and triage. */
export type JevTransportOptions = {
  /** Injected fetch; tests stub this so no call can reach the network. */
  fetch?: JevFetch;
  /** SDK diagnostics; defaults to {@link JEV_SDK_LOG_LEVEL_DEFAULT}. */
  logLevel?: JevLogLevel;
};

/**
 * Default client factory. The SDK constructor reads the ambient environment
 * when `apiKey` is omitted, which would ignore a caller-supplied environment
 * (or silently authenticate as whatever key the process happens to hold), so
 * the key is read from `env` and passed explicitly. Refuses without a key.
 */
export function createJevClient(
  env: NodeJS.ProcessEnv = process.env,
  options: JevTransportOptions = {},
): JevClient {
  const apiKey = readJevApiKey(env);
  if (apiKey === undefined) {
    throw new JevNotConfigured(
      "TYPESAFE_API_KEY is not set; export it (or pass --env-file to the CLI) before Jev decisions can run.",
    );
  }
  const client = new TypeSafeClient({
    apiKey,
    logLevel: options.logLevel ?? JEV_SDK_LOG_LEVEL_DEFAULT,
    logger: stderrSdkLogger,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return client as unknown as JevClient;
}

/** Deterministic JSON used for state hashing (sorted keys, no undefined). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString()) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** `sha256` of the canonical state; the log's only link back to a raw state. */
export function stateSha256(state: unknown): string {
  return createHash("sha256").update(canonicalJson(state), "utf8").digest("hex");
}

function toOptionalInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return null;
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toProbabilityRecord(value: unknown): Record<string, number> | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const probabilities: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed = toOptionalNumber(raw);
    if (parsed !== undefined) {
      probabilities[key] = parsed;
    }
  }
  return probabilities;
}

/**
 * Normalize SDK answers. Unrecognized answer shapes are skipped for
 * forward-compatibility; a response with none left fails the decision.
 */
export function normalizeAnswers(response: unknown): Record<string, JevAnswer> {
  const raw = (response as RawSystemOneResponse | null)?.answers;
  const normalized: Record<string, JevAnswer> = {};
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [name, answer] of Object.entries(raw as Record<string, unknown>)) {
      if (answer === null || typeof answer !== "object") {
        continue;
      }
      const record = answer as Record<string, unknown>;
      const kind = record.type;
      if (kind === "noul") {
        const probability = toOptionalNumber(record.noul);
        if (probability !== undefined) {
          normalized[name] = { name, kind: "noul", value: probability };
        }
        continue;
      }
      if (kind === "choice") {
        const confidence = toOptionalNumber(record.confidence);
        if (typeof record.choice === "string" && confidence !== undefined) {
          const probabilities = toProbabilityRecord(record.probabilities);
          normalized[name] = {
            name,
            kind: "choice",
            value: record.choice,
            confidence,
            ...(probabilities === undefined ? {} : { probabilities }),
          };
        }
        continue;
      }
      if (kind === "score") {
        const confidence = toOptionalNumber(record.confidence);
        const value = toOptionalNumber(record.score);
        if (value !== undefined && confidence !== undefined) {
          const probabilities = toProbabilityRecord(record.probabilities);
          normalized[name] = {
            name,
            kind: "score",
            value,
            confidence,
            ...(probabilities === undefined ? {} : { probabilities }),
          };
        }
      }
    }
  }
  if (Object.keys(normalized).length === 0) {
    throw new JevDecisionError("Jev response contained no usable answers");
  }
  return normalized;
}

/** Options accepted by {@link decide}. */
export type DecideOptions = {
  state: JevJson | null;
  questions: readonly JevQuestion[];
  model?: string;
  /** Injected transport (tests, callers with a shared client). */
  client?: JevClient;
  /** Injected factory used instead of the default SDK client. */
  clientFactory?: () => JevClient;
  env?: NodeJS.ProcessEnv;
  /**
   * Transport override forwarded to the default SDK client. Tests stub this so
   * the real client, question serialization, and auth path run hermetically.
   */
  fetch?: JevFetch;
  /**
   * SDK log level for the default client. Defaults to
   * {@link JEV_SDK_LOG_LEVEL_DEFAULT} (`warn`, stderr only) so SDK diagnostics
   * cannot pollute stdout or emit message text.
   */
  logLevel?: JevLogLevel;
  /** Per-call timeout in milliseconds, forwarded to the transport. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * Run one System One decision. Fails closed; there is no fallback value.
 *
 * Injection order: `client`, then `clientFactory`, then the default SDK client
 * (built from `env`, which requires TYPESAFE_API_KEY). Any transport failure
 * becomes a {@link JevDecisionError}, so callers branch on success or refusal
 * only.
 */
export async function decide(options: DecideOptions): Promise<JevDecision> {
  const sdkQuestions = buildQuestions(options.questions);
  const env = options.env ?? process.env;
  let client = options.client;
  if (client === undefined) {
    const factory = options.clientFactory;
    if (factory === undefined) {
      requireApiKey(env);
      client = createJevClient(env, {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
      });
    } else {
      client = factory();
    }
  }
  const started = performance.now();
  let response: unknown;
  try {
    response = await client.systemOne(
      {
        state: options.state,
        questions: sdkQuestions,
        ...(options.model === undefined ? {} : { model: options.model }),
      },
      {
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
  } catch (error) {
    throw new JevDecisionError(
      `Jev decision failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  const latencyMs = Math.round((performance.now() - started) * 100) / 100;
  const raw = (response ?? {}) as RawSystemOneResponse;
  const usage = raw.usage ?? null;
  return {
    model: typeof raw.model === "string" ? raw.model : "",
    answers: normalizeAnswers(response),
    inputTokens: toOptionalInt(usage?.input_tokens),
    outputTokens: toOptionalInt(usage?.output_tokens),
    latencyMs,
    stateSha256: stateSha256(options.state),
  };
}

/**
 * Bound and scrub an arbitrary value for logging. Secret-named keys never
 * survive; strings, list lengths, and nesting depth are capped.
 */
export function redactState(value: unknown, depth = 0): unknown {
  if (depth >= JEV_LIMITS.maxRedactDepth) {
    return "<max-depth>";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value) ? String(value) : value;
  }
  if (typeof value === "string") {
    return value.length > JEV_LIMITS.maxRedactedStringChars
      ? `${value.slice(0, JEV_LIMITS.maxRedactedStringChars)}[truncated]`
      : value;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, JEV_LIMITS.maxRedactedListItems)
      .map((item) => redactState(item, depth + 1));
    if (value.length > JEV_LIMITS.maxRedactedListItems) {
      items.push(`<truncated: ${value.length} items>`);
    }
    return items;
  }
  if (typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = SECRET_KEY_PATTERN.test(key) ? "<redacted>" : redactState(item, depth + 1);
    }
    return redacted;
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return value.toString().slice(0, JEV_LIMITS.maxRedactedStringChars);
  }
  return "<unserializable>";
}

/** One JSONL decision record (`jev_decision_log.v1`). */
export type JevDecisionRecord = {
  version: string;
  decision_id: string;
  created_at: string;
  model: string;
  state_sha256: string;
  state_excerpt: string;
  context: Record<string, unknown>;
  answers: Record<string, Record<string, unknown>>;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
};

/** Build the bounded, redacted log record for one decision. */
export function buildDecisionRecord(
  decision: JevDecision,
  options: {
    state?: unknown;
    context?: Record<string, unknown>;
    decisionId?: string;
    createdAt?: string;
  } = {},
): JevDecisionRecord {
  const excerpt = canonicalJson(redactState(options.state ?? null));
  const answers: Record<string, Record<string, unknown>> = {};
  for (const [name, answer] of Object.entries(decision.answers)) {
    answers[name] = {
      kind: answer.kind,
      value: answer.value,
      ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
      ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities }),
    };
  }
  return {
    version: JEV_DECISION_LOG_VERSION,
    decision_id: options.decisionId ?? `jevd_${randomUUID().replaceAll("-", "")}`,
    created_at: options.createdAt ?? new Date().toISOString(),
    model: decision.model,
    state_sha256: decision.stateSha256,
    state_excerpt:
      excerpt.length > JEV_LIMITS.maxExcerptChars
        ? excerpt.slice(0, JEV_LIMITS.maxExcerptChars)
        : excerpt,
    context: (redactState(options.context ?? {}) as Record<string, unknown>) ?? {},
    answers,
    input_tokens: decision.inputTokens,
    output_tokens: decision.outputTokens,
    latency_ms: decision.latencyMs,
  };
}

/** `$JEV_DECISION_LOG` when set, else `~/.jev/decisions.jsonl`. */
export function defaultDecisionLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.JEV_DECISION_LOG ?? "").trim();
  return override.length > 0
    ? path.resolve(override.replace(/^~(?=\/|$)/u, homedir()))
    : path.join(homedir(), ".jev", "decisions.jsonl");
}

/**
 * The slice of `fs.promises.FileHandle` the log writer needs, so tests can pass
 * a fake handle and assert the order of operations.
 */
export type LogFileHandle = {
  chmod: (mode: number) => Promise<void>;
  appendFile: (data: string, options?: { encoding?: BufferEncoding }) => Promise<void>;
  close: () => Promise<void>;
};

async function openLogFile(logPath: string): Promise<LogFileHandle> {
  return open(logPath, "a", 0o600);
}

/**
 * Append one JSONL record, handle-based so the permission repair cannot be
 * skipped or reordered: open (0600 when it creates the file) -> chmod 0600 ->
 * append through the same handle -> close. A failed chmod aborts with no write,
 * so the record never exists under group/other permissions, not even
 * transiently. The directory is a separate story: `--log` / `JEV_DECISION_LOG`
 * may point at a caller-managed directory, so it is only tightened when this
 * call created it. Failures propagate (fail loud).
 */
export async function appendDecisionLog(
  logPath: string,
  record: JevDecisionRecord,
  /** Handle opener override for tests; defaults to `fs.promises.open`. */
  openLog: (logPath: string) => Promise<LogFileHandle> = openLogFile,
): Promise<void> {
  const directory = path.dirname(logPath);
  const directoryExisted = await pathExists(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await openLog(logPath);
  try {
    await handle.chmod(0o600);
    await handle.appendFile(`${JSON.stringify(record)}\n`, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
  if (!directoryExisted) {
    await chmod(directory, 0o700);
  }
}

/** True when the path exists; any other stat failure propagates. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Build and append the decision record; returns it for callers that want it. */
export async function recordDecision(
  decision: JevDecision,
  options: {
    state?: unknown;
    context?: Record<string, unknown>;
    logPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<JevDecisionRecord> {
  const record = buildDecisionRecord(decision, { state: options.state, context: options.context });
  await appendDecisionLog(
    options.logPath ?? defaultDecisionLogPath(options.env ?? process.env),
    record,
  );
  return record;
}

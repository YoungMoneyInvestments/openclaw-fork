/**
 * Jev message triage — typed, calibrated triage for one inbound message.
 *
 * The "1,700 emails for 18 cents" use case: each message becomes one System One
 * call asking three typed questions —
 * `actionable` (noul: is a human response actually needed?),
 * `category` (choice: which lane does it belong to?),
 * `priority` (score: how urgent is it?) — and code branches on the calibrated
 * probability through {@link route}. Advisory only: this module classifies and
 * routes; it never sends, replies, archives, or executes anything.
 *
 * Fail-closed contract (see `decision-layer.ts`):
 * - `JEV_TRIAGE_DISABLED` set to a truthy value refuses before any call.
 * - A missing TYPESAFE_API_KEY throws `JevNotConfigured`; a transport failure
 *   throws `JevDecisionError`. No fallback category, priority, or route.
 * - The state sent to Jev never carries secrets; the log stores a hash plus a
 *   bounded, redacted excerpt, never the raw message.
 */

import {
  JevDecisionError,
  JevError,
  buildQuestions,
  choiceQuestion,
  decide,
  defaultDecisionLogPath,
  noulQuestion,
  recordDecision,
  route,
  scoreQuestion,
  type JevAnswer,
  type JevClient,
  type JevDecision,
  type JevDecisionRecord,
  type JevQuestion,
} from "./decision-layer.js";

/** Question-set version; bump when labels, rubric, or instructions change. */
export const TRIAGE_QUESTION_SET_VERSION = "openclaw_message_triage.v1";

/** Default thresholds for the `actionable` route. */
export const TRIAGE_ROUTE_DEFAULTS = { hit: 0.7, miss: 0.3 } as const;

/** Input caps; longer fields are truncated before they reach Jev or the log. */
export const TRIAGE_MESSAGE_LIMITS = {
  fromChars: 320,
  subjectChars: 500,
  bodyChars: 8_000,
  truncationMarker: "[truncated]",
} as const;

/**
 * Category labels. Chosen for the messages this gateway already sees (member
 * mail, trade questions, billing, business coordination, personal notes, and
 * bulk/automated mail); retune through the slow loop rather than in place.
 */
export const TRIAGE_CATEGORIES = {
  member_support:
    "A member, learner, or customer needs help: access, onboarding, account, or how-to questions.",
  trade_idea:
    "Market, strategy, position, or trade-plan discussion that may need a trading answer.",
  billing: "Payments, invoices, refunds, subscriptions, credits, or plan changes.",
  business:
    "Partnerships, vendors, press, recruiting, legal, or scheduling with an external counterparty.",
  personal: "Friends, family, or personal coordination with no business content.",
  noise: "Automated notifications, newsletters, receipts, and unsolicited bulk or marketing mail.",
} as const;

/** Priority rubric, indexed from zero; `score` may land between levels. */
export const TRIAGE_PRIORITY_RUBRIC: readonly string[] = [
  "No action needed: informational, background, or already handled.",
  "Low: worth handling this week; no cost to waiting a day or two.",
  "Normal: should be handled today during working hours.",
  "High: time-sensitive today; delay costs money, trust, or an opportunity.",
  "Critical: same-hour attention needed (outage, money at risk, live incident, angry customer).",
];

const ACTIONABLE_CRITERIA = {
  true: "The message asks for a decision, answer, or action from the recipient, or reports a problem only the recipient can resolve.",
  false:
    "The message needs no reply or action from the recipient: FYI notes, receipts, newsletters, marketing, or automated status mail.",
} as const;

/** The triage question set, built once at module scope. */
export const TRIAGE_QUESTIONS: readonly JevQuestion[] = Object.freeze([
  noulQuestion(
    "actionable",
    "Does this message need a reply or action from the recipient, rather than being informational, automated, or bulk mail?",
    ACTIONABLE_CRITERIA,
  ),
  choiceQuestion(
    "category",
    "Which single category best describes what this message is about?",
    TRIAGE_CATEGORIES,
  ),
  scoreQuestion(
    "priority",
    "How urgent is this message, using the rubric?",
    TRIAGE_PRIORITY_RUBRIC,
  ),
]);

/** Question names in the order they are asked. */
export const TRIAGE_QUESTION_NAMES = ["actionable", "category", "priority"] as const;

/** Raised when the `JEV_TRIAGE_DISABLED` kill switch is engaged. */
export class JevTriageDisabled extends JevError {}

const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);

/** True when the kill switch disables triage calls for this process. */
export function isTriageDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has((env.JEV_TRIAGE_DISABLED ?? "").trim().toLowerCase());
}

function assertTriageEnabled(env: NodeJS.ProcessEnv): void {
  if (isTriageDisabled(env)) {
    throw new JevTriageDisabled(
      "Jev triage is disabled by JEV_TRIAGE_DISABLED; unset it to allow triage calls.",
    );
  }
}

/** One inbound message, exactly as the CLI and callers supply it. */
export type TriageMessageInput = {
  /** Sender identity, e.g. `"discord:1234"` or an email address. */
  from: string;
  subject: string;
  body: string;
  /** ISO-8601 timestamp; validated here (dates stay in code), never compared. */
  received_at: string;
  /** Optional stable id; logged in place of the raw message. */
  id?: string;
};

/** A validated message with field caps applied. */
export type NormalizedTriageMessage = {
  from: string;
  subject: string;
  body: string;
  received_at: string;
  id?: string;
};

function capText(value: string, maxChars: number): string {
  return value.length > maxChars
    ? `${value.slice(0, maxChars)}${TRIAGE_MESSAGE_LIMITS.truncationMarker}`
    : value;
}

function requireStringField(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`message field "${field}" must be a non-empty string`);
  }
  return value;
}

/** Validate and bound one message. Throws plain `Error` on bad input. */
export function normalizeTriageMessage(input: unknown): NormalizedTriageMessage {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("message must be a JSON object");
  }
  const record = input as Record<string, unknown>;
  const from = requireStringField(record, "from");
  const receivedAt = requireStringField(record, "received_at");
  if (Number.isNaN(Date.parse(receivedAt))) {
    throw new Error(
      `message field "received_at" must be an ISO-8601 timestamp, got ${JSON.stringify(receivedAt)}`,
    );
  }
  const subject =
    typeof record.subject === "string" ? record.subject : record.subject === undefined ? "" : null;
  const body =
    typeof record.body === "string" ? record.body : record.body === undefined ? "" : null;
  if (subject === null) {
    throw new Error('message field "subject" must be a string when present');
  }
  if (body === null) {
    throw new Error('message field "body" must be a string when present');
  }
  const id = record.id;
  if (id !== undefined && (typeof id !== "string" || id.trim().length === 0)) {
    throw new Error('message field "id" must be a non-empty string when present');
  }
  return {
    from: capText(from, TRIAGE_MESSAGE_LIMITS.fromChars),
    subject: capText(subject, TRIAGE_MESSAGE_LIMITS.subjectChars),
    body: capText(body, TRIAGE_MESSAGE_LIMITS.bodyChars),
    received_at: receivedAt,
    ...(id === undefined ? {} : { id }),
  };
}

/** The exact state object sent to Jev for one message. */
export function triageState(message: NormalizedTriageMessage): Record<string, string> {
  return {
    surface: "openclaw.message",
    message_id: message.id ?? "",
    from: message.from,
    subject: message.subject,
    body: message.body,
    received_at: message.received_at,
  };
}

/** Typed triage answers; malformed shapes fail the call, never default. */
export type TriageAnswers = {
  actionable: { probability: number };
  category: {
    label: keyof typeof TRIAGE_CATEGORIES;
    confidence: number;
    probabilities: Record<string, number>;
  };
  priority: { value: number; confidence: number; probabilities: Record<string, number> };
};

/** Route verdict for the `actionable` question. */
export type TriageRoute = {
  name: "actionable";
  probability: number;
  hit: number;
  miss: number;
  decision: "hit" | "miss" | "escalate";
};

/** Options accepted by {@link triageMessage}. */
export type TriageMessageOptions = {
  /** Injected transport; omit to use the SDK client (requires the API key). */
  client?: JevClient;
  /** Injected client factory used instead of the SDK client. */
  clientFactory?: () => JevClient;
  /** Model override, e.g. `"jev-1.13.0"`. */
  model?: string;
  hit?: number;
  miss?: number;
  /** Extra redacted context for the decision log. */
  context?: Record<string, unknown>;
  /** Decision-log path; defaults to `$JEV_DECISION_LOG` or `~/.jev/decisions.jsonl`. */
  logPath?: string;
  /** Set false to skip the decision log for this call. */
  log?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
};
/** One message's triage outcome. */
export type TriageResult = {
  message: NormalizedTriageMessage;
  answers: TriageAnswers;
  route: TriageRoute;
  decision: JevDecision;
  record?: JevDecisionRecord;
  logPath?: string;
};

function readAnswer(
  decision: JevDecision,
  name: string,
  kind: "noul" | "choice" | "score",
): JevAnswer {
  const answer = decision.answers[name];
  if (answer === undefined) {
    throw new JevDecisionError(`Jev response is missing the ${name} answer`);
  }
  if (answer.kind !== kind) {
    throw new JevDecisionError(`Jev answer ${name} is ${answer.kind}, expected ${kind}`);
  }
  return answer;
}

/** Extract the typed triage answers; any missing or unexpected shape refuses. */
export function readTriageAnswers(decision: JevDecision): TriageAnswers {
  const actionable = readAnswer(decision, "actionable", "noul");
  const category = readAnswer(decision, "category", "choice");
  const priority = readAnswer(decision, "priority", "score");
  const label = String(category.value);
  if (!Object.hasOwn(TRIAGE_CATEGORIES, label)) {
    throw new JevDecisionError(
      `Jev returned category ${JSON.stringify(label)}, which is not one of ${Object.keys(TRIAGE_CATEGORIES).join(", ")}`,
    );
  }
  if (typeof actionable.value !== "number" || typeof priority.value !== "number") {
    throw new JevDecisionError("Jev returned non-numeric answers for actionable/priority");
  }
  return {
    actionable: { probability: actionable.value },
    category: {
      label: label as keyof typeof TRIAGE_CATEGORIES,
      confidence: category.confidence ?? 0,
      probabilities: category.probabilities ?? {},
    },
    priority: {
      value: priority.value,
      confidence: priority.confidence ?? 0,
      probabilities: priority.probabilities ?? {},
    },
  };
}

/**
 * Triage one message. Fails closed: kill switch, missing key, or transport
 * failure refuses; there is never a fallback classification.
 */
export async function triageMessage(
  /** Raw message; validated by {@link normalizeTriageMessage}. */
  input: unknown,
  options: TriageMessageOptions = {},
): Promise<TriageResult> {
  const env = options.env ?? process.env;
  assertTriageEnabled(env);
  const message = normalizeTriageMessage(input);
  const hit = options.hit ?? TRIAGE_ROUTE_DEFAULTS.hit;
  const miss = options.miss ?? TRIAGE_ROUTE_DEFAULTS.miss;
  const state = triageState(message);
  const decision = await decide({
    state,
    questions: TRIAGE_QUESTIONS,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
    env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const answers = readTriageAnswers(decision);
  const routeDecision = route(answers.actionable.probability, { hit, miss });
  const result: TriageResult = {
    message,
    answers,
    route: {
      name: "actionable",
      probability: answers.actionable.probability,
      hit,
      miss,
      decision: routeDecision,
    },
    decision,
  };
  if (options.log === false) {
    return result;
  }
  const logPath = options.logPath ?? defaultDecisionLogPath(env);
  const record = await recordDecision(decision, {
    state,
    context: {
      surface: "openclaw.message",
      question_set: TRIAGE_QUESTION_SET_VERSION,
      message_id: message.id ?? null,
      route: { name: "actionable", decision: routeDecision, hit, miss },
      ...options.context,
    },
    logPath,
    env,
  });
  return { ...result, record, logPath };
}

/** Validate the triage question set against the SDK at import time. */
buildQuestions(TRIAGE_QUESTIONS);

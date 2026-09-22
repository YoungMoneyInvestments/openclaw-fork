/**
 * Hermetic tests for the message triage unit: typed questions, message
 * normalization, routing, kill switch, and the redacted decision log.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { JevDecisionError, JevNotConfigured, type JevClient } from "./decision-layer.js";
import {
  JevTriageDisabled,
  TRIAGE_CATEGORIES,
  TRIAGE_PRIORITY_RUBRIC,
  TRIAGE_QUESTIONS,
  TRIAGE_QUESTION_SET_VERSION,
  isTriageDisabled,
  normalizeTriageMessage,
  readTriageAnswers,
  triageMessage,
  triageState,
  type TriageAnswers,
} from "./triage.js";
import { useHermeticJevEnv } from "./triage.test-support.js";

useHermeticJevEnv();

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const MESSAGE = {
  id: "msg-1",
  from: "member@example.com",
  subject: "I cannot access the members area",
  body: "I paid yesterday but the login still says access denied.",
  received_at: "2026-09-21T15:04:05Z",
};

type AnswersOverride = {
  probability?: number;
  category?: string;
  priority?: number;
};

function triageResponse(override: AnswersOverride = {}): unknown {
  return {
    model: "jev-1.13.0",
    answers: {
      actionable: { type: "noul", noul: override.probability ?? 0.93 },
      category: {
        type: "choice",
        choice: override.category ?? "member_support",
        confidence: 0.81,
        probabilities: { member_support: 0.81, noise: 0.05 },
      },
      priority: {
        type: "score",
        score: override.priority ?? 2.4,
        confidence: 0.62,
        legend: {},
        probabilities: { "2": 0.5, "3": 0.3 },
      },
    },
    usage: { input_tokens: 431, output_tokens: 0 },
  };
}

function fakeClient(response: unknown = triageResponse()): { client: JevClient; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      systemOne: async (request: unknown) => {
        calls.push(request);
        return response;
      },
    },
  };
}

function logPath(): string {
  return path.join(tempDirs.make("openclaw-jev-triage-"), "decisions.jsonl");
}

describe("triage question set", () => {
  it("asks one noul, one choice, and one score question", () => {
    expect(TRIAGE_QUESTIONS.map((question) => [question.name, question.kind])).toEqual([
      ["actionable", "noul"],
      ["category", "choice"],
      ["priority", "score"],
    ]);
    expect(Object.keys(TRIAGE_QUESTIONS[1]?.criteria ?? {})).toEqual(
      Object.keys(TRIAGE_CATEGORIES),
    );
    expect(TRIAGE_QUESTIONS[2]?.criteria).toEqual(TRIAGE_PRIORITY_RUBRIC);
    expect(TRIAGE_QUESTION_SET_VERSION).toBe("openclaw_message_triage.v1");
  });
});

describe("normalizeTriageMessage", () => {
  it("validates required fields and bounds long text", () => {
    const normalized = normalizeTriageMessage({
      ...MESSAGE,
      subject: "s".repeat(600),
      body: "b".repeat(9_000),
    });
    expect(normalized.subject.length).toBe(500 + "[truncated]".length);
    expect(normalized.subject.endsWith("[truncated]")).toBe(true);
    expect(normalized.body.length).toBe(8_000 + "[truncated]".length);
    expect(normalized.body.endsWith("[truncated]")).toBe(true);
    expect(normalized.id).toBe("msg-1");
  });

  it("rejects malformed messages", () => {
    expect(() => normalizeTriageMessage("nope")).toThrow(/must be a JSON object/u);
    expect(() => normalizeTriageMessage([MESSAGE])).toThrow(/must be a JSON object/u);
    expect(() => normalizeTriageMessage({ ...MESSAGE, from: "" })).toThrow(
      /"from" must be a non-empty string/u,
    );
    expect(() => normalizeTriageMessage({ ...MESSAGE, received_at: undefined })).toThrow(
      /"received_at"/u,
    );
    expect(() => normalizeTriageMessage({ ...MESSAGE, received_at: "yesterday" })).toThrow(
      /ISO-8601/u,
    );
    expect(() => normalizeTriageMessage({ ...MESSAGE, subject: 42 })).toThrow(
      /"subject" must be a string/u,
    );
    expect(() => normalizeTriageMessage({ ...MESSAGE, body: null })).toThrow(
      /"body" must be a string/u,
    );
    expect(() => normalizeTriageMessage({ ...MESSAGE, id: "  " })).toThrow(
      /"id" must be a non-empty string/u,
    );
  });

  it("allows a missing subject or body and keeps the state shape stable", () => {
    const normalized = normalizeTriageMessage({
      from: "bot@openclaw",
      received_at: "2026-09-21T15:04:05Z",
    });
    expect(normalized.subject).toBe("");
    expect(normalized.body).toBe("");
    expect(Object.keys(triageState(normalized))).toEqual([
      "surface",
      "message_id",
      "from",
      "subject",
      "body",
      "received_at",
    ]);
  });
});

describe("triageMessage", () => {
  it("returns typed answers plus a hit route and logs one redacted record", async () => {
    const { client, calls } = fakeClient();
    const log = logPath();
    const result = await triageMessage(MESSAGE, { client, logPath: log });
    expect(calls).toHaveLength(1);
    expect(result.answers.actionable.probability).toBe(0.93);
    expect(result.answers.category).toMatchObject({ label: "member_support", confidence: 0.81 });
    expect(result.answers.priority).toMatchObject({ value: 2.4, confidence: 0.62 });
    expect(result.route).toEqual({
      name: "actionable",
      probability: 0.93,
      hit: 0.7,
      miss: 0.3,
      decision: "hit",
    });
    expect(result.decision.model).toBe("jev-1.13.0");

    const lines = readFileSync(log, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string) as {
      version: string;
      context: Record<string, unknown>;
      state_excerpt: string;
      state_sha256: string;
      decision_id: string;
    };
    expect(record.version).toBe("jev_decision_log.v1");
    expect(record.context.question_set).toBe(TRIAGE_QUESTION_SET_VERSION);
    expect(record.context.route).toEqual({
      name: "actionable",
      decision: "hit",
      hit: 0.7,
      miss: 0.3,
    });
    expect(record.context.message_id).toBe("msg-1");
    expect(record.state_sha256).toBe(result.decision.stateSha256);
    expect(record.state_excerpt).toContain("member@example.com");
    expect(result.record?.decision_id).toBe(record.decision_id);
    expect(result.logPath).toBe(log);
  });

  it("routes the uncertain band to escalate and low probabilities to miss", async () => {
    const escalating = fakeClient(triageResponse({ probability: 0.5 }));
    const escalatingResult = await triageMessage(MESSAGE, {
      client: escalating.client,
      log: false,
    });
    expect(escalatingResult.route.decision).toBe("escalate");

    const missing = fakeClient(
      triageResponse({ probability: 0.05, category: "noise", priority: 0 }),
    );
    const missingResult = await triageMessage(MESSAGE, { client: missing.client, log: false });
    expect(missingResult.route.decision).toBe("miss");
    expect(missingResult.answers.category.label).toBe("noise");
    expect(missingResult.answers.priority.value).toBe(0);
  });

  it("honors custom thresholds and the model override", async () => {
    const { client, calls } = fakeClient(triageResponse({ probability: 0.5 }));
    const result = await triageMessage(MESSAGE, {
      client,
      hit: 0.45,
      miss: 0.2,
      model: "jev-1.13.0",
      log: false,
    });
    expect(result.route).toMatchObject({ decision: "hit", hit: 0.45, miss: 0.2 });
    expect((calls[0] as { model?: string }).model).toBe("jev-1.13.0");
  });

  it("refuses when the kill switch is engaged and never calls the transport", async () => {
    const { client, calls } = fakeClient();
    await expect(
      triageMessage(MESSAGE, { client, env: { JEV_TRIAGE_DISABLED: "1" }, log: false }),
    ).rejects.toBeInstanceOf(JevTriageDisabled);
    expect(calls).toHaveLength(0);
    expect(isTriageDisabled({ JEV_TRIAGE_DISABLED: "true" })).toBe(true);
    expect(isTriageDisabled({ JEV_TRIAGE_DISABLED: "0" })).toBe(false);
    expect(isTriageDisabled({})).toBe(false);
  });

  it("fails closed without a key instead of falling back", async () => {
    await expect(triageMessage(MESSAGE, { env: {}, log: false })).rejects.toBeInstanceOf(
      JevNotConfigured,
    );
  });

  it("rejects unexpected answer shapes instead of defaulting", async () => {
    const unknownCategory = fakeClient(triageResponse({ category: "not_a_category" }));
    await expect(
      triageMessage(MESSAGE, { client: unknownCategory.client, log: false }),
    ).rejects.toThrow(/not one of member_support/u);

    const missingPriority = fakeClient({
      model: "jev-1.13.0",
      answers: { actionable: { type: "noul", noul: 0.9 } },
    });
    await expect(
      triageMessage(MESSAGE, { client: missingPriority.client, log: false }),
    ).rejects.toBeInstanceOf(JevDecisionError);
  });

  it("keeps secrets out of the log and skips logging when asked", async () => {
    const { client } = fakeClient();
    const log = logPath();
    const result = await triageMessage(MESSAGE, {
      client,
      logPath: log,
      context: { api_key: "sk-live-123", note: "context stays bounded" },
    });
    const line = readFileSync(log, "utf8").trimEnd();
    expect(line).not.toContain("sk-live-123");
    expect((result.record?.context.api_key as string) ?? "").toBe("<redacted>");
    expect(result.record?.context.note).toBe("context stays bounded");

    const skipped = await triageMessage(MESSAGE, { client, logPath: logPath(), log: false });
    expect(skipped.record).toBeUndefined();
    expect(skipped.logPath).toBeUndefined();
  });

  it("never writes a log file when logging is disabled", async () => {
    const log = logPath();
    await triageMessage(MESSAGE, { client: fakeClient().client, logPath: log, log: false });
    expect(existsSync(log)).toBe(false);
  });

  it("uses an injected transport even when a key is present in the environment", async () => {
    const { client, calls } = fakeClient();
    const result = await triageMessage(MESSAGE, {
      client,
      env: { TYPESAFE_API_KEY: "not-a-real-key" },
      log: false,
    });
    expect(calls).toHaveLength(1);
    expect(result.route.decision).toBe("hit");
  });

  it("reads triage answers strictly", () => {
    const decision = {
      model: "jev-1.13.0",
      answers: {
        actionable: { name: "actionable", kind: "noul" as const, value: 0.9 },
        category: { name: "category", kind: "choice" as const, value: "billing", confidence: 0.7 },
        priority: { name: "priority", kind: "score" as const, value: 3.1, confidence: 0.5 },
      },
      inputTokens: null,
      outputTokens: null,
      latencyMs: 1,
      stateSha256: "0".repeat(64),
    };
    const answers: TriageAnswers = readTriageAnswers(decision);
    expect(answers.category.label).toBe("billing");
    expect(answers.priority.value).toBe(3.1);
  });
});

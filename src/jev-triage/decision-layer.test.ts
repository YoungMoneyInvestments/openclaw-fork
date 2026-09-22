/**
 * Hermetic tests for the Jev decision layer. No network, no key: every call
 * injects a transport, and `useHermeticJevEnv` clears any ambient key first.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  JevDecisionError,
  JevNotConfigured,
  buildQuestions,
  canonicalJson,
  choiceQuestion,
  createJevClient,
  decide,
  defaultDecisionLogPath,
  hasJevApiKey,
  normalizeAnswers,
  noulQuestion,
  readJevApiKey,
  recordDecision,
  redactState,
  route,
  scoreQuestion,
  stateSha256,
  appendDecisionLog,
  buildDecisionRecord,
  JEV_DECISION_LOG_VERSION,
  JEV_LIMITS,
  type JevClient,
  type JevFetch,
} from "./decision-layer.js";
import { useHermeticJevEnv } from "./triage.test-support.js";

useHermeticJevEnv();

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const MESSAGE_STATE = {
  surface: "openclaw.message",
  from: "member@example.com",
  subject: "Access",
  body: "I cannot log in to the members area.",
  received_at: "2026-09-21T12:00:00Z",
};

const LOG_RESPONSE = {
  model: "jev-1.13.0",
  answers: {
    actionable: { type: "noul", noul: 0.93 },
    category: {
      type: "choice",
      choice: "member_support",
      confidence: 0.81,
      probabilities: { member_support: 0.81 },
    },
    priority: {
      type: "score",
      score: 2.4,
      confidence: 0.62,
      legend: {},
      probabilities: { "2": 0.5, "3": 0.3 },
    },
  },
  usage: { input_tokens: 431, output_tokens: 0 },
};

function fakeClient(response: unknown = LOG_RESPONSE): { client: JevClient; calls: unknown[] } {
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

describe("route", () => {
  it("branches at the threshold boundaries and escalates the band between", () => {
    expect(route(0.93)).toBe("hit");
    expect(route(0.7)).toBe("hit");
    expect(route(0.5)).toBe("escalate");
    expect(route(0.3)).toBe("miss");
    expect(route(0.02)).toBe("miss");
  });

  it("honors custom thresholds and rejects invalid ones", () => {
    expect(route(0.5, { hit: 0.4, miss: 0.2 })).toBe("hit");
    expect(route(0.25, { hit: 0.4, miss: 0.2 })).toBe("escalate");
    expect(() => route(0.5, { hit: 0.2, miss: 0.4 })).toThrow(/miss < hit/u);
    expect(() => route(0.5, { hit: 1.2 })).toThrow(/miss < hit/u);
  });

  it("rejects probabilities outside [0, 1]", () => {
    expect(() => route(1.5)).toThrow(/finite number in \[0, 1\]/u);
    expect(() => route(Number.NaN)).toThrow(/finite number in \[0, 1\]/u);
    expect(() => route(-0.1)).toThrow(/finite number in \[0, 1\]/u);
  });
});

describe("question builders", () => {
  it("accepts typed questions and rejects malformed ones", () => {
    expect(
      noulQuestion("actionable", "Does it need a reply?", { true: "yes", false: "no" }).kind,
    ).toBe("noul");
    expect(choiceQuestion("category", "Which one?", { a: "A", b: "B" }).kind).toBe("choice");
    expect(scoreQuestion("priority", "How urgent?", ["low", "high"]).kind).toBe("score");

    expect(() => noulQuestion("Actionable", "q")).toThrow(/lowercase/u);
    expect(() => noulQuestion("1actionable", "q")).toThrow(/lowercase/u);
    expect(() => noulQuestion("a".repeat(65), "q")).toThrow(/max 64 chars/u);
    expect(() => noulQuestion("ok", "   ")).toThrow(/instructions are required/u);
    expect(() => noulQuestion("ok", "x".repeat(JEV_LIMITS.maxInstructionsChars + 1))).toThrow(
      /exceed/u,
    );
    expect(() => noulQuestion("ok", "q", { true: "" })).toThrow(/non-blank/u);
    expect(() => choiceQuestion("category", "q", { only: "one" })).toThrow(/>=2 non-blank/u);
    expect(() => scoreQuestion("priority", "q", ["only-one"])).toThrow(/>=2 non-blank/u);
  });

  it("builds SDK questions keyed by name and guards duplicates and caps", () => {
    const built = buildQuestions([
      noulQuestion("actionable", "Does it need a reply?", { true: "yes", false: "no" }),
      choiceQuestion("category", "Which one?", {
        member_support: "Member help",
        noise: "Bulk mail",
      }),
      scoreQuestion("priority", "How urgent?", ["low", "high"]),
    ]);
    expect(Object.keys(built)).toEqual(["actionable", "category", "priority"]);
    expect(built.actionable?.type).toBe("noul");
    expect(built.category?.type).toBe("choice");
    expect(built.priority?.type).toBe("score");

    expect(() => buildQuestions([])).toThrow(/at least one question/u);
    expect(() => buildQuestions([noulQuestion("dup", "q1"), noulQuestion("dup", "q2")])).toThrow(
      /duplicate question name/u,
    );
    const tooMany = Array.from({ length: JEV_LIMITS.maxQuestionsPerDecision + 1 }, (_, index) =>
      noulQuestion(`q_${index}`, "q"),
    );
    expect(() => buildQuestions(tooMany)).toThrow(/at most 24 questions/u);
  });
});

describe("decide", () => {
  it("normalizes answers, usage, latency, and the state hash", async () => {
    const { client, calls } = fakeClient();
    const decision = await decide({
      state: MESSAGE_STATE,
      questions: [noulQuestion("actionable", "Does it need a reply?")],
      client,
    });
    expect(calls).toHaveLength(1);
    expect(decision.model).toBe("jev-1.13.0");
    expect(decision.answers.actionable).toEqual({ name: "actionable", kind: "noul", value: 0.93 });
    expect(decision.answers.category?.value).toBe("member_support");
    expect(decision.answers.category?.confidence).toBeCloseTo(0.81);
    expect(decision.answers.priority?.value).toBeCloseTo(2.4);
    expect(decision.inputTokens).toBe(431);
    expect(decision.outputTokens).toBe(0);
    expect(decision.latencyMs).toBeGreaterThanOrEqual(0);
    expect(decision.stateSha256).toBe(stateSha256(MESSAGE_STATE));
    expect(decision.stateSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("sends the state and questions it was given", async () => {
    const { client, calls } = fakeClient();
    await decide({
      state: MESSAGE_STATE,
      questions: [
        noulQuestion("actionable", "Does it need a reply?", { true: "yes", false: "no" }),
      ],
      model: "jev-1.13.0",
      client,
    });
    const request = calls[0] as {
      state: unknown;
      questions: Record<string, { instructions?: unknown }>;
      model?: string;
    };
    expect(request.state).toEqual(MESSAGE_STATE);
    expect(request.model).toBe("jev-1.13.0");
    expect(Object.keys(request.questions)).toEqual(["actionable"]);
  });

  it("fails closed with no key and never constructs a transport", async () => {
    await expect(
      decide({ state: MESSAGE_STATE, questions: [noulQuestion("actionable", "q")], env: {} }),
    ).rejects.toBeInstanceOf(JevNotConfigured);
  });

  it("wraps transport failures as JevDecisionError", async () => {
    const client: JevClient = {
      systemOne: async () => {
        throw new Error("rate limited");
      },
    };
    await expect(
      decide({ state: MESSAGE_STATE, questions: [noulQuestion("actionable", "q")], client }),
    ).rejects.toThrow(/Jev decision failed: rate limited/u);
  });

  it("rejects responses without usable answers", async () => {
    const empty = fakeClient({ model: "jev-1.13.0", answers: {} });
    await expect(
      decide({
        state: MESSAGE_STATE,
        questions: [noulQuestion("actionable", "q")],
        client: empty.client,
      }),
    ).rejects.toBeInstanceOf(JevDecisionError);
    expect(() => normalizeAnswers({ answers: { actionable: { type: "unknown" } } })).toThrow(
      /no usable answers/u,
    );
  });

  it("reads the key only from the injected environment", () => {
    expect(hasJevApiKey({ TYPESAFE_API_KEY: "  " })).toBe(false);
    expect(hasJevApiKey({ TYPESAFE_API_KEY: "abc" })).toBe(true);
    expect(hasJevApiKey({})).toBe(false);
  });
});

describe("redactState", () => {
  it("scrubs secret-named keys and keeps ordinary fields", () => {
    const redacted = redactState({
      from: "member@example.com",
      api_key: "sk-live-123",
      nested: { authorization: "Bearer abc", TOKEN: "t", note: "keep me" },
    }) as Record<string, unknown>;
    expect(redacted.from).toBe("member@example.com");
    expect(redacted.api_key).toBe("<redacted>");
    const nested = redacted.nested as Record<string, unknown>;
    expect(nested.authorization).toBe("<redacted>");
    expect(nested.TOKEN).toBe("<redacted>");
    expect(nested.note).toBe("keep me");
    expect(JSON.stringify(redacted)).not.toContain("sk-live-123");
  });

  it("caps strings, list lengths, and depth", () => {
    const long = "x".repeat(JEV_LIMITS.maxRedactedStringChars + 10);
    expect(redactState(long)).toBe(`${"x".repeat(JEV_LIMITS.maxRedactedStringChars)}[truncated]`);
    const list = redactState(
      Array.from({ length: JEV_LIMITS.maxRedactedListItems + 5 }, () => 1),
    ) as unknown[];
    expect(list).toHaveLength(JEV_LIMITS.maxRedactedListItems + 1);
    expect(list.at(-1)).toBe(`<truncated: ${JEV_LIMITS.maxRedactedListItems + 5} items>`);
    let deep: unknown = "leaf";
    for (let index = 0; index < JEV_LIMITS.maxRedactDepth + 2; index += 1) {
      deep = { level: deep };
    }
    expect(canonicalJson(redactState(deep))).toContain("<max-depth>");
  });
});

describe("decision log", () => {
  it("writes a bounded, redacted JSONL record and never the raw state", async () => {
    const logPath = path.join(tempDirs.make("openclaw-jev-log-"), "decisions.jsonl");
    const { client } = fakeClient();
    const state = {
      ...MESSAGE_STATE,
      body: `secret body ${"y".repeat(JEV_LIMITS.maxExcerptChars * 2)}`,
    };
    const decision = await decide({
      state,
      questions: [noulQuestion("actionable", "q")],
      client,
    });
    const record = await recordDecision(decision, {
      state,
      context: { surface: "openclaw.message", api_key: "sk-live-123" },
      logPath,
    });
    expect(record.version).toBe(JEV_DECISION_LOG_VERSION);
    expect(record.decision_id).toMatch(/^jevd_[0-9a-f]{32}$/u);
    expect(record.state_sha256).toBe(decision.stateSha256);
    expect(record.state_excerpt.length).toBeLessThanOrEqual(JEV_LIMITS.maxExcerptChars);
    expect(record.context.api_key).toBe("<redacted>");
    expect(record.answers.actionable).toEqual({ kind: "noul", value: 0.93 });
    expect(record.answers.category).toEqual({
      kind: "choice",
      value: "member_support",
      confidence: 0.81,
      probabilities: { member_support: 0.81 },
    });

    const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as { decision_id: string; state_excerpt: string };
    expect(parsed.decision_id).toBe(record.decision_id);
    expect(lines[0]).not.toContain("sk-live-123");
    // The excerpt is capped, so the raw state can never appear in full.
    expect(parsed.state_excerpt.length).toBeLessThanOrEqual(JEV_LIMITS.maxExcerptChars);
    expect(lines[0]?.includes(state.body)).toBe(false);
  });

  it("keeps records comparable with the portable Python contract", () => {
    const decision = {
      model: "jev-1.13.0",
      answers: { actionable: { name: "actionable", kind: "noul" as const, value: 0.5 } },
      inputTokens: 400,
      outputTokens: 0,
      latencyMs: 812.5,
      stateSha256: "0".repeat(64),
    };
    const record = buildDecisionRecord(decision, {
      state: MESSAGE_STATE,
      context: { surface: "openclaw.message" },
      decisionId: "jevd_fixed",
      createdAt: "2026-09-21T12:00:00.000Z",
    });
    expect(Object.keys(record).toSorted()).toEqual(
      [
        "answers",
        "context",
        "created_at",
        "decision_id",
        "input_tokens",
        "latency_ms",
        "model",
        "output_tokens",
        "state_excerpt",
        "state_sha256",
        "version",
      ].toSorted(),
    );
    expect(record.state_excerpt).toContain("member@example.com");
  });

  it("appends one line per decision and creates parent directories", async () => {
    const root = tempDirs.make("openclaw-jev-append-");
    const logPath = path.join(root, "nested", "decisions.jsonl");
    const record = buildDecisionRecord(
      {
        model: "jev-1.13.0",
        answers: { actionable: { name: "actionable", kind: "noul", value: 0.93 } },
        inputTokens: null,
        outputTokens: null,
        latencyMs: 1,
        stateSha256: "1".repeat(64),
      },
      { state: MESSAGE_STATE },
    );
    await appendDecisionLog(logPath, record);
    await appendDecisionLog(logPath, { ...record, decision_id: "jevd_second" });
    const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1] as string) as { decision_id: string }).decision_id).toBe(
      "jevd_second",
    );
  });

  it("resolves the log path from JEV_DECISION_LOG then the home default", () => {
    expect(defaultDecisionLogPath({ JEV_DECISION_LOG: "/tmp/custom.jsonl" })).toBe(
      "/tmp/custom.jsonl",
    );
    expect(defaultDecisionLogPath({ JEV_DECISION_LOG: "  " })).toMatch(
      /\.jev[/\\]decisions\.jsonl$/u,
    );
    expect(defaultDecisionLogPath({})).toMatch(/\.jev[/\\]decisions\.jsonl$/u);
  });
});

describe("default transport", () => {
  /** Minimal SDK transport stub: records auth headers, returns a canned answer. */
  function stubFetch(): { fetch: JevFetch; auth: (string | null)[]; urls: string[] } {
    const auth: (string | null)[] = [];
    const urls: string[] = [];
    const fetch = (async (url: unknown, init?: RequestInit) => {
      urls.push(typeof url === "string" ? url : String(url));
      auth.push(new Headers(init?.headers).get("authorization"));
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { actionable: { type: "noul", noul: 0.77 } },
          usage: { input_tokens: 12, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as JevFetch;
    return { fetch, auth, urls };
  }

  it("authenticates with the injected environment's key, not the ambient one", async () => {
    process.env.TYPESAFE_API_KEY = "ambient-key-must-not-be-used";
    const stub = stubFetch();

    const decision = await decide({
      state: "ship it?",
      questions: [noulQuestion("actionable", "Is this actionable?")],
      env: { TYPESAFE_API_KEY: "env-scoped-key" },
      fetch: stub.fetch,
    });

    expect(stub.auth).toEqual(["Bearer env-scoped-key"]);
    expect(stub.urls).toEqual(["https://api.typesafe.ai/v1/systemone"]);
    expect(decision.answers.actionable).toEqual({
      name: "actionable",
      kind: "noul",
      value: 0.77,
    });
    expect(JSON.stringify(decision)).not.toContain("ambient-key-must-not-be-used");
  });

  it("refuses when the injected environment has no key, even if the process does", () => {
    process.env.TYPESAFE_API_KEY = "ambient-key-must-not-be-used";
    const stub = stubFetch();

    expect(() => createJevClient({}, stub.fetch)).toThrow(JevNotConfigured);
    expect(stub.auth).toEqual([]);
  });

  it("treats a blank key as missing and still resolves the real client otherwise", () => {
    expect(hasJevApiKey({ TYPESAFE_API_KEY: "   " })).toBe(false);
    expect(readJevApiKey({ TYPESAFE_API_KEY: " k " })).toBe("k");
    expect(() => createJevClient({ TYPESAFE_API_KEY: "  " })).toThrow(JevNotConfigured);
    expect(createJevClient({ TYPESAFE_API_KEY: "k" }, stubFetch().fetch)).toBeDefined();
  });
});

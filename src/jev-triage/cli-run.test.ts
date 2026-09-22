/**
 * Hermetic tests for the `jev-triage` CLI runner: input parsing, exit codes,
 * injected-env handling, and per-line JSON output. The triage dependency is a
 * stub, so no test touches the network or the decision layer's transport.
 */

import { describe, expect, it } from "vitest";
import {
  TRIAGE_EXIT,
  loadEnvFile,
  parseTriageMessages,
  runTriageCli,
  type TriageCliDeps,
} from "./cli-run.js";
import { JevDecisionError, JevNotConfigured } from "./decision-layer.js";
import {
  JevTriageDisabled,
  normalizeTriageMessage,
  type NormalizedTriageMessage,
  type TriageMessageOptions,
  type TriageResult,
} from "./triage.js";
import { useHermeticJevEnv } from "./triage.test-support.js";

useHermeticJevEnv();

function stubResult(
  message: NormalizedTriageMessage,
  options: TriageMessageOptions = {},
): TriageResult {
  const hit = options.hit ?? 0.7;
  const miss = options.miss ?? 0.3;
  return {
    message,
    answers: {
      actionable: { probability: 0.93 },
      category: {
        label: "member_support",
        confidence: 0.81,
        probabilities: { member_support: 0.81 },
      },
      priority: { value: 2.4, confidence: 0.62, probabilities: { "2": 0.5 } },
    },
    route: { name: "actionable", probability: 0.93, hit, miss, decision: "hit" },
    decision: {
      model: options.model ?? "jev-1.13.0",
      answers: {},
      inputTokens: 431,
      outputTokens: 0,
      latencyMs: 12.5,
      stateSha256: "a".repeat(64),
    },
    ...(options.log === false
      ? {}
      : {
          record: {
            version: "jev_decision_log.v1",
            decision_id: `jevd_${message.id ?? "anon"}`,
            created_at: "2026-09-21T15:04:05.000Z",
            model: "jev-1.13.0",
            state_sha256: "a".repeat(64),
            state_excerpt: "{}",
            context: {},
            answers: {},
            input_tokens: 431,
            output_tokens: 0,
            latency_ms: 12.5,
          },
          logPath: options.logPath ?? "/tmp/decisions.jsonl",
        }),
  };
}

type Harness = {
  stdout: string[];
  stderr: string[];
  env: NodeJS.ProcessEnv;
  files: Map<string, string>;
  stdin: string;
};

function harness(): Harness {
  return { stdout: [], stderr: [], env: {}, files: new Map(), stdin: "" };
}

function run(argv: readonly string[], test: Harness, overrides: Partial<TriageCliDeps> = {}) {
  return runTriageCli(argv, {
    stdout: (line) => test.stdout.push(line),
    stderr: (line) => test.stderr.push(line),
    env: test.env,
    readTextFile: async (filePath) => {
      const content = test.files.get(filePath);
      if (content === undefined) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return content;
    },
    readStdin: async () => test.stdin,
    ...overrides,
  });
}

describe("parseTriageMessages", () => {
  it("accepts an array, a messages wrapper, a single object, and JSONL", () => {
    const message = {
      from: "a@b.c",
      subject: "s",
      body: "b",
      received_at: "2026-09-21T15:04:05Z",
    };
    expect(parseTriageMessages(JSON.stringify([message, message]))).toHaveLength(2);
    expect(parseTriageMessages(JSON.stringify({ messages: [message] }))).toHaveLength(1);
    expect(parseTriageMessages(JSON.stringify(message))).toHaveLength(1);
    const jsonl = `${JSON.stringify(message)}\n\n${JSON.stringify({ ...message, id: "second" })}\n`;
    const parsed = parseTriageMessages(jsonl);
    expect(parsed.map((entry) => entry.id)).toEqual([undefined, "second"]);
  });

  it("rejects empty, malformed, and invalid input with context", () => {
    expect(() => parseTriageMessages("   ")).toThrow(/empty/u);
    expect(() => parseTriageMessages("[]")).toThrow(/no messages/u);
    expect(() => parseTriageMessages("{not json}")).toThrow(/line 1 is not valid JSON/u);
    expect(() => parseTriageMessages(JSON.stringify([{ from: "a@b.c" }]))).toThrow(
      /message 1: message field "received_at"/u,
    );
    expect(() => parseTriageMessages(JSON.stringify({ nope: true }))).toThrow(/message 1/u);
  });
});

describe("loadEnvFile", () => {
  it("sets TYPESAFE_API_KEY in the injected env and never returns the value", async () => {
    const env: NodeJS.ProcessEnv = {};
    await loadEnvFile(
      "/tmp/env",
      env,
      async () => 'OTHER=x\nTYPESAFE_API_KEY="sk-live-123"\nexport TYPESAFE_API_KEY=later\n',
    );
    expect(env.TYPESAFE_API_KEY).toBe("sk-live-123");

    const alreadySet: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "existing" };
    await loadEnvFile("/tmp/missing", alreadySet, async () => {
      throw new Error("should not read");
    });
    expect(alreadySet.TYPESAFE_API_KEY).toBe("existing");

    const noKey: NodeJS.ProcessEnv = {};
    await loadEnvFile("/tmp/env2", noKey, async () => "export FOO=1\n");
    expect(noKey.TYPESAFE_API_KEY).toBeUndefined();
  });
});

describe("runTriageCli", () => {
  const messages = JSON.stringify([
    {
      id: "m1",
      from: "member@example.com",
      subject: "Hi",
      body: "Help",
      received_at: "2026-09-21T15:04:05Z",
    },
    {
      id: "m2",
      from: "bot@openclaw",
      subject: "CI",
      body: "green",
      received_at: "2026-09-21T15:05:00Z",
    },
  ]);

  it("prints one JSON decision per message and exits 0", async () => {
    const test = harness();
    test.stdin = messages;
    const seen: NormalizedTriageMessage[] = [];
    const code = await run(["-"], test, {
      triage: async (message, options) => {
        seen.push(message);
        return stubResult(message, options);
      },
    });
    expect(code).toBe(TRIAGE_EXIT.ok);
    expect(test.stderr).toEqual([]);
    expect(test.stdout).toHaveLength(2);
    const first = JSON.parse(test.stdout[0] as string) as Record<string, unknown>;
    expect(first.index).toBe(0);
    expect(first.id).toBe("m1");
    expect(first.route).toEqual({
      name: "actionable",
      probability: 0.93,
      hit: 0.7,
      miss: 0.3,
      decision: "hit",
    });
    expect(first.answers).toEqual({
      actionable: 0.93,
      category: { label: "member_support", confidence: 0.81 },
      priority: { value: 2.4, confidence: 0.62 },
    });
    expect(first.decision_id).toBe("jevd_m1");
    expect(first.logged_to).toBe("/tmp/decisions.jsonl");
    expect(JSON.parse(test.stdout[1] as string).decision_id).toBe("jevd_m2");
    expect(seen.map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  it("forwards model, thresholds, and log flags to the triage call", async () => {
    const test = harness();
    test.stdin = messages;
    const options: TriageMessageOptions[] = [];
    const code = await run(
      ["-", "--model", "jev-1.13.0", "--hit", "0.4", "--miss", "0.1", "--log", "/tmp/custom.jsonl"],
      test,
      {
        triage: async (message, callOptions) => {
          options.push(callOptions ?? {});
          return stubResult(message, callOptions);
        },
      },
    );
    expect(code).toBe(TRIAGE_EXIT.ok);
    expect(options[0]).toMatchObject({
      model: "jev-1.13.0",
      hit: 0.4,
      miss: 0.1,
      logPath: "/tmp/custom.jsonl",
    });
    const parsed = JSON.parse(test.stdout[0] as string) as { logged_to: string };
    expect(parsed.logged_to).toBe("/tmp/custom.jsonl");
  });

  it("suppresses the log with --no-log", async () => {
    const test = harness();
    test.stdin = messages;
    const options: TriageMessageOptions[] = [];
    const code = await run(["-", "--no-log"], test, {
      triage: async (message, callOptions) => {
        options.push(callOptions ?? {});
        return stubResult(message, callOptions);
      },
    });
    expect(code).toBe(TRIAGE_EXIT.ok);
    expect(options[0]?.log).toBe(false);
    expect(JSON.parse(test.stdout[0] as string).logged_to).toBeNull();
  });

  it("prints usage and exits 0 for --help", async () => {
    const test = harness();
    const code = await run(["--help"], test);
    expect(code).toBe(TRIAGE_EXIT.ok);
    expect(test.stdout.join("\n")).toContain("Usage: jev-triage");
  });

  it("exits 2 for bad usage and bad input", async () => {
    const empty = harness();
    expect(await run([], empty)).toBe(TRIAGE_EXIT.badInput);
    expect(empty.stderr.join("\n")).toContain("error:");

    const unknown = harness();
    expect(await run(["--nope"], unknown)).toBe(TRIAGE_EXIT.badInput);
    expect(unknown.stderr.join("\n")).toContain("unknown option: --nope");

    const missingValue = harness();
    expect(await run(["--model"], missingValue)).toBe(TRIAGE_EXIT.badInput);
    expect(missingValue.stderr.join("\n")).toContain("--model needs a value");

    const badNumber = harness();
    expect(await run(["--hit", "abc"], badNumber)).toBe(TRIAGE_EXIT.badInput);

    const badInput = harness();
    badInput.stdin = '[{"from":"a@b.c"}]';
    expect(await run(["-"], badInput)).toBe(TRIAGE_EXIT.badInput);
    expect(badInput.stderr.join("\n")).toContain("received_at");
  });

  it("exits 5 when the input or env file is unreadable", async () => {
    const missingInput = harness();
    expect(await run(["/does/not/exist.json"], missingInput)).toBe(TRIAGE_EXIT.inputUnreadable);

    const missingEnv = harness();
    missingEnv.stdin = messages;
    expect(await run(["-", "--env-file", "/does/not/exist.env"], missingEnv)).toBe(
      TRIAGE_EXIT.inputUnreadable,
    );
  });

  it("loads the key from --env-file into the injected env without printing it", async () => {
    const test = harness();
    test.stdin = messages;
    test.files.set("/tmp/agents.env", 'TYPESAFE_API_KEY="sk-live-123"\n');
    const seenEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const code = await run(["-", "--env-file", "/tmp/agents.env"], test, {
      triage: async (message, options) => {
        seenEnvs.push(options?.env);
        return stubResult(message, options);
      },
    });
    expect(code).toBe(TRIAGE_EXIT.ok);
    expect(test.env.TYPESAFE_API_KEY).toBe("sk-live-123");
    expect(seenEnvs[0]?.TYPESAFE_API_KEY).toBe("sk-live-123");
    expect([...test.stdout, ...test.stderr].join("\n")).not.toContain("sk-live-123");
  });

  it("maps fail-closed refusals to exit 3 and decision failures to exit 4", async () => {
    const disabled = harness();
    disabled.stdin = messages;
    expect(
      await run(["-"], disabled, {
        triage: async () => {
          throw new JevTriageDisabled("disabled by kill switch");
        },
      }),
    ).toBe(TRIAGE_EXIT.notConfigured);
    expect(disabled.stderr.join("\n")).toContain("kill switch");

    const unconfigured = harness();
    unconfigured.stdin = messages;
    expect(
      await run(["-"], unconfigured, {
        triage: async () => {
          throw new JevNotConfigured("TYPESAFE_API_KEY is not set");
        },
      }),
    ).toBe(TRIAGE_EXIT.notConfigured);

    const failing = harness();
    failing.stdin = messages;
    let call = 0;
    const code = await run(["-"], failing, {
      triage: async (message, options) => {
        call += 1;
        if (call === 2) {
          throw new JevDecisionError("Jev decision failed: rate limited");
        }
        return stubResult(message, options);
      },
    });
    expect(code).toBe(TRIAGE_EXIT.decisionFailed);
    expect(failing.stdout).toHaveLength(1);
    expect(failing.stderr.join("\n")).toContain("message 2: Jev decision failed: rate limited");
  });

  it("normalizes messages before they reach the transport", async () => {
    const test = harness();
    test.stdin = JSON.stringify([
      { from: "a@b.c", subject: "s", body: "b".repeat(9_000), received_at: "2026-09-21T15:04:05Z" },
    ]);
    let captured: NormalizedTriageMessage | undefined;
    const code = await run(["-"], test, {
      triage: async (message, options) => {
        captured = message;
        return stubResult(message, options);
      },
    });
    expect(code).toBe(TRIAGE_EXIT.ok);
    expect(captured?.body.length).toBe(8_000 + "[truncated]".length);
    expect(captured).toEqual(normalizeTriageMessage(captured));
  });
});

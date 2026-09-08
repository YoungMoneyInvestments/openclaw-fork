import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";
import { markInterruptedStartupRun } from "./startup-run-repair.js";
import { createCronServiceState } from "./state.js";

// GAP-205: a gateway restart interrupting an in-flight cron run is not a
// genuine execution failure — the run is retried by the startup catch-up
// path (or its next scheduled tick) anyway. Before this fix,
// markInterruptedStartupRun fed the synthetic STARTUP_INTERRUPTED_ERROR
// through the same failure-alert path as a real failure, so every gateway
// restart paged the operator's configured failure-alert destination once
// per in-flight recurring job.
describe("markInterruptedStartupRun failure alert suppression", () => {
  it("does not dispatch a failure alert for a restart-interrupted run, even once the alert threshold is met", () => {
    const runningAtMs = Date.parse("2026-08-01T16:00:00.000Z");
    const nowMs = runningAtMs + 30_000;
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createCronServiceState({
      storePath: "/tmp/startup-run-repair-interrupted-alert.json",
      cronEnabled: true,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      sendCronFailureAlert,
    });
    const job: CronJob = {
      id: "restart-interrupted-recurring",
      name: "restart interrupted recurring",
      enabled: true,
      createdAtMs: runningAtMs - 60_000,
      updatedAtMs: runningAtMs,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: runningAtMs - 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "check thing" },
      // Configured alert route with the default after-2-failures threshold.
      failureAlert: { mode: "webhook", to: "https://alerts.example.test/cron" },
      // One prior consecutive failure: this interruption is the 2nd, which
      // meets the default alert threshold (after: 2) — the exact condition
      // that previously triggered a real alert dispatch.
      state: { runningAtMs, consecutiveErrors: 1 },
    };
    const deferredNotifications: Array<() => void> = [];

    markInterruptedStartupRun({
      state,
      job,
      runningAtMs,
      nowMs,
      deferredNotifications,
    });

    expect(job.state.consecutiveErrors).toBe(2);
    for (const notify of deferredNotifications) {
      notify();
    }
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
  });
});

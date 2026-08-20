import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const workerHarness = vi.hoisted(() => ({
  instances: [] as unknown[],
  workerData: [] as unknown[],
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await vi.importActual<typeof import("node:events")>("node:events");
  return {
    Worker: class extends EventEmitter {
      postMessage = vi.fn();
      terminate = vi.fn(async () => 1);

      constructor(_url: URL, options: { workerData?: unknown }) {
        super();
        workerHarness.instances.push(this);
        workerHarness.workerData.push(options.workerData);
      }
    },
  };
});

import { createTelegramIngressWorker } from "./telegram-ingress-worker.js";

type FakeWorker = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
};

function createWorker(): {
  handle: ReturnType<typeof createTelegramIngressWorker>;
  worker: FakeWorker;
} {
  const handle = createTelegramIngressWorker({
    token: "123456:test",
    accountId: "default",
    initialUpdateId: null,
    spoolDir: "/tmp/openclaw-telegram-worker-test",
  });
  const worker = workerHarness.instances.at(-1) as FakeWorker | undefined;
  if (!worker) {
    throw new Error("expected Telegram ingress worker");
  }
  return { handle, worker };
}

describe("stopTelegramIngressWorker", () => {
  afterEach(() => {
    vi.useRealTimers();
    workerHarness.instances.length = 0;
    workerHarness.workerData.length = 0;
  });

  it("assigns each worker a non-secret stable poller id", () => {
    createWorker();
    createWorker();
    const first = workerHarness.workerData.at(-2) as Record<string, unknown>;
    const second = workerHarness.workerData.at(-1) as Record<string, unknown>;

    expect(first.pollerId).toEqual(
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    );
    expect(first.pollerId).not.toContain("123456:test");
    expect(second.pollerId).not.toBe(first.pollerId);
  });

  it("preserves cooperative worker shutdown", async () => {
    vi.useFakeTimers();
    const { handle, worker } = createWorker();

    const stopping = handle.stop();
    worker.emit("exit", 0);
    await stopping;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(worker.postMessage).toHaveBeenCalledWith({ type: "stop" });
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("terminates a non-cooperative worker inside the channel stop budget", async () => {
    vi.useFakeTimers();
    const { handle, worker } = createWorker();

    const stopping = handle.stop();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(worker.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await stopping;

    expect(worker.postMessage).toHaveBeenCalledWith({ type: "stop" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

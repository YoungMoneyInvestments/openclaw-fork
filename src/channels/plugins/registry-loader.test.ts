// Regression cover for GAP-182: outbound adapter resolution must consult the
// AsyncLocalStorage-scoped plugin registry, not just the process-root one.
//
// `openclaw message send` runs under `loadPlugins: "never"` (src/cli/command-catalog.ts),
// so it never populates the process-root registry. It loads a caller-owned handle and
// publishes it through the scope that `createChannelHandler` wraps around outbound sends.
// Resolving only from the root therefore returned `undefined` for every direct-delivery
// channel (Discord, Slack, ...) and surfaced as "<channel> outbound adapter is unavailable."
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActivePluginRegistry: vi.fn(),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: mocks.getActivePluginRegistry,
}));

function registryWith(channelId: string, marker: string) {
  return {
    channels: [{ plugin: { id: channelId, outbound: { sendText: marker } } }],
  } as never;
}

describe("createChannelRegistryLoader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getActivePluginRegistry.mockReturnValue(null);
  });

  async function loadSendText(id: string) {
    const { createChannelRegistryLoader } = await import("./registry-loader.js");
    const load = createChannelRegistryLoader<{ sendText: string }>(
      (entry) => entry.plugin.outbound as unknown as { sendText: string },
    );
    return await load(id as never);
  }

  it("resolves from the scoped registry when the process root is empty", async () => {
    const { withPluginRuntimeRegistryScope } =
      await import("../../plugins/runtime/gateway-request-scope.js");

    const resolved = await withPluginRuntimeRegistryScope(
      registryWith("discord", "scoped"),
      async () => await loadSendText("discord"),
    );

    // Before the fix this returned undefined and the CLI threw
    // "discord outbound adapter is unavailable."
    expect(resolved).toEqual({ sendText: "scoped" });
  });

  it("still resolves from the process root when no scope is active", async () => {
    mocks.getActivePluginRegistry.mockReturnValue(registryWith("discord", "root"));

    expect(await loadSendText("discord")).toEqual({ sendText: "root" });
  });

  it("falls back to the process root when the scope lacks the channel", async () => {
    const { withPluginRuntimeRegistryScope } =
      await import("../../plugins/runtime/gateway-request-scope.js");
    mocks.getActivePluginRegistry.mockReturnValue(registryWith("discord", "root"));

    const resolved = await withPluginRuntimeRegistryScope(
      registryWith("telegram", "scoped"),
      async () => await loadSendText("discord"),
    );

    // The fallback is purely additive: a lookup that already succeeded against
    // the root must keep resolving exactly as before.
    expect(resolved).toEqual({ sendText: "root" });
  });

  it("returns undefined when neither registry has the channel", async () => {
    const { withPluginRuntimeRegistryScope } =
      await import("../../plugins/runtime/gateway-request-scope.js");

    const resolved = await withPluginRuntimeRegistryScope(
      registryWith("telegram", "scoped"),
      async () => await loadSendText("discord"),
    );

    expect(resolved).toBeUndefined();
  });
});

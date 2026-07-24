import { describe, expect, it, vi } from "vitest";
import {
  defineFleetMachineInventory,
  fleetMachineAllowsService,
  probeFleetMachine,
  type FleetMachineEndpointProbe,
  type FleetMachineRecord,
} from "./machine-inventory.js";

const HOST_KEY_ALIAS = "100.64.0.10";

function machine(overrides: Partial<FleetMachineRecord> = {}): FleetMachineRecord {
  return {
    id: "build-mac",
    roles: ["build-worker"],
    capabilities: ["node", "macos"],
    allowed_services: [],
    ssh: { user: "builder", hostKeyAlias: HOST_KEY_ALIAS },
    endpoints: {
      tailscale: { host: "100.64.0.10", port: 22 },
      mdns: { host: "build-mac.local", port: 22 },
      lan: { host: "192.168.1.10", port: 22 },
    },
    ...overrides,
  };
}

describe("fleet machine inventory", () => {
  it("indexes validated declarative records without changing endpoint priority", () => {
    const record = machine();
    const inventory = defineFleetMachineInventory([record]);

    expect(inventory.get("build-mac")).toBe(record);
    expect(fleetMachineAllowsService(record, "brokerbridge")).toBe(false);
    expect(() => defineFleetMachineInventory([record, record])).toThrow(
      "Duplicate fleet machine id",
    );
  });

  it.each([
    [{ id: " " }, "id must not be empty"],
    [{ ssh: { user: "", hostKeyAlias: HOST_KEY_ALIAS } }, "SSH user must not be empty"],
    [{ ssh: { user: "builder", hostKeyAlias: "" } }, "host-key alias must not be empty"],
    [{ endpoints: {} }, "must declare at least one endpoint"],
    [{ endpoints: { lan: { host: "lan", port: 0 } } }, "port must be between 1 and 65535"],
  ])("rejects invalid machine declarations", (overrides, message) => {
    expect(() => defineFleetMachineInventory([machine(overrides)])).toThrow(message);
  });
});

describe("fleet machine transport probe", () => {
  it("falls back from stale Tailscale to mDNS and keeps the pinned identity", async () => {
    const probeEndpoint = vi
      .fn<FleetMachineEndpointProbe>()
      .mockResolvedValueOnce({ status: "failed", code: "transport_unreachable" })
      .mockResolvedValueOnce({ status: "reachable" });

    const result = await probeFleetMachine({ machine: machine(), probeEndpoint });

    expect(result.status).toBe("reachable");
    if (result.status !== "reachable") {
      throw new Error("expected reachable machine");
    }
    expect(result.transport).toBe("mdns");
    expect(result.attempts.map((attempt) => attempt.transport)).toEqual(["tailscale", "mdns"]);
    expect(probeEndpoint).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        transport: "mdns",
        ssh: { user: "builder", hostKeyAlias: HOST_KEY_ALIAS },
      }),
    );
  });

  it("uses fixed transport order independent of endpoint object insertion order", async () => {
    const probeEndpoint = vi
      .fn<FleetMachineEndpointProbe>()
      .mockResolvedValueOnce({ status: "failed", code: "transport_unreachable" })
      .mockResolvedValueOnce({ status: "failed", code: "host_unreachable" })
      .mockResolvedValueOnce({ status: "reachable" });
    const record = machine({
      endpoints: {
        lan: { host: "192.168.1.10", port: 22 },
        mdns: { host: "build-mac.local", port: 22 },
        tailscale: { host: "100.64.0.10", port: 22 },
      },
    });

    const result = await probeFleetMachine({ machine: record, probeEndpoint });

    expect(result.attempts.map((attempt) => attempt.transport)).toEqual([
      "tailscale",
      "mdns",
      "lan",
    ]);
  });

  it.each(["auth_failed", "host_key_failed", "agent_unhealthy", "service_failed"] as const)(
    "does not bypass terminal %s errors through another transport",
    async (code) => {
      const probeEndpoint = vi.fn<FleetMachineEndpointProbe>().mockResolvedValue({
        status: "failed",
        code,
      });

      const result = await probeFleetMachine({ machine: machine(), probeEndpoint });

      expect(result).toMatchObject({ status: "failed", code });
      expect(probeEndpoint).toHaveBeenCalledTimes(1);
    },
  );

  it("reports missing capabilities without touching the network", async () => {
    const probeEndpoint = vi.fn<FleetMachineEndpointProbe>();

    const result = await probeFleetMachine({
      machine: machine(),
      probeEndpoint,
      requiredCapabilities: ["node", "xcode"],
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "capability_missing",
      missingCapabilities: ["xcode"],
      attempts: [],
    });
    expect(probeEndpoint).not.toHaveBeenCalled();
  });

  it("default-denies services before touching the network", async () => {
    const probeEndpoint = vi.fn<FleetMachineEndpointProbe>();

    const result = await probeFleetMachine({
      machine: machine(),
      probeEndpoint,
      requiredService: "brokerbridge",
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "service_not_allowed",
      requiredService: "brokerbridge",
      attempts: [],
    });
    expect(probeEndpoint).not.toHaveBeenCalled();
  });

  it("reports host failure only after exhausting route-level transport failures", async () => {
    const probeEndpoint = vi
      .fn<FleetMachineEndpointProbe>()
      .mockResolvedValueOnce({ status: "failed", code: "transport_unreachable" })
      .mockResolvedValueOnce({ status: "failed", code: "transport_unreachable" })
      .mockResolvedValueOnce({ status: "failed", code: "transport_unreachable" });

    await expect(probeFleetMachine({ machine: machine(), probeEndpoint })).resolves.toMatchObject({
      status: "failed",
      code: "host_unreachable",
    });
  });
});

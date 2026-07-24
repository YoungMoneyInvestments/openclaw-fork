import { describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../process/exec.js";
import type { FleetMachineProbeRequest } from "./machine-inventory.js";
import { createFleetMachineSshProbe } from "./machine-ssh-probe.js";

const REQUEST: FleetMachineProbeRequest = {
  machineId: "build-mac",
  transport: "mdns",
  endpoint: { host: "build-mac.local", port: 22 },
  ssh: { user: "builder", hostKeyAlias: "100.64.0.10" },
};

function result(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

describe("fleet machine SSH probe", () => {
  it("uses strict known-hosts checking and a stable host-key alias", async () => {
    const runCommand = vi.fn().mockResolvedValue(result());
    const probe = createFleetMachineSshProbe({
      runCommand,
      knownHostsPath: "/keys/known_hosts",
      sshPath: "/usr/bin/ssh",
    });

    await expect(probe(REQUEST)).resolves.toEqual({ status: "reachable" });
    const argv = runCommand.mock.calls[0]?.[0] as string[];
    expect(argv).toContain("StrictHostKeyChecking=yes");
    expect(argv).toContain("UpdateHostKeys=no");
    expect(argv).toContain("HostKeyAlias=100.64.0.10");
    expect(argv).toContain("UserKnownHostsFile=/keys/known_hosts");
    expect(argv).toContain("builder@build-mac.local");
    expect(argv).not.toContain("StrictHostKeyChecking=no");
  });

  it.each([
    ["Host key verification failed.", "host_key_failed"],
    ["Permission denied (publickey).", "auth_failed"],
    ["ssh: connect to host build-mac.local port 22: Operation timed out", "transport_unreachable"],
    ["ssh: connect to host build-mac.local port 22: Connection refused", "service_failed"],
    ["remote agent failed health check", "service_failed"],
  ] as const)("classifies %s", async (stderr, code) => {
    const probe = createFleetMachineSshProbe({
      runCommand: vi.fn().mockResolvedValue(result({ code: 255, stderr })),
    });

    await expect(probe(REQUEST)).resolves.toEqual({ status: "failed", code });
  });

  it("labels a stale Tailscale route as transport failure", async () => {
    const probe = createFleetMachineSshProbe({
      runCommand: vi.fn().mockResolvedValue(
        result({
          code: 255,
          stderr: "ssh: connect to host 100.64.0.10 port 22: Operation timed out",
        }),
      ),
    });

    await expect(
      probe({
        ...REQUEST,
        transport: "tailscale",
        endpoint: { host: "100.64.0.10", port: 22 },
      }),
    ).resolves.toEqual({ status: "failed", code: "transport_unreachable" });
  });
});

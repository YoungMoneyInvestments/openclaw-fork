import type { FleetMachineRecord } from "../src/fleet/machine-inventory.js";

export const FLEET_MACHINE_INVENTORY = [
  {
    id: "mbp2025",
    roles: ["orchestrator", "development"],
    capabilities: ["macos", "ssh", "codex"],
    allowed_services: ["brokerbridge", "arena", "cortex"],
    ssh: { user: "cameronbennion", hostKeyAlias: "100.72.87.115" },
    endpoints: {
      tailscale: { host: "100.72.87.115", port: 22 },
      mdns: { host: "mbp2025.local", port: 22 },
      lan: { host: "192.168.0.84", port: 22 },
    },
  },
  {
    id: "mbp2021",
    roles: ["development-worker"],
    capabilities: ["macos", "ssh", "claude-code"],
    allowed_services: [],
    ssh: { user: "cameronbennion", hostKeyAlias: "100.91.63.113" },
    endpoints: {
      tailscale: { host: "100.91.63.113", port: 22 },
      mdns: { host: "mbp2021.local", port: 22 },
      lan: { host: "192.168.0.191", port: 22 },
    },
  },
  {
    id: "mbp2016",
    roles: ["development-worker"],
    capabilities: ["macos", "ssh"],
    allowed_services: [],
    ssh: { user: "cameronbennion", hostKeyAlias: "100.80.133.87" },
    endpoints: {
      tailscale: { host: "100.80.133.87", port: 22 },
      mdns: { host: "mbp2016.local", port: 22 },
      lan: { host: "192.168.0.140", port: 22 },
    },
  },
] as const satisfies readonly FleetMachineRecord[];

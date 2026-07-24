const FLEET_MACHINE_TRANSPORT_ORDER = ["tailscale", "mdns", "lan"] as const;

type FleetMachineTransport = (typeof FLEET_MACHINE_TRANSPORT_ORDER)[number];

type FleetMachineEndpoint = {
  host: string;
  port: number;
};

export type FleetMachineRecord = {
  id: string;
  roles: readonly string[];
  capabilities: readonly string[];
  allowed_services: readonly string[];
  ssh: {
    user: string;
    hostKeyAlias: string;
  };
  endpoints: Partial<Record<FleetMachineTransport, FleetMachineEndpoint>>;
};

type FleetMachineProbeErrorCode =
  | "transport_unreachable"
  | "host_unreachable"
  | "auth_failed"
  | "host_key_failed"
  | "agent_unhealthy"
  | "service_failed"
  | "service_not_allowed"
  | "capability_missing";

export type FleetMachineEndpointProbeErrorCode = Exclude<
  FleetMachineProbeErrorCode,
  "capability_missing" | "service_not_allowed"
>;

type FleetMachineProbeAttempt = {
  transport: FleetMachineTransport;
  endpoint: FleetMachineEndpoint;
  result:
    | { status: "reachable" }
    | {
        status: "failed";
        code: FleetMachineEndpointProbeErrorCode;
      };
};

type FleetMachineProbeRequest = {
  machineId: string;
  transport: FleetMachineTransport;
  endpoint: FleetMachineEndpoint;
  ssh: FleetMachineRecord["ssh"];
};

export type FleetMachineEndpointProbe = (
  request: FleetMachineProbeRequest,
) => Promise<FleetMachineProbeAttempt["result"]>;

type FleetMachineProbeResult =
  | {
      status: "reachable";
      machine: FleetMachineRecord;
      transport: FleetMachineTransport;
      endpoint: FleetMachineEndpoint;
      attempts: readonly FleetMachineProbeAttempt[];
    }
  | {
      status: "failed";
      machine: FleetMachineRecord;
      code: FleetMachineProbeErrorCode;
      attempts: readonly FleetMachineProbeAttempt[];
      missingCapabilities?: readonly string[];
      requiredService?: string;
    };

const TERMINAL_PROBE_ERRORS = new Set<FleetMachineProbeErrorCode>([
  "auth_failed",
  "host_key_failed",
  "agent_unhealthy",
  "service_failed",
]);

function validateMachine(machine: FleetMachineRecord): void {
  if (!machine.id.trim()) {
    throw new Error("Fleet machine id must not be empty");
  }
  if (!machine.ssh.user.trim()) {
    throw new Error(`Fleet machine ${machine.id} SSH user must not be empty`);
  }
  if (!machine.ssh.hostKeyAlias.trim()) {
    throw new Error(`Fleet machine ${machine.id} SSH host-key alias must not be empty`);
  }
  const endpoints = FLEET_MACHINE_TRANSPORT_ORDER.flatMap((transport) => {
    const endpoint = machine.endpoints[transport];
    return endpoint ? [[transport, endpoint] as const] : [];
  });
  if (endpoints.length === 0) {
    throw new Error(`Fleet machine ${machine.id} must declare at least one endpoint`);
  }
  for (const [transport, endpoint] of endpoints) {
    if (!endpoint.host.trim()) {
      throw new Error(`Fleet machine ${machine.id} ${transport} host must not be empty`);
    }
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535) {
      throw new Error(`Fleet machine ${machine.id} ${transport} port must be between 1 and 65535`);
    }
  }
}

export function defineFleetMachineInventory(
  machines: readonly FleetMachineRecord[],
): ReadonlyMap<string, FleetMachineRecord> {
  const inventory = new Map<string, FleetMachineRecord>();
  for (const machine of machines) {
    validateMachine(machine);
    if (inventory.has(machine.id)) {
      throw new Error(`Duplicate fleet machine id: ${machine.id}`);
    }
    inventory.set(machine.id, machine);
  }
  return inventory;
}

function fleetMachineAllowsService(machine: FleetMachineRecord, service: string): boolean {
  return machine.allowed_services.includes(service);
}

export async function probeFleetMachine(params: {
  machine: FleetMachineRecord;
  probeEndpoint: FleetMachineEndpointProbe;
  requiredCapabilities?: readonly string[];
  requiredService?: string;
}): Promise<FleetMachineProbeResult> {
  validateMachine(params.machine);
  if (
    params.requiredService !== undefined &&
    !fleetMachineAllowsService(params.machine, params.requiredService)
  ) {
    return {
      status: "failed",
      machine: params.machine,
      code: "service_not_allowed",
      requiredService: params.requiredService,
      attempts: [],
    };
  }
  const requiredCapabilities = new Set(params.requiredCapabilities ?? []);
  const availableCapabilities = new Set(params.machine.capabilities);
  const missingCapabilities = [...requiredCapabilities].filter(
    (capability) => !availableCapabilities.has(capability),
  );
  if (missingCapabilities.length > 0) {
    return {
      status: "failed",
      machine: params.machine,
      code: "capability_missing",
      missingCapabilities,
      attempts: [],
    };
  }

  const attempts: FleetMachineProbeAttempt[] = [];
  for (const transport of FLEET_MACHINE_TRANSPORT_ORDER) {
    const endpoint = params.machine.endpoints[transport];
    if (!endpoint) {
      continue;
    }
    // Every transport receives one stable trust alias. Probe adapters must bind it
    // to strict known-hosts verification instead of learning a key on fallback.
    const result = await params.probeEndpoint({
      machineId: params.machine.id,
      transport,
      endpoint,
      ssh: params.machine.ssh,
    });
    attempts.push({ transport, endpoint, result });
    if (result.status === "reachable") {
      return {
        status: "reachable",
        machine: params.machine,
        transport,
        endpoint,
        attempts,
      };
    }
    if (TERMINAL_PROBE_ERRORS.has(result.code)) {
      return {
        status: "failed",
        machine: params.machine,
        code: result.code,
        attempts,
      };
    }
  }

  return {
    status: "failed",
    machine: params.machine,
    // Route failures become host-level failure only after every configured
    // transport has been exhausted.
    code: "host_unreachable",
    attempts,
  };
}

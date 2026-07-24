import { defineFleetMachineInventory, probeFleetMachine } from "../src/fleet/machine-inventory.js";
import { createFleetMachineSshProbe } from "../src/fleet/machine-ssh-probe.js";
import { FLEET_MACHINE_INVENTORY } from "./fleet-machine-inventory.js";

function readArguments(argv: readonly string[]): { machineIds: string[]; json: boolean } {
  const machineIds: string[] = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--machine") {
      const machineId = argv[index + 1]?.trim();
      if (!machineId) {
        throw new Error("--machine requires an inventory id");
      }
      machineIds.push(machineId);
      index += 1;
      continue;
    }
    throw new Error(`Unknown fleet probe argument: ${arg}`);
  }
  return { machineIds, json };
}

const args = readArguments(process.argv.slice(2));
const inventory = defineFleetMachineInventory(FLEET_MACHINE_INVENTORY);
const selected =
  args.machineIds.length === 0
    ? [...inventory.values()]
    : args.machineIds.map((machineId) => {
        const machine = inventory.get(machineId);
        if (!machine) {
          throw new Error(`Unknown fleet machine: ${machineId}`);
        }
        return machine;
      });
const probeEndpoint = createFleetMachineSshProbe();
const results = [];
for (const machine of selected) {
  results.push(await probeFleetMachine({ machine, probeEndpoint }));
}

if (args.json) {
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} else {
  for (const result of results) {
    if (result.status === "reachable") {
      process.stdout.write(
        `${result.machine.id}: reachable via ${result.transport} (${result.endpoint.host}:${result.endpoint.port})\n`,
      );
      continue;
    }
    process.stdout.write(
      `${result.machine.id}: failed (${result.code}); tried ${result.attempts.map((attempt) => attempt.transport).join(", ") || "none"}\n`,
    );
  }
}

if (results.some((result) => result.status === "failed")) {
  process.exitCode = 1;
}

import { describe, expect, it } from "vitest";
import { FLEET_MACHINE_INVENTORY } from "../../scripts/fleet-machine-inventory.js";
import { defineFleetMachineInventory, fleetMachineAllowsService } from "./machine-inventory.js";

describe("canonical fleet machine inventory", () => {
  const inventory = defineFleetMachineInventory(FLEET_MACHINE_INVENTORY);

  it("tracks all three Macs with exact current endpoints", () => {
    expect([...inventory.keys()]).toEqual(["mbp2025", "mbp2021", "mbp2016"]);
    expect(inventory.get("mbp2025")?.endpoints.lan?.host).toBe("192.168.0.84");
    expect(inventory.get("mbp2021")?.endpoints).toMatchObject({
      tailscale: { host: "100.91.63.113", port: 22 },
      mdns: { host: "mbp2021.local", port: 22 },
      lan: { host: "192.168.0.191", port: 22 },
    });
    expect(inventory.get("mbp2016")?.endpoints).toMatchObject({
      tailscale: { host: "100.80.133.87", port: 22 },
      mdns: { host: "mbp2016.local", port: 22 },
      lan: { host: "192.168.0.140", port: 22 },
    });
  });

  it("keeps production ownership on mbp2025 and default-denies secondary Macs", () => {
    const owner = inventory.get("mbp2025");
    const worker2021 = inventory.get("mbp2021");
    const worker2016 = inventory.get("mbp2016");
    expect(owner?.roles).toContain("orchestrator");
    expect(owner?.allowed_services).toEqual(["brokerbridge", "arena", "cortex"]);
    expect(worker2021?.allowed_services).toEqual([]);
    expect(worker2016?.allowed_services).toEqual([]);
    expect(owner && fleetMachineAllowsService(owner, "brokerbridge")).toBe(true);
    expect(worker2021 && fleetMachineAllowsService(worker2021, "brokerbridge")).toBe(false);
    expect(worker2016 && fleetMachineAllowsService(worker2016, "cortex")).toBe(false);
  });
});

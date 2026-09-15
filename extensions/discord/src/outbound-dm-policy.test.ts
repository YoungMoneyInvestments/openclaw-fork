import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, expect, it } from "vitest";
import { createDiscordOutboundDmPolicy } from "./outbound-dm-policy.js";

afterEach(() => clearRuntimeConfigSnapshot());
it("follows current account restrictions without changing open or pairing transport", () => {
  const cfg: OpenClawConfig = {
    channels: {
      discord: {
        dmPolicy: "allowlist",
        allowFrom: ["123"],
        accounts: { specialist: { allowFrom: ["456"] } },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  const read = createDiscordOutboundDmPolicy(cfg, "specialist");
  expect(read()).toEqual(["456"]);
  setRuntimeConfigSnapshot({
    channels: { discord: { dmPolicy: "allowlist", allowFrom: ["123"] } },
  });
  expect(read()).toEqual(["123"]);
  setRuntimeConfigSnapshot({ channels: { discord: { dmPolicy: "disabled" } } });
  expect(read()).toEqual([]);
  setRuntimeConfigSnapshot({ channels: { discord: { dmPolicy: "open", allowFrom: ["*"] } } });
  expect(read()).toBeUndefined();
  setRuntimeConfigSnapshot({ channels: { discord: { dmPolicy: "pairing" } } });
  expect(read()).toBeUndefined();
});

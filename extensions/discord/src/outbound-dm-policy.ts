import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  mergeDiscordAccountConfig,
  resolveDiscordAccountAllowFrom,
  resolveDiscordAccountDmPolicy,
} from "./accounts.js";

/** Reuse authored account DM restrictions for sends, not just inbound admission. */
export function createDiscordOutboundDmPolicy(cfg: OpenClawConfig, accountId: string) {
  const readConfig = createRuntimeConfigReader(cfg);
  return () => {
    const current = readConfig();
    const account = mergeDiscordAccountConfig(current, accountId);
    const policy = resolveDiscordAccountDmPolicy({ cfg: current, accountId });
    if (policy === "disabled" || account.dm?.enabled === false) return [];
    if (policy !== "allowlist") return undefined;
    return (resolveDiscordAccountAllowFrom({ cfg: current, accountId }) ?? []).filter(
      (recipient) => recipient === "*" || /^\d+$/.test(recipient),
    );
  };
}

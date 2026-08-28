/**
 * Lazy channel registry value loader.
 *
 * Resolves plugin sub-surfaces from the scoped registry when one is active,
 * otherwise from the process-root registry.
 */
import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { ChannelId } from "./channel-id.types.js";

type ChannelRegistryValueResolver<TValue> = (
  entry: PluginChannelRegistration,
) => TValue | undefined;

/**
 * Creates a lazy loader that resolves one value from the authoritative channel registry.
 */
export function createChannelRegistryLoader<TValue>(
  resolveValue: ChannelRegistryValueResolver<TValue>,
): (id: ChannelId) => Promise<TValue | undefined> {
  return async (id: ChannelId): Promise<TValue | undefined> => {
    const resolveFromRegistry = (
      registry: ReturnType<typeof getActivePluginRegistry> | undefined,
    ): TValue | undefined => {
      const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
      return pluginEntry ? resolveValue(pluginEntry) : undefined;
    };

    // Commands with `loadPlugins: "never"` (e.g. `openclaw message send`) never
    // populate the process-root registry; they load a caller-owned handle and
    // publish it through the AsyncLocalStorage scope that `createChannelHandler`
    // establishes around outbound sends. Reading only the process root therefore
    // resolved `undefined` for every direct-delivery channel and surfaced as
    // "<channel> outbound adapter is unavailable." Prefer the scoped registry,
    // then fall back to the root: purely additive, so a lookup that already
    // succeeded keeps resolving exactly as before.
    return (
      resolveFromRegistry(getPluginRuntimeGatewayRequestScope()?.pluginRegistry) ??
      resolveFromRegistry(getActivePluginRegistry())
    );
  };
}

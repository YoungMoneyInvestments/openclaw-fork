/**
 * Shared hermetic guard for the Jev triage test lane.
 *
 * Mirrors the Python port's autouse `_no_live_typesafe_key` fixture: every test
 * file in this lane calls {@link useHermeticJevEnv} at module scope, so no test
 * can pick up a developer's live TYPESAFE_API_KEY (or a leftover kill switch /
 * log path) from the ambient environment. Combined with injected clients in the
 * tests themselves, a paid live call is impossible: the only transport any test
 * can reach is the one it constructs.
 */

import { afterEach, beforeEach } from "vitest";

const MANAGED_ENV_KEYS = [
  "TYPESAFE_API_KEY",
  "TYPESAFE_LOG_LEVEL",
  "JEV_TRIAGE_DISABLED",
  "JEV_DECISION_LOG",
] as const;

/**
 * Clear Jev-related environment variables around every test in the file, and
 * replace `globalThis.fetch` with a refuser. The SDK resolves its transport at
 * call time (`config.fetch ?? globalThis.fetch`), so this is the backstop that
 * makes an accidental real call fail loudly instead of spending money or
 * leaking a message to the network.
 */
export function useHermeticJevEnv(): void {
  const saved = new Map<string, string | undefined>();
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    saved.clear();
    for (const key of MANAGED_ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    globalThis.fetch = ((input: unknown) => {
      throw new Error(
        `hermetic guard: a test attempted a real fetch (${String(input)}); inject a transport instead`,
      );
    }) as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

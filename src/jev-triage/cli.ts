/**
 * Entrypoint for `pnpm jev:triage`; the contract lives in `cli-run.ts`.
 *
 * Runs against the real SDK client (requires TYPESAFE_API_KEY), the real
 * process environment, and the real decision log. Exit codes:
 * 0 ok · 2 bad input/usage · 3 not configured · 4 decision failed · 5 input unreadable.
 */

import { runTriageCli } from "./cli-run.js";

process.exitCode = await runTriageCli(process.argv.slice(2));

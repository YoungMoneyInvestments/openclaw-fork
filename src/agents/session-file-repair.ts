import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";

type RepairReport = {
  repaired: boolean;
  droppedLines: number;
  backupPath?: string;
  reason?: string;
};

type SessionEntry = {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  [key: string]: unknown;
};

type SessionHeaderEntry = SessionEntry & {
  type: "session";
  id: string;
};

type SessionMessageEntry = SessionEntry & {
  type: "message";
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message: AgentMessage;
};

type TranscriptRepairReport = {
  entries: SessionEntry[];
  repaired: boolean;
  addedToolResults: number;
  droppedOrphanToolResults: number;
  droppedDuplicateToolResults: number;
};

function isSessionHeader(entry: unknown): entry is SessionHeaderEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; id?: unknown };
  return record.type === "session" && typeof record.id === "string" && record.id.length > 0;
}

function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === "message" && Boolean(entry.message) && typeof entry.message === "object";
}

function isAssistantMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
  return isMessageEntry(entry) && entry.message.role === "assistant";
}

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeToolResultMessage(message: AgentMessage, fallbackName?: string): AgentMessage {
  if ((message as { role?: unknown }).role !== "toolResult") {
    return message;
  }
  const toolResult = message as Extract<AgentMessage, { role: "toolResult" }>;
  const rawToolName = (toolResult as { toolName?: unknown }).toolName;
  const normalizedToolName = trimNonEmptyString(rawToolName);
  if (normalizedToolName) {
    if (rawToolName === normalizedToolName) {
      return toolResult;
    }
    return { ...toolResult, toolName: normalizedToolName };
  }

  const normalizedFallback = trimNonEmptyString(fallbackName);
  if (normalizedFallback) {
    return { ...toolResult, toolName: normalizedFallback };
  }

  if (typeof rawToolName === "string") {
    return { ...toolResult, toolName: "unknown" };
  }
  return toolResult;
}

function nextSyntheticEntryId(usedIds: Set<string>): string {
  let id = "";
  while (!id || usedIds.has(id)) {
    id = randomUUID().replace(/-/g, "").slice(0, 8);
  }
  usedIds.add(id);
  return id;
}

function cloneWithNormalizedMessage(
  entry: SessionMessageEntry,
  message: AgentMessage,
): SessionMessageEntry {
  if (entry.message === message) {
    return entry;
  }
  return { ...entry, message };
}

function rechainSessionEntries(entries: SessionEntry[], usedIds: Set<string>): SessionEntry[] {
  let previousId: string | null = null;
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    if (entry.type === "session") {
      return entry;
    }
    const next = { ...entry };
    let entryId = typeof next.id === "string" && next.id.length > 0 ? next.id : undefined;
    if (!entryId) {
      entryId = nextSyntheticEntryId(usedIds);
    }
    next.id = entryId;
    next.parentId = previousId;
    previousId = entryId;
    return next;
  });
}

function repairTranscriptEntries(entries: SessionEntry[]): TranscriptRepairReport {
  const usedIds = new Set(
    entries
      .map((entry) => entry?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const seenToolResultIds = new Set<string>();
  const out: SessionEntry[] = [];
  let repaired = false;
  let addedToolResults = 0;
  let droppedOrphanToolResults = 0;
  let droppedDuplicateToolResults = 0;

  for (let i = 0; i < entries.length; ) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") {
      out.push(entry);
      i += 1;
      continue;
    }
    if (!isMessageEntry(entry)) {
      out.push(entry);
      i += 1;
      continue;
    }

    const role = (entry.message as { role?: unknown }).role;
    if (role !== "assistant") {
      if (role === "toolResult") {
        droppedOrphanToolResults += 1;
        repaired = true;
      } else {
        out.push(entry);
      }
      i += 1;
      continue;
    }

    const sanitizedAssistantMessages = sanitizeToolCallInputs([entry.message]);
    if (sanitizedAssistantMessages.length === 0) {
      repaired = true;
      i += 1;
      continue;
    }

    const sanitizedAssistant = sanitizedAssistantMessages[0] as Extract<
      AgentMessage,
      { role: "assistant" }
    >;
    const assistantEntry = cloneWithNormalizedMessage(entry, sanitizedAssistant);
    if (assistantEntry !== entry) {
      repaired = true;
    }

    const stopReason = (sanitizedAssistant as { stopReason?: string }).stopReason;
    const toolCalls =
      stopReason === "aborted" || stopReason === "error"
        ? []
        : extractToolCallsFromAssistant(sanitizedAssistant);

    if (toolCalls.length === 0) {
      out.push(assistantEntry);
      i += 1;
      continue;
    }

    const toolCallIds = new Set(toolCalls.map((toolCall) => toolCall.id));
    const toolCallNamesById = new Map(
      toolCalls.map((toolCall) => [toolCall.id, toolCall.name] as const),
    );
    const spanResultsById = new Map<string, SessionMessageEntry>();
    const remainder: SessionEntry[] = [];
    let spanChanged = assistantEntry !== entry;
    let sawBlockingMessage = false;

    let j = i + 1;
    for (; j < entries.length; j += 1) {
      const nextEntry = entries[j];
      if (!nextEntry || typeof nextEntry !== "object") {
        remainder.push(nextEntry);
        continue;
      }
      if (isAssistantMessageEntry(nextEntry)) {
        break;
      }
      if (!isMessageEntry(nextEntry)) {
        remainder.push(nextEntry);
        continue;
      }
      const nextRole = (nextEntry.message as { role?: unknown }).role;
      if (nextRole === "toolResult") {
        const id = extractToolResultId(
          nextEntry.message as Extract<AgentMessage, { role: "toolResult" }>,
        );
        if (id && toolCallIds.has(id)) {
          if (seenToolResultIds.has(id) || spanResultsById.has(id)) {
            droppedDuplicateToolResults += 1;
            repaired = true;
            spanChanged = true;
            continue;
          }
          if (sawBlockingMessage) {
            repaired = true;
            spanChanged = true;
          }
          const normalizedResult = normalizeToolResultMessage(
            nextEntry.message,
            toolCallNamesById.get(id),
          );
          if (normalizedResult !== nextEntry.message) {
            repaired = true;
            spanChanged = true;
          }
          spanResultsById.set(id, cloneWithNormalizedMessage(nextEntry, normalizedResult));
          continue;
        }
        droppedOrphanToolResults += 1;
        repaired = true;
        spanChanged = true;
        continue;
      }
      sawBlockingMessage = true;
      remainder.push(nextEntry);
    }

    const missingToolCallIds = toolCalls
      .map((toolCall) => toolCall.id)
      .filter((toolCallId) => !spanResultsById.has(toolCallId));
    if (missingToolCallIds.length > 0) {
      repaired = true;
      spanChanged = true;
    }
    const needsRebuild = spanChanged;
    if (!needsRebuild) {
      out.push(entry);
      for (const toolCallId of spanResultsById.keys()) {
        seenToolResultIds.add(toolCallId);
      }
      for (let k = i + 1; k < j; k += 1) {
        out.push(entries[k]);
      }
      i = j;
      continue;
    }

    out.push(assistantEntry);
    for (const toolCall of toolCalls) {
      const existing = spanResultsById.get(toolCall.id);
      if (existing) {
        seenToolResultIds.add(toolCall.id);
        out.push(existing);
        continue;
      }
      addedToolResults += 1;
      seenToolResultIds.add(toolCall.id);
      out.push({
        type: "message",
        id: nextSyntheticEntryId(usedIds),
        parentId: null,
        timestamp: new Date().toISOString(),
        message: makeMissingToolResult({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        }),
      });
    }
    for (const remainderEntry of remainder) {
      out.push(remainderEntry);
    }
    i = j;
  }

  if (!repaired) {
    return {
      entries,
      repaired: false,
      addedToolResults: 0,
      droppedOrphanToolResults: 0,
      droppedDuplicateToolResults: 0,
    };
  }

  return {
    entries: rechainSessionEntries(out, usedIds),
    repaired: true,
    addedToolResults,
    droppedOrphanToolResults,
    droppedDuplicateToolResults,
  };
}

export async function repairSessionFileIfNeeded(params: {
  sessionFile: string;
  warn?: (message: string) => void;
}): Promise<RepairReport> {
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    return { repaired: false, droppedLines: 0, reason: "missing session file" };
  }

  let content: string;
  try {
    content = await fs.readFile(sessionFile, "utf-8");
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code;
    if (code === "ENOENT") {
      return { repaired: false, droppedLines: 0, reason: "missing session file" };
    }
    const reason = `failed to read session file: ${err instanceof Error ? err.message : "unknown error"}`;
    params.warn?.(`session file repair skipped: ${reason} (${path.basename(sessionFile)})`);
    return { repaired: false, droppedLines: 0, reason };
  }

  const lines = content.split(/\r?\n/);
  const entries: SessionEntry[] = [];
  let droppedLines = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as SessionEntry;
      entries.push(entry);
    } catch {
      droppedLines += 1;
    }
  }

  if (entries.length === 0) {
    return { repaired: false, droppedLines, reason: "empty session file" };
  }

  if (!isSessionHeader(entries[0])) {
    params.warn?.(
      `session file repair skipped: invalid session header (${path.basename(sessionFile)})`,
    );
    return { repaired: false, droppedLines, reason: "invalid session header" };
  }

  const transcriptRepair = repairTranscriptEntries(entries);
  if (droppedLines === 0 && !transcriptRepair.repaired) {
    return { repaired: false, droppedLines: 0 };
  }

  const cleanedEntries =
    droppedLines > 0 && !transcriptRepair.repaired
      ? rechainSessionEntries(entries, new Set())
      : transcriptRepair.entries;
  const cleaned = `${cleanedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const backupPath = `${sessionFile}.bak-${process.pid}-${Date.now()}`;
  const tmpPath = `${sessionFile}.repair-${process.pid}-${Date.now()}.tmp`;
  try {
    const stat = await fs.stat(sessionFile).catch(() => null);
    await fs.writeFile(backupPath, content, "utf-8");
    if (stat) {
      await fs.chmod(backupPath, stat.mode);
    }
    await fs.writeFile(tmpPath, cleaned, "utf-8");
    if (stat) {
      await fs.chmod(tmpPath, stat.mode);
    }
    await fs.rename(tmpPath, sessionFile);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch (cleanupErr) {
      params.warn?.(
        `session file repair cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : "unknown error"} (${path.basename(
          tmpPath,
        )})`,
      );
    }
    return {
      repaired: false,
      droppedLines,
      reason: `repair failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  const repairNotes: string[] = [];
  if (droppedLines > 0) {
    repairNotes.push(`dropped ${droppedLines} malformed line(s)`);
  }
  if (transcriptRepair.addedToolResults > 0) {
    repairNotes.push(`inserted ${transcriptRepair.addedToolResults} synthetic tool result(s)`);
  }
  if (transcriptRepair.droppedOrphanToolResults > 0) {
    repairNotes.push(`dropped ${transcriptRepair.droppedOrphanToolResults} orphan tool result(s)`);
  }
  if (transcriptRepair.droppedDuplicateToolResults > 0) {
    repairNotes.push(
      `dropped ${transcriptRepair.droppedDuplicateToolResults} duplicate tool result(s)`,
    );
  }
  if (repairNotes.length === 0) {
    repairNotes.push("normalized transcript ordering");
  }

  params.warn?.(`session file repaired: ${repairNotes.join("; ")} (${path.basename(sessionFile)})`);
  return { repaired: true, droppedLines, backupPath };
}

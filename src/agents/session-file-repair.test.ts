import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repairSessionFileIfNeeded } from "./session-file-repair.js";

function buildSessionHeaderAndMessage() {
  const header = {
    type: "session",
    version: 7,
    id: "session-1",
    timestamp: new Date().toISOString(),
    cwd: "/tmp",
  };
  const message = {
    type: "message",
    id: "msg-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "hello" },
  };
  return { header, message };
}

function buildMessageEntry(params: {
  id: string;
  parentId?: string | null;
  message: AgentMessage;
  timestamp?: string;
}) {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId ?? null,
    timestamp: params.timestamp ?? new Date().toISOString(),
    message: params.message,
  };
}

function buildCustomEntry(params: {
  id: string;
  parentId?: string | null;
  customType: string;
  data: unknown;
  timestamp?: string;
}) {
  return {
    type: "custom",
    customType: params.customType,
    data: params.data,
    id: params.id,
    parentId: params.parentId ?? null,
    timestamp: params.timestamp ?? new Date().toISOString(),
  };
}

const tempDirs: string[] = [];

async function createTempSessionPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-repair-"));
  tempDirs.push(dir);
  return { dir, file: path.join(dir, "session.jsonl") };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("repairSessionFileIfNeeded", () => {
  it("rewrites session files that contain malformed lines", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();

    const content = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n{"type":"message"`;
    await fs.writeFile(file, content, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });
    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(1);
    expect(result.backupPath).toBeTruthy();

    const repaired = await fs.readFile(file, "utf-8");
    expect(repaired.trim().split("\n")).toHaveLength(2);

    if (result.backupPath) {
      const backup = await fs.readFile(result.backupPath, "utf-8");
      expect(backup).toBe(content);
    }
  });

  it("does not drop CRLF-terminated JSONL lines", async () => {
    const { file } = await createTempSessionPath();
    const { header, message } = buildSessionHeaderAndMessage();
    const content = `${JSON.stringify(header)}\r\n${JSON.stringify(message)}\r\n`;
    await fs.writeFile(file, content, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });
    expect(result.repaired).toBe(false);
    expect(result.droppedLines).toBe(0);
  });

  it("leaves healthy assistant/tool-result spans untouched", async () => {
    const { file } = await createTempSessionPath();
    const { header } = buildSessionHeaderAndMessage();
    const assistant = buildMessageEntry({
      id: "assistant-1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_ok", name: "read", arguments: {} }],
        stopReason: "toolUse",
      } as AgentMessage,
    });
    const toolResult = buildMessageEntry({
      id: "tool-1",
      parentId: "assistant-1",
      message: {
        role: "toolResult",
        toolCallId: "call_ok",
        toolName: "read",
        content: [{ type: "text", text: "done" }],
        isError: false,
      } as AgentMessage,
    });
    const user = buildMessageEntry({
      id: "user-1",
      parentId: "tool-1",
      message: { role: "user", content: "continue" } as AgentMessage,
    });

    const content = [header, assistant, toolResult, user]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await fs.writeFile(file, `${content}\n`, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });
    expect(result.repaired).toBe(false);

    const repaired = await fs.readFile(file, "utf-8");
    expect(repaired).toBe(`${content}\n`);
  });

  it("drops orphan tool results that follow an aborted assistant tool call", async () => {
    const { file } = await createTempSessionPath();
    const { header } = buildSessionHeaderAndMessage();
    const assistant = buildMessageEntry({
      id: "assistant-1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_aborted", name: "exec", arguments: {} }],
        stopReason: "aborted",
      } as AgentMessage,
    });
    const toolResult = buildMessageEntry({
      id: "tool-1",
      parentId: "assistant-1",
      message: {
        role: "toolResult",
        toolCallId: "call_aborted",
        toolName: "exec",
        content: [{ type: "text", text: "partial" }],
        isError: false,
      } as AgentMessage,
    });
    const custom = buildCustomEntry({
      id: "custom-1",
      parentId: "tool-1",
      customType: "openclaw.cache-ttl",
      data: { ttl: 60 },
    });
    const user = buildMessageEntry({
      id: "user-1",
      parentId: "custom-1",
      message: { role: "user", content: "retrying" } as AgentMessage,
    });

    const content = [header, assistant, toolResult, custom, user]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await fs.writeFile(file, `${content}\n`, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });
    expect(result.repaired).toBe(true);

    const repaired = (await fs.readFile(file, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const repairedMessages = repaired.filter((entry) => entry.type === "message");

    expect(repairedMessages).toHaveLength(2);
    expect(repairedMessages.map((entry) => entry.message.role)).toEqual(["assistant", "user"]);
    expect(repaired[2]?.type).toBe("custom");
    expect(repaired[2]?.parentId).toBe("assistant-1");
    expect(repaired[3]?.id).toBe("user-1");
    expect(repaired[3]?.parentId).toBe("custom-1");
  });

  it("inserts a synthetic tool result before the next message and rechains later entries", async () => {
    const { file } = await createTempSessionPath();
    const { header } = buildSessionHeaderAndMessage();
    const assistant = buildMessageEntry({
      id: "assistant-1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_missing", name: "read", arguments: {} }],
        stopReason: "toolUse",
      } as AgentMessage,
    });
    const custom = buildCustomEntry({
      id: "custom-1",
      parentId: "assistant-1",
      customType: "openclaw.cache-ttl",
      data: { ttl: 120 },
    });
    const user = buildMessageEntry({
      id: "user-1",
      parentId: "custom-1",
      message: { role: "user", content: "continue" } as AgentMessage,
    });

    const content = [header, assistant, custom, user]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await fs.writeFile(file, `${content}\n`, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });
    expect(result.repaired).toBe(true);

    const repaired = (await fs.readFile(file, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const repairedMessages = repaired.filter((entry) => entry.type === "message");

    expect(repairedMessages).toHaveLength(3);
    expect(repairedMessages[0]?.message.role).toBe("assistant");
    expect(repairedMessages[1]?.message.role).toBe("toolResult");
    expect(repairedMessages[1]?.message.toolCallId).toBe("call_missing");
    expect(repairedMessages[1]?.message.isError).toBe(true);
    expect(repairedMessages[1]?.parentId).toBe("assistant-1");
    expect(repairedMessages[2]?.id).toBe("user-1");
    expect(repairedMessages[2]?.parentId).toBe("custom-1");
    expect(repaired[2]?.type).toBe("message");
    expect(repaired[3]?.type).toBe("custom");
    expect(repaired[3]?.parentId).toBe(repairedMessages[1]?.id);
  });

  it("warns and skips repair when the session header is invalid", async () => {
    const { file } = await createTempSessionPath();
    const badHeader = {
      type: "message",
      id: "msg-1",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "hello" },
    };
    const content = `${JSON.stringify(badHeader)}\n{"type":"message"`;
    await fs.writeFile(file, content, "utf-8");

    const warn = vi.fn();
    const result = await repairSessionFileIfNeeded({ sessionFile: file, warn });

    expect(result.repaired).toBe(false);
    expect(result.reason).toBe("invalid session header");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("invalid session header");
  });

  it("returns a detailed reason when read errors are not ENOENT", async () => {
    const { dir } = await createTempSessionPath();
    const warn = vi.fn();

    const result = await repairSessionFileIfNeeded({ sessionFile: dir, warn });

    expect(result.repaired).toBe(false);
    expect(result.reason).toContain("failed to read session file");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

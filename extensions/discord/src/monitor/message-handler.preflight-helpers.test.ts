// Discord mention-state helper tests: @everyone/@here must not count as bot mentions.
import { describe, expect, it } from "vitest";
import { resolveDiscordMentionState } from "./message-handler.preflight-helpers.js";

const BOT_ID = "openclaw-bot";

describe("resolveDiscordMentionState", () => {
  it("does not treat a DM as a guild mention", () => {
    expect(
      resolveDiscordMentionState({
        botId: BOT_ID,
        hasAnyMention: false,
        isDirectMessage: true,
        isExplicitlyMentioned: true,
        mentionRegexes: [],
        mentionText: `<@${BOT_ID}> hi`,
      }),
    ).toEqual({ implicitMentionKinds: [], wasMentioned: false });
  });

  it("does not treat @everyone or @here as mentioning this bot", () => {
    for (const mentionText of ["@everyone standup", "@here market open"]) {
      expect(
        resolveDiscordMentionState({
          botId: BOT_ID,
          hasAnyMention: true,
          isDirectMessage: false,
          isExplicitlyMentioned: false,
          mentionRegexes: [],
          mentionText,
        }),
      ).toEqual({ implicitMentionKinds: [], wasMentioned: false });
    }
  });

  it("treats an explicit bot user mention as mentioned", () => {
    expect(
      resolveDiscordMentionState({
        botId: BOT_ID,
        hasAnyMention: true,
        isDirectMessage: false,
        isExplicitlyMentioned: true,
        mentionRegexes: [],
        mentionText: `<@${BOT_ID}> @everyone standup`,
      }).wasMentioned,
    ).toBe(true);
  });

  it("records reply-to-bot as an implicit mention without flipping wasMentioned", () => {
    const result = resolveDiscordMentionState({
      botId: BOT_ID,
      hasAnyMention: false,
      isDirectMessage: false,
      isExplicitlyMentioned: false,
      mentionRegexes: [],
      mentionText: "following up",
      referencedAuthorId: BOT_ID,
    });
    expect(result.wasMentioned).toBe(false);
    expect(result.implicitMentionKinds).toEqual(["reply_to_bot"]);
  });
});

/**
 * `world.*` primitives mapped onto Mineflayer: chat, commands, and a
 * buffered chat-wait. The bot lifecycle (join/leave) is owned by
 * `HeadlessDriver`; these are the stateless verbs over an existing bot.
 */
import type { Bot } from "mineflayer";
import type { ChatFilter, ChatLine } from "@mc-test/protocol";

/** A buffered inbound chat line. */
export interface ChatRecord {
  seq: number;
  plain: string;
}

/** Whether a chat line satisfies a `world.waitForChat` filter. */
export function matchChat(filter: ChatFilter | undefined, plain: string): boolean {
  if (!filter) return true;
  if (filter.contains !== undefined && !plain.toLowerCase().includes(filter.contains.toLowerCase())) {
    return false;
  }
  if (filter.regex !== undefined) {
    try {
      if (!new RegExp(filter.regex).test(plain)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Send a plain chat message. */
export function sendChat(bot: Bot, message: string): void {
  bot.chat(message);
}

/** Run a slash command (leading `/` optional). */
export function runCommand(bot: Bot, command: string): void {
  bot.chat(command.startsWith("/") ? command : `/${command}`);
}

/**
 * Block until a chat line matches the filter (or timeout). Scans the buffer
 * first so a line that already arrived is not missed (closes the race between
 * a click and the chat it triggers).
 */
export function waitForChat(
  bot: Bot,
  buffer: readonly ChatRecord[],
  filter: ChatFilter | undefined,
  timeoutMs: number,
): Promise<ChatLine> {
  for (const rec of buffer) {
    if (matchChat(filter, rec.plain)) {
      return Promise.resolve({ text: rec.plain, sender: "server", channel: "system" });
    }
  }
  return new Promise<ChatLine>((resolve, reject) => {
    const onMsg = (msg: string): void => {
      if (matchChat(filter, msg)) {
        cleanup();
        resolve({ text: msg, sender: "server", channel: "system" });
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("waitForChat timeout"));
    }, timeoutMs);
    function cleanup(): void {
      bot.removeListener("messagestr", onMsg as never);
      clearTimeout(timer);
    }
    bot.on("messagestr", onMsg as never);
  });
}

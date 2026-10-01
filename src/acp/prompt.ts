import { BridgeError } from "../errors.js";

/**
 * The bridge advertises image and audio as unsupported. Reject them here so a
 * harness does not see a prompt the phone was told not to send.
 */
export function assertSupportedPrompt(params: unknown): void {
  if (!params || typeof params !== "object") return;
  const prompt = (params as { prompt?: unknown }).prompt;
  if (!Array.isArray(prompt)) return;
  for (const block of prompt) {
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: unknown }).type;
    if (type === "image" || type === "audio") {
      throw new BridgeError(-32602, `prompt content type ${String(type)} is not supported`, {
        type,
      });
    }
  }
}

/** First text block, used as a session title until the agent sets one. */
export function firstPromptText(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const prompt = (params as { prompt?: unknown }).prompt;
  if (!Array.isArray(prompt)) return "";
  const parts: string[] = [];
  for (const block of prompt) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

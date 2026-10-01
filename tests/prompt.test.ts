import { describe, expect, it } from "vitest";
import { assertSupportedPrompt, firstPromptText } from "../src/acp/prompt.js";

describe("prompt content", () => {
  it("rejects image and audio blocks and keeps text for the title", () => {
    expect(() =>
      assertSupportedPrompt({ prompt: [{ type: "image", data: "aa" }] }),
    ).toThrow(/image is not supported/);
    expect(() =>
      assertSupportedPrompt({ prompt: [{ type: "audio", data: "aa" }] }),
    ).toThrow(/audio is not supported/);
    expect(() =>
      assertSupportedPrompt({ prompt: [{ type: "text", text: "hello" }] }),
    ).not.toThrow();
    expect(
      firstPromptText({
        prompt: [
          { type: "text", text: "  hello\n" },
          { type: "text", text: "bridge  " },
        ],
      }),
    ).toBe("hello bridge");
  });
});
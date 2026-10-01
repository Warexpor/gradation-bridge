import { describe, expect, it } from "vitest";
import {
  elicitationSupportFromInitialize,
  ElicitationRejected,
  relayElicitationParams,
  sanitizeElicitationResponse,
} from "../src/acp/elicitation.js";

const both = { form: true, url: true };

describe("elicitation relay checks", () => {
  it("reads explicit form and url capabilities", () => {
    expect(elicitationSupportFromInitialize({})).toEqual({ form: false, url: false });
    expect(
      elicitationSupportFromInitialize({
        clientCapabilities: { elicitation: { form: {}, url: null } },
      }),
    ).toEqual({ form: true, url: false });
    expect(
      elicitationSupportFromInitialize({
        clientCapabilities: { elicitation: {} },
      }),
    ).toEqual({ form: false, url: false });
  });

  it("rejects credential fields and unsafe urls before they are forwarded", () => {
    expect(() =>
      relayElicitationParams(
        {
          sessionId: "s",
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: { api_key: { type: "string" } },
          },
        },
        both,
      ),
    ).toThrow(ElicitationRejected);

    expect(() =>
      relayElicitationParams(
        {
          requestId: 1,
          mode: "url",
          elicitationId: "e1",
          url: "http://user:pass@example.com/callback",
        },
        both,
      ),
    ).toThrow(/credentials/);

    expect(() =>
      relayElicitationParams(
        {
          sessionId: "s",
          mode: "url",
          elicitationId: "e1",
          url: "javascript:alert(1)",
        },
        both,
      ),
    ).toThrow(/http or https/);

    const forwarded = relayElicitationParams(
      {
        sessionId: "s",
        mode: "url",
        elicitationId: "e1",
        message: "Connect",
        url: "https://example.com/connect?elicitationId=e1",
      },
      both,
    );
    expect(forwarded.url).toBe("https://example.com/connect?elicitationId=e1");
  });

  it("refuses a mode the phone did not advertise", () => {
    expect(() =>
      relayElicitationParams(
        {
          sessionId: "s",
          mode: "form",
          requestedSchema: { type: "object", properties: { name: { type: "string" } } },
        },
        { form: false, url: true },
      ),
    ).toThrow(/form elicitation/);
    expect(() =>
      relayElicitationParams(
        { sessionId: "s", mode: "form", requestedSchema: { type: "object", properties: {} } },
        { form: false, url: false },
      ),
    ).toThrow(/does not advertise elicitation/);
  });

  it("strips content unless the action is accept", () => {
    expect(
      sanitizeElicitationResponse({
        action: "decline",
        content: { name: "Ada", password: "nope" },
      }),
    ).toEqual({ action: "decline" });
    expect(
      sanitizeElicitationResponse({
        action: "accept",
        content: { name: "Ada", password: "nope", nested: { a: 1 } },
      }),
    ).toEqual({ action: "accept", content: { name: "Ada" } });
    expect(sanitizeElicitationResponse({ action: "nope" })).toEqual({ action: "cancel" });
  });
});

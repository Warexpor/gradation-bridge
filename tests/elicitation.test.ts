import { describe, expect, it } from "vitest";
import {
  bindElicitationSession,
  elicitationSupportFromInitialize,
  ElicitationRejected,
  mergeInitializeElicitation,
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

  it("rejects disguised modes, password formats, and non-public urls", () => {
    expect(() =>
      relayElicitationParams(
        {
          sessionId: "s",
          mode: "Form",
          requestedSchema: { type: "object", properties: { password: { type: "string" } } },
        },
        both,
      ),
    ).toThrow(/not supported/);

    expect(() =>
      relayElicitationParams(
        {
          sessionId: "s",
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: { note: { type: "string", format: "password" } },
          },
        },
        both,
      ),
    ).toThrow(/credentials/);

    expect(() =>
      relayElicitationParams(
        {
          sessionId: "s",
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: { note: { type: "string", writeOnly: true } },
          },
        },
        both,
      ),
    ).toThrow(/credentials/);

    for (const url of [
      "http://127.0.0.1/login",
      "http://2130706433/login",
      "http://[::1]/login",
      "https://169.254.169.254/latest",
      "https://metadata.google.internal/computeMetadata/v1/",
      "http://10.1.2.3/hook",
      "http://[0:0:0:0:0:ffff:127.0.0.1]/login",
      "http://[64:ff9b::7f00:1]/login",
      "http://[64:ff9b::127.0.0.1]/login",
      "http://[64:ff9b::a9fe:a9fe]/latest",
      "http://[64:ff9b:1::7f00:1]/login",
      "http://[64:ff9b:1:2::a00:1]/hook",
      "http://[2002:7f00:1::]/login",
    ]) {
      expect(() =>
        relayElicitationParams(
          { sessionId: "s", mode: "url", elicitationId: "e1", url },
          both,
        ),
      ).toThrow(/public/);
    }

    const forwarded = relayElicitationParams(
      {
        sessionId: "s",
        mode: "url",
        elicitationId: "e1",
        url: "https://example.com/connect",
        env: { TOKEN: "nope" },
      },
      both,
    );
    expect(forwarded).toEqual({
      mode: "url",
      sessionId: "s",
      elicitationId: "e1",
      url: "https://example.com/connect",
    });
    for (const url of ["http://[64:ff9b::808:808]/dns", "http://[2002:808:808::]/dns"]) {
      expect(
        relayElicitationParams({ sessionId: "s", mode: "url", elicitationId: "e1", url }, both).url,
      ).toBe(url);
    }
    expect(
      relayElicitationParams(
        { sessionId: "s", mode: "_vendor", message: "extension" },
        both,
      ).mode,
    ).toBe("_vendor");
  });

  it("binds the prompt to the calling session and keeps earlier elicitation modes", () => {
    expect(bindElicitationSession({ sessionId: "victim", requestId: 4, mode: "form" }, "real")).toMatchObject({
      sessionId: "real",
      requestId: 4,
    });
    const warm = bindElicitationSession({ sessionId: "victim", requestId: 4, mode: "form" }) as {
      sessionId?: string;
    };
    expect(warm.sessionId).toBeUndefined();

    const merged = mergeInitializeElicitation(
      { clientCapabilities: { elicitation: { form: {} } } },
      { clientCapabilities: { fs: { readTextFile: true } } },
    );
    expect(elicitationSupportFromInitialize(merged)).toEqual({ form: true, url: false });
  });
});

#!/usr/bin/env node
/**
 * Minimal ACP agent over stdio for bridge e2e tests.
 *
 * Speaks Agent Client Protocol v1 JSON-RPC (newline-delimited):
 *   initialize, session/new, session/prompt, session/cancel, session/load
 * Emits session/update chunks and optionally session/request_permission.
 *
 * Env:
 *   FAKE_ACP_PERMISSION=1       — request permission mid-prompt
 *   FAKE_ACP_PERMISSION_KIND    — tool kind for that request (default edit)
 *   FAKE_ACP_PERMISSION_COMMAND — rawInput.command on that permission request
 *   FAKE_ACP_CLOSE_HOLD_MS=N    — delay session/close so a racing prompt can be refused
 *   FAKE_ACP_FS_WRITE=1         — call fs/write_text_file during the prompt
 *   FAKE_ACP_TERMINAL=1         — call terminal/create during the prompt
 *   FAKE_ACP_TERMINAL_MISS=1    — try a missing command first; the grant must survive
 *   FAKE_ACP_TERMINAL_HANG=1    — wait on a command that ignores SIGTERM until cancel
 *   FAKE_ACP_AUTH=1             — advertise an agent auth method from initialize
 *   FAKE_ACP_AUTH_REQUIRED=1    — session/new fails until authenticate succeeds
 *   FAKE_ACP_AUTH_ALIAS=1       — authenticate is method-not-found; auth/login works
 *   FAKE_ACP_AUTH_TERMINAL=1    — advertise a terminal auth method (env must not leak)
 *   FAKE_ACP_LOGOUT=1           — advertise logout
 *   FAKE_ACP_ELICIT_FORM=1      — form elicitation during authenticate
 *   FAKE_ACP_ELICIT_SECRET=1    — form that asks for a password (bridge should reject)
 *   FAKE_ACP_ELICIT_URL=<url>   — url elicitation during the prompt
 *   FAKE_ACP_ELICIT_FOREIGN=1   — elicitation claims sessionId "victim-session"
 *   FAKE_ACP_ELICIT_DUMP=<file> — write the elicitation result JSON
 *   FAKE_ACP_CANCEL_ELICIT=1    — `$/cancel_request` the elicitation as soon as it is sent
 *   FAKE_ACP_ELICIT_IGNORE_CANCEL=1 — still elicit after session/cancel
 *   FAKE_ACP_IGNORE_CANCEL=1    — keep going after session/cancel (bridge must still refuse writes)
 *   FAKE_ACP_WRITE_ON_TERM=1    — emit a session update from the SIGTERM handler
 *   FAKE_ACP_AUTH_HOLD_MS=N     — delay authenticate before it succeeds
 *   FAKE_ACP_TRACE=<file>       — append init/auth/new lines with this process id
 *   FAKE_ACP_DUMP=<file>        — write the initialize params JSON to a file
 *   FAKE_ACP_SLOW_MS=N          — delay between update chunks
 *   FAKE_ACP_EXIT_AFTER_PROMPT=1 — exit shortly after the prompt result is flushed
 *   FAKE_ACP_SESSION_ID=<id>     — force the id returned by session/new
 *   FAKE_ACP_NO_RESUME=1         — session/resume returns method-not-found
 *   FAKE_ACP_DUMP_NEW=<file>     — write session/new params JSON to a file
 *   FAKE_ACP_TERMINAL_TAIL=1     — terminal/create with a 4-byte output limit
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const sessions = new Map<string, { cwd: string; cancelled: boolean }>();
let nextSession = 1;
const wantPermission = process.env.FAKE_ACP_PERMISSION === "1";
const permissionKind = process.env.FAKE_ACP_PERMISSION_KIND || "edit";
const permissionCommand = process.env.FAKE_ACP_PERMISSION_COMMAND;
const wantWrite = process.env.FAKE_ACP_FS_WRITE === "1";
const wantTerminal = process.env.FAKE_ACP_TERMINAL === "1";
const wantAuth = process.env.FAKE_ACP_AUTH === "1" || process.env.FAKE_ACP_AUTH_REQUIRED === "1";
const authRequired = process.env.FAKE_ACP_AUTH_REQUIRED === "1";
const authAlias = process.env.FAKE_ACP_AUTH_ALIAS === "1";
const authTerminal = process.env.FAKE_ACP_AUTH_TERMINAL === "1";
const wantLogout = process.env.FAKE_ACP_LOGOUT === "1";
const elicitForm = process.env.FAKE_ACP_ELICIT_FORM === "1";
const elicitSecret = process.env.FAKE_ACP_ELICIT_SECRET === "1";
const elicitUrl = process.env.FAKE_ACP_ELICIT_URL;
const elicitForeign = process.env.FAKE_ACP_ELICIT_FOREIGN === "1";
const elicitDump = process.env.FAKE_ACP_ELICIT_DUMP;
const cancelElicit = process.env.FAKE_ACP_CANCEL_ELICIT === "1";
const elicitIgnoreCancel = process.env.FAKE_ACP_ELICIT_IGNORE_CANCEL === "1";
const ignoreCancel = process.env.FAKE_ACP_IGNORE_CANCEL === "1";
const writeOnTerm = process.env.FAKE_ACP_WRITE_ON_TERM === "1";
let lastSessionId = "";
const authHoldMs = Number(process.env.FAKE_ACP_AUTH_HOLD_MS ?? "0") || 0;
let authenticated = !authRequired;
const dumpPath = process.env.FAKE_ACP_DUMP;
const slowMs = Number(process.env.FAKE_ACP_SLOW_MS ?? "0") || 0;
const exitAfterPrompt = process.env.FAKE_ACP_EXIT_AFTER_PROMPT === "1";
const forcedSessionId = process.env.FAKE_ACP_SESSION_ID;
const noResume = process.env.FAKE_ACP_NO_RESUME === "1";
const dumpNewPath = process.env.FAKE_ACP_DUMP_NEW;
const terminalTail = process.env.FAKE_ACP_TERMINAL_TAIL === "1";
const terminalMiss = process.env.FAKE_ACP_TERMINAL_MISS === "1";
const terminalHang = process.env.FAKE_ACP_TERMINAL_HANG === "1";

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function respond(id: number | string | null | undefined, result: unknown): void {
  if (id === undefined || id === null) return;
  write({ jsonrpc: "2.0", id, result });
}

function respondError(id: number | string | null | undefined, code: number, message: string): void {
  if (id === undefined || id === null) return;
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method: string, params: unknown): void {
  write({ jsonrpc: "2.0", method, params });
}

function trace(event: string): void {
  const path = process.env.FAKE_ACP_TRACE;
  if (!path) return;
  appendFileSync(path, `${event} ${process.pid}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let inboundId = 1;
const pendingInbound = new Map<
  number | string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function requestClient(method: string, params: unknown): Promise<unknown> {
  const id = `agent-${inboundId++}`;
  return new Promise((resolve, reject) => {
    pendingInbound.set(id, { resolve, reject });
    const requestLine = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (cancelElicit && method === "elicitation/create") {
      const cancelLine = JSON.stringify({
        jsonrpc: "2.0",
        method: "$/cancel_request",
        params: { requestId: id },
      });
      process.stdout.write(`${requestLine}\n${cancelLine}\n`);
      return;
    }
    process.stdout.write(`${requestLine}\n`);
  });
}

if (writeOnTerm) {
  let termHandled = false;
  process.on("SIGTERM", () => {
    if (termHandled) return;
    termHandled = true;
    if (lastSessionId) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: lastSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "stale-after-kill" },
          },
        },
      });
    }
    setTimeout(() => process.exit(0), 80);
  });
}

async function handlePrompt(id: number | string, params: Record<string, unknown>): Promise<void> {
  const sessionId = String(params.sessionId ?? "");
  const session = sessions.get(sessionId);
  if (!session) {
    respondError(id, -32002, `unknown session: ${sessionId}`);
    return;
  }
  session.cancelled = false;

  const prompt = params.prompt;
  let userText = "";
  if (Array.isArray(prompt)) {
    for (const block of prompt) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        userText += String((block as { text?: string }).text ?? "");
      }
    }
  }

  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: userText || "(empty)" },
    },
  });
  if (slowMs) await sleep(slowMs);
  if (session.cancelled && !elicitIgnoreCancel && !ignoreCancel) {
    respond(id, { stopReason: "cancelled" });
    return;
  }

  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking…" },
    },
  });
  if (slowMs) await sleep(slowMs);

  const toolCallId = "tool-1";
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Edit README.md",
      kind: "edit",
      status: "pending",
      locations: [{ path: `${session.cwd}/README.md` }],
    },
  });

  if (session.cancelled && !elicitIgnoreCancel && !ignoreCancel) {
    respond(id, { stopReason: "cancelled" });
    return;
  }

  if (wantPermission) {
    try {
      const permResult = (await requestClient("session/request_permission", {
        sessionId,
          toolCall: {
          toolCallId,
          title: permissionKind === "execute" ? "Run command" : "Edit README.md",
          kind: permissionKind,
          locations:
            permissionKind === "execute" ? [] : [{ path: join(session.cwd, "README.md") }],
          ...(permissionCommand ? { rawInput: { command: permissionCommand } } : {}),
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      })) as { outcome?: { outcome?: string; optionId?: string } };

      const outcome = permResult?.outcome?.outcome;
      const optionId = permResult?.outcome?.optionId;
      if (session.cancelled || outcome === "cancelled") {
        respond(id, { stopReason: "cancelled" });
        return;
      }
      if (optionId && optionId.startsWith("reject")) {
        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
          },
        });
        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Permission denied; stopping." },
          },
        });
        respond(id, { stopReason: "end_turn" });
        return;
      }
    } catch (e) {
      respondError(id, -32603, e instanceof Error ? e.message : String(e));
      return;
    }
  }

  if (session.cancelled && !elicitIgnoreCancel && !ignoreCancel) {
    respond(id, { stopReason: "cancelled" });
    return;
  }

  if (elicitSecret || elicitUrl) {
    const blocked = await runPromptElicitation(sessionId);
    if (blocked) {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "elicitation-blocked" },
        },
      });
      respond(id, { stopReason: "end_turn" });
      return;
    }
  }

  if (wantWrite) {
    try {
      await requestClient("fs/write_text_file", {
        sessionId,
        path: join(session.cwd, "README.md"),
        content: "agent write\n",
      });
    } catch (e) {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `write failed: ${e instanceof Error ? e.message : String(e)}` },
        },
      });
      respond(id, { stopReason: "end_turn" });
      return;
    }
  }

  if (wantTerminal || terminalTail || terminalMiss || terminalHang) {
    try {
      if (terminalMiss) {
        try {
          await requestClient("terminal/create", {
            sessionId,
            command: "gradation-bridge-missing-bin",
            args: [],
            cwd: session.cwd,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (!message.includes("command not found")) throw e;
        }
      }
      if (terminalHang) {
        const created = (await requestClient("terminal/create", {
          sessionId,
          command: process.execPath,
          args: ["-e", "process.stdout.write('up'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
          cwd: session.cwd,
        })) as { terminalId?: string };
        const terminalId = String(created?.terminalId ?? "");
        const readyDeadline = Date.now() + 3_000;
        while (Date.now() < readyDeadline) {
          const output = (await requestClient("terminal/output", { sessionId, terminalId })) as {
            output?: string;
          };
          if (String(output?.output ?? "").includes("up")) break;
          await sleep(20);
        }
        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "term-hanging" },
          },
        });
        await requestClient("terminal/wait_for_exit", { sessionId, terminalId });
        if (session.cancelled) {
          respond(id, { stopReason: "cancelled" });
          return;
        }
      }
      if (!wantTerminal && !terminalTail && !terminalMiss) {
        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: userText ? `Echo: ${userText}` : "Hello from fake ACP agent." },
          },
        });
        respond(id, { stopReason: "end_turn" });
        return;
      }
      const created = (await requestClient("terminal/create", {
        sessionId,
        command: process.execPath,
        args: ["-e", terminalTail ? "process.stdout.write('ééXYZ')" : "process.stdout.write('term-ok')"],
        cwd: session.cwd,
        ...(terminalTail ? { outputByteLimit: 4 } : {}),
      })) as { terminalId?: string };
      const terminalId = String(created?.terminalId ?? "");
      await requestClient("terminal/wait_for_exit", { sessionId, terminalId });
      const output = await requestClient("terminal/output", { sessionId, terminalId });
      if (terminalTail) {
        notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `tail:${JSON.stringify(output)}` },
          },
        });
      }
      await requestClient("terminal/release", { sessionId, terminalId });
    } catch (e) {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `terminal failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        },
      });
      respond(id, { stopReason: "end_turn" });
      return;
    }
  }

  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
    },
  });
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: userText ? `Echo: ${userText}` : "Hello from fake ACP agent.",
      },
    },
  });
  const done = { jsonrpc: "2.0", id, result: { stopReason: "end_turn" } };
  process.stdout.write(JSON.stringify(done) + "\n", () => {
    if (exitAfterPrompt) setTimeout(() => process.exit(0), 50);
  });
}

async function runPromptElicitation(sessionId: string): Promise<boolean> {
  try {
    if (elicitSecret) {
      const result = await requestClient("elicitation/create", {
        sessionId: elicitForeign ? "victim-session" : sessionId,
        mode: "form",
        message: "Enter password",
        requestedSchema: {
          type: "object",
          properties: { password: { type: "string" } },
          required: ["password"],
        },
      });
      dumpElicitation(result);
      return false;
    }
    if (elicitUrl) {
      const result = await requestClient("elicitation/create", {
        sessionId: elicitForeign ? "victim-session" : sessionId,
        mode: "url",
        elicitationId: "url-1",
        message: "Open this link",
        url: elicitUrl,
      });
      dumpElicitation(result);
      return false;
    }
  } catch {
    return true;
  }
  return false;
}

function dumpElicitation(result: unknown): void {
  if (!elicitDump) return;
  writeFileSync(elicitDump, JSON.stringify(result));
}

async function handleAuth(id: number | string | null | undefined, params: Record<string, unknown>): Promise<void> {
  const methodId = String(params.methodId ?? "");
  if (authHoldMs > 0) await sleep(authHoldMs);
  if (elicitForm) {
    try {
      const result = (await requestClient("elicitation/create", {
        requestId: id,
        ...(elicitForeign ? { sessionId: "victim-session" } : {}),
        mode: "form",
        message: "What should I call you?",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string", title: "Name" } },
          required: ["name"],
        },
      })) as { action?: string; content?: { name?: string } };
      dumpElicitation(result);
      if (result?.action !== "accept" || !result.content?.name) {
        respondError(id, -32000, "auth_required");
        return;
      }
    } catch (e) {
      respondError(id, -32603, e instanceof Error ? e.message : String(e));
      return;
    }
  }
  authenticated = true;
  trace(`auth ${methodId}`);
  respond(id, {});
}

async function dispatch(msg: JsonRpcRequest): Promise<void> {
  // Response to our client request
  if (
    msg.id != null &&
    msg.method === undefined &&
    ((msg as { result?: unknown }).result !== undefined ||
      (msg as { error?: unknown }).error !== undefined)
  ) {
    const pending = pendingInbound.get(msg.id);
    if (pending) {
      pendingInbound.delete(msg.id);
      const err = (msg as { error?: unknown }).error;
      if (err) pending.reject(new Error(JSON.stringify(err)));
      else pending.resolve((msg as { result?: unknown }).result);
    }
    return;
  }

  const method = msg.method;
  const id = msg.id;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case "initialize":
      if (dumpPath) writeFileSync(dumpPath, JSON.stringify(params));
      trace("init");
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          ...(wantLogout ? { auth: { logout: {} } } : {}),
        },
        agentInfo: { name: "fake-acp-agent", version: "0.1.0" },
        ...((wantAuth || authTerminal)
          ? {
              authMethods: [
                ...(wantAuth
                  ? [{ id: "fake_login", name: "Fake login", description: "Test auth method" }]
                  : []),
                ...(authTerminal
                  ? [
                      {
                        id: "term_login",
                        name: "Terminal login",
                        type: "terminal",
                        args: ["--login"],
                        env: { LEAK_TOKEN: "super-secret-token" },
                      },
                    ]
                  : []),
              ],
            }
          : {}),
      });
      return;
    case "authenticate":
      if (authAlias) {
        respondError(id, -32601, "Method not found: authenticate");
        return;
      }
      await handleAuth(id, params);
      return;
    case "auth/login":
      await handleAuth(id, params);
      return;
    case "logout":
    case "auth/logout":
      if (!wantLogout) {
        respondError(id, -32601, "Method not found: logout");
        return;
      }
      authenticated = false;
      respond(id, {});
      return;
    case "session/new": {
      if (dumpNewPath) writeFileSync(dumpNewPath, JSON.stringify(params));
      if (authRequired && !authenticated) {
        respondError(id, -32000, "auth_required");
        return;
      }
      trace("new");
      const sessionId = forcedSessionId || `fake-${nextSession++}`;
      lastSessionId = sessionId;
      sessions.set(sessionId, { cwd: String(params.cwd ?? process.cwd()), cancelled: false });
      respond(id, {
        sessionId,
        modes: {
          currentModeId: "agent",
          availableModes: [{ id: "agent", name: "Agent", description: "Fake agent mode" }],
        },
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "small",
            options: [{ value: "small", name: "Small" }],
          },
        ],
      });
      return;
    }
    case "session/load":
    case "session/resume": {
      if (method === "session/resume" && noResume) {
        respondError(id, -32601, "Method not found: session/resume");
        return;
      }
      const sessionId = String(params.sessionId ?? "");
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { cwd: String(params.cwd ?? process.cwd()), cancelled: false });
      }
      respond(id, {});
      return;
    }
    case "session/close": {
      const hold = Number(process.env.FAKE_ACP_CLOSE_HOLD_MS ?? "0") || 0;
      if (hold > 0) await sleep(hold);
      sessions.delete(String(params.sessionId ?? ""));
      respond(id, {});
      return;
    }
    case "session/set_config_option": {
      respond(id, {
        configOptions: [
          {
            id: String(params.configId ?? "model"),
            name: "Model",
            type: "select",
            currentValue: String(params.value ?? ""),
            options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }],
          },
        ],
      });
      return;
    }
    case "session/prompt":
      lastSessionId = String(params.sessionId ?? lastSessionId);
      await handlePrompt(id as number | string, params);
      return;
    case "session/cancel": {
      const sessionId = String(params.sessionId ?? "");
      const s = sessions.get(sessionId);
      if (s) s.cancelled = true;
      return;
    }
    case "session/set_mode":
      respond(id, {});
      return;
    default:
      if (id != null) respondError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return;
  }
  void dispatch(msg).catch((e) => {
    process.stderr.write(`fake-agent error: ${e instanceof Error ? e.message : String(e)}\n`);
  });
});

process.stdin.on("end", () => process.exit(0));

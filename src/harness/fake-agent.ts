#!/usr/bin/env node
/**
 * Minimal ACP agent over stdio for bridge e2e tests.
 *
 * Speaks Agent Client Protocol v1 JSON-RPC (newline-delimited):
 *   initialize, session/new, session/prompt, session/cancel, session/load
 * Emits session/update chunks and optionally session/request_permission.
 *
 * Env:
 *   FAKE_ACP_PERMISSION=1  — request permission mid-prompt (edit kind)
 *   FAKE_ACP_SLOW_MS=N     — delay between update chunks
 */
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
const slowMs = Number(process.env.FAKE_ACP_SLOW_MS ?? "0") || 0;

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
    write({ jsonrpc: "2.0", id, method, params });
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
  if (session.cancelled) {
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

  if (wantPermission && !session.cancelled) {
    try {
      const permResult = (await requestClient("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId,
          title: "Edit README.md",
          kind: "edit",
          locations: [{ path: `${session.cwd}/README.md` }],
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      })) as { outcome?: { outcome?: string; optionId?: string } };

      const outcome = permResult?.outcome?.outcome;
      const optionId = permResult?.outcome?.optionId;
      if (outcome === "cancelled" || (optionId && optionId.startsWith("reject"))) {
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

  if (session.cancelled) {
    respond(id, { stopReason: "cancelled" });
    return;
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
  respond(id, { stopReason: "end_turn" });
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
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        agentInfo: { name: "fake-acp-agent", version: "0.1.0" },
      });
      return;
    case "session/new": {
      const sessionId = `fake-${nextSession++}`;
      sessions.set(sessionId, { cwd: String(params.cwd ?? process.cwd()), cancelled: false });
      respond(id, { sessionId });
      return;
    }
    case "session/load": {
      const sessionId = String(params.sessionId ?? "");
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { cwd: String(params.cwd ?? process.cwd()), cancelled: false });
      }
      respond(id, {});
      return;
    }
    case "session/prompt":
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

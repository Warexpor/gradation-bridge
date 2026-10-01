# gradation-bridge

ACP bridge daemon for [GradatiON](https://github.com/Warexpor/GradatiON) Code mode.

The phone never runs an agent. This small Node 20+ daemon on your machine launches coding agents (Claude Code, Codex, OpenCode, Grok Build, Cursor CLI, Pi, …) over stdio via the [Agent Client Protocol](https://agentclientprotocol.com/), and relays sessions to GradatiON over one authenticated WebSocket.

> **Status:** Working MVP (0.4.0). End-to-end ACP sessions (initialize / new / prompt / cancel / load / resume / set_mode / set_config_option / list / close / delete), harness `authenticate` / `logout` (and the `auth/login` / `auth/logout` names), `elicitation/create` relay, approval policy enforced on real file writes and terminal calls, JSONL resume that survives a bridge restart, sandboxed git status/diff, harness readiness diagnostics, and bridge extensions are implemented. The wire protocol stays at ACP 1. Tested with a fake ACP agent. Point config at a harness below, or run `gradation-bridge doctor` to see what is actually installed.

## Quick start (against GradatiON)

```bash
# from a clone (until published to npm)
npm install
npm start
# or later: npx gradation-bridge
```

On first run the bridge:

1. Writes `~/.config/gradation-bridge/config.json` (harnesses, allowed roots, default approval mode). Default `allowedRoots` is your home directory.
2. Mints a 32-byte bearer token (`~/.config/gradation-bridge/devices.json`).
3. Generates a self-signed TLS cert under `~/.local/share/gradation-bridge/certs/` (needs `openssl` on PATH).
4. Prints the listen address, token, and a pairing payload:

```
gradation://pair?url=wss://127.0.0.1:8787/v1&token=…&fp=<sha256 cert>
```

**In GradatiON:** Settings → Code mode → add machine → paste / scan that link.

Then on the Code home screen pick a harness + workspace under an allowed root and start a session. The phone speaks ACP to this bridge; the bridge speaks ACP to the local agent over stdio.

### Same-machine smoke test (no phone)

```bash
# terminal 1
npm start -- --port 8787

# terminal 2 — use the printed token
npx wscat -c "ws://127.0.0.1:8787/v1?token=YOUR_TOKEN"
# then send JSON-RPC frames, e.g.:
# {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"cli","version":"0"}}}
# {"jsonrpc":"2.0","id":2,"method":"bridge/listHarnesses","params":{}}
```

Or run the automated e2e suite (spawns the fake ACP agent):

```bash
npm test
```

## Bind address

| Flag | Bind |
|------|------|
| *(default)* | `127.0.0.1` |
| `--lan` | first non-loopback IPv4 |
| `--tailscale` | Tailscale `100.x` address if present, else LAN |
| `--port N` | override port (default `8787`) |

## Config

`~/.config/gradation-bridge/config.json`:

```json
{
  "allowedRoots": ["/home/you"],
  "workspaces": ["/home/you/src/my-app"],
  "defaultPermissionMode": "ask",
  "port": 8787,
  "harnesses": [
    {
      "id": "opencode",
      "name": "OpenCode",
      "command": "opencode",
      "args": ["acp"]
    },
    {
      "id": "claude-code",
      "name": "Claude Code",
      "command": "npx",
      "args": ["-y", "@agentclientprotocol/claude-agent-acp"]
    }
  ]
}
```

Paths outside `allowedRoots` are refused (folder picker, edits, terminal, session cwd).

Default harness registry (ids match GradatiON). New configs use these commands. A config you already have is left as written; `doctor` notes when a package moved.

| id | Command | If the binary is missing |
|----|---------|--------------------------|
| `claude-code` | `npx -y @agentclientprotocol/claude-agent-acp` | first session downloads it (`on-demand`) |
| `codex` | `npx -y @agentclientprotocol/codex-acp` | same |
| `opencode` | `opencode acp` | `npx -y opencode-ai acp` |
| `grok-build` | `grok agent stdio` | `npx -y @xai-official/grok agent stdio` |
| `cursor-cli` | `cursor-agent acp` | falls back to `agent acp` |
| `pi` | `pi-acp` | `npx -y pi-acp` |

`bridge/listHarnesses` reports `readiness`: `ready` (binary on PATH), `on-demand` (will run via npx), or `missing` (session start is refused, with `install` / `authHint`). `available` stays true for `ready` and `on-demand`.

Cursor's CLI is `cursor-agent`. The older name `agent` is still accepted, but if both exist the bridge launches `cursor-agent`. Installing Grok can point the bare `agent` command at Grok.

Auth is per CLI, not a bridge prompt: Claude (`ANTHROPIC_API_KEY` or `claude` login), Codex (`codex login` or `CODEX_API_KEY` / `OPENAI_API_KEY`), Grok (`XAI_API_KEY` or `grok` login), Cursor (`cursor-agent login`). Do not put API keys in harness `args`. The phone receives those args. `env` values are never sent to the phone. `doctor` and error payloads redact `--api-key` and `sk-…` values.

Custom harnesses are another `{ id, name, command, args, env? }` entry. A custom command that is not on PATH is `missing`; the bridge does not silently swap it for npx.

```bash
gradation-bridge doctor
```

## Approval modes

Enforced on the bridge (never trust the phone alone):

| Mode | Behaviour |
|------|-----------|
| `ask` | Forward every permission request to the phone. A file write or terminal command is refused unless the phone approved that kind (`allow_once` is consumed by the next call; `allow_always` lasts for the session). |
| `auto-edit` | Auto-allow `edit`/`write` inside the workspace. Commands still need an approval grant. |
| `plan` | Reject writes and exec on the bridge, including `fs/write_text_file` and `terminal/create` that skip `session/request_permission`. Reads allowed. |
| `full-auto` | Allow all (logs a machine-side warning the first time) |

Changing mode clears outstanding grants. Phone-selected outcomes are applied back to the agent. When several phones are attached, the first answer wins; others get `bridge/permissionResolved`.

`session/set_mode` is forwarded to the harness so agent modes such as Cursor's `agent` work. If `modeId` is also a bridge permission mode (`ask`, `auto-edit`, `plan`, `full-auto`), the bridge policy updates too. `bridge/setPermissionMode` changes only the bridge policy.

## Wire protocol

WebSocket, text frames, JSON-RPC 2.0, path `/v1`, `Authorization: Bearer <token>`.

ACP methods relayed: `initialize`, `authenticate` (`auth/login`), `logout` (`auth/logout`), `session/new`, `session/prompt`, `session/cancel`, `session/load` (with `_meta.afterSeq` replay), `session/resume` (no transcript replay), `session/set_mode`, `session/set_config_option`, `session/list`, `session/close`, `session/delete`, `session/update`, `session/request_permission`, `elicitation/create`, `elicitation/complete`. The bridge implements `fs/read_text_file`, `fs/write_text_file`, and `terminal/*` for the agent. Phone `clientCapabilities` are forwarded, with filesystem and terminal forced on because the bridge is the one performing them. `clientCapabilities.auth.terminal` is forced off: this process cannot show an interactive login TTY.

`initialize` answers `protocolVersion: 1`. A phone that asks for another version, including ACP v2, still gets `1` (v2 is a draft and removes `session/load` plus client filesystem and terminal methods). `initialize` advertises `sessionCapabilities` for list, close, resume, and delete, and `loadSession: true`. Prompt image and audio stay off; a prompt that includes those blocks is rejected with `-32602`. `session/new` returns the agent's payload (including `modes` and `configOptions` when the harness sends them) plus `_meta.permissionMode`, `_meta.harness`, `_meta.agentInfo`, `_meta.logout` when the agent supports logout, and `_meta.authMethods` when the agent advertised login methods. `initialize` advertises `authMethods: []` because the WebSocket bearer already authenticated the phone. Harness login is a separate ACP call.

### Harness login

`authenticate` and `auth/login` take `{ methodId, sessionId? , cwd?, _meta: { harness, cwd } }`.

- With `sessionId`, the call is forwarded to that session's running process. Load or resume first if the process is down (`-32004`).
- Without `sessionId`, the bridge starts the harness in the sandboxed `cwd`, calls `authenticate` (falling back to `auth/login` if the harness returns `-32601`), and keeps that process for the next `session/new` of the same harness and cwd (10 minutes, or until `logout`). The login therefore survives into the session instead of dying with a throwaway process.
- `type: "terminal"` methods are not executed and are not passed to `authenticate` (`-32602`). `env` on those methods is stripped before anything is sent to the phone or written to the session catalog. Run that login in a terminal on this machine.
- If `session/new` fails because the harness said authentication is required, the error is `-32011` and `data.authMethods` lists the public methods (still no env).

`logout` and `auth/logout` are forwarded only when the agent advertised `agentCapabilities.auth.logout`. Logging out a pre-session process drops it.

### Elicitation

`elicitation/create` from the harness is relayed to the phone when `initialize` advertised that mode (`clientCapabilities.elicitation.form` and/or `.url` as objects). A missing capability, a form field that looks like a credential (`password`, `api_key`, `token`, …), or a URL that is not `http`/`https` or that contains userinfo is rejected with `-32602` and is not forwarded. The bridge does not open the URL. Decline and cancel responses drop `content`. Answers are not written to the session JSONL. If the phone does not answer, the agent receives `{ "action": "cancel" }`. `elicitation/complete` is broadcast to connected phones and is not stored in the log.

`session/list` is the ACP list (`cwd` filter, `cursor` / `nextCursor`). `bridge/listSessions` is the same catalog with bridge fields. `session/close` matches `bridge/closeSession` and also asks the harness to close before the process is killed. `session/delete` removes the session and its on-disk log. `session/set_config_option` is forwarded when the harness process is running (`-32004` if it has exited; load or resume first). Extra workspace roots on `session/new` (`additionalDirectories`) are realpath-checked against `allowedRoots` and forwarded. A harness session id that is not a safe directory name is rejected.

Bridge extensions (see GradatiON `docs/code-mode-plan.md` §3.2):

- `bridge/listHarnesses`, `bridge/listWorkspaces`, `bridge/browse`
- `bridge/listSessions`, `bridge/closeSession`, `bridge/setPermissionMode`
- `bridge/diagnostics` (recent redacted log lines, harness readiness; no tokens)
- `bridge/permissionResolved`, `bridge/sessionStatus` (notifications)
- `bridge/diff`, `bridge/gitStatus` (sandboxed `git diff` / `git status --porcelain` under allowedRoots)

Harness launch failures use JSON-RPC code `-32010` and a `data` object (`readiness`, `install`, `authHint`, redacted `stderr`). Sandbox and approval denials use `-32003`. Unknown sessions use `-32002`. A second `session/prompt` while one is running is `-32005`. An agent that is not running is `-32004`. Stderr is also kept on the session preview when the process exits.

`GRADATION_LOG=debug|info|warn|error|silent` (or config `logLevel`) sets the stderr threshold. `debug` records non-JSON harness stdout.

Every notification carries `_meta.seq` from an append-only JSONL log so a reconnecting phone can resume via `session/load` + `_meta.afterSeq`. `session/load` replays `seq > afterSeq` (skipping corrupt log lines), respawns the harness if the agent process has died, and returns `{ replayed, agentAlive, lastSeq, status }` merged with whatever the agent's `session/load` returned. A prompt that finishes while the phone is gone is also logged as `bridge/promptResult` so the next load can see `stopReason`.

`session/resume` respawns a dead harness without replaying that log. If the harness has no `session/resume`, the bridge falls back to `session/load` on the agent and still does not replay frames to the phone. The first prompt's text becomes the session title until the agent sends `session_info_update`.

`session/cancel` is accepted as a notification or a request. It is forwarded to the agent and aborts an in-flight `session/request_permission` so cancel is not stuck behind the approval dialog.

`session/new` params include `_meta:{ harness, permissionMode, model? }` (GradatiON sends these).

### Reliability

- **Reconnect.** Pending permission requests stay open across a dropped socket and are re-sent to the next phone (first answer still wins). Live sockets are pinged every 20s and dropped if they never pong, or if their bearer token is revoked.
- **Backpressure.** Each socket has an outbound queue. Past a 1MB kernel buffer, frames wait in user space. `session/update` chunks are the first frames dropped when a phone stops reading; responses, status, permissions, and replay are kept. `session/load` paces replay instead of bursting the socket.
- **Malformed frames.** Non-JSON, `null`, arrays, and non-2.0 envelopes return a JSON-RPC error and leave the socket up. Payload cap is 8MB.
- **Auth / TLS.** Token checks hash then compare in constant time. A corrupt `devices.json` fails closed and is not overwritten with a new token. New self-signed certs include `subjectAltName` for localhost, loopback, and the bind address (an existing cert is left in place so the pinned fingerprint does not change).
- **Process lifecycle.** Each harness is its own process group, so shutting a session down also kills `npx` grandchildren. Terminals for that session are killed with it. `terminal/create` honors `outputByteLimit` (capped at 1MB) by keeping the newest bytes, on a UTF-8 boundary. `terminal/kill` leaves the id readable; `terminal/release` frees it. `fs/read_text_file` and `fs/write_text_file` refuse payloads over 8MB.
- **Restart.** Open sessions are written to `~/.local/share/gradation-bridge/sessions/<id>/` (`meta.json` + `events.jsonl`). A bridge restart lists them again. The harness process is gone until `session/load` or `session/resume`. `session/close` keeps the log but does not restore that session. `session/delete` removes the directory. Shutting the bridge down does not mark sessions closed.

## Safety

The pairing token is a shell on this machine. Treat the `gradation://pair` link like a password: do not commit it, paste it into chat, or leave it in a screenshot.

- Bind stays on `127.0.0.1` unless you pass `--lan` or `--tailscale`. Prefer Tailscale. A non-loopback bind prints a warning.
- The link includes `fp` (SHA-256 of the TLS cert) and `name` (hostname). In GradatiON, confirm the fingerprint before trusting the connection. Older apps ignore `name`.
- `gradation-bridge devices` lists device ids, never tokens. `gradation-bridge revoke <deviceId>` cuts off a phone.
- `gradation-bridge doctor` prints harness readiness and these warnings without printing tokens.
- Plan mode is enforced on the bridge. A harness that skips the permission request still cannot write or spawn a terminal.

## Devices

```bash
gradation-bridge doctor
gradation-bridge devices
gradation-bridge revoke <deviceId>
```

## Development

```bash
npm install
npm test          # vitest — policy, sandbox, session log, e2e via fake agent
npm run build     # tsc → dist/
npm start         # tsx src/index.ts
npm run fake-agent  # stdio fake ACP agent (for manual wiring)
```

Requires Node 20+. Depends on [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) (declared; the bridge uses a small stdio JSON-RPC client compatible with ACP v1).

### Fake agent

`src/harness/fake-agent.ts` speaks ACP over stdio for tests without OpenCode/Claude installed. Set `FAKE_ACP_PERMISSION=1` to exercise `session/request_permission`.

## Remaining stubs / next

- Push notifications when no phone is attached (§3.1.7 of the plan) — not implemented. A permission request is held for a reconnecting phone and cancelled if nobody answers.
- Richer terminal UX (PTY / streaming). Output is buffered until `terminal/output`. FS browse/read/write already realpath-sandbox.
- Multi-session sharing one long-lived agent process (today: one process per session). `session/load` and `session/resume` respawn a dead per-session process. The catalog survives a bridge restart; the harness's own memory survives only if that harness implements load or resume.
- `$/cancel_request` is ignored, which the protocol allows. ACP v2 is not negotiated: it is still a draft, and it removes `session/load`, client `fs/*`, and client `terminal/*`. The bridge keeps answering `protocolVersion: 1`. Non-breaking ACP additions (elicitation, logout, terminal auth metadata) are handled as capabilities on that version.
- Terminal auth methods are advertised to the phone without `env`, and the bridge does not spawn them. Protocol-driven `authenticate` is relayed. One harness process per session, plus at most one warm process between `authenticate` and the following `session/new`.

## License

MIT

# gradation-bridge

ACP bridge daemon for [GradatiON](https://github.com/Warexpor/GradatiON) Code mode.

The phone never runs an agent. This small Node 20+ daemon on your machine launches coding agents (Claude Code, Codex, OpenCode, Grok Build, Cursor CLI, Pi, …) over stdio via the [Agent Client Protocol](https://agentclientprotocol.com/), and relays sessions to GradatiON over one authenticated WebSocket.

> **Status:** Working MVP. End-to-end ACP sessions (initialize / new / prompt / cancel / load / set_mode), approval policy enforced on real file writes and terminal calls, JSONL resume, sandboxed git status/diff, harness readiness diagnostics, and bridge extensions are implemented. Tested with a fake ACP agent. Point config at a harness below, or run `gradation-bridge doctor` to see what is actually installed.

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

ACP methods relayed: `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/load` (with `_meta.afterSeq` replay), `session/set_mode`, `session/update`, `session/request_permission`. The bridge implements `fs/read_text_file`, `fs/write_text_file`, and `terminal/*` for the agent. Phone `clientCapabilities` are forwarded, with filesystem and terminal forced on because the bridge is the one performing them.

`session/new` returns the agent's payload (including `modes` when the harness sends them) plus `_meta.permissionMode`, `_meta.harness`, `_meta.agentInfo`, and `_meta.authMethods` when the agent advertised login methods. `initialize` advertises `authMethods: []` because the WebSocket bearer already authenticated the phone. Harness login stays on the machine.

Bridge extensions (see GradatiON `docs/code-mode-plan.md` §3.2):

- `bridge/listHarnesses`, `bridge/listWorkspaces`, `bridge/browse`
- `bridge/listSessions`, `bridge/closeSession`, `bridge/setPermissionMode`
- `bridge/diagnostics` (recent redacted log lines, harness readiness; no tokens)
- `bridge/permissionResolved`, `bridge/sessionStatus` (notifications)
- `bridge/diff`, `bridge/gitStatus` (sandboxed `git diff` / `git status --porcelain` under allowedRoots)

Harness launch failures use JSON-RPC code `-32010` and a `data` object (`readiness`, `install`, `authHint`, redacted `stderr`). Sandbox and approval denials use `-32003`. Unknown sessions use `-32002`. Stderr is also kept on the session preview when the process exits.

`GRADATION_LOG=debug|info|warn|error|silent` (or config `logLevel`) sets the stderr threshold. `debug` records non-JSON harness stdout.

Every notification carries `_meta.seq` from an append-only JSONL log so a reconnecting phone can resume via `session/load` + `_meta.afterSeq`.

`session/new` params include `_meta:{ harness, permissionMode, model? }` (GradatiON sends these).

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

- Push notifications when no phone is attached (§3.1.7 of the plan) — not implemented. A permission request with no phone is cancelled.
- Richer terminal UX (PTY / streaming). Output is buffered until `terminal/output`.
- Multi-session sharing one long-lived agent process (today: one process per session).
- ACP `authenticate` is not relayed. Harness login stays on the machine; `session/new` surfaces `authMethods` so the phone can say why a start failed.

## License

MIT

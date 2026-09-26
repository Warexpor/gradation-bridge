# gradation-bridge

ACP bridge daemon for [GradatiON](https://github.com/Warexpor/GradatiON) Code mode.

The phone never runs an agent. This small Node 20+ daemon on your machine launches coding agents (Claude Code, Codex, OpenCode, Grok Build, Cursor CLI, Pi, …) over stdio via the [Agent Client Protocol](https://agentclientprotocol.com/), and relays sessions to GradatiON over one authenticated WebSocket.

> **Status:** Working MVP. End-to-end ACP sessions (initialize / new / prompt / cancel / load), approval policy, JSONL resume, and bridge extensions are implemented. Tested with a fake ACP agent; point config at OpenCode (`opencode acp`), Claude (`npx @zed-industries/claude-code-acp`), or any other harness on PATH.

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
      "args": ["-y", "@zed-industries/claude-code-acp"]
    }
  ]
}
```

Paths outside `allowedRoots` are refused (folder picker, edits, terminal, session cwd).

Default harness registry (ids match GradatiON):

| id | Command |
|----|---------|
| `claude-code` | `npx -y @zed-industries/claude-code-acp` |
| `codex` | `npx -y @zed-industries/codex-acp` |
| `opencode` | `opencode acp` |
| `grok-build` | `npx -y @xai-official/grok agent stdio` |
| `cursor-cli` | `agent acp` |
| `pi` | `npx -y pi-acp` |

Prefer OpenCode when installed; otherwise Claude via `claude-code-acp`. Custom harnesses are just another `{ id, name, command, args, env? }` entry.

## Approval modes

Enforced on the bridge (never trust the phone alone):

| Mode | Behaviour |
|------|-----------|
| `ask` | Forward every permission request to the phone |
| `auto-edit` | Auto-allow `edit`/`write` inside the workspace; still ask for commands |
| `plan` | Reject all writes and exec; reads allowed |
| `full-auto` | Allow all (prints a machine-side warning the first time) |

Phone-selected outcomes are applied back to the agent. When several phones are attached, the first answer wins; others get `bridge/permissionResolved`.

## Wire protocol

WebSocket, text frames, JSON-RPC 2.0, path `/v1`, `Authorization: Bearer <token>`.

ACP methods relayed: `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/load` (with `_meta.afterSeq` replay), `session/set_mode`, `session/update`, `session/request_permission`.

Bridge extensions (see GradatiON `docs/code-mode-plan.md` §3.2):

- `bridge/listHarnesses`, `bridge/listWorkspaces`, `bridge/browse`
- `bridge/listSessions`, `bridge/closeSession`
- `bridge/permissionResolved`, `bridge/sessionStatus` (notifications)
- `bridge/diff`, `bridge/gitStatus` (stubs — empty for now)

Every notification carries `_meta.seq` from an append-only JSONL log so a reconnecting phone can resume via `session/load` + `_meta.afterSeq`.

`session/new` params include `_meta:{ harness, permissionMode, model? }` (GradatiON sends these).

## Devices

```bash
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

- `bridge/diff` and `bridge/gitStatus` return empty placeholders.
- Push notifications when no phone is attached (§3.1.7 of the plan).
- Richer terminal UX and symlink-aware sandbox (`realpath`).
- Multi-session sharing one long-lived agent process (today: one process per session).

## License

MIT

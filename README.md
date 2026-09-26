# gradation-bridge

ACP bridge daemon for [GradatiON](https://github.com/Warexpor/GradatiON) Code mode.

The phone never runs an agent. This small Node 20+ daemon on your machine launches coding agents (Claude Code, Codex, OpenCode, Gemini CLI, …) over stdio via the [Agent Client Protocol](https://agentclientprotocol.com/), and relays sessions to GradatiON over one authenticated WebSocket.

> **Status:** MVP scaffold. Pairing/auth, config, approval policy, session log, harness registry, and WS stubs are in place. Full ACP session relay is next.

## Quick start

```bash
# from a clone (until published to npm)
npm install
npm start
# or later: npx gradation-bridge
```

On first run the bridge:

1. Writes `~/.config/gradation-bridge/config.json` (harnesses, allowed roots, default approval mode).
2. Mints a 32-byte bearer token (`~/.config/gradation-bridge/devices.json`).
3. Generates a self-signed TLS cert under `~/.local/share/gradation-bridge/certs/` (needs `openssl` on PATH).
4. Prints the listen address, token, and a pairing payload:

```
gradation://pair?url=wss://127.0.0.1:8787/v1&token=…&fp=<sha256 cert>
```

Paste / scan that in GradatiON → Settings → Code mode → add machine.

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
  "allowedRoots": ["/home/you/src"],
  "workspaces": ["/home/you/src/my-app"],
  "defaultPermissionMode": "ask",
  "port": 8787,
  "harnesses": [
    {
      "id": "claude",
      "name": "Claude Code",
      "command": "npx",
      "args": ["-y", "@zed-industries/claude-code-acp"]
    },
    {
      "id": "opencode",
      "name": "OpenCode",
      "command": "opencode",
      "args": ["acp"]
    }
  ]
}
```

Paths outside `allowedRoots` are refused (folder picker, edits, terminal).

## Approval modes

Enforced on the bridge (never trust the phone alone):

| Mode | Behaviour |
|------|-----------|
| `ask` | Forward every permission request to the phone |
| `auto-edit` | Auto-allow `edit`/`write` inside the workspace; still ask for commands |
| `plan` | Reject all writes and exec; reads allowed |
| `full-auto` | Allow all (shows a machine-side warning the first time) |

## Wire protocol

WebSocket, text frames, JSON-RPC 2.0, path `/v1`, `Authorization: Bearer <token>`.

ACP methods are relayed as-is. Bridge extensions (see GradatiON `docs/code-mode-plan.md` §3.2):

- `bridge/listHarnesses`, `bridge/listWorkspaces`, `bridge/browse`
- `bridge/listSessions`, `bridge/closeSession`
- `bridge/permissionResolved`, `bridge/sessionStatus` (notifications)
- `bridge/diff`, `bridge/gitStatus`

Every notification carries `_meta.seq` from an append-only JSONL log so a reconnecting phone can resume.

## Devices

```bash
gradation-bridge devices
gradation-bridge revoke <deviceId>
```

## Development

```bash
npm install
npm test          # vitest — approval policy + sandbox
npm run build     # tsc → dist/
npm start         # tsx src/index.ts
```

Requires Node 20+. Depends on [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) (official ACP TypeScript SDK).

## License

MIT

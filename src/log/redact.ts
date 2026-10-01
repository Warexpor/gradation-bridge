/**
 * Redact secrets before they reach stderr, JSON-RPC errors, or the phone.
 * The pairing token is a 64-char hex string; CLIs sometimes echo API keys.
 */

const SECRET_ASSIGN =
  /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)=([^\s]+)/gi;

export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(SECRET_ASSIGN, "$1=[redacted]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[redacted]");
}

const SECRET_FLAG = /^(--api-key|--token|--password|--secret)$/i;

/** Args returned to the phone or printed by `doctor`. Spawn still uses the raw argv. */
export function redactArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const prev = args[i - 1] ?? "";
    if (SECRET_FLAG.test(prev) || /^sk-[A-Za-z0-9_-]{8,}$/.test(arg)) {
      out.push("[redacted]");
      continue;
    }
    if (/(?:KEY|TOKEN|SECRET|PASSWORD)=/i.test(arg)) {
      out.push(arg.replace(/=.*/, "=[redacted]"));
      continue;
    }
    out.push(arg);
  }
  return out;
}

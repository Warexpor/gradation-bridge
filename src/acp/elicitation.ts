/**
 * Relay checks for ACP elicitation/create.
 * Form mode must not carry credential fields. URL mode must be an http(s) URL
 * with no userinfo. The bridge does not open the URL.
 */

export interface ElicitationSupport {
  form: boolean;
  url: boolean;
}

export class ElicitationRejected extends Error {
  readonly code = -32602;

  constructor(message: string) {
    super(message);
    this.name = "ElicitationRejected";
  }
}

const MAX_BYTES = 256 * 1024;
const MAX_PROPERTIES = 40;
const SECRET_KEY =
  /(password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|credential|otp|(^|[-_])pin($|[-_]))/i;

const PROPERTY_TYPES = new Set(["string", "number", "integer", "boolean", "array"]);

export function elicitationSupportFromInitialize(params: unknown): ElicitationSupport {
  const caps = clientCaps(params)?.elicitation;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return { form: false, url: false };
  const rec = caps as Record<string, unknown>;
  return {
    form: isCapability(rec.form),
    url: isCapability(rec.url),
  };
}

/** Return the params to forward, or throw ElicitationRejected. */
export function relayElicitationParams(
  params: unknown,
  support: ElicitationSupport,
): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new ElicitationRejected("invalid elicitation");
  }
  const raw = params as Record<string, unknown>;
  let encoded = "";
  try {
    encoded = JSON.stringify(raw);
  } catch {
    throw new ElicitationRejected("invalid elicitation");
  }
  if (encoded.length > MAX_BYTES) throw new ElicitationRejected("elicitation payload is too large");
  if (!support.form && !support.url) {
    throw new ElicitationRejected("client does not advertise elicitation");
  }
  const mode = raw.mode;
  if (typeof mode !== "string" || !mode) throw new ElicitationRejected("elicitation mode required");
  assertScope(raw);
  if (mode === "form") {
    if (!support.form) throw new ElicitationRejected("client does not advertise form elicitation");
    assertForm(raw);
  } else if (mode === "url") {
    if (!support.url) throw new ElicitationRejected("client does not advertise url elicitation");
    assertUrl(raw);
  } else if (!mode.startsWith("_") && mode.length > 64) {
    throw new ElicitationRejected("elicitation mode is not supported");
  }
  return raw;
}

export function elicitationLogLabel(params: Record<string, unknown>): string {
  if (params.mode === "url") {
    try {
      return `url host=${new URL(String(params.url)).host}`;
    } catch {
      return "url";
    }
  }
  return params.mode === "form" ? "form" : "other";
}

type ElicitValue = string | number | boolean | string[];

/** Keep accept/decline/cancel. Drop content on anything except accept. */
export function sanitizeElicitationResponse(result: unknown): {
  action: string;
  content?: Record<string, ElicitValue>;
} {
  if (!result || typeof result !== "object" || Array.isArray(result)) return { action: "cancel" };
  const action = (result as { action?: unknown }).action;
  if (action !== "accept" && action !== "decline" && action !== "cancel") {
    if (typeof action === "string" && action.startsWith("_") && action.length <= 64) {
      return { action };
    }
    return { action: "cancel" };
  }
  if (action !== "accept") return { action };
  const content = (result as { content?: unknown }).content;
  if (content == null) return { action: "accept" };
  if (!isPlain(content)) return { action: "cancel" };
  const clean: Record<string, ElicitValue> = {};
  for (const [key, value] of Object.entries(content)) {
    if (!key || key.length > 80 || SECRET_KEY.test(key)) continue;
    const kept = sanitizeValue(value);
    if (kept !== undefined) clean[key] = kept;
  }
  return { action: "accept", content: clean };
}

function clientCaps(params: unknown): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object") return undefined;
  const caps = (params as { clientCapabilities?: unknown }).clientCapabilities;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return undefined;
  return caps as Record<string, unknown>;
}

function isCapability(value: unknown): boolean {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function assertScope(raw: Record<string, unknown>): void {
  const hasSession = typeof raw.sessionId === "string" && raw.sessionId.length > 0;
  const hasRequest = typeof raw.requestId === "string" || typeof raw.requestId === "number";
  if (!hasSession && !hasRequest) {
    throw new ElicitationRejected("elicitation requires sessionId or requestId");
  }
}

function assertForm(raw: Record<string, unknown>): void {
  const schema = raw.requestedSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new ElicitationRejected("form elicitation requires requestedSchema");
  }
  const rec = schema as Record<string, unknown>;
  if (rec.type != null && rec.type !== "object") {
    throw new ElicitationRejected("form schema must be an object");
  }
  const properties = rec.properties ?? {};
  if (!isPlain(properties)) throw new ElicitationRejected("form properties must be an object");
  const entries = Object.entries(properties);
  if (entries.length > MAX_PROPERTIES) throw new ElicitationRejected("form schema has too many fields");
  for (const [key, value] of entries) {
    if (SECRET_KEY.test(key)) {
      throw new ElicitationRejected("form elicitation cannot request credentials");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ElicitationRejected("form field schema is invalid");
    }
    const type = (value as { type?: unknown }).type;
    if (typeof type !== "string" || !PROPERTY_TYPES.has(type)) {
      throw new ElicitationRejected("form field type is not supported");
    }
  }
}

function assertUrl(raw: Record<string, unknown>): void {
  const id = raw.elicitationId;
  if (typeof id !== "string" || !id || id.length > 200 || /[\s\u0000]/.test(id)) {
    throw new ElicitationRejected("elicitationId is invalid");
  }
  const urlText = raw.url;
  if (typeof urlText !== "string" || urlText.length > 2048) {
    throw new ElicitationRejected("elicitation url is invalid");
  }
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new ElicitationRejected("elicitation url is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ElicitationRejected("elicitation url must be http or https");
  }
  if (url.username || url.password) {
    throw new ElicitationRejected("elicitation url must not include credentials");
  }
  if (!url.hostname) throw new ElicitationRejected("elicitation url is invalid");
}

function sanitizeValue(value: unknown): ElicitValue | undefined {
  if (typeof value === "string") return value.slice(0, 4000);
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string") && value.length <= 32) {
    return value.map((item) => item.slice(0, 500));
  }
  return undefined;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

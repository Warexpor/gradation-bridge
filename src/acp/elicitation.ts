/**
 * Relay checks for ACP elicitation/create.
 * Form mode must not carry credential fields. URL mode must be a public http(s)
 * URL with no userinfo. The bridge does not open the URL. The phone does, so a
 * loopback or private host would be the phone's network, not this machine.
 */

import { isIP } from "node:net";
import { wireIdString } from "./wire-id.js";

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
const MAX_MESSAGE = 8000;
const MAX_MODE = 64;
const SECRET_KEY =
  /(password|passwd|passphrase|passcode|(^|[-_])pwd($|[-_])|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|session[-_]?token|id[-_]?token|private[-_]?key|credential|client[-_]?secret|(^|[-_])otp($|[-_])|(^|[-_])pin($|[-_])|(^|[-_])cvv($|[-_])|(^|[-_])ssn($|[-_]))/i;

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

/**
 * A later `initialize` must not drop elicitation modes an earlier phone already
 * advertised. Other capabilities stay as the latest params sent them.
 */
export function mergeInitializeElicitation(previous: unknown, next: unknown): Record<string, unknown> {
  if (!next || typeof next !== "object" || Array.isArray(next)) return {};
  const nextObj = { ...(next as Record<string, unknown>) };
  const prevSupport = elicitationSupportFromInitialize(previous);
  const nextSupport = elicitationSupportFromInitialize(nextObj);
  if (!prevSupport.form && !prevSupport.url) return nextObj;
  if (prevSupport.form === nextSupport.form && prevSupport.url === nextSupport.url) return nextObj;
  const caps = { ...(clientCaps(nextObj) ?? {}) };
  const elicitation: Record<string, unknown> = {};
  const raw = caps.elicitation;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    Object.assign(elicitation, raw);
  }
  if ((prevSupport.form || nextSupport.form) && !isCapability(elicitation.form)) elicitation.form = {};
  if ((prevSupport.url || nextSupport.url) && !isCapability(elicitation.url)) elicitation.url = {};
  caps.elicitation = elicitation;
  return { ...nextObj, clientCapabilities: caps };
}

/**
 * In a session, the phone always sees that session id. Before a session exists,
 * drop any sessionId so a warm login cannot point the prompt at another session.
 */
export function bindElicitationSession(params: unknown, sessionId?: string): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const raw = { ...(params as Record<string, unknown>) };
  if (sessionId) {
    raw.sessionId = sessionId;
    return raw;
  }
  delete raw.sessionId;
  return raw;
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
  assertMessage(raw);
  assertScope(raw);
  if (mode === "form") {
    if (!support.form) throw new ElicitationRejected("client does not advertise form elicitation");
    assertForm(raw);
    return pickKnown(raw, ["sessionId", "requestId", "message", "requestedSchema"]);
  }
  if (mode === "url") {
    if (!support.url) throw new ElicitationRejected("client does not advertise url elicitation");
    assertUrl(raw);
    return pickKnown(raw, ["sessionId", "requestId", "message", "elicitationId", "url"]);
  }
  if (!isExtensionMode(mode)) {
    throw new ElicitationRejected("elicitation mode is not supported");
  }
  const copy = { ...raw };
  delete copy.env;
  return copy;
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
    if (!key || key.length > 80 || SECRET_KEY.test(canonicalKey(key))) continue;
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

function assertMessage(raw: Record<string, unknown>): void {
  if (raw.message == null) return;
  if (typeof raw.message !== "string") throw new ElicitationRejected("elicitation message is invalid");
  if (raw.message.length > MAX_MESSAGE) throw new ElicitationRejected("elicitation message is too large");
}

function canonicalKey(key: string): string {
  return key.normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/g, "");
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
  const required = rec.required;
  if (required != null) {
    if (!Array.isArray(required) || required.some((item) => typeof item !== "string")) {
      throw new ElicitationRejected("form schema is invalid");
    }
    if (required.some((item) => SECRET_KEY.test(canonicalKey(item)))) {
      throw new ElicitationRejected("form elicitation cannot request credentials");
    }
  }
  for (const [key, value] of entries) {
    if (SECRET_KEY.test(canonicalKey(key))) {
      throw new ElicitationRejected("form elicitation cannot request credentials");
    }
    assertFieldSchema(value);
  }
}

function assertFieldSchema(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ElicitationRejected("form field schema is invalid");
  }
  const field = value as Record<string, unknown>;
  if (field.writeOnly === true || (typeof field.format === "string" && field.format.toLowerCase() === "password")) {
    throw new ElicitationRejected("form elicitation cannot request credentials");
  }
  const type = field.type;
  if (typeof type !== "string" || !PROPERTY_TYPES.has(type)) {
    throw new ElicitationRejected("form field type is not supported");
  }
  if (type === "array" && field.items != null) {
    const items = field.items;
    if (!items || typeof items !== "object" || Array.isArray(items)) {
      throw new ElicitationRejected("form field schema is invalid");
    }
    const itemType = (items as { type?: unknown }).type;
    if (itemType != null && (typeof itemType !== "string" || !PROPERTY_TYPES.has(itemType) || itemType === "array")) {
      throw new ElicitationRejected("form field type is not supported");
    }
    const itemFormat = (items as { format?: unknown }).format;
    if (
      (items as { writeOnly?: unknown }).writeOnly === true ||
      (typeof itemFormat === "string" && itemFormat.toLowerCase() === "password")
    ) {
      throw new ElicitationRejected("form elicitation cannot request credentials");
    }
  }
}

/** Canonical digit-string elicitation id. Spaces stay invalid. */
export function elicitationIdString(value: unknown): string | undefined {
  const id = wireIdString(value);
  if (!id || /\s/.test(id)) return undefined;
  return id;
}

function assertUrl(raw: Record<string, unknown>): void {
  // Digit-string ids arrive as JSON numbers or `"5.0"`, same as methodId.
  const id = elicitationIdString(raw.elicitationId);
  if (!id) {
    throw new ElicitationRejected("elicitationId is invalid");
  }
  raw.elicitationId = id;
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
  assertPublicHost(url.hostname);
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.internal",
]);

/** The phone opens this URL. Loopback would be the phone, not this machine. */
function assertPublicHost(hostname: string): void {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.replace(/\.$/, "");
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith(".localhost")) {
    throw new ElicitationRejected("elicitation url must be a public http(s) address");
  }
  const kind = isIP(host);
  if (kind === 4 && isBlockedV4(host)) {
    throw new ElicitationRejected("elicitation url must be a public http(s) address");
  }
  if (kind === 6 && isBlockedV6(host)) {
    throw new ElicitationRejected("elicitation url must be a public http(s) address");
  }
}

function isBlockedV4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedV6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = Number.parseInt(mapped[1] ?? "", 16);
    const lo = Number.parseInt(mapped[2] ?? "", 16);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return true;
    return isBlockedV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (h.startsWith("::ffff:")) {
    const v4 = h.slice("::ffff:".length);
    return isIP(v4) !== 4 || isBlockedV4(v4);
  }
  const expanded = expandIpv6(h);
  if (expanded && embeddedPrivateV4(expanded)) return true;
  const head = h.split(":")[0] ?? "";
  if (!head) return false;
  const prefix = Number.parseInt(head, 16);
  if (!Number.isFinite(prefix)) return false;
  if (prefix >= 0xfe80 && prefix <= 0xfebf) return true;
  if (prefix >= 0xfc00 && prefix <= 0xfdff) return true;
  if (prefix >= 0xff00) return true;
  return false;
}

/** Eight hextets, or undefined when `host` is not a compressed IPv6 literal. */
function expandIpv6(host: string): number[] | undefined {
  if (host.includes(".")) return undefined;
  const halves = host.split("::");
  if (halves.length > 2) return undefined;
  const parseSide = (side: string): number[] | undefined => {
    if (!side) return [];
    const out: number[] = [];
    for (const part of side.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
      out.push(Number.parseInt(part, 16));
    }
    return out;
  };
  const left = parseSide(halves[0] ?? "");
  if (!left) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const right = parseSide(halves[1] ?? "");
  if (!right) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function v4FromHextets(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * NAT64, 6to4, and IPv4-compatible forms hide a private IPv4 address inside
 * a public-looking IPv6 literal. The phone would still open that IPv4.
 * A public embedded address (8.8.8.8) stays allowed.
 */
function embeddedPrivateV4(parts: number[]): boolean {
  const hi = parts[6] ?? 0;
  const lo = parts[7] ?? 0;
  const v4 = (): boolean => isBlockedV4(v4FromHextets(hi, lo));
  // IPv4-compatible ::a.b.c.d and :: (already covered) — last 32 bits are IPv4.
  if (parts.slice(0, 6).every((n) => n === 0)) return v4();
  // NAT64 well-known prefix 64:ff9b::/96.
  if (
    parts[0] === 0x64 &&
    parts[1] === 0xff9b &&
    parts[2] === 0 &&
    parts[3] === 0 &&
    parts[4] === 0 &&
    parts[5] === 0
  ) {
    return v4();
  }
  // NAT64 local-use prefix 64:ff9b:1::/48 (RFC 8215). Subnet id is hextet 3.
  if (parts[0] === 0x64 && parts[1] === 0xff9b && parts[2] === 1 && parts[4] === 0 && parts[5] === 0) {
    return v4();
  }
  // 6to4 2002::/16 embeds IPv4 in the next 32 bits.
  if (parts[0] === 0x2002) return isBlockedV4(v4FromHextets(parts[1] ?? 0, parts[2] ?? 0));
  return false;
}

function isExtensionMode(mode: string): boolean {
  return mode.startsWith("_") && mode.length <= MAX_MODE && !/[\s\u0000-\u001f]/.test(mode);
}

function pickKnown(raw: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { mode: raw.mode };
  for (const key of keys) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
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

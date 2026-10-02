/**
 * Phone and proxy stacks sometimes rewrite digit-string ids as JSON numbers
 * (or whole-number doubles / `"5.0"` strings). Canonicalize those to the digit
 * string the agent advertised so authenticate, permission answers, and similar
 * lookups still match.
 */

const MAX_WIRE_ID = 200;

/**
 * Return a safe string form of a wire id, mapping whole-number doubles and
 * their string spellings onto the integer digit string (`5`, `5.0`, `"5.0"` →
 * `"5"`). Non-numeric strings are returned trimmed. Invalid values are
 * `undefined`.
 */
export function wireIdString(value: unknown): string | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
      return undefined;
    }
    return String(value);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_WIRE_ID || /[\u0000-\u001f]/.test(trimmed)) {
    return undefined;
  }
  const whole = wholeNumberDigitString(trimmed);
  return whole ?? trimmed;
}

/** True when both sides canonicalize to the same wire id string. */
export function wireIdsEqual(a: unknown, b: unknown): boolean {
  const left = wireIdString(a);
  const right = wireIdString(b);
  if (left == null || right == null) return false;
  return left === right;
}

/**
 * `"5"`, `"5.0"`, `"5.00"` → `"5"`. Non-whole or non-numeric strings return
 * `undefined` so callers keep the original text.
 */
export function wholeNumberDigitString(raw: string): string | undefined {
  if (/^-?\d+$/.test(raw)) {
    const asNum = Number(raw);
    if (!Number.isSafeInteger(asNum)) return undefined;
    return String(asNum);
  }
  if (/^-?\d+\.0+$/.test(raw)) {
    const asNum = Number(raw);
    if (!Number.isSafeInteger(asNum)) return undefined;
    return String(asNum);
  }
  return undefined;
}

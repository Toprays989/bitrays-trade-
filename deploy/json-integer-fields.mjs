const escapePattern = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * JSON.parse converts large integer tokens to imprecise JavaScript numbers.
 * Exchange identifiers are opaque decimal strings, so quote only integer
 * values for the selected fields before parsing.
 */
export function preserveJsonIntegerFields(text, fields = ["orderId"]) {
  const source = String(text ?? "");
  const names = [...new Set(fields.map(String).filter(Boolean))];
  if (!source || !names.length) return source;
  const fieldPattern = names.map(escapePattern).join("|");
  return source.replace(
    new RegExp(
      `("(?:${fieldPattern})"\\s*:\\s*)(-?\\d{16,})(?=\\s*[,}\\]])`,
      "g",
    ),
    '$1"$2"',
  );
}

export function parseJsonPreservingIntegerFields(
  text,
  fields = ["orderId"],
) {
  return JSON.parse(preserveJsonIntegerFields(text, fields));
}

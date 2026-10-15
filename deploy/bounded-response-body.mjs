export async function readResponseTextBounded(response, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0)
    throw new TypeError("maxBytes must be a positive integer");
  if (!response.body) return { text: "", bytesRead: 0, truncated: false };

  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;

      const remaining = maxBytes - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel("response body byte budget reached");
        break;
      }

      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        bytesRead += remaining;
        truncated = true;
        await reader.cancel("response body byte budget reached");
        break;
      }

      chunks.push(value);
      bytesRead += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    text: new TextDecoder().decode(body),
    bytesRead,
    truncated,
  };
}

export const SQL_QUERY_VALUE_CHUNK_SIZE = 80;

export function chunkSqlQueryValues<T>(values: readonly T[]) {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += SQL_QUERY_VALUE_CHUNK_SIZE)
    chunks.push(values.slice(offset, offset + SQL_QUERY_VALUE_CHUNK_SIZE));
  return chunks;
}

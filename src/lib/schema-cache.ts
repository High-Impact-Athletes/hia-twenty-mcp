import type { MetadataObject, TwentyClient } from "./twenty-client";

const TTL_SECONDS = 60 * 60; // 1 hour

/**
 * Returns the workspace schema, using a KV cache keyed by Twenty base URL.
 *
 * Note: cache is shared across all users on the same base URL. This is safe
 * because the metadata API returns the *workspace* schema, which does not
 * vary per user. Row-level permissions only affect record queries, which
 * don't go through here.
 */
export async function getSchema(
  kv: KVNamespace,
  client: TwentyClient,
  baseUrl: string,
  opts: { force?: boolean } = {}
): Promise<MetadataObject[]> {
  const key = `schema:${baseUrl}`;

  if (!opts.force) {
    const cached = await kv.get(key, "json");
    if (cached) return cached as MetadataObject[];
  }

  const fresh = await client.introspectObjects();
  await kv.put(key, JSON.stringify(fresh), { expirationTtl: TTL_SECONDS });
  return fresh;
}

/** Look up an object by name (singular or plural), case-insensitive. */
export function findObject(
  schema: MetadataObject[],
  name: string
): MetadataObject | undefined {
  const lower = name.toLowerCase();
  return schema.find(
    (o) =>
      o.nameSingular.toLowerCase() === lower ||
      o.namePlural.toLowerCase() === lower
  );
}

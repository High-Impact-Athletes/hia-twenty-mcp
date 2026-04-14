import type { MetadataObject } from "./twenty-client";
import defaultContext from "../primer/default-context.md";

/**
 * KV key under which the org-specific primer markdown is stored.
 * Upload via `POST /admin/primer` (see auth/twenty-handler.ts).
 */
export const PRIMER_KV_KEY = "primer:context";

/**
 * Load the org-specific primer from KV, or fall back to the bundled default.
 * Deployments override the default by uploading a markdown file via the admin
 * endpoint — no rebuild required.
 */
export async function loadOrgContext(kv: KVNamespace): Promise<string> {
  try {
    const override = await kv.get(PRIMER_KV_KEY);
    if (override && override.trim().length > 0) return override;
  } catch {
    // Fall through to default if KV read fails.
  }
  return defaultContext;
}

/**
 * Render the full primer: org-specific context + compact schema snapshot.
 * Sized to fit under ~6k tokens of markdown.
 */
export async function renderPrimer(
  kv: KVNamespace,
  schema: MetadataObject[],
  allowedObjects: string[] = []
): Promise<string> {
  const orgContext = await loadOrgContext(kv);

  const filtered =
    allowedObjects.length === 0
      ? schema
      : schema.filter((o) =>
          allowedObjects.includes(o.namePlural) ||
          allowedObjects.includes(o.nameSingular)
        );

  // Group: stock (isCustom=false) vs custom (isCustom=true)
  const stock = filtered.filter((o) => !o.isCustom && o.isActive);
  const custom = filtered.filter((o) => o.isCustom && o.isActive);

  const parts: string[] = [
    orgContext,
    "",
    "---",
    "",
    "## Live schema snapshot",
    "",
    "_Auto-generated from the Twenty metadata API. Cached for 1 hour. Call `list_objects` or `describe_object` for deeper detail._",
    "",
  ];

  if (custom.length) {
    parts.push("### Custom objects");
    parts.push("");
    for (const o of custom) parts.push(renderObject(o));
  }

  if (stock.length) {
    parts.push("### Stock objects");
    parts.push("");
    for (const o of stock) parts.push(renderObject(o));
  }

  return parts.join("\n");
}

function renderObject(o: MetadataObject): string {
  const fieldLines = o.fields
    .filter((f) => f.isActive && !f.isSystem)
    .map((f) => {
      const tag = f.isCustom ? " _(custom)_" : "";
      const rel = f.relation
        ? ` → ${f.relation.targetObject ?? "?"}`
        : "";
      const type = rel ? `relation${rel}` : f.type;
      const req = f.isNullable ? "" : " *required*";
      return `  - **${f.name}** (${type})${tag}${req}`;
    });

  return [
    `#### ${o.labelSingular} \`${o.nameSingular}\` / \`${o.namePlural}\``,
    o.description ? `_${o.description}_` : "",
    ...fieldLines,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

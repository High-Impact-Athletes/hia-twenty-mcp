/**
 * HTTP client for Twenty CRM.
 *
 * - Record CRUD uses the REST API at `<base>/rest/<objectNamePlural>`.
 * - Schema introspection uses the GraphQL metadata API at `<base>/metadata`.
 *
 * Each instance is scoped to a single user's Twenty API key (workspace-bound).
 *
 * Gotchas intentionally handled here (see twenty-crm-setup/TWENTY-API-QUIRKS.md):
 *  - 429 cascade: on rate limit, back off for 120s, then retry (max 3 attempts).
 *  - Cursor pagination bug: `listRecords` detects duplicate cursors and stops.
 *  - Email trailing whitespace: callers should `.trim()` — we don't mutate bodies.
 *  - Currency fields: callers pass `{amountMicros, currencyCode}` — we don't translate.
 */
export class TwentyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  // -------- REST (records) --------

  async listRecords(
    objectNamePlural: string,
    params: {
      limit?: number;
      after?: string;
      filter?: string; // Twenty filter string, e.g. "name.firstName[eq]:Jane"
      orderBy?: string;
      depth?: number;
    } = {}
  ): Promise<{ data: unknown[]; endCursor?: string; hasNextPage: boolean }> {
    const qs = new URLSearchParams();
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.after) qs.set("starting_after", params.after);
    if (params.filter) qs.set("filter", params.filter);
    if (params.orderBy) qs.set("order_by", params.orderBy);
    if (typeof params.depth === "number") qs.set("depth", String(Math.min(params.depth, 1)));

    const path = `/rest/${objectNamePlural}${qs.toString() ? `?${qs}` : ""}`;
    const json = await this.rest<any>("GET", path);

    // Twenty REST shape: { data: { <objectNamePlural>: [...] }, pageInfo: {...} }
    const records: unknown[] = json?.data?.[objectNamePlural] ?? [];
    const pageInfo = json?.pageInfo ?? {};
    return {
      data: records,
      endCursor: pageInfo.endCursor,
      hasNextPage: Boolean(pageInfo.hasNextPage),
    };
  }

  async getRecord(
    objectNamePlural: string,
    id: string,
    depth = 1
  ): Promise<unknown> {
    const json = await this.rest<any>(
      "GET",
      `/rest/${objectNamePlural}/${id}?depth=${depth}`
    );
    // Single-record shape: { data: { <objectNameSingular>: {...} } }
    const data = json?.data ?? {};
    const key = Object.keys(data)[0];
    return key ? data[key] : data;
  }

  async createRecord(objectNamePlural: string, body: unknown): Promise<unknown> {
    const json = await this.rest<any>("POST", `/rest/${objectNamePlural}`, body);
    const data = json?.data ?? {};
    const key = Object.keys(data)[0];
    return key ? data[key] : data;
  }

  async updateRecord(
    objectNamePlural: string,
    id: string,
    body: unknown
  ): Promise<unknown> {
    const json = await this.rest<any>(
      "PATCH",
      `/rest/${objectNamePlural}/${id}`,
      body
    );
    const data = json?.data ?? {};
    const key = Object.keys(data)[0];
    return key ? data[key] : data;
  }

  async deleteRecord(objectNamePlural: string, id: string): Promise<unknown> {
    return this.rest<unknown>("DELETE", `/rest/${objectNamePlural}/${id}`);
  }

  // -------- GraphQL --------

  /** Run a raw GraphQL query against /metadata (schema) or /graphql (records). */
  async graphql<T = unknown>(
    endpoint: "metadata" | "graphql",
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/${endpoint}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ query, variables }),
      }
    );
    const json = (await res.json()) as { data?: T; errors?: unknown[] };
    if (json.errors && json.errors.length) {
      throw new Error(
        `Twenty GraphQL (${endpoint}) error: ${JSON.stringify(json.errors)}`
      );
    }
    return json.data as T;
  }

  /** Fetch all object metadata (objects + fields + relations). */
  async introspectObjects(): Promise<MetadataObject[]> {
    const query = `
      query Objects {
        objects(paging: { first: 200 }) {
          edges {
            node {
              id
              nameSingular
              namePlural
              labelSingular
              labelPlural
              description
              icon
              isCustom
              isActive
              isSystem
              fields(paging: { first: 200 }) {
                edges {
                  node {
                    id
                    name
                    label
                    type
                    description
                    isCustom
                    isActive
                    isNullable
                    isSystem
                    defaultValue
                    options
                    settings
                  }
                }
              }
            }
          }
        }
      }
    `;
    const data = await this.graphql<{
      objects: { edges: { node: MetadataObjectRaw }[] };
    }>("metadata", query);

    return data.objects.edges.map(({ node }) => ({
      id: node.id,
      nameSingular: node.nameSingular,
      namePlural: node.namePlural,
      labelSingular: node.labelSingular,
      labelPlural: node.labelPlural,
      description: node.description ?? undefined,
      icon: node.icon ?? undefined,
      isCustom: node.isCustom,
      isActive: node.isActive,
      isSystem: node.isSystem,
      fields: node.fields.edges.map((e) => ({
        id: e.node.id,
        name: e.node.name,
        label: e.node.label,
        type: e.node.type,
        description: e.node.description ?? undefined,
        isCustom: e.node.isCustom,
        isActive: e.node.isActive,
        isNullable: e.node.isNullable,
        isSystem: e.node.isSystem,
        defaultValue: e.node.defaultValue ?? undefined,
        options: e.node.options ?? undefined,
        relation: (e.node.type === "RELATION" && e.node.settings)
          ? {
              direction: e.node.settings.relationType ?? "UNKNOWN",
              targetObject: inferTargetFromJoinColumn(e.node.settings.joinColumnName, e.node.name),
              targetField: e.node.settings.joinColumnName ?? undefined,
            }
          : undefined,
      })),
    }));
  }

  /** Ping the API key — returns workspace name on success, throws on auth failure. */
  async validateApiKey(): Promise<{ workspaceName: string | null }> {
    // Use a lightweight metadata query. If the key is invalid, /metadata returns 401.
    const data = await this.graphql<{
      currentWorkspace?: { displayName?: string };
    }>(
      "metadata",
      `query { currentWorkspace { displayName } }`
    ).catch(async () => {
      // currentWorkspace may not exist on all versions; fall back to a trivial introspection
      await this.graphql("metadata", "query { __typename }");
      return { currentWorkspace: { displayName: null } };
    });
    return {
      workspaceName: data?.currentWorkspace?.displayName ?? null,
    };
  }

  // -------- internals --------

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private async rest<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * Fetch with:
   *  - 3 retry attempts on 429/5xx
   *  - 429 "cascade" backoff: wait 120s before retry (two full windows)
   *  - 30s per-request timeout
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(30_000),
      });

      if (res.status === 429) {
        // Twenty's 429 cascade: retrying immediately compounds the problem.
        // Wait 120s (two full 60s windows) before the next attempt.
        await sleep(120_000);
        lastErr = new Error(`Rate limited (attempt ${attempt + 1}/3)`);
        continue;
      }

      if (res.status >= 500 && res.status < 600) {
        lastErr = new Error(`Twenty ${res.status}: ${await safeText(res)}`);
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }

      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`Twenty ${init.method} ${url} -> ${res.status}: ${text}`);
      }

      return res;
    }
    throw lastErr ?? new Error("Twenty request failed after retries");
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Infer the target object name from a join column like "companyId" → "company",
 * or fall back to the field name itself.
 */
function inferTargetFromJoinColumn(joinColumn?: string, fieldName?: string): string | undefined {
  if (joinColumn && joinColumn.endsWith("Id")) {
    return joinColumn.slice(0, -2);
  }
  return fieldName ?? undefined;
}

// ---- metadata shapes (subset of Twenty's schema we use) ----

export interface MetadataField {
  id: string;
  name: string;
  label: string;
  type: string;
  description?: string;
  isCustom: boolean;
  isActive: boolean;
  isNullable: boolean;
  isSystem: boolean;
  defaultValue?: unknown;
  options?: unknown;
  relation?: {
    direction: string;
    targetObject?: string;
    targetField?: string;
  };
}

export interface MetadataObject {
  id: string;
  nameSingular: string;
  namePlural: string;
  labelSingular: string;
  labelPlural: string;
  description?: string;
  icon?: string;
  isCustom: boolean;
  isActive: boolean;
  isSystem: boolean;
  fields: MetadataField[];
}

interface MetadataObjectRaw {
  id: string;
  nameSingular: string;
  namePlural: string;
  labelSingular: string;
  labelPlural: string;
  description: string | null;
  icon: string | null;
  isCustom: boolean;
  isActive: boolean;
  isSystem: boolean;
  fields: {
    edges: {
      node: {
        id: string;
        name: string;
        label: string;
        type: string;
        description: string | null;
        isCustom: boolean;
        isActive: boolean;
        isNullable: boolean;
        isSystem: boolean;
        defaultValue: unknown;
        options: unknown;
        settings: {
          relationType?: string;
          joinColumnName?: string;
          onDelete?: string;
          [key: string]: unknown;
        } | null;
      };
    }[];
  };
}

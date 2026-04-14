import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TwentyClient } from "./lib/twenty-client";
import { findObject, getSchema } from "./lib/schema-cache";
import { renderPrimer } from "./lib/primer";
import type { Env, Props, State } from "./types";

/**
 * Twenty MCP — generic, schema-driven.
 *
 * 8 tools operate on any Twenty object without requiring code changes when
 * the schema evolves. Tools honour this.props.mode ("read" hides mutations)
 * and this.props.allowedObjects (a whitelist; empty means "all").
 */
export class TwentyMCP extends McpAgent<Env, State, Props> {
  server = new McpServer({
    name: "Twenty CRM",
    version: "0.1.0",
  });

  async init() {
    const props = this.props;
    const apiKey = props?.twentyApiKey;
    const baseUrl = this.env.TWENTY_BASE_URL;

    if (!props || !apiKey) {
      this.server.registerTool(
        "status",
        { description: "Check authentication status" },
        async () => ({
          content: [
            {
              type: "text" as const,
              text: "Not authenticated. Please reconnect via Claude Settings → Connectors.",
            },
          ],
        })
      );
      return;
    }

    const client = new TwentyClient(baseUrl, apiKey);
    const mode = props.mode ?? "read";
    const allowed = props.allowedObjects ?? [];
    const canWrite = mode === "write";

    const assertAllowed = (namePlural: string): string | null => {
      if (allowed.length === 0) return null;
      const lower = namePlural.toLowerCase();
      const match = allowed.some((a) => a.toLowerCase() === lower);
      if (match) return null;
      return `Access to object "${namePlural}" is not permitted for this connection. Allowed: ${allowed.join(", ")}`;
    };

    // ---- Read tools (always on) ----

    this.server.registerTool(
      "list_objects",
      {
        description:
          "List all object types in this Twenty workspace, filtered to those permitted for this connection. " +
          "Includes both stock objects (Person, Company, Opportunity, ...) and any custom objects defined in this workspace. " +
          "Use this before any other tool to discover what exists.",
        inputSchema: {},
      },
      async () => {
        const schema = await getSchema(this.env.OAUTH_KV, client, baseUrl);
        const visible = schema
          .filter((o) => o.isActive)
          .filter((o) => assertAllowed(o.namePlural) === null)
          .map((o) => ({
            nameSingular: o.nameSingular,
            namePlural: o.namePlural,
            labelSingular: o.labelSingular,
            labelPlural: o.labelPlural,
            isCustom: o.isCustom,
            fieldCount: o.fields.filter((f) => f.isActive && !f.isSystem).length,
            description: o.description,
          }));
        return jsonContent(visible);
      }
    );

    this.server.registerTool(
      "describe_object",
      {
        description:
          "Get the full field schema for a single object, including custom fields, select options, and relations. " +
          "Use the object name in singular or plural form (e.g. 'person' or 'people').",
        inputSchema: {
          objectName: z
            .string()
            .describe("Object name, singular or plural (case-insensitive)"),
        },
      },
      async ({ objectName }) => {
        const schema = await getSchema(this.env.OAUTH_KV, client, baseUrl);
        const obj = findObject(schema, objectName);
        if (!obj) return errorContent(`Object "${objectName}" not found.`);
        const err = assertAllowed(obj.namePlural);
        if (err) return errorContent(err);
        return jsonContent(obj);
      }
    );

    this.server.registerTool(
      "find_records",
      {
        description:
          "Query records with optional filtering, ordering, and pagination. " +
          "Filter uses Twenty's syntax, e.g. 'firstName[eq]:Jane' or 'createdAt[gt]:2026-01-01'. " +
          "Returns up to `limit` records (default 20, max 60) and a cursor for the next page.",
        inputSchema: {
          objectName: z.string().describe("Object name (singular or plural)"),
          filter: z.string().optional().describe("Twenty filter expression"),
          orderBy: z
            .string()
            .optional()
            .describe("Field to order by, e.g. 'createdAt[DescNullsLast]'"),
          limit: z.number().min(1).max(60).optional().default(20),
          cursor: z.string().optional().describe("Pagination cursor from a previous response"),
          depth: z
            .number()
            .min(0)
            .max(2)
            .optional()
            .default(1)
            .describe(
              "0=only this record's fields, 1=include one level of relations (default), 2=two levels"
            ),
        },
      },
      async ({ objectName, filter, orderBy, limit, cursor, depth }) => {
        const schema = await getSchema(this.env.OAUTH_KV, client, baseUrl);
        const obj = findObject(schema, objectName);
        if (!obj) return errorContent(`Object "${objectName}" not found.`);
        const err = assertAllowed(obj.namePlural);
        if (err) return errorContent(err);

        const result = await client.listRecords(obj.namePlural, {
          filter,
          orderBy,
          limit,
          after: cursor,
          depth,
        });
        return jsonContent({
          object: obj.namePlural,
          count: result.data.length,
          hasNextPage: result.hasNextPage,
          cursor: result.endCursor,
          records: result.data,
        });
      }
    );

    this.server.registerTool(
      "get_record",
      {
        description:
          "Fetch a single record by ID, including its related records (e.g. people for a company, tasks for a person).",
        inputSchema: {
          objectName: z.string(),
          id: z.string().describe("Twenty UUID"),
          depth: z.number().min(0).max(2).optional().default(1),
        },
      },
      async ({ objectName, id, depth }) => {
        const schema = await getSchema(this.env.OAUTH_KV, client, baseUrl);
        const obj = findObject(schema, objectName);
        if (!obj) return errorContent(`Object "${objectName}" not found.`);
        const err = assertAllowed(obj.namePlural);
        if (err) return errorContent(err);

        const record = await client.getRecord(obj.namePlural, id, depth);
        return jsonContent(record);
      }
    );

    this.server.registerTool(
      "run_graphql",
      {
        description:
          "Escape hatch: run a raw GraphQL query. Use endpoint='metadata' for schema mutations (create/update/delete fields or objects) " +
          "or endpoint='graphql' for record-level GraphQL (rare — prefer the REST tools above). " +
          "Returns the `data` field of the response; errors throw.",
        inputSchema: {
          endpoint: z.enum(["metadata", "graphql"]),
          query: z.string(),
          variables: z.record(z.unknown()).optional(),
        },
      },
      async ({ endpoint, query, variables }) => {
        if (!canWrite && /\bmutation\b/i.test(query)) {
          return errorContent("Read-only connection: mutations are disabled.");
        }
        const data = await client.graphql(endpoint, query, variables);
        return jsonContent(data);
      }
    );

    this.server.registerTool(
      "get_primer",
      {
        description:
          "Fetch the organisation-specific context doc plus a live schema snapshot. " +
          "This is the same content exposed as the `twenty://primer` resource — use this tool if your client doesn't auto-load MCP resources.",
        inputSchema: {},
      },
      async () => {
        const schema = await getSchema(this.env.OAUTH_KV, client, baseUrl);
        const text = await renderPrimer(this.env.OAUTH_KV, schema, allowed);
        return {
          content: [{ type: "text" as const, text }],
        };
      }
    );

    // ---- Write tools (only in write mode) ----

    if (canWrite) {
      this.server.registerTool(
        "create_record",
        {
          description:
            "Create a new record. `data` is a plain object matching the object's field schema. " +
            "For currency fields pass {amountMicros, currencyCode} — amountMicros is dollars × 1,000,000. " +
            "For relation fields use `<fieldName>Id` with the target UUID (e.g. companyId, personId). " +
            "Call describe_object first if unsure about field names.",
          inputSchema: {
            objectName: z.string(),
            data: z.record(z.unknown()),
          },
        },
        async ({ objectName, data }) => {
          const schema = await getSchema(this.env.OAUTH_KV, client, baseUrl);
          const obj = findObject(schema, objectName);
          if (!obj) return errorContent(`Object "${objectName}" not found.`);
          const err = assertAllowed(obj.namePlural);
          if (err) return errorContent(err);

          const created = await client.createRecord(obj.namePlural, data);
          return jsonContent(created);
        }
      );

      this.server.registerTool(
        "update_record",
        {
          description:
            "Patch an existing record. Only fields present in `data` are changed. " +
            "Same data shape rules as create_record (currency composite, relation <fieldName>Id).",
          inputSchema: {
            objectName: z.string(),
            id: z.string(),
            data: z.record(z.unknown()),
          },
        },
        async ({ objectName, id, data }) => {
          const schema = await getSchema(this.env.OAUTH_KV, client, baseUrl);
          const obj = findObject(schema, objectName);
          if (!obj) return errorContent(`Object "${objectName}" not found.`);
          const err = assertAllowed(obj.namePlural);
          if (err) return errorContent(err);

          const updated = await client.updateRecord(obj.namePlural, id, data);
          return jsonContent(updated);
        }
      );

      this.server.registerTool(
        "delete_record",
        {
          description:
            "Soft-delete a record. Twenty marks the record deleted but keeps it in the database (recoverable via the UI). " +
            "For junction objects, consider updating a status field instead of deleting — that preserves history.",
          inputSchema: {
            objectName: z.string(),
            id: z.string(),
          },
        },
        async ({ objectName, id }) => {
          const schema = await getSchema(this.env.OAUTH_KV, client, baseUrl);
          const obj = findObject(schema, objectName);
          if (!obj) return errorContent(`Object "${objectName}" not found.`);
          const err = assertAllowed(obj.namePlural);
          if (err) return errorContent(err);

          await client.deleteRecord(obj.namePlural, id);
          return jsonContent({ deleted: true, object: obj.namePlural, id });
        }
      );
    }

    // ---- Resources ----

    this.server.resource("twenty-primer", "twenty://primer", async () => {
      const schema = await getSchema(this.env.OAUTH_KV, client, baseUrl);
      const text = await renderPrimer(this.env.OAUTH_KV, schema, allowed);
      return {
        contents: [
          {
            uri: "twenty://primer",
            text,
          },
        ],
      };
    });

    this.server.resource("twenty-api-info", "twenty://api/info", async () => ({
      contents: [
        {
          uri: "twenty://api/info",
          text: `# Twenty MCP

Connected to: ${baseUrl}
Mode: **${mode}** (${canWrite ? "create/update/delete available" : "read-only"})
Allowed objects: ${allowed.length === 0 ? "_all_" : allowed.join(", ")}
User label: ${props.label ?? props.userId}

## Available tools
- \`list_objects\` — discover object types
- \`describe_object\` — full field schema for one object
- \`find_records\` — query with filter/orderBy/pagination
- \`get_record\` — single record by id
- \`get_primer\` — org context + schema snapshot (same as twenty://primer resource)
- \`run_graphql\` — raw metadata/graphql escape hatch
${canWrite ? "- `create_record`, `update_record`, `delete_record` — mutations" : "_(mutation tools hidden — read-only connection)_"}

## Always read twenty://primer first
It explains custom objects, business rules, and conventions specific to this workspace.`,
        },
      ],
    }));
  }
}

function jsonContent(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

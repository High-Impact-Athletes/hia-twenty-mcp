# Twenty MCP

A remote MCP (Model Context Protocol) server that connects Claude to a [Twenty CRM](https://twenty.com) workspace, deployed on Cloudflare Workers with OAuth for a one-click team install.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/High-Impact-Athletes/hia-twenty-mcp)

## What it does

Exposes 8 generic, **schema-driven** tools that work on any Twenty object (Person, Company, Opportunity, or any custom object). The MCP introspects Twenty's metadata API at runtime — you never need to update the MCP when you add fields or objects.

**Tools**
- `list_objects`, `describe_object` — discover what's in the CRM
- `find_records`, `get_record` — query with filter/orderBy/pagination
- `create_record`, `update_record`, `delete_record` — mutations (only when connected in write mode)
- `run_graphql` — escape hatch for raw metadata/graphql
- `get_primer` — org-specific domain context + live schema snapshot

**Resources** (auto-loaded by Claude on session start)
- `twenty://primer` — organisation context merged with a compact schema snapshot
- `twenty://api/info` — connector status and current scopes

## Install (team member, one-click)

1. In Claude → Settings → Connectors → **Add custom connector**
2. URL: `https://<your-worker>.workers.dev/mcp`
3. Claude redirects you to a consent page where you'll need your **personal** Twenty API key. To get one:
   - Log into your Twenty workspace in the browser
   - Click the gear icon (bottom-left) → **Settings**
   - Go to **Developers** (under the Workspace section in the sidebar)
   - Click **+ Create API key**, give it a name (e.g. "Claude MCP"), and copy the key
4. Paste the API key into the consent form. Choose permission (read-only or read+write) and optional object scopes.
5. Done. Your key is stored encrypted in Cloudflare KV, bound to your session.

Changes you make in Twenty are attributed to your Twenty user, not to a shared service account.

## Deploy (admin, first time)

1. Click the deploy button above. Cloudflare will fork the repo and prompt for secrets.
2. Set the required secrets:
   - `COOKIE_ENCRYPTION_KEY` — a random hex string used to encrypt OAuth session cookies. **Not a Twenty secret** — just generate one:
     ```bash
     openssl rand -hex 32
     ```
     Copy the output (a 64-character hex string like `a1b2c3d4...`) and paste it in.
   - `TWENTY_BASE_URL` — the full URL of your Twenty instance, including `https://` (e.g. `https://crm.example.com`). To find it: it's whatever URL you use to log into Twenty in your browser.
3. (Optional) Set `ADMIN_TOKEN` — another random hex string (`openssl rand -hex 32`) — enables the `/admin/*` endpoints for uploading org-specific primer context.
4. Note the deployed URL, e.g. `https://twenty-mcp.your-subdomain.workers.dev`.
5. Share `<url>/mcp` with the team.

For Claude managed team: register `<url>/mcp` once in the Claude team admin console — it will appear in every team member's connector list. Each member still completes the one-time consent page to paste their own Twenty API key.

## Customising the primer

The `twenty://primer` resource gives Claude context about your CRM before any tool calls. It contains two parts:

1. **Organisation context** — a markdown doc describing your domain model, custom objects, business rules, and conventions. Things introspection can't capture (e.g. "Object A and Object B are independent — don't infer one from the other").
2. **Schema snapshot** — auto-generated from Twenty's metadata API, cached for 1 hour.

Out of the box, part (1) is a generic Twenty template. To upload your org-specific context:

```bash
# Set ADMIN_TOKEN first if you haven't:
# wrangler secret put ADMIN_TOKEN

# Upload your context markdown:
curl -X PUT https://<your-worker>.workers.dev/admin/primer \
  -H "Authorization: Bearer <your-admin-token>" \
  -H "Content-Type: text/markdown" \
  --data-binary @path/to/your-context.md

# Verify it's loaded:
curl https://<your-worker>.workers.dev/admin/primer \
  -H "Authorization: Bearer <your-admin-token>"

# Revert to the bundled default:
curl -X DELETE https://<your-worker>.workers.dev/admin/primer \
  -H "Authorization: Bearer <your-admin-token>"
```

The context markdown should describe: what your organisation does, what each custom object means and how they relate, tiering/classification models, naming conventions, and any "do this / don't do that" rules for AI. See `src/primer/default-context.md` for the template structure.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
# edit .dev.vars — set COOKIE_ENCRYPTION_KEY, TWENTY_BASE_URL, and optionally ADMIN_TOKEN
npm run dev            # wrangler dev on http://localhost:8787
npm run typecheck
```

To connect a local Claude Desktop to the dev worker, add `http://localhost:8787/mcp` as a connector.

## How auth works

Twenty has no upstream OAuth provider — authentication is via per-workspace API keys. So:
- The Worker runs its **own** OAuth 2.1 endpoint (required by Claude connectors).
- During the OAuth consent step, the user pastes their Twenty API key into an HTML form.
- The Worker validates the key against Twenty's `/metadata` endpoint, then stores `{twentyApiKey, mode, allowedObjects, label}` as encrypted OAuth props.
- Every subsequent MCP tool call has the user's key available via `this.props`.

This means the MCP is OAuth on the outside (for Claude) and API key on the inside (for Twenty).

## Scoping

Each connection can be narrowed at install time:
- **Mode:** read-only hides `create_record` / `update_record` / `delete_record`.
- **Allowed objects:** comma-separated list to restrict to specific objects.

Object-level permissions are also enforced by Twenty itself via the role attached to the user's API key — belt and braces.

## Architecture

```
Claude ↔ OAuth 2.1 ↔ Worker ↔ REST+GraphQL ↔ Twenty workspace
                        │
                        ├─ McpAgent Durable Object (per session)
                        ├─ OAUTH_KV (token store, schema cache, primer)
                        └─ twenty://primer (org context + live schema)
```

## License

Apache-2.0. Based on the same architecture as [fathom-mcp](https://github.com/High-Impact-Athletes/fathom-mcp).

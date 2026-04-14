import { Hono } from "hono";
import { TwentyClient } from "../lib/twenty-client";
import { getSchema } from "../lib/schema-cache";
import { PRIMER_KV_KEY } from "../lib/primer";
import type { Env, Mode, Props } from "../types";

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>();

/**
 * GET /authorize
 *
 * Twenty has no upstream OAuth — we run our own consent page where the user
 * pastes their personal Twenty API key. We preserve the original MCP OAuth
 * request in a hidden field so the POST handler can complete the MCP flow.
 */
app.get("/authorize", async (c) => {
  const oauthReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const state = btoa(JSON.stringify(oauthReq));

  // Pre-fetch the schema so the consent form can offer object checkboxes.
  // If this fails (no valid key yet), we still render with an empty list.
  let objects: { name: string; label: string; isCustom: boolean }[] = [];
  try {
    // Use a throwaway client with no key just to discover the base URL works.
    // The metadata introspection requires auth, so we skip it here and let
    // the user see object names after submitting.
    objects = [];
  } catch {
    /* ignore */
  }

  return c.html(consentPage({ state, baseUrl: c.env.TWENTY_BASE_URL, objects, error: null }));
});

/**
 * POST /authorize — receive API key + options, validate, issue MCP auth code.
 */
app.post("/authorize", async (c) => {
  const body = await c.req.parseBody();
  const state = String(body.state ?? "");
  const apiKey = String(body.api_key ?? "").trim();
  const mode = (String(body.mode ?? "read") as Mode) === "write" ? "write" : "read";
  const allowedObjectsStr = String(body.allowed_objects ?? "").trim();
  const allowedObjects = allowedObjectsStr
    ? allowedObjectsStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const label = String(body.label ?? "").trim();

  if (!state) return c.text("Missing state", 400);
  if (!apiKey) {
    return c.html(
      consentPage({
        state,
        baseUrl: c.env.TWENTY_BASE_URL,
        objects: [],
        error: "API key is required.",
      }),
      400
    );
  }

  let oauthReq;
  try {
    oauthReq = JSON.parse(atob(state));
  } catch {
    return c.text("Invalid state parameter", 400);
  }

  // Validate the key by hitting /metadata
  const client = new TwentyClient(c.env.TWENTY_BASE_URL, apiKey);
  try {
    await client.validateApiKey();
  } catch (err) {
    return c.html(
      consentPage({
        state,
        baseUrl: c.env.TWENTY_BASE_URL,
        objects: [],
        error: `Key validation failed: ${(err as Error).message}`,
      }),
      401
    );
  }

  // Warm the schema cache (optional — speeds up first tool call)
  try {
    await getSchema(c.env.OAUTH_KV, client, c.env.TWENTY_BASE_URL, { force: true });
  } catch {
    /* non-fatal */
  }

  // Derive a stable userId from the API key hash (no PII leaked)
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(apiKey)
  );
  const userId =
    "twenty_" +
    Array.from(new Uint8Array(hashBuffer))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  const props: Props = {
    userId,
    twentyApiKey: apiKey,
    mode,
    allowedObjects,
    ...(label ? { label } : {}),
  };

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId,
    metadata: { label: label || undefined },
    scope: oauthReq.scope,
    props,
  });

  return c.redirect(redirectTo);
});

function consentPage(opts: {
  state: string;
  baseUrl: string;
  objects: { name: string; label: string; isCustom: boolean }[];
  error: string | null;
}): string {
  const { state, baseUrl, error } = opts;
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect Twenty CRM</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    p.lead { color: #555; font-size: 14px; margin-top: 0; }
    label { display: block; margin-top: 18px; font-weight: 600; font-size: 14px; }
    .hint { font-weight: normal; color: #666; font-size: 12px; margin-top: 3px; }
    input[type=text], input[type=password], input[type=url] { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; box-sizing: border-box; margin-top: 6px; font-family: monospace; }
    .radio-row { display: flex; gap: 20px; margin-top: 8px; }
    .radio-row label { display: flex; align-items: center; gap: 6px; font-weight: normal; margin-top: 0; }
    button { margin-top: 24px; padding: 12px 20px; background: #1a73e8; color: white; border: 0; border-radius: 6px; font-size: 15px; cursor: pointer; font-weight: 600; }
    button:hover { background: #1558b0; }
    .error { background: #fee; border: 1px solid #fbb; color: #a00; padding: 10px; border-radius: 6px; margin-top: 12px; font-size: 14px; }
    code { background: #f5f5f5; padding: 2px 5px; border-radius: 3px; font-size: 12px; }
    .note { margin-top: 12px; font-size: 13px; color: #666; background: #f9f9f9; padding: 10px; border-radius: 6px; border-left: 3px solid #ccc; }
  </style>
</head>
<body>
  <h1>Connect Twenty CRM</h1>
  <p class="lead">Connect this Claude session to <code>${esc(baseUrl)}</code>. Your Twenty API key is stored encrypted and only used when you make requests.</p>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <form method="post" action="/authorize">
    <input type="hidden" name="state" value="${esc(state)}" />

    <label>Twenty API key
      <div class="hint">Get one from Twenty → Settings → Developers → Generate API key. This is personal — changes you make are attributed to your Twenty user.</div>
      <input type="password" name="api_key" required autocomplete="off" placeholder="eyJ..." />
    </label>

    <label>Label (optional)
      <div class="hint">A name for this connection, e.g. "Jane — laptop" or "Work machine".</div>
      <input type="text" name="label" autocomplete="off" />
    </label>

    <label>Permission</label>
    <div class="radio-row">
      <label><input type="radio" name="mode" value="read" checked /> Read-only</label>
      <label><input type="radio" name="mode" value="write" /> Read &amp; write</label>
    </div>

    <label>Restrict to objects (optional)
      <div class="hint">Comma-separated plural object names, e.g. <code>people, companies, opportunities</code>. Leave blank for access to every object your API key permits.</div>
      <input type="text" name="allowed_objects" autocomplete="off" placeholder="people, companies, opportunities" />
    </label>

    <div class="note">
      Your API key is bound to your Twenty workspace role. Object-level permissions are enforced by Twenty as well — restricting here is belt-and-braces.
    </div>

    <button type="submit">Connect</button>
  </form>
</body>
</html>`;
}

/**
 * Admin endpoints for uploading organisation-specific primer content to KV.
 * Protected by the `ADMIN_TOKEN` Worker secret. All three routes 503 if the
 * secret is not configured — i.e. admin is opt-in per deployment.
 */
function requireAdmin(c: {
  req: { header: (k: string) => string | undefined };
  env: Env;
}): Response | null {
  const token = c.env.ADMIN_TOKEN;
  if (!token) {
    return new Response(
      "Admin endpoints disabled. Set ADMIN_TOKEN via `wrangler secret put ADMIN_TOKEN` to enable.",
      { status: 503 }
    );
  }
  const auth = c.req.header("authorization") ?? "";
  const provided = auth.replace(/^Bearer\s+/i, "");
  if (!provided || provided !== token) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

/**
 * PUT /admin/primer — upload the org-specific primer markdown.
 * Body: raw markdown (Content-Type: text/markdown or text/plain). Max 100 KB.
 */
app.put("/admin/primer", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const text = await c.req.text();
  if (!text || text.trim().length === 0) {
    return c.text("Body must be non-empty markdown", 400);
  }
  if (text.length > 100_000) {
    return c.text("Primer too large (max 100 KB)", 413);
  }
  await c.env.OAUTH_KV.put(PRIMER_KV_KEY, text);
  return c.json({ ok: true, bytes: text.length });
});

/**
 * GET /admin/primer — fetch the current primer (for verification).
 */
app.get("/admin/primer", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const current = await c.env.OAUTH_KV.get(PRIMER_KV_KEY);
  if (!current) return c.text("(using bundled default)", 404);
  return new Response(current, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
});

/**
 * DELETE /admin/primer — revert to the bundled default.
 */
app.delete("/admin/primer", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  await c.env.OAUTH_KV.delete(PRIMER_KV_KEY);
  return c.json({ ok: true });
});

export const TwentyHandler = app;

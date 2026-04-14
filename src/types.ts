import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  COOKIE_ENCRYPTION_KEY: string;
  TWENTY_BASE_URL: string;
  /** Bearer token for the /admin/* endpoints. Set via `wrangler secret put ADMIN_TOKEN`. Admin endpoints return 503 if unset. */
  ADMIN_TOKEN?: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

export type Mode = "read" | "write";

/**
 * Props stored on the MCP OAuth access token.
 * Available as `this.props` inside McpAgent.
 */
export interface Props extends Record<string, unknown> {
  /** Stable per-user identifier derived from the Twenty API key hash */
  userId: string;
  /** Workspace-scoped Twenty API key (Bearer token for /rest and /metadata) */
  twentyApiKey: string;
  /** "read" hides mutation tools; "write" exposes all */
  mode: Mode;
  /**
   * Object slugs (plural lowercase — the URL path segment) the user allowed.
   * Empty array means "all objects visible to the API key".
   */
  allowedObjects: string[];
  /** Display name captured during consent (optional, for audit in resource) */
  label?: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface State {}

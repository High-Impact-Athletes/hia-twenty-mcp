import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { TwentyHandler } from "./auth/twenty-handler";
import { TwentyMCP } from "./twenty-mcp";
import type { Env } from "./types";

const defaultHandler = {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext) =>
    TwentyHandler.fetch(request, env as Env, ctx),
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        `Twenty MCP\n\nConnect via Claude → Settings → Connectors → add:\n  ${url.origin}/mcp\n\nYou'll be prompted once to paste your Twenty API key.`,
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    return new OAuthProvider({
      apiHandlers: {
        "/mcp": TwentyMCP.serve("/mcp"),
      },
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["twenty:read", "twenty:write"],

      // Twenty API keys don't expire. Just pass the stored props through
      // on both initial auth and refresh. No upstream refresh required.
      tokenExchangeCallback: async (options) => {
        if (
          options.grantType === "authorization_code" ||
          options.grantType === "refresh_token"
        ) {
          return {
            accessTokenProps: {
              userId: options.props.userId,
              twentyApiKey: options.props.twentyApiKey,
              mode: options.props.mode,
              allowedObjects: options.props.allowedObjects,
              label: options.props.label,
            },
            newProps: options.props,
            accessTokenTTL: 3600,
          };
        }
      },
    }).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export { TwentyMCP } from "./twenty-mcp";

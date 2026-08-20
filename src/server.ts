import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { createToolHandlers } from "./tools.js";

const jsonToolResult = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }]
});

export function createServer(): McpServer {
  const server = new McpServer({
    name: "meta-instagram-mcp",
    version: "0.1.0"
  });
  const handlers = createToolHandlers({ config: loadConfig() });

  server.registerTool(
    "meta_auth_status",
    {
      title: "Meta Auth Status",
      description: "Show Meta Instagram MCP configuration and redacted token metadata.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    async () => jsonToolResult(await handlers.authStatus())
  );
  server.registerTool(
    "meta_scope_presets",
    {
      title: "Meta Scope Presets",
      description: "Show supported Instagram OAuth scope presets for this MCP.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    async () => jsonToolResult(handlers.scopePresets())
  );
  server.registerTool(
    "meta_build_login_url",
    {
      title: "Build Instagram Login URL",
      description: "Build an official Instagram Business Login OAuth URL for selected analytics permissions.",
      inputSchema: z.object({
        scopes: z.array(z.string()).optional(),
        scopePreset: z.enum(["readOnly", "analytics", "fullStandard"]).optional(),
        forceReauth: z.boolean().optional(),
        enableFacebookLogin: z.boolean().optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => jsonToolResult(handlers.buildLoginUrl(args))
  );
  server.registerTool(
    "meta_exchange_code",
    {
      title: "Exchange Instagram OAuth Code",
      description: "Exchange an Instagram authorization code for a long-lived token and optionally save it outside the repo.",
      inputSchema: z.object({
        code: z.string().min(1),
        save: z.boolean().optional()
      })
    },
    async (args) => jsonToolResult(await handlers.exchangeCode(args))
  );
  server.registerTool(
    "meta_refresh_token",
    {
      title: "Refresh Instagram Token",
      description: "Refresh the current long-lived Instagram token before it expires.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        save: z.boolean().optional()
      })
    },
    async (args) => jsonToolResult(await handlers.refreshToken(args))
  );
  server.registerTool(
    "meta_get_account_info",
    {
      title: "Get Instagram Account Info",
      description: "Fetch profile/account metadata for the authorized Instagram professional account.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        userId: z.string().optional(),
        fields: z.array(z.string()).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => jsonToolResult(await handlers.getAccountInfo(args))
  );
  server.registerTool(
    "meta_list_media",
    {
      title: "List Instagram Media",
      description: "List media objects for the authorized Instagram professional account.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        userId: z.string().optional(),
        fields: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
        before: z.string().optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => jsonToolResult(await handlers.listMedia(args))
  );
  server.registerTool(
    "meta_get_media",
    {
      title: "Get Instagram Media",
      description: "Fetch metadata for one Instagram media object.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        mediaId: z.string().min(1),
        fields: z.array(z.string()).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => jsonToolResult(await handlers.getMedia(args))
  );
  server.registerTool(
    "meta_get_top_media",
    {
      title: "Rank Instagram Media",
      description: "List and locally rank recent media by engagement, likes, comments, or timestamp.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        userId: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
        before: z.string().optional(),
        sortBy: z.enum(["engagement", "like_count", "comments_count", "timestamp"]).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => jsonToolResult(await handlers.getTopMedia(args))
  );
  server.registerTool(
    "meta_get_user_insights",
    {
      title: "Get Instagram User Insights",
      description: "Fetch account-level Instagram insights for the authorized account.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        userId: z.string().optional(),
        metric: z.string().optional(),
        period: z.string().optional(),
        metricType: z.string().optional(),
        breakdown: z.string().optional(),
        timeframe: z.string().optional(),
        since: z.union([z.string(), z.number()]).optional(),
        until: z.union([z.string(), z.number()]).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => jsonToolResult(await handlers.getUserInsights(args))
  );
  server.registerTool(
    "meta_get_post_insights",
    {
      title: "Get Instagram Media Insights",
      description: "Fetch insights for a specific Instagram media object.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        mediaId: z.string().min(1),
        metric: z.string().optional(),
        period: z.string().optional(),
        metricType: z.string().optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => jsonToolResult(await handlers.getPostInsights(args))
  );
  server.registerTool(
    "meta_list_comments",
    {
      title: "List Instagram Comments",
      description: "List comments for a media object when the authorized account has comment access.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        mediaId: z.string().min(1),
        fields: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
        before: z.string().optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => jsonToolResult(await handlers.listComments(args))
  );
  server.registerTool(
    "meta_get_comment_replies",
    {
      title: "Get Instagram Comment Replies",
      description: "List replies for an Instagram comment when the authorized account has comment access.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        commentId: z.string().min(1),
        fields: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
        before: z.string().optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => jsonToolResult(await handlers.getCommentReplies(args))
  );
  server.registerTool(
    "meta_list_facebook_pages",
    {
      title: "List Facebook Pages",
      description: "List Facebook Pages available to the Facebook Login token and include connected Instagram Business accounts when present.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        fields: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
        before: z.string().optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => jsonToolResult(await handlers.listFacebookPages(args))
  );
  server.registerTool(
    "meta_resolve_instagram_account",
    {
      title: "Resolve Instagram Account",
      description: "Resolve and save an Instagram professional account id for later Graph API calls. Use pageId for Page-linked accounts or userId when Facebook Login granted direct Instagram access.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        pageId: z.string().optional(),
        userId: z.string().optional(),
        save: z.boolean().optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => jsonToolResult(await handlers.resolveInstagramAccount(args))
  );
  server.registerTool(
    "meta_raw_get",
    {
      title: "Meta Raw GET",
      description: "Run a read-only GET against an official Meta Instagram Graph relative path for exploratory endpoints.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        path: z.string().min(1).describe("Relative Graph path such as /me, /<IG_ID>/media, or /<MEDIA_ID>/insights."),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async (args) => jsonToolResult(await handlers.rawGet(args))
  );
  return server;
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error("meta-instagram-mcp running on stdio");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

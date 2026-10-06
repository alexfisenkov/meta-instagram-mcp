import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { createToolHandlers } from "./tools.js";
import type { LayeredToolHandlers } from "./layered-tools.js";

export type ExistingToolHandlers = ReturnType<typeof createToolHandlers>;

const jsonToolResult = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }]
});

export function createMcpServer(handlers: ExistingToolHandlers = createToolHandlers({ config: loadConfig() }), layered?: LayeredToolHandlers): McpServer {
  const server = new McpServer({
    name: "meta-instagram-mcp",
    version: "0.1.0"
  });

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
    "meta_create_media_container",
    {
      title: "Create Instagram Media Container",
      description:
        "Создать контейнер публикации (POST /{ig-user-id}/media) по ПУБЛИЧНОЙ ссылке на медиа и вернуть его id и status_code. " +
        "Ничего не публикует: без meta_publish_media контейнер истекает сам. Это сухой прогон публикации.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        userId: z.string().optional(),
        imageUrl: z.string().optional().describe("Публичная ссылка на JPEG. Взаимоисключающа с videoUrl."),
        videoUrl: z.string().optional().describe("Публичная ссылка на MP4/MOV. Взаимоисключающа с imageUrl."),
        mediaType: z.enum(["IMAGE", "REELS", "STORIES"]).optional(),
        caption: z.string().max(2200).optional(),
        coverUrl: z.string().optional(),
        thumbOffset: z.number().int().min(0).optional(),
        shareToFeed: z.boolean().optional(),
        altText: z.string().max(1000).optional(),
        checkStatus: z.boolean().optional().describe(
          "Прочитать status_code контейнера один раз сразу после создания — это разовое чтение, а не опрос до " +
          "готовности. По умолчанию да. Видео (REELS/STORIES) Meta обрабатывает асинхронно: сразу после создания " +
          "status_code обычно IN_PROGRESS, и повторный опрос контейнера до FINISHED/ERROR — на вызывающей стороне " +
          "(meta_raw_get по /<containerId> с полем status_code), инструмент сам не повторяет."
        )
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (args) => jsonToolResult(await handlers.createMediaContainer(args))
  );
  server.registerTool(
    "meta_publish_media",
    {
      title: "Publish Instagram Media Container",
      description:
        "Опубликовать готовый контейнер (POST /{ig-user-id}/media_publish). Необратимо. " +
        "Требует confirm: true и переменной окружения META_INSTAGRAM_WRITE=true — без любого из двух отказывает, ничего не публикуя. " +
        "Каждая попытка и её исход пишутся в журнал публикаций.",
      inputSchema: z.object({
        accessToken: z.string().optional(),
        userId: z.string().optional(),
        creationId: z.string().min(1).describe("id контейнера из meta_create_media_container."),
        confirm: z.boolean().optional().describe("Обязателен и обязан быть true: без него отказ.")
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async (args) => jsonToolResult(await handlers.publishMedia(args))
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
  if (layered) registerLayeredTools(server, layered);
  return server;
}

function registerLayeredTools(server: McpServer, handlers: LayeredToolHandlers): void {
  server.registerTool("meta_capabilities", {
    title: "Instagram Source Capabilities",
    description: "Report current per-source readiness and read-operation status; runtime status does not prove live UI verification.",
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonToolResult(await handlers.capabilities()));
  const inboxInput = z.object({ source: z.literal("auto").default("auto"), limit: z.number().int().min(1).max(100).default(20), cursor: z.string().optional() });
  server.registerTool("meta_triage_inbox", {
    title: "Triage Instagram Inbox",
    description: "Return a bounded review queue with source coverage and separate unread/unanswered state.",
    inputSchema: inboxInput, annotations: { readOnlyHint: true }
  }, async (args) => jsonToolResult(await handlers.triageInbox(args)));
  server.registerTool("meta_read_source", {
    title: "Read selected Instagram source data",
    description: "Read one bounded inbox, selected conversation (including an older API cursor), comments, replies, or insights request through the configured API→browser→phone router. UI conversation reads may mark messages seen; the observation reports that side effect. Imported observations are never accepted as fresh mutation context.",
    inputSchema: z.object({ operation: z.enum(["account.inspect", "inbox.list", "conversation.read", "comments.list", "comments.replies", "insights.read"]), target: z.object({ accountBinding: z.string().min(1).max(128), nativeId: z.string().max(512).optional(), instagramUrl: z.string().max(2048).optional(), explicitOwnerRef: z.string().max(512).optional() }).optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(2048).optional(), olderCursor: z.string().max(2048).optional(), period: z.string().max(64).optional() }),
    annotations: { readOnlyHint: false }
  }, async (args) => jsonToolResult(await handlers.readSource(args as Parameters<LayeredToolHandlers["readSource"]>[0])));
  server.registerTool("meta_read_inbox", {
    title: "Read Instagram Inbox",
    description: "Read a bounded inbox page through API, browser and phone sources in priority order.",
    inputSchema: inboxInput, annotations: { readOnlyHint: true }
  }, async (args) => jsonToolResult(await handlers.readInbox(args)));
  server.registerTool("meta_analyze_inbox", {
    title: "Analyze Selected Inbox Observations",
    description: "Compute deterministic statistics from explicitly selected observations and optionally request structured analysis from the connected host model. Caller-provided and user_supplied observations are untrusted analysis input only; drafts do not grant write authority, and every action requires a fresh source-bound preview.",
    inputSchema: z.object({ selectedObservations: z.array(z.unknown()).max(100), promptVersion: z.string().min(1).max(120) }),
    annotations: { readOnlyHint: true }
  }, async (args) => jsonToolResult(await handlers.analyzeInbox(args as Parameters<LayeredToolHandlers["analyzeInbox"]>[0])));
}

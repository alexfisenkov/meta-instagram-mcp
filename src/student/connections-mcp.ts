import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BrokerError, type Subject } from "./types.js";
import { connectionProducts, connectionReadSchema } from "./connections-types.js";
import type { ConnectionsRuntime } from "./connections-runtime.js";
/** Explicit read-account facade. Does not alter the four-provider publishing surface. */
export function registerConnectionTools(server: McpServer, runtime: ConnectionsRuntime, subject: Subject) {
  const result = async (run: () => unknown | Promise<unknown>) => {
    try { const data = await run(); return { content: [{ type: "text" as const, text: JSON.stringify(data) }] }; }
    catch (e) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: e instanceof BrokerError ? e.code : "operation_failed" }) }] }; }
  };
  const id = z.object({ connectionId: z.string().uuid() }).strict();
  server.registerTool("social_accounts_catalog", { description: "Separate read-account OAuth admission for Twitch, LinkedIn, Google Business Profile, X. Readiness is not proof of live access or publication support.", inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, () => result(() => runtime.catalog(subject)));
  server.registerTool("social_accounts_list", { description: "List only this authenticated subject's own read resources and actual capabilities, without credentials.", inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, () => result(() => runtime.list(subject)));
  server.registerTool("social_accounts_begin", { description: "Begin one subject-bound official consent flow; optional reconnection is bound to the same provider actor and resource.", inputSchema: z.object({ product: z.enum(connectionProducts), connectionId: z.string().uuid().optional() }).strict(), annotations: { readOnlyHint: false, destructiveHint: false } }, args => result(() => runtime.begin(subject, args.product, args.connectionId)));
  server.registerTool("social_accounts_read", { description: "Read bounded profiles, basic posts or available metric snapshots from one owned resource. Unsupported operations fail explicitly.", inputSchema: connectionReadSchema, annotations: { readOnlyHint: true } }, args => result(() => runtime.read(subject, args)));
  server.registerTool("social_accounts_refresh", { description: "Refresh an existing own grant where the provider actually issued a refresh token, verifying identity and resource access again.", inputSchema: id, annotations: { readOnlyHint: false } }, args => result(() => runtime.refresh(subject, args.connectionId)));
  server.registerTool("social_accounts_disconnect", { description: "Disable one own resource locally; shared credentials remain only while another resource is connected. External revocation is reported separately.", inputSchema: id, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } }, args => result(() => runtime.disconnect(subject, args.connectionId)));
}

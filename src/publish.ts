import type { MetaInstagramConfig } from "./config.js";
import type { MetaClient } from "./meta-client.js";
import type { AuthMode } from "./oauth.js";
import { buildContainerRequest, type ContainerArgs } from "./publish-params.js";
import { appendPublishRecord, type PublishRecord } from "./publish-journal.js";

export interface PublishResolvedToken {
  accessToken: string;
  authMode: AuthMode;
  userId?: string;
}

export interface PublishDependencies {
  config: MetaInstagramConfig;
  resolveToken: (accessToken?: string) => Promise<PublishResolvedToken>;
  makeClient: (accessToken: string, authMode: AuthMode) => MetaClient;
  resolveUserId: (args: Record<string, any>, resolved: PublishResolvedToken) => string;
  journal?: (record: PublishRecord) => Promise<void>;
}

const CONTAINER_NOTE =
  "Контейнер создан и НЕ опубликован: без meta_publish_media он истекает сам (Meta держит его около суток). " +
  "Это и есть сухой прогон — видно, забрала ли Instagram файл по ссылке.";

export function createPublishHandlers(dependencies: PublishDependencies) {
  // Единственный источник пути — dependencies.config.publishLogPath (его
  // считает loadConfig); второго вычисления по умолчанию здесь нет и не
  // должно быть.
  const journal = dependencies.journal ?? ((record: PublishRecord) => appendPublishRecord(
    dependencies.config.publishLogPath,
    record
  ));

  async function client(args: Record<string, any>) {
    const resolved = await dependencies.resolveToken(args.accessToken);
    return {
      userId: dependencies.resolveUserId(args, resolved),
      api: dependencies.makeClient(resolved.accessToken, resolved.authMode)
    };
  }

  return {
    /** Шаг 1: контейнер. Ничего не публикует — этим и годится как сухой прогон. */
    async createMediaContainer(args: ContainerArgs & Record<string, any>) {
      const { userId, api } = await client(args);
      const request = buildContainerRequest(args);
      const created = await api.post(`/${encodeURIComponent(userId)}/media`, request.params);
      const containerId = readId(created);
      if (!containerId) throw new Error("Meta did not return a media container id.");
      const status = args.checkStatus === false
        ? undefined
        : asRecord(await api.get(`/${encodeURIComponent(containerId)}`, { fields: "id,status_code,status" }));
      return {
        containerId,
        userId,
        mediaType: request.mediaType,
        statusCode: status?.status_code,
        status: status?.status,
        published: false,
        note: CONTAINER_NOTE
      };
    },

    /**
     * Шаг 2: публикация. Два предохранителя, оба обязательны и оба проверяются
     * до сети: переменная окружения (решение о среде) и `confirm` (решение о
     * конкретном посте). Порядок важен — сначала среда, потом вызов: иначе
     * отказ звучал бы как «добавь confirm» там, где публикация запрещена вовсе.
     */
    async publishMedia(args: Record<string, any>) {
      if (dependencies.config.writeEnabled !== true) {
        throw new Error(
          "META_INSTAGRAM_WRITE is not enabled: publishing is switched off for this process. " +
          "Nothing was published. Set META_INSTAGRAM_WRITE=true for the process that runs this MCP."
        );
      }
      if (args.confirm !== true) {
        throw new Error(
          "meta_publish_media requires confirm: true. Publishing to Instagram cannot be undone from this tool. " +
          "Nothing was published."
        );
      }
      const creationId = String(args.creationId ?? "").trim();
      if (!creationId) throw new Error("creationId is required: create a container with meta_create_media_container first.");

      const { userId, api } = await client(args);
      // Журнал пишем до вызова и падаем, если он недоступен: публикация без
      // записи — ровно то, чего этот журнал не должен допускать.
      await journal({ at: new Date().toISOString(), event: "attempt", userId, containerId: creationId });
      try {
        const published = await api.post(`/${encodeURIComponent(userId)}/media_publish`, { creation_id: creationId });
        const mediaId = readId(published);
        await journal({ at: new Date().toISOString(), event: "published", userId, containerId: creationId, mediaId });
        return { published: true, mediaId, containerId: creationId, userId };
      } catch (error) {
        await journal({
          at: new Date().toISOString(),
          event: "failed",
          userId,
          containerId: creationId,
          reason: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
  };
}

function readId(value: unknown): string | undefined {
  const record = asRecord(value);
  return typeof record?.id === "string" ? record.id : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

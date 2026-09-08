import type { GraphQuery } from "./meta-client.js";

export type ContainerMediaType = "IMAGE" | "REELS" | "STORIES";

const ALLOWED_MEDIA_TYPES: ReadonlySet<string> = new Set<ContainerMediaType>(["IMAGE", "REELS", "STORIES"]);

export interface ContainerArgs {
  imageUrl?: string;
  videoUrl?: string;
  mediaType?: ContainerMediaType;
  caption?: string;
  coverUrl?: string;
  thumbOffset?: number;
  shareToFeed?: boolean;
  altText?: string;
}

export interface ContainerRequest {
  mediaType: ContainerMediaType;
  mediaUrl: string;
  params: GraphQuery;
}

/**
 * Собирает параметры контейнера `POST /{ig-user-id}/media`.
 *
 * Ссылка на медиа обязана быть публичной: файл забирает не этот сервер, а
 * Instagram со своей стороны. Поэтому здесь только проверка схемы — http(s);
 * доступность проверяет уже Meta, и её отказ приезжает как ошибка контейнера.
 */
export function buildContainerRequest(args: ContainerArgs): ContainerRequest {
  const { imageUrl, videoUrl } = args;
  if (Boolean(imageUrl) === Boolean(videoUrl)) {
    throw new Error("Pass exactly one of imageUrl or videoUrl: a container carries a single media file.");
  }
  const mediaUrl = requireHttpUrl((imageUrl ?? videoUrl) as string, imageUrl ? "imageUrl" : "videoUrl");
  const mediaType = args.mediaType ?? (videoUrl ? "REELS" : "IMAGE");
  // Тип уже ограничен схемой инструмента (zod), но buildContainerRequest —
  // отдельная функция, которую вызывают и напрямую (тесты, будущие вызывающие
  // без того же слоя валидации). Сверяем с перечнем здесь же, где параметры
  // запроса собираются, а не полагаемся на чужой слой перед этим местом.
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    throw new Error(`mediaType must be one of IMAGE, REELS, STORIES, got "${mediaType}".`);
  }
  if (videoUrl && mediaType === "IMAGE") {
    throw new Error("videoUrl needs mediaType REELS or STORIES: IMAGE containers accept imageUrl only.");
  }

  const params: GraphQuery = {};
  if (imageUrl) params.image_url = mediaUrl;
  if (videoUrl) params.video_url = mediaUrl;
  // media_type=IMAGE Graph API не ждёт — это его значение по умолчанию, и
  // явная передача на части версий отвечает ошибкой. Шлём поле только когда
  // оно что-то меняет.
  if (mediaType !== "IMAGE") params.media_type = mediaType;
  if (args.caption !== undefined) params.caption = args.caption;
  if (args.coverUrl !== undefined) params.cover_url = requireHttpUrl(args.coverUrl, "coverUrl");
  if (args.thumbOffset !== undefined) params.thumb_offset = args.thumbOffset;
  if (args.shareToFeed !== undefined) params.share_to_feed = args.shareToFeed;
  if (args.altText !== undefined) params.alt_text = args.altText;
  return { mediaType, mediaUrl, params };
}

function requireHttpUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute public URL, got "${value}".`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${field} must be an http(s) URL: Instagram downloads the file itself.`);
  }
  return parsed.toString();
}

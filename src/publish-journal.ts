import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type PublishEvent = "attempt" | "published" | "failed";

export interface PublishRecord {
  at: string;
  event: PublishEvent;
  userId?: string;
  containerId?: string;
  mediaId?: string;
  reason?: string;
}

/**
 * Журнал публикаций: по строке JSON на событие, только дописывание.
 *
 * Две записи на публикацию, а не одна: «attempt» уходит до вызова Meta,
 * «published»/«failed» — после. Если процесс убьют посреди вызова, останется
 * след того, что попытка была; одна итоговая запись в этом случае не осталась
 * бы вовсе, и публикация выглядела бы как не начинавшаяся.
 *
 * Токенов здесь нет. Отказы (нет флага, нет confirm) не пишем: они ничего не
 * меняют и видны в журнале юнита — писать в файл то, что не случилось, значит
 * засорять единственное место, где ищут случившееся.
 */
export async function appendPublishRecord(path: string, record: PublishRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

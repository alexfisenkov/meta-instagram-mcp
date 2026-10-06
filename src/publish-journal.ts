import { appendFile, lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { assertPrivateFile, ensurePrivateDirectory, ensurePrivateFile } from "./private-fs.js";

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
  await ensurePrivateDirectory(dirname(path));
  try { await lstat(path); await assertPrivateFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await ensurePrivateFile(path);
}

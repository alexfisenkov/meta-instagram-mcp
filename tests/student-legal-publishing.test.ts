import { expect, it } from "vitest";
import { renderLegal } from "../src/student/legal.js";
const config = { operatorName: "Fictitious operator", privacyContact: "privacy@example.test" };
it("describes separate publication credentials, checkpoints and cache without claiming provider approval", () => {
  const html = renderLegal(config, false);
  for (const text of ["Instagram Reels", "YouTube", "TikTok", "Pinterest", "youtube.upload", "Twitch", "LinkedIn", "Google Business Profile", "X", "зашифрованном хранилище публикаций", "контрольные точки", "исходные медиа платформы", "не подтверждает прохождение"]) expect(html).toContain(text);
  expect(html).toContain("подтверждении пользователем точного аккаунта");
});
it("discloses the unified offline scope and failure boundary while keeping originals and remote revocation separate", () => {
  const html = renderLegal(config, true);
  for (const text of ["хранилище публикаций", "TikTok", "Pinterest", "рабочие копии", "Исходные медиа платформы", "не образуют общую транзакцию", "Ошибка не выдаётся за завершённое удаление", "Внешний отзыв разрешений выполняется отдельно"]) expect(html).toContain(text);
});

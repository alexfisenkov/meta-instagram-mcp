import type { MetaInstagramConfig } from "./config.js";
import type { AuthMode } from "./oauth.js";

export type SetupObservation = "unknown" | "available" | "unavailable";
export interface ConnectionPlanInput {
  directInstagramSetup?: SetupObservation;
  unifiedSetup?: SetupObservation;
  businessPortfolio?: "unknown" | "available" | "blocked";
  preferredSource?: "auto" | "browser";
  existingBrowserControl?: SetupObservation;
  existingConnectionWorking?: boolean;
}
export interface ConnectionPlanState {
  hasSavedToken?: boolean;
  savedAuthMode?: AuthMode;
  tokenStoreUnavailable?: boolean;
  browserBridgeConfigured?: boolean;
  credentialStoreConflict?: boolean;
}
export type RecommendedPath = "inspect_dashboard" | "instagram_login" | "browser" | "unified_login" | "verify_existing" | "keep_existing" | "separate_token_store";

/** An offline plan, not proof of Meta eligibility, browser login, or permission grants. */
export function buildConnectionPlan(config: MetaInstagramConfig, input: ConnectionPlanInput = {}, state: ConnectionPlanState = {}) {
  const direct = input.directInstagramSetup ?? "unknown";
  const unified = input.unifiedSetup ?? "unknown";
  const portfolio = input.businessPortfolio ?? "unknown";
  const hasEnvironmentToken = Boolean(config.accessToken);
  const familyMismatch = !hasEnvironmentToken && state.hasSavedToken === true && state.savedAuthMode !== undefined && state.savedAuthMode !== config.authMode;
  const hasCredential = hasEnvironmentToken || (state.hasSavedToken === true && !familyMismatch);
  let recommendedPath: RecommendedPath;
  if (input.preferredSource === "browser") recommendedPath = "browser";
  else if (input.existingConnectionWorking === true) recommendedPath = "keep_existing";
  else if (state.credentialStoreConflict) recommendedPath = "separate_token_store";
  else if (hasCredential && input.existingConnectionWorking !== false) recommendedPath = "verify_existing";
  else if (direct === "available") recommendedPath = "instagram_login";
  else if (direct === "unknown") recommendedPath = "inspect_dashboard";
  else if (unified === "available" && portfolio === "available") recommendedPath = "unified_login";
  else recommendedPath = "browser";

  const nextSteps = {
    inspect_dashboard: ["check_instagram_login_setup", "Сначала осмотрите раздел Instagram в Meta App Dashboard: есть ли API setup with Instagram login. Не делайте вывод по одному окну Unified. Не создавайте portfolio или приглашения автоматически."],
    instagram_login: ["configure_instagram_login", "Используйте Instagram App ID/Secret либо лично введённый Dashboard Instagram User token. Затем проверьте свой профиль и media через MCP; конфигурация ещё не доказывает доступ."],
    browser: ["configure_browser", "Используйте локальное расширение Chrome и Native Host без Meta App. Пользователь входит сам; затем проверьте владельца и выполните browser read. Сервер и публичный домен не нужны."],
    unified_login: ["configure_unified_login", "Unified используйте только для подтверждённого setup и доступного portfolio. Отказ назначения App или добавления пользователя требует остановки административных действий; предложите browser."],
    verify_existing: ["verify_current_connection", "Сначала проверьте уже выбранное подключение безопасным чтением профиля/media. Не заменяйте токен и login family только из-за нового шаблона."],
    keep_existing: ["keep_current_connection", "Сохраните рабочее подключение. Для независимого нового пути используйте отдельный приватный config/token-store, не переносите credentials между login families."],
    separate_token_store: ["preserve_and_isolate_credentials", "В environment и token-store выбраны разные credentials. Сохраните старый файл и задайте отдельный абсолютный META_TOKEN_STORE_PATH либо новый приватный config directory. Не удаляйте и не перезаписывайте прежний токен; затем повторите проверку нового профиля."]
  } as const;
  const browserControl = input.existingBrowserControl ?? "unknown";
  const [nextStep, instruction] = recommendedPath === "browser" && browserControl !== "unavailable"
    ? browserControl === "available"
      ? ["use_existing_browser", "Используйте уже подключённый браузерный инструмент AI-клиента и свой авторизованный Chrome. Подтвердите нужный профиль и читайте видимый интерфейс. Это результат browser-инструмента клиента, а не проверка нашего MCP companion; дополнительную установку не начинайте без необходимости."]
      : ["check_existing_browser", "Сначала проверьте, умеет ли AI-клиент уже управлять вашим Chrome. Если да — используйте существующий браузерный инструмент после проверки профиля. Если нет или нужен browser source внутри MCP — настройте локальный companion по инструкции."]
    : nextSteps[recommendedPath];
  return {
    version: 1, verification: "configuration_only" as const, observationVerification: "caller_supplied" as const,
    recommendedPath, nextStep, instruction,
    observations: { directInstagramSetup: direct, unifiedSetup: unified, businessPortfolio: portfolio, existingBrowserControl: browserControl },
    configured: { apiMode: config.authMode, hasSelectedCredential: hasCredential, browserBridgeConfigured: state.browserBridgeConfigured === true },
    issues: [...(familyMismatch ? ["saved_credential_family_mismatch"] : []), ...(state.credentialStoreConflict ? ["token_store_occupied_by_other_credential"] : []), ...(state.tokenStoreUnavailable ? ["token_store_unavailable"] : [])],
    routes: [
      { id: "instagram_login", priority: 1, authMode: "instagram", dashboardAvailability: direct, requiresMetaApp: true, requiresBusinessPortfolio: false, setupGuide: "docs/direct-instagram-login.md", acceptance: "fresh_professional_profile_and_media_read" },
      { id: "browser", priority: 2, authMode: null, dashboardAvailability: "not_applicable", requiresMetaApp: false, requiresBusinessPortfolio: false, setupGuide: "docs/browser-only.md", variants: ["existing_ai_client_browser", "local_mcp_companion"], acceptance: "owner_verified_browser_read", limitations: ["visible_data_only", "manual_login", "not_full_history", "insights_not_supported_by_companion", "conversation_read_may_mark_seen"] },
      { id: "unified_login", priority: 3, authMode: "unified", dashboardAvailability: unified, requiresMetaApp: true, requiresBusinessPortfolio: true, setupGuide: "docs/unified-login.md", acceptance: "fresh_bisu_grant_asset_and_media_read" },
      { id: "facebook_login", priority: 4, authMode: "facebook", dashboardAvailability: "check_existing_setup", requiresMetaApp: true, requiresBusinessPortfolio: "depends_on_setup", setupGuide: "docs/meta-setup.md", acceptance: "verified_existing_facebook_setup", limitations: ["not_a_default_workaround_for_business_refusal"] }
    ],
    safeguards: ["no_network_or_ui_action", "no_credential_or_config_writes", "no_automatic_login_family_change", "no_automatic_business_invites", "requested_scopes_are_not_grants", "no_cookies_or_tokens_in_chat"]
  };
}

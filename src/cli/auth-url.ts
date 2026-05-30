import { loadConfig } from "../config.js";
import { buildAuthUrl, defaultScopesForAuthMode } from "../oauth.js";

const config = loadConfig();

if (!config.appId || !config.redirectUri) {
  console.error("Missing META_INSTAGRAM_APP_ID or META_INSTAGRAM_REDIRECT_URI.");
  process.exit(1);
}

const url = buildAuthUrl({
  authMode: config.authMode,
  appId: config.appId,
  redirectUri: config.redirectUri,
  scopes: config.defaultScopes ?? defaultScopesForAuthMode(config.authMode),
  forceReauth: true,
  graphApiVersion: config.graphApiVersion,
});

console.log(url.toString());

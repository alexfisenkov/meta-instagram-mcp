import { runCallbackServer } from "../callback-server.js";

runCallbackServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

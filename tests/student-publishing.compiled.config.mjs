import { fileURLToPath } from "node:url";
// Reuse the same behavioral fixtures against tsc output, including its real HTTP/MCP composition.
export default {
  resolve: {
    alias: [{ find: /^\.\.\/src\/student\/(.+)\.js$/, replacement: fileURLToPath(new URL("../dist/student/", import.meta.url)) + "$1.js" }],
  },
  test: { include: ["tests/student-publishing*.test.ts"] },
};

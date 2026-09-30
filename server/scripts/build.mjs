// Bundles src/server.ts into dist/server.js.
//
// The package version is injected as a compile-time constant so the built
// server reports exactly the version npm published (see src/version.ts).
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  logLevel: "info",
  define: {
    __MAKESPDF_SERVER_VERSION__: JSON.stringify(packageJson.version),
  },
});

// The version reported in the `X-MakesPDF-Client` header.
//
// The esbuild build injects the package.json version (scripts/build.mjs), so a
// built server reports exactly the version npm published. Running the sources
// directly (unit tests) has no injected value and falls back to a dev marker.
declare const __MAKESPDF_SERVER_VERSION__: string | undefined;

export const SERVER_VERSION: string =
  typeof __MAKESPDF_SERVER_VERSION__ === "string"
    ? __MAKESPDF_SERVER_VERSION__
    : "0.0.0-dev";

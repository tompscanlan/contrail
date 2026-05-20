import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/adapters/sqlite.ts", "src/adapters/postgres.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  tsconfig: "tsconfig.build.json",
  external: ["pg", "node:sqlite"],
  // tsup strips the `node:` protocol by default, turning `node:sqlite` into a
  // bare `sqlite` import that resolves to a nonexistent npm package in
  // consumers. Keep the prefix so the built-in module resolves at runtime.
  removeNodeProtocol: false,
});

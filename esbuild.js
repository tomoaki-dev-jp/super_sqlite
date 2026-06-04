const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    // vscode は実行時に提供される。sql.js は node_modules から require する
    // (emscripten 製の wasm ローダなのでバンドルせず external にするのが安全)。
    external: ["vscode", "sql.js"],
    sourcemap: !production,
    minify: production,
    logLevel: "info"
  });

  if (watch) {
    await ctx.watch();
    console.log("[watch] build started");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

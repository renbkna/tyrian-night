const esbuild = require("esbuild");

const args = process.argv.slice(2);
const watch = args.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "out/extension.js",
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    minify: !watch,
    sourcemap: watch,
  });

  if (watch) {
    await ctx.watch();
    console.log("watching...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log("build succeeded");
  }
}

main().catch(() => process.exit(1));

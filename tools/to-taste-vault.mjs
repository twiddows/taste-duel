#!/usr/bin/env node
// File a Taste Duel run's favourites as screenshots in an inspiration folder.
//
//   node tools/to-taste-vault.mjs <results.json> <folder> [--top N] [--dry-run]
//
// <results.json> is the file from "Download results" on the results page. Each favourite's preview
// image is saved to <folder>/taste-duel/<scope>-<date>/NN-<name>.<ext>, best first, with a
// taste-duel.md beside them holding the brief and the profile. Point <folder> at Taste Vault's
// drop folder and its import picks the images up like any other screenshots. Files already there
// are skipped, so running it twice is harmless. Needs Node 18+ (built-in fetch).
//
// tools/serve.mjs imports fileFavourites() for the save button on the results page.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const TYPE_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

function slug(text) {
  return String(text).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").slice(0, 60) || "site";
}

function extFromUrl(url) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return IMAGE_EXT.has(ext) ? ext : null;
}

function existingFile(base) {
  for (const ext of IMAGE_EXT) if (fs.existsSync(base + ext)) return base + ext;
  return null;
}

// Throws on a results object that isn't a Taste Duel run; otherwise saves what it can and reports.
// name overrides the <scope>-<date> subfolder (a project round passes its request id).
export async function fileFavourites(results, destRoot, { top = 12, dryRun = false, log = console.log, name = null } = {}) {
  if (!results || typeof results !== "object") throw new Error("not a results file");
  if (results.tool && results.tool !== "taste-duel") throw new Error("not a Taste Duel results file");
  if (!Array.isArray(results.favourites) || !results.favourites.length) throw new Error("no favourites in this run");
  if (!fs.existsSync(destRoot)) throw new Error(`folder not found: ${destRoot}`);

  // scope and date name a folder, so keep them to plain word characters.
  const scope = slug(results.scope || "all");
  const date = String(results.date || String(results.generated || "").slice(0, 10) || "undated").replace(/[^\w-]/g, "") || "undated";
  const outDir = path.join(destRoot, "taste-duel", name ? slug(name) : `${scope}-${date}`);
  const favourites = results.favourites.slice(0, top);

  log(`${favourites.length} favourites from the ${results.scopeLabel || scope} run -> ${outDir}${dryRun ? " (dry run)" : ""}`);
  if (!dryRun) fs.mkdirSync(outDir, { recursive: true });

  let saved = 0, skipped = 0, failed = 0;
  for (const [i, fav] of favourites.entries()) {
    const base = path.join(outDir, `${String(i + 1).padStart(2, "0")}-${slug(fav.name)}`);
    const already = existingFile(base);
    if (already) { skipped++; log(`  skip  ${path.basename(already)} (already there)`); continue; }
    try {
      if (!/^https:\/\//.test(String(fav.preview))) throw new Error("preview is not an https URL");
      if (dryRun) { log(`  would save  ${path.basename(base)}${extFromUrl(fav.preview) || ".png"}  <- ${fav.preview}`); continue; }
      const res = await fetch(fav.preview);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers.get("content-type") || "").split(";")[0].trim();
      const ext = TYPE_EXT[type] || extFromUrl(fav.preview);
      if (!ext) throw new Error(`not an image (${type || "no content type"})`);
      const file = base + ext;
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      saved++;
      log(`  saved ${path.basename(file)}`);
    } catch (e) {
      failed++;
      log(`  FAIL  ${fav.name}: ${e.message}`);
    }
  }

  const profile = Object.entries(results.profile || {})
    .map(([feature, value]) => `| ${feature} | ${value > 0 ? "+" : ""}${value} |`).join("\n");
  const note = [
    `# Taste Duel: ${results.scopeLabel || scope}, ${date}`,
    "",
    "```",
    results.brief || "(no brief in this results file)",
    "```",
    "",
    "| feature | weight |",
    "|---|---|",
    profile || "| (none) | |",
    "",
    ...favourites.map((f, i) => `${i + 1}. [${f.name}](${f.url})`),
    "",
  ].join("\n");
  if (!dryRun) {
    fs.writeFileSync(path.join(outDir, "taste-duel.md"), note);
    fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  }

  log(`Done: ${saved} saved, ${skipped} already there, ${failed} failed.`);
  return { outDir, saved, skipped, failed };
}

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node tools/to-taste-vault.mjs <results.json> <folder> [--top N] [--dry-run]");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const topIndex = args.indexOf("--top");
  const top = topIndex >= 0 ? Number(args[topIndex + 1]) : 12;
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--top");
  if (positional.length !== 2) usage();
  if (!Number.isInteger(top) || top < 1) usage("--top needs a whole number above 0");
  const [resultsPath, destRoot] = positional;

  let results;
  try {
    results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  } catch (e) {
    usage(`Could not read ${resultsPath}: ${e.message}`);
  }
  try {
    const { failed } = await fileFavourites(results, destRoot, { top, dryRun });
    process.exit(failed ? 2 : 0);
  } catch (e) {
    usage(`${resultsPath}: ${e.message}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

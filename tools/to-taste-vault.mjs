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

import fs from "node:fs";
import path from "node:path";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const TYPE_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node tools/to-taste-vault.mjs <results.json> <folder> [--top N] [--dry-run]");
  process.exit(1);
}

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
if (results.tool && results.tool !== "taste-duel") usage(`${resultsPath} is not a Taste Duel results file`);
if (!Array.isArray(results.favourites) || !results.favourites.length) usage(`${resultsPath} has no favourites`);
if (!fs.existsSync(destRoot)) usage(`Folder not found: ${destRoot}`);

const scope = results.scope || "all";
const date = results.date || String(results.generated || "").slice(0, 10) || "undated";
const outDir = path.join(destRoot, "taste-duel", `${scope}-${date}`);
const favourites = results.favourites.slice(0, top);

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

console.log(`${favourites.length} favourites from the ${results.scopeLabel || scope} run -> ${outDir}${dryRun ? " (dry run)" : ""}`);
if (!dryRun) fs.mkdirSync(outDir, { recursive: true });

let saved = 0, skipped = 0, failed = 0;
for (const [i, fav] of favourites.entries()) {
  const base = path.join(outDir, `${String(i + 1).padStart(2, "0")}-${slug(fav.name)}`);
  const already = existingFile(base);
  if (already) { skipped++; console.log(`  skip  ${path.basename(already)} (already there)`); continue; }
  if (dryRun) { console.log(`  would save  ${path.basename(base)}${extFromUrl(fav.preview) || ".png"}  <- ${fav.preview}`); continue; }
  try {
    const res = await fetch(fav.preview);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    const ext = TYPE_EXT[type] || extFromUrl(fav.preview);
    if (!ext) throw new Error(`not an image (${type || "no content type"})`);
    const file = base + ext;
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    saved++;
    console.log(`  saved ${path.basename(file)}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${fav.name}: ${e.message}`);
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
if (!dryRun) fs.writeFileSync(path.join(outDir, "taste-duel.md"), note);

console.log(`Done: ${saved} saved, ${skipped} already there, ${failed} failed.`);
process.exit(failed ? 2 : 0);

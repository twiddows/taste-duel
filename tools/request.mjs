#!/usr/bin/env node
// Start a project round of Taste Duel from a script or a coding agent, and wait for its results.
//
//   node tools/request.mjs new --project "Truss site" --folder "D:\work\truss-site\design" [--scope marketing] [--pairs 20] [--open]
//   node tools/request.mjs wait <id> [--timeout 120]
//   node tools/request.mjs status <id>
//
// new     writes requests/<id>.json, starts tools/serve.mjs in the background if nothing answers on
//         the port, and prints { id, url }. --open also opens the URL in the default browser.
//         --scope is dashboards | marketing | all (default all); --pairs defaults to 20.
// wait    blocks until the results page's "Send to <project>" button has filed the run, then prints
//         { outDir, vaultDir } and exits 0; exits 3 on timeout (minutes, default 120).
// status  prints the request file.
//
// The favourites land in <folder>/taste-duel/<id>/ (preview images, taste-duel.md, results.json),
// and in the save folder from taste-duel.config.json too when one is set.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUESTS = path.join(ROOT, "requests");
const PORT = Number(process.env.PORT) || 4611;
const BASE = `http://127.0.0.1:${PORT}`;
const SCOPES = ["dashboards", "marketing", "all"];

function slug(text) {
  return String(text).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "").slice(0, 40).replace(/^-+|-+$/g, "") || "project";
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function option(args, name, fallback = null) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
}

function readRequest(id) {
  try { return JSON.parse(fs.readFileSync(path.join(REQUESTS, id + ".json"), "utf8")); } catch { return null; }
}

// "new" = this server knows about project rounds; "old" = an older serve.mjs or plain static server.
async function serverState() {
  try {
    const res = await fetch(`${BASE}/api/request?id=ping`);
    return (res.headers.get("content-type") || "").startsWith("application/json") ? "new" : "old";
  } catch { return "down"; }
}

async function ensureServer() {
  const state = await serverState();
  if (state === "new") return;
  if (state === "old") fail(`Something older is serving port ${PORT} (no project rounds). Close it, then run this again.`);
  const child = spawn(process.execPath, [path.join(ROOT, "tools", "serve.mjs")], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await serverState() === "new") return;
  }
  fail(`Started tools/serve.mjs but nothing answers on ${BASE}.`);
}

function openInBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function create(args) {
  const project = option(args, "project");
  const folder = option(args, "folder");
  const scope = option(args, "scope", "all");
  const pairs = Number(option(args, "pairs", "20"));
  if (!project || !folder) fail("new needs --project and --folder");
  if (!SCOPES.includes(scope)) fail(`--scope must be one of ${SCOPES.join(", ")}`);
  if (!Number.isInteger(pairs) || pairs < 4) fail("--pairs needs a whole number of 4 or more");

  fs.mkdirSync(REQUESTS, { recursive: true });
  fs.mkdirSync(folder, { recursive: true });
  const base = `${slug(project)}-${localDate()}`;
  let id = base;
  for (let n = 2; fs.existsSync(path.join(REQUESTS, id + ".json")); n++) id = `${base}-${n}`;
  const request = { id, project, scope, pairs, folder: path.resolve(folder), created: new Date().toISOString() };
  fs.writeFileSync(path.join(REQUESTS, id + ".json"), JSON.stringify(request, null, 2));

  await ensureServer();
  const url = `${BASE}/?request=${id}`;
  if (args.includes("--open")) openInBrowser(url);
  console.log(JSON.stringify({ id, url, folder: request.folder, scope, pairs }, null, 2));
}

async function wait(id, args) {
  if (!readRequest(id)) fail(`No project round called ${id}`);
  const minutes = Number(option(args, "timeout", "120"));
  const until = Date.now() + minutes * 60_000;
  while (Date.now() < until) {
    const request = readRequest(id);
    if (request?.done) {
      console.log(JSON.stringify(request.done, null, 2));
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  fail(`Timed out after ${minutes} min waiting for ${id}.`, 3);
}

const [command, ...args] = process.argv.slice(2);
if (command === "new") await create(args);
else if (command === "wait" && args[0]) await wait(args[0], args);
else if (command === "status" && args[0]) {
  const request = readRequest(args[0]);
  if (!request) fail(`No project round called ${args[0]}`);
  console.log(JSON.stringify(request, null, 2));
} else fail("Usage: node tools/request.mjs new --project <name> --folder <dir> [--scope dashboards|marketing|all] [--pairs N] [--open]\n" +
  "       node tools/request.mjs wait <id> [--timeout minutes]\n       node tools/request.mjs status <id>");

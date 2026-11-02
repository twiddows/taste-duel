#!/usr/bin/env node
// Serve Taste Duel on http://127.0.0.1:4611 and let the results page save favourites to a folder.
//
//   node tools/serve.mjs            (PORT=nnnn to change the port)
//
// Static files work exactly as with `python -m http.server`. On top of that:
//   GET  /api/config        -> { folder, label } when a save folder is set, else { folder: null }
//   GET  /api/request?id=X  -> a project round made by tools/request.mjs (project, scope, pairs, done)
//   POST /api/save          -> body = the results JSON; files the favourites with to-taste-vault.mjs
// The save folder comes from TASTE_DUEL_FOLDER or from taste-duel.config.json beside index.html
// ({ "folder": "D:\\path", "label": "Send to Taste Vault" }); that file is git-ignored.
// A project round (results carry "request") is filed in the folder its request file names, and in
// the save folder too when one is set; the request file then records where it went.
// Request files live in requests/ (git-ignored) and are only ever written by tools/request.mjs or
// this server, so a page can name a request but never a folder.
// Only listens on 127.0.0.1, and /api/save only takes JSON from this page's own origin.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileFavourites } from "./to-taste-vault.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 4611;
const HOST = "127.0.0.1";
const REQUESTS = path.join(ROOT, "requests");
const REQUEST_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".md": "text/markdown; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

function config() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(ROOT, "taste-duel.config.json"), "utf8")); } catch {}
  const folder = process.env.TASTE_DUEL_FOLDER || file.folder || null;
  return { folder, label: file.label || "Save favourites to folder" };
}

function readRequest(id) {
  if (!REQUEST_ID.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(REQUESTS, id + ".json"), "utf8")); } catch { return null; }
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function save(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: "wrong origin" });
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "send JSON" });
  const { folder } = config();
  try {
    const results = JSON.parse(await readBody(req));
    const lines = [];
    const log = (l) => { lines.push(l); console.log(l); };
    if (!results.request) {
      if (!folder) return send(res, 400, { error: "No save folder set. Add taste-duel.config.json (see README)." });
      const report = await fileFavourites(results, folder, { log });
      return send(res, 200, { ...report, lines });
    }
    const request = readRequest(results.request);
    if (!request) return send(res, 404, { error: `No project round called ${results.request}` });
    const report = await fileFavourites(results, request.folder, { log, name: request.id });
    let vault = null;
    if (folder) {
      try { vault = await fileFavourites(results, folder, { log, name: request.id }); }
      catch (e) { log(`Save folder: ${e.message}`); }
    }
    request.done = { at: new Date().toISOString(), outDir: report.outDir, vaultDir: vault?.outDir || null, failed: report.failed };
    fs.writeFileSync(path.join(REQUESTS, request.id + ".json"), JSON.stringify(request, null, 2));
    send(res, 200, { ...report, vaultDir: vault?.outDir || null, lines });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}

function serveFile(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return send(res, 400, "bad path", "text/plain"); }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(ROOT, "." + rel);
  if (!file.startsWith(ROOT + path.sep) || path.basename(file) === "taste-duel.config.json" ||
      file.startsWith(REQUESTS + path.sep)) return send(res, 404, "not found", "text/plain");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found", "text/plain");
    send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/config" && req.method === "GET") {
    const { folder, label } = config();
    return send(res, 200, { folder, label });
  }
  if (url.pathname === "/api/request" && req.method === "GET") {
    const request = readRequest(url.searchParams.get("id"));
    if (!request) return send(res, 404, { error: "no such project round" });
    const { id, project, scope, pairs, folder, done } = request;
    return send(res, 200, { id, project, scope, pairs, folder, done: done || null, vault: Boolean(config().folder) });
  }
  if (url.pathname === "/api/save") return req.method === "POST" ? save(req, res) : send(res, 405, { error: "POST only" });
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "GET only", "text/plain");
  serveFile(req, res);
}).listen(PORT, HOST, () => {
  const { folder } = config();
  console.log(`Taste Duel on http://${HOST}:${PORT}/`);
  console.log(folder ? `Save button files favourites in ${folder}` : "No save folder set: the results page offers Download only.");
});

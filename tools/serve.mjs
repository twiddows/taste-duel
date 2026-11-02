#!/usr/bin/env node
// Serve Taste Duel on http://127.0.0.1:4611 and let the results page save favourites to a folder.
//
//   node tools/serve.mjs            (PORT=nnnn to change the port)
//
// Static files work exactly as with `python -m http.server`. On top of that:
//   GET  /api/config  -> { folder, label } when a save folder is set, else { folder: null }
//   POST /api/save    -> body = the results JSON; files the favourites with to-taste-vault.mjs
// The save folder comes from TASTE_DUEL_FOLDER or from taste-duel.config.json beside index.html
// ({ "folder": "D:\\path", "label": "Send to Taste Vault" }); that file is git-ignored.
// Only listens on 127.0.0.1, and /api/save only takes JSON from this page's own origin.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileFavourites } from "./to-taste-vault.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 4611;
const HOST = "127.0.0.1";
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
  if (!folder) return send(res, 400, { error: "No save folder set. Add taste-duel.config.json (see README)." });
  try {
    const results = JSON.parse(await readBody(req));
    const lines = [];
    const report = await fileFavourites(results, folder, { log: (l) => { lines.push(l); console.log(l); } });
    send(res, 200, { ...report, lines });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}

function serveFile(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return send(res, 400, "bad path", "text/plain"); }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(ROOT, "." + rel);
  if (!file.startsWith(ROOT + path.sep) || path.basename(file) === "taste-duel.config.json") return send(res, 404, "not found", "text/plain");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found", "text/plain");
    send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
  });
}

http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/api/config" && req.method === "GET") {
    const { folder, label } = config();
    return send(res, 200, { folder, label });
  }
  if (url === "/api/save") return req.method === "POST" ? save(req, res) : send(res, 405, { error: "POST only" });
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "GET only", "text/plain");
  serveFile(req, res);
}).listen(PORT, HOST, () => {
  const { folder } = config();
  console.log(`Taste Duel on http://${HOST}:${PORT}/`);
  console.log(folder ? `Save button files favourites in ${folder}` : "No save folder set: the results page offers Download only.");
});

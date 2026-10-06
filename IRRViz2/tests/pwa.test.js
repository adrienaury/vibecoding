/* Cohérence de l'application installable : node --test IRRViz2/tests/*.test.js */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");

function appShell(){
  const m = /const APP_SHELL = \[([\s\S]*?)\];/.exec(read("sw.js"));
  assert.ok(m, "APP_SHELL introuvable dans sw.js");
  return [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
}

// Fichiers locaux chargés par index.html (scripts, feuilles de style, manifeste, icônes).
function localAssets(){
  const html = read("index.html");
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map(x => x[1]);
  return refs.filter(r => !r.startsWith("..") && r !== "./" && /\.(js|css|webmanifest|png|svg)$/.test(r));
}

test("le service worker met en cache tout ce que charge index.html", () => {
  const shell = appShell();
  for(const asset of localAssets()) assert.ok(shell.includes(asset), `${asset} absent de APP_SHELL (sw.js)`);
  assert.ok(shell.includes("./") && shell.includes("index.html"));
});

test("chaque fichier de APP_SHELL existe", () => {
  for(const f of appShell()){
    if(f === "./") continue;
    assert.ok(fs.existsSync(path.join(root, f)), `${f} n'existe pas`);
  }
});

test("le manifeste est valide et ses icônes existent", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  const sizes = manifest.icons.map(i => i.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"), "icônes 192 et 512 requises pour l'installation");
  assert.ok(manifest.icons.some(i => i.purpose === "maskable"));
  const shell = appShell();
  for(const icon of manifest.icons){
    assert.ok(fs.existsSync(path.join(root, icon.src)), `${icon.src} n'existe pas`);
    assert.ok(shell.includes(icon.src), `${icon.src} absent de APP_SHELL`);
  }
});

test("politique de sécurité : empreinte du script en ligne à jour, connexions limitées", () => {
  const html = read("index.html");
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(csp, "CSP absente de index.html");
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const crypto = require("node:crypto");
  for(const code of inline){
    const hash = crypto.createHash("sha256").update(code).digest("base64");
    assert.ok(csp[1].includes(`'sha256-${hash}'`), "empreinte du script en ligne à recalculer dans la CSP");
  }
  const connect = /connect-src ([^;]+)/.exec(csp[1])[1].trim().split(/\s+/);
  assert.deepEqual(connect, ["'self'", "https://api.github.com", "http://127.0.0.1:*"]);
});

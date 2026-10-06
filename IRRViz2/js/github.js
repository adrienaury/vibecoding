/* =========================================================================
   IRRViz 2 — adaptateur de synchronisation GitHub (dépôt privé + jeton personnel).

   Seule couche propre au service : lire et écrire le fichier distant avec sa
   version. On passe par l'API Contents (api.github.com accepte les appels
   directs depuis le navigateur) :
   - lecture : GET /repos/{dépôt}/contents/{fichier} → contenu + `sha` ;
   - écriture : PUT avec le `sha` de la version remplacée. Si un autre appareil a
     écrit entre-temps, GitHub refuse (409) : erreur `conflict`, l'orchestrateur
     relit, fusionne et réécrit.
   Chaque écriture est un commit : l'historique complet reste consultable sur GitHub.

   Le jeton (à portée fine, limité à un dépôt, permission « Contents : lecture et
   écriture ») est fourni par l'appelant ; il n'est envoyé qu'à api.github.com.
   ========================================================================= */

(function(root){
"use strict";

const IRR = root.IRR = root.IRR || {};
const API = "https://api.github.com";
const TIMEOUT_MS = 20000;

/* ---------------------------------------------------------------------
   Base64 ⇄ texte UTF-8 (atob / btoa ne traitent que l'octet)
   --------------------------------------------------------------------- */

function encodeBase64(text){
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for(let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function decodeBase64(b64){
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---------------------------------------------------------------------
   Saisie
   --------------------------------------------------------------------- */

// « propriétaire/dépôt », ou l'adresse du dépôt copiée depuis GitHub.
function parseRepo(input){
  const s = String(input || "").trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(s);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Chemin du fichier dans le dépôt : segments simples, extension .json.
function normalizePath(input){
  const s = String(input || "").trim().replace(/^\/+|\/+$/g, "") || "irrviz.json";
  if(!/^[\w .-]+(\/[\w .-]+)*$/.test(s) || s.split("/").some(seg => seg === "." || seg === "..")) return null;
  return /\.json$/i.test(s) ? s : `${s}.json`;
}

/* ---------------------------------------------------------------------
   Erreurs : `code` = network | auth | forbidden | notfound | conflict | ratelimit | invalid | http
   --------------------------------------------------------------------- */

function syncError(code, message, status = 0){
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

async function errorFrom(res){
  let body = null;
  try{ body = await res.json(); }catch(e){ /* corps non JSON */ }
  const detail = (body && body.message) || "";
  const s = res.status;
  if(s === 401) return syncError("auth", "Jeton refusé par GitHub : il a expiré ou a été révoqué.", s);
  if(s === 429 || (s === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(detail)))){
    return syncError("ratelimit", "Trop de requêtes vers GitHub : nouvel essai dans quelques minutes.", s);
  }
  if(s === 403) return syncError("forbidden", "Accès refusé : le jeton doit avoir la permission « Contents : lecture et écriture » sur ce dépôt.", s);
  if(s === 404) return syncError("notfound", "Dépôt introuvable, ou jeton sans accès à ce dépôt.", s);
  // 409 : sha périmé ; 422 « sha wasn't supplied » / « does not match » : le fichier a changé.
  if(s === 409 || (s === 422 && /sha/i.test(detail))) return syncError("conflict", "Le fichier a été modifié par un autre appareil.", s);
  return syncError("http", `GitHub a répondu par une erreur (HTTP ${s}${detail ? ` : ${detail}` : ""}).`, s);
}

/* ---------------------------------------------------------------------
   Adaptateur
   config : { owner, repo, branch, path, token }
   `branch` vide : branche par défaut du dépôt (fonctionne aussi avec un dépôt vide).
   --------------------------------------------------------------------- */

function createGitHubAdapter(config, { fetchImpl = (...a) => root.fetch(...a), timeoutMs = TIMEOUT_MS } = {}){
  const { owner, repo, token } = config;
  const branch = (config.branch || "").trim();
  const path = config.path || "irrviz.json";
  const repoUrl = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const contentsUrl = `${repoUrl}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

  async function call(method, url, body){
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if(body) headers["Content-Type"] = "application/json";
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try{
      // no-store : jamais de réponse en cache, un autre appareil a pu écrire il y a une seconde.
      return await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: ctrl ? ctrl.signal : undefined });
    }catch(e){
      throw syncError("network", "GitHub est injoignable : vérifiez la connexion.");
    }finally{
      if(timer) clearTimeout(timer);
    }
  }

  async function json(res){
    try{ return await res.json(); }
    catch(e){ throw syncError("http", "Réponse illisible de GitHub.", res.status); }
  }

  return {
    kind: "github",

    // Dépôt accessible ? Renvoie { fullName, private, defaultBranch, htmlUrl }.
    async checkRepo(){
      const res = await call("GET", repoUrl);
      if(!res.ok) throw await errorFrom(res);
      const r = await json(res);
      return { fullName: r.full_name, private: !!r.private, defaultBranch: r.default_branch || "main", htmlUrl: r.html_url };
    },

    // Fichier distant : { sha, text }, ou null s'il n'existe pas encore.
    async read(){
      const res = await call("GET", branch ? `${contentsUrl}?ref=${encodeURIComponent(branch)}` : contentsUrl);
      if(res.status === 404) return null;
      if(!res.ok) throw await errorFrom(res);
      const f = await json(res);
      if(!f || Array.isArray(f) || f.type !== "file") throw syncError("invalid", `« ${path} » n'est pas un fichier dans le dépôt.`);
      if(f.encoding === "base64" && f.content) return { sha: f.sha, text: decodeBase64(f.content) };
      if(!f.size) return { sha: f.sha, text: "" };
      // Au-delà de 1 Mo, l'API Contents ne renvoie pas le contenu : on le lit par son blob.
      const blob = await call("GET", `${repoUrl}/git/blobs/${encodeURIComponent(f.sha)}`);
      if(!blob.ok) throw await errorFrom(blob);
      const b = await json(blob);
      return { sha: f.sha, text: decodeBase64(b.content || "") };
    },

    /* Écrit le fichier. `sha` : version remplacée (null pour une création).
       Renvoie { sha, commitUrl }. Erreur `conflict` si le fichier a changé entre-temps. */
    async write(text, sha, message){
      const body = { message, content: encodeBase64(text) };
      if(sha) body.sha = sha;
      if(branch) body.branch = branch;
      const res = await call("PUT", contentsUrl, body);
      if(!res.ok) throw await errorFrom(res);
      const r = await json(res);
      return { sha: r.content && r.content.sha, commitUrl: r.commit && r.commit.html_url || null };
    },

    describe(defaultBranch){
      const web = `https://github.com/${owner}/${repo}`;
      const ref = branch || defaultBranch || "HEAD";
      return {
        label: `${owner}/${repo}`,
        url: web,
        fileUrl: `${web}/blob/${encodeURIComponent(ref)}/${path}`,
        historyUrl: `${web}/commits/${encodeURIComponent(ref)}/${path}`,
      };
    },
  };
}

IRR.github = { createGitHubAdapter, parseRepo, normalizePath, encodeBase64, decodeBase64, syncError };

if(typeof module !== "undefined" && module.exports) module.exports = IRR.github;

})(typeof window !== "undefined" ? window : globalThis);

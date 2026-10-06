/* =========================================================================
   IRRViz 2 — orchestration de la synchronisation entre appareils.

   Indépendante du service distant : elle reçoit un adaptateur (github.js) qui
   sait lire et écrire le fichier distant avec sa version, et s'appuie sur le
   moteur de fusion de store.js. Le localStorage reste la référence : l'application
   fonctionne hors ligne, le fichier distant est une copie synchronisée.

   Quand synchroniser :
   - au démarrage, au retour du réseau et au retour au premier plan (lecture) ;
   - après une modification, avec un délai : les modifications rapprochées sont
     regroupées en un seul commit (au plus un toutes les quelques minutes) ;
   - quand l'application passe en arrière-plan avec des modifications en attente ;
   - à la demande.

   Une synchronisation : lire le fichier distant → fusionner position par position
   → appliquer localement → écrire si besoin, en précisant la version remplacée.
   Si un autre appareil a écrit entre-temps, l'écriture est refusée : on recommence.
   ========================================================================= */

(function(root){
"use strict";

const IRR = root.IRR = root.IRR || {};

const DEFAULTS = {
  pushDelay: 60 * 1000,        // délai après la dernière modification
  maxDelay: 5 * 60 * 1000,     // délai maximal pendant une saisie continue
  foregroundInterval: 30 * 1000, // relecture au retour au premier plan, au plus toutes les 30 s
  retryDelays: [60, 120, 300, 600].map(s => s * 1000),
  maxAttempts: 4,              // écritures refusées (fichier changé entre-temps) avant d'abandonner
  expiryWarningDays: 7,
};

const DAY = 86400000;

// Même forme que les erreurs des adaptateurs : `code` sert à choisir l'état affiché et la reprise.
function syncError(code, message){
  const e = new Error(message);
  e.code = code;
  return e;
}

function engine(){
  const St = IRR.store || (typeof require !== "undefined" ? require("./store.js") : null);
  return St.syncEngine;
}

// Réglages lus du stockage : on ne garde que ce qui est reconnu.
function sanitizeMeta(raw){
  if(!raw || typeof raw !== "object" || !raw.config || typeof raw.config !== "object") return null;
  const c = raw.config;
  if(typeof c.owner !== "string" || typeof c.repo !== "string" || typeof c.token !== "string" || !c.token) return null;
  return {
    config: {
      service: "github",
      owner: c.owner, repo: c.repo,
      branch: typeof c.branch === "string" ? c.branch : "",
      defaultBranch: typeof c.defaultBranch === "string" ? c.defaultBranch : "",
      path: typeof c.path === "string" && c.path ? c.path : "irrviz.json",
      token: c.token,
      device: typeof c.device === "string" ? c.device.slice(0, 40) : "",
      expiresAt: typeof c.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.expiresAt) ? c.expiresAt : "",
    },
    sha: typeof raw.sha === "string" ? raw.sha : null,
    base: raw.base && typeof raw.base === "object" && raw.base.positions ? raw.base : { positions: {} },
    docHash: typeof raw.docHash === "string" ? raw.docHash : null,
    lastSyncAt: Number.isFinite(raw.lastSyncAt) ? raw.lastSyncAt : 0,
    conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.filter(c => c && typeof c.id === "string") : [],
  };
}

// Résumé lisible des différences, pour le message de commit.
function describeChanges(before, after){
  const prev = new Map((before ? before.positions : []).map(p => [p.id, p]));
  const E = engine();
  const hashIn = (doc, p) => E.positionHash(p, doc.manual[p.id]);
  const added = [], modified = [], removed = [];
  after.positions.forEach(p => {
    const o = prev.get(p.id);
    if(!o) added.push(p.name);
    else if(hashIn(before, o) !== hashIn(after, p)) modified.push(p.name);
  });
  const ids = new Set(after.positions.map(p => p.id));
  prev.forEach((p, id) => { if(!ids.has(id)) removed.push(p.name); });
  const list = names => names.slice(0, 3).join(", ") + (names.length > 3 ? ` et ${names.length - 3} autre(s)` : "");
  const parts = [];
  if(modified.length) parts.push(`modifié ${list(modified)}`);
  if(added.length) parts.push(`ajouté ${list(added)}`);
  if(removed.length) parts.push(`supprimé ${list(removed)}`);
  if(!before) return "création du fichier de synchronisation";
  return parts.join(" ; ") || "ordre des positions";
}

/* options :
   - store : store IRRViz (createStore) ;
   - createAdapter(config) : adaptateur du service (github.js) ;
   - isOnline() : état du réseau ;
   - timers : { set, clear } (remplaçables dans les tests). */
function createSync({ store, createAdapter, isOnline = () => true, timers = null, now = () => Date.now(), options = {} }){
  const opt = Object.assign({}, DEFAULTS, options);
  const T = timers || { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) };
  const E = engine();
  const listeners = new Set();
  const resultListeners = new Set();

  let meta = sanitizeMeta(store.readSyncMeta());
  let adapter = meta ? createAdapter(meta.config) : null;
  let pending = meta ? E.docHash(store.syncSnapshot()) !== meta.docHash : false;
  let firstPendingAt = pending ? now() : 0;
  let running = null;      // promesse de la synchronisation en cours
  let again = false;       // une modification est arrivée pendant la synchronisation
  let lastError = null;
  let failures = 0;
  let lastCheckAt = 0;
  let timer = null, dueAt = 0;
  let stopped = false;

  const save = () => store.writeSyncMeta(meta);

  function tokenExpiry(){
    if(!meta || !meta.config.expiresAt) return null;
    const [y, m, d] = meta.config.expiresAt.split("-").map(Number);
    const at = Date.UTC(y, m - 1, d);
    return { at, days: Math.ceil((at - now()) / DAY) };
  }

  function computeState(){
    if(!meta) return "off";
    if(running) return "syncing";
    const exp = tokenExpiry();
    if((lastError && lastError.code === "auth") || (exp && exp.days < 0)) return "auth";
    if(meta.conflicts.length) return "conflict";
    if(lastError && lastError.code !== "network") return "error";
    if(pending || lastError) return isOnline() ? "pending" : "offline";
    return "synced";
  }

  function status(){
    const state = computeState();
    const exp = tokenExpiry();
    const info = adapter ? adapter.describe(meta.config.defaultBranch) : null;
    const n = meta ? meta.conflicts.length : 0;
    const messages = {
      off: "Synchronisation désactivée",
      syncing: "Synchronisation en cours…",
      synced: "Synchronisé",
      pending: "Modifications en attente d'envoi",
      offline: "Hors ligne : modifications en attente",
      auth: exp && exp.days < 0 ? "Jeton expiré : saisissez un nouveau jeton" : "Jeton refusé : saisissez un nouveau jeton",
      conflict: `Conflit : ${n} version${n > 1 ? "s" : ""} à vérifier`,
      error: lastError ? lastError.message : "Erreur de synchronisation",
    };
    let warning = "";
    if(exp && exp.days >= 0 && exp.days <= opt.expiryWarningDays){
      warning = exp.days === 0 ? "Le jeton GitHub expire aujourd'hui." : `Le jeton GitHub expire dans ${exp.days} jour${exp.days > 1 ? "s" : ""}.`;
    }
    return {
      state,
      message: messages[state],
      warning,
      error: lastError,
      lastSyncAt: meta ? meta.lastSyncAt : 0,
      pending,
      config: meta ? Object.assign({}, meta.config, { token: undefined }) : null,
      repo: info,
      conflicts: meta ? meta.conflicts.slice() : [],
    };
  }

  function emit(){ const s = status(); listeners.forEach(fn => fn(s)); }

  function schedule(at){
    if(stopped || !meta) return;
    if(timer && dueAt <= at) return;
    if(timer) T.clear(timer);
    dueAt = at;
    timer = T.set(() => { timer = null; dueAt = 0; syncNow(); }, Math.max(0, at - now()));
  }
  function unschedule(){ if(timer){ T.clear(timer); timer = null; dueAt = 0; } }

  // Garde la version écartée d'un conflit (sans doublon si le même conflit est revu).
  function addConflicts(list){
    if(!list.length) return;
    list.forEach(c => {
      const otherHash = c.other ? E.positionHash(c.other.pos, c.other.manual) : "deleted";
      if(meta.conflicts.some(x => x.id === c.id && x.otherHash === otherHash)) return;
      meta.conflicts.push(Object.assign({ otherHash }, c));
    });
    save();
  }

  async function run(){
    const result = { pulled: [], pushed: false, conflicts: [] };
    for(let attempt = 1; ; attempt++){
      const remote = await adapter.read();
      let remoteDoc = null;
      if(remote && remote.text.trim()){
        let raw;
        try{ raw = JSON.parse(remote.text); }
        catch(e){ throw syncError("invalid", "Le fichier distant n'est pas un JSON valide : corrigez-le sur GitHub ou choisissez un autre fichier."); }
        try{ remoteDoc = E.parseSyncDoc(raw); }
        catch(e){ throw syncError("invalid", "Le fichier distant n'est pas une sauvegarde IRRViz : choisissez un autre fichier."); }
      }
      const local = store.syncSnapshot();
      const localHash = E.docHash(local);
      // Rien n'a bougé, ni ici ni ailleurs.
      if(remote && remote.sha === meta.sha && localHash === meta.docHash) break;

      const { doc, conflicts } = remoteDoc ? E.mergeSyncDocs(local, remoteDoc, meta.base) : { doc: local, conflicts: [] };
      const mergedHash = E.docHash(doc);
      if(mergedHash !== localHash) result.pulled.push(...store.syncApply(doc));
      addConflicts(conflicts);
      result.conflicts.push(...conflicts);

      let sha = remote ? remote.sha : null;
      if(!remoteDoc || mergedHash !== E.docHash(remoteDoc)){
        const message = `IRRViz${meta.config.device ? ` (${meta.config.device})` : ""} : ${describeChanges(remoteDoc, doc)}`;
        try{
          sha = (await adapter.write(E.serializeSyncDoc(doc, { device: meta.config.device }), sha, message)).sha;
          result.pushed = true;
        }catch(e){
          // Un autre appareil a écrit entre la lecture et l'écriture : relire et refusionner.
          if(e.code === "conflict" && attempt < opt.maxAttempts) continue;
          throw e;
        }
      }
      meta.sha = sha;
      meta.base = E.baseOf(doc);
      meta.docHash = mergedHash;
      break;
    }
    meta.lastSyncAt = now();
    save();
    return result;
  }

  /* Synchronise maintenant. Renvoie { pulled, pushed, conflicts }, ou null si la
     synchronisation n'a pas eu lieu (non configurée, hors ligne, en erreur). */
  function syncNow({ manual = false } = {}){
    if(!meta || stopped) return Promise.resolve(null);
    if(running){
      again = true;
      // Seul l'appelant « à la demande » reçoit les erreurs ; les autres déclencheurs les ignorent.
      return manual ? running : running.catch(() => null);
    }
    unschedule();
    if(!isOnline()){ emit(); return Promise.resolve(null); }
    lastCheckAt = now();
    const startedWithChanges = pending;
    running = (async () => {
      try{
        emit();
        const res = await run();
        lastError = null;
        failures = 0;
        // Des modifications faites pendant l'échange restent à envoyer.
        pending = E.docHash(store.syncSnapshot()) !== meta.docHash;
        firstPendingAt = pending ? (firstPendingAt || now()) : 0;
        resultListeners.forEach(fn => fn(res, { manual }));
        return res;
      }catch(e){
        lastError = e.code ? e : syncError("http", e.message || "Erreur de synchronisation");
        if(startedWithChanges) pending = true;
        const retry = ["network", "ratelimit", "http", "conflict"].includes(lastError.code);
        if(retry){
          schedule(now() + opt.retryDelays[Math.min(failures, opt.retryDelays.length - 1)]);
          failures++;
        }
        if(manual) throw lastError;
        return null;
      }finally{
        running = null;
        if(again){ again = false; if(pending) schedule(now() + opt.pushDelay); }
        else if(pending && !lastError) schedule(now() + opt.pushDelay);
        emit();
      }
    })();
    return running;
  }

  // Modification locale : envoi regroupé après un délai.
  function notifyChange(){
    if(!meta) return;
    const wasPending = pending;
    pending = true;
    if(!firstPendingAt) firstPendingAt = now();
    if(running){ again = true; }
    else if(!lastError || lastError.code === "network"){
      const t = now();
      // Débounce : repoussé à chaque frappe, sans dépasser maxDelay depuis la première modification.
      const at = Math.min(t + opt.pushDelay, firstPendingAt + opt.maxDelay);
      if(timer && dueAt < at){ T.clear(timer); timer = null; }
      schedule(at);
    }
    if(!wasPending) emit();
  }

  const offData = store.onDataChange(notifyChange);

  return {
    get status(){ return status(); },
    get configured(){ return !!meta; },
    subscribe(fn){ listeners.add(fn); return () => listeners.delete(fn); },
    // Résultat de chaque synchronisation réussie : { pulled, pushed, conflicts }, { manual }.
    onResult(fn){ resultListeners.add(fn); return () => resultListeners.delete(fn); },
    syncNow,
    notifyChange,

    // Démarrage, retour du réseau, retour au premier plan.
    start(){ if(meta) syncNow(); else emit(); },
    onOnline(){ if(meta) syncNow(); },
    onForeground(){ if(meta && now() - lastCheckAt >= opt.foregroundInterval) syncNow(); },
    // Passage en arrière-plan : on envoie tout de suite ce qui attend (l'application peut être fermée).
    onBackground(){ if(meta && pending && (!lastError || lastError.code === "network")) syncNow(); },

    /* Vérifie un réglage sans l'enregistrer. Renvoie { repo, remote } où remote vaut
       null (fichier absent, il sera créé) ou { positions, names, exportedAt, device, doc, sha }. */
    async test(config){
      const a = createAdapter(config);
      const repo = await a.checkRepo();
      if(!repo.private){
        throw syncError("public", "Ce dépôt est public : vos données y seraient visibles de tous. Utilisez un dépôt privé.");
      }
      const file = await a.read();
      if(!file || !file.text.trim()) return { repo, remote: null };
      let raw, doc;
      try{ raw = JSON.parse(file.text); doc = E.parseSyncDoc(raw); }
      catch(e){ throw syncError("invalid", `« ${config.path} » existe mais n'est pas une sauvegarde IRRViz : choisissez un autre nom de fichier.`); }
      return {
        repo,
        remote: {
          sha: file.sha, doc,
          positions: doc.positions.length,
          names: doc.positions.map(p => p.name),
          exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : null,
          device: typeof raw.device === "string" ? raw.device : "",
        },
      };
    },

    /* Active la synchronisation. mode : "merge" (fusionner avec les données de cet
       appareil) | "replace" (remplacer les données de cet appareil par le fichier distant,
       `remote` étant le résultat de test()). */
    async connect(config, { mode = "merge", remote = null } = {}){
      unschedule();
      meta = sanitizeMeta({ config, base: { positions: {} }, conflicts: [] });
      if(!meta) throw new Error("Réglages incomplets");
      adapter = createAdapter(meta.config);
      lastError = null;
      failures = 0;
      if(mode === "replace" && remote && remote.doc){
        store.syncApply(remote.doc);
        meta.sha = remote.sha;
        meta.base = E.baseOf(remote.doc);
        meta.docHash = E.docHash(remote.doc);
      }
      save();
      pending = E.docHash(store.syncSnapshot()) !== meta.docHash;
      firstPendingAt = pending ? now() : 0;
      return syncNow({ manual: true });
    },

    // Nouveau jeton (expiré ou révoqué) : le reste des réglages est conservé.
    updateToken(token, expiresAt = ""){
      if(!meta) return Promise.resolve(null);
      meta.config.token = token;
      meta.config.expiresAt = expiresAt;
      adapter = createAdapter(meta.config);
      lastError = null;
      failures = 0;
      save();
      return syncNow({ manual: true });
    },

    updateSettings({ device, expiresAt }){
      if(!meta) return;
      if(typeof device === "string") meta.config.device = device.trim().slice(0, 40);
      if(typeof expiresAt === "string") meta.config.expiresAt = expiresAt;
      save();
      emit();
    },

    // Désactive la synchronisation sur cet appareil : les données locales restent, le jeton est effacé.
    disconnect(){
      unschedule();
      meta = null;
      adapter = null;
      lastError = null;
      pending = false;
      store.writeSyncMeta(null);
      emit();
    },

    /* Règle un conflit. action :
       - "other" : reprendre la version écartée (ou supprimer la position, si l'écartée était une suppression) ;
       - "both" : garder les deux (la version écartée devient une nouvelle position) ;
       - "dismiss" : garder la version actuelle. */
    resolveConflict(index, action){
      if(!meta || !meta.conflicts[index]) return;
      const c = meta.conflicts[index];
      meta.conflicts.splice(index, 1);
      save();
      if(action === "other"){
        if(c.other) store.syncAdopt(c.other);
        else if(store.positions.some(p => p.id === c.id)) store.deletePosition(c.id);
      } else if(action === "both" && c.other){
        store.syncAdopt(c.other, { asCopy: true });
      }
      emit();
    },

    stop(){ stopped = true; unschedule(); offData(); },
  };
}

IRR.sync = { createSync, sanitizeMeta, describeChanges, DEFAULTS };

if(typeof module !== "undefined" && module.exports) module.exports = IRR.sync;

})(typeof window !== "undefined" ? window : globalThis);

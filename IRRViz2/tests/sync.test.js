/* Tests de la synchronisation entre appareils — node --test IRRViz2/tests/*.test.js
   Plusieurs « appareils » sont simulés par des stockages en mémoire distincts,
   partageant un fichier distant fictif qui refuse les écritures périmées comme GitHub. */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
require("../js/util.js");
const St = require("../js/store.js");
const GH = require("../js/github.js");
const Sync = require("../js/sync.js");
const E = St.syncEngine;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function memoryStorage(){
  const data = new Map();
  return {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: k => data.delete(k),
    keys: () => [...data.keys()],
    raw: data,
  };
}

// Fichier distant fictif : version (sha) vérifiée à chaque écriture, comme l'API Contents.
function fakeRemote(){
  const r = { sha: null, text: null, commits: [], beforeWrite: null };
  r.adapter = () => ({
    async checkRepo(){ return { fullName: "moi/irrviz-data", private: true, defaultBranch: "main" }; },
    async read(){ return r.text == null ? null : { sha: r.sha, text: r.text }; },
    async write(text, sha, message){
      if(r.beforeWrite){ const fn = r.beforeWrite; r.beforeWrite = null; await fn(); }
      if((sha || null) !== r.sha) throw Object.assign(new Error("conflit"), { code: "conflict" });
      r.sha = `sha${r.commits.length + 1}`;
      r.text = text;
      r.commits.push(message);
      return { sha: r.sha };
    },
    describe(){ return { label: "moi/irrviz-data", url: "https://github.com/moi/irrviz-data" }; },
  });
  r.doc = () => E.parseSyncDoc(JSON.parse(r.text));
  return r;
}

const CONFIG = { owner: "moi", repo: "irrviz-data", path: "irrviz.json", token: "github_pat_test", device: "PC" };
const noTimers = { set: () => 0, clear: () => {} };

function device(remote, name = "PC"){
  const storage = memoryStorage();
  const store = St.createStore({ storage });
  const sync = Sync.createSync({ store, createAdapter: remote.adapter, timers: noTimers });
  return { storage, store, sync, name, connect: (mode = "merge", rem = null) => sync.connect(Object.assign({}, CONFIG, { device: name }), { mode, remote: rem }) };
}

/* ---------------------------------------------------------------------
   Suivi des modifications dans le store
   --------------------------------------------------------------------- */

test("store : date de modification, traces de suppression et ordre suivis", async () => {
  const store = St.createStore({ storage: memoryStorage() });
  let notified = 0;
  store.onDataChange(() => notified++);
  const id = store.activeId;
  const t0 = store.state.modifiedAt;
  await sleep(3);
  store.update(s => { s.feePercent = 1; });
  assert.ok(store.state.modifiedAt > t0);
  assert.equal(notified, 1);

  // Les préférences d'affichage et la vue ne sont pas des modifications synchronisées.
  store.setUi(g => { g.ui.showBands = false; });
  store.setView({ start: 1, end: 2 });
  assert.equal(notified, 1);

  const b = store.createPosition({ name: "B" });
  const snap = store.syncSnapshot();
  assert.ok(snap.orderAt > 0);
  assert.equal(snap.positions[0].view, undefined, "la vue reste propre à l'appareil");

  const token = store.deletePosition(b);
  assert.ok(store.syncSnapshot().deleted[b] > 0);
  store.restorePosition(token);
  assert.equal(store.syncSnapshot().deleted[b], undefined, "restaurer retire la trace");

  // L'historique importé compte comme une modification de la position.
  const before = store.positions.find(p => p.id === id).modifiedAt;
  await sleep(3);
  store.writeManualPrices({ name: "X", kind: "close", candles: [{ ms: Date.UTC(2026, 0, 1), open: 1, high: 1, low: 1, close: 1 }] }, id);
  assert.ok(store.positions.find(p => p.id === id).modifiedAt > before);
  assert.ok(store.syncSnapshot().manual[id]);
});

test("store : restaurer une sauvegarde complète laisse des traces pour les positions écartées", () => {
  const store = St.createStore({ storage: memoryStorage() });
  const old = store.activeId;
  const other = St.createStore({ storage: memoryStorage() });
  other.createPosition({ name: "Autre" });
  const res = store.restoreBackup(JSON.parse(JSON.stringify(other.backup())));
  const snap = store.syncSnapshot();
  assert.ok(snap.deleted[old] > 0);
  assert.equal(snap.positions.length, 2);
  res.undo();
  const after = store.syncSnapshot();
  assert.equal(after.deleted[old], undefined);
  other.positions.forEach(p => assert.ok(after.deleted[p.id] > 0));
});

test("anciennes données sans date de modification : relues sans erreur", () => {
  const app = St.sanitizeApp({ positions: [{ id: "p1", name: "A", createdAt: 1000 }], deleted: { p1: 5, p2: 7, "x y": 3 } });
  assert.equal(app.positions[0].modifiedAt, 1000);
  assert.deepEqual(app.deleted, { p2: 7 }, "une position présente n'a pas de trace ; identifiants invalides écartés");
  assert.equal(app.orderAt, 0);
});

/* ---------------------------------------------------------------------
   Moteur de fusion
   --------------------------------------------------------------------- */

function pos(id, name, extra = {}){
  return Object.assign(St.sanitizePosition({ id, name, createdAt: 1, modifiedAt: 1 }), { view: undefined }, extra);
}
function doc(positions, extra = {}){
  return Object.assign({ positions, manual: {}, deleted: {}, orderAt: 0 }, extra);
}

test("fusion : version modifiée d'un seul côté retenue, nouvelles positions ajoutées des deux côtés", () => {
  const a = pos("a", "A"), b = pos("b", "B");
  const base = E.baseOf(doc([a, b]));
  const local = doc([pos("a", "A", { feePercent: 2, modifiedAt: 5 }), b, pos("l", "Locale")]);
  const remote = doc([a, pos("b", "B", { assetTicker: "AI.PA", modifiedAt: 3 }), pos("r", "Distante")]);
  const { doc: m, conflicts } = E.mergeSyncDocs(local, remote, base);
  assert.equal(conflicts.length, 0);
  const by = id => m.positions.find(p => p.id === id);
  assert.equal(by("a").feePercent, 2);
  assert.equal(by("b").assetTicker, "AI.PA");
  assert.ok(by("l") && by("r"));
});

test("fusion : modifiée des deux côtés → la plus récente gagne, l'autre est conservée", () => {
  const a = pos("a", "A");
  const base = E.baseOf(doc([a]));
  const local = doc([pos("a", "A", { feePercent: 2, modifiedAt: 10 })]);
  const remote = doc([pos("a", "A", { feePercent: 3, modifiedAt: 20 })]);
  const { doc: m, conflicts } = E.mergeSyncDocs(local, remote, base);
  assert.equal(m.positions[0].feePercent, 3);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kept, "remote");
  assert.equal(conflicts[0].other.pos.feePercent, 2);
  // Même contenu des deux côtés : pas de conflit.
  const same = E.mergeSyncDocs(local, doc([pos("a", "A", { feePercent: 2, modifiedAt: 30 })]), base);
  assert.equal(same.conflicts.length, 0);
  assert.equal(same.doc.positions[0].modifiedAt, 30);
});

test("fusion : sans base commune (premier branchement), contenus différents = conflit signalé", () => {
  const { conflicts } = E.mergeSyncDocs(doc([pos("a", "A", { feePercent: 1 })]), doc([pos("a", "A", { feePercent: 2 })]), null);
  assert.equal(conflicts.length, 1);
});

test("fusion : suppression propagée, sans résurrection ; modification postérieure conservée", () => {
  const a = pos("a", "A"), b = pos("b", "B");
  const base = E.baseOf(doc([a, b]));
  // Supprimée ici, inchangée là-bas : supprimée partout.
  let r = E.mergeSyncDocs(doc([b], { deleted: { a: 50 } }), doc([a, b]), base);
  assert.deepEqual(r.doc.positions.map(p => p.id), ["b"]);
  assert.equal(r.doc.deleted.a, 50);
  assert.equal(r.conflicts.length, 0);
  // Supprimée là-bas, inchangée ici : supprimée ici aussi.
  r = E.mergeSyncDocs(doc([a, b]), doc([b], { deleted: { a: 50 } }), base);
  assert.deepEqual(r.doc.positions.map(p => p.id), ["b"]);
  // Modifiée ici AVANT la suppression : la suppression l'emporte, la modification est signalée.
  r = E.mergeSyncDocs(doc([pos("a", "A", { feePercent: 9, modifiedAt: 40 }), b]), doc([b], { deleted: { a: 50 } }), base);
  assert.deepEqual(r.doc.positions.map(p => p.id), ["b"]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].keptDeleted, true);
  assert.equal(r.conflicts[0].other.pos.feePercent, 9);
  // Modifiée ici APRÈS la suppression : conservée, la trace disparaît.
  r = E.mergeSyncDocs(doc([pos("a", "A", { feePercent: 9, modifiedAt: 60 }), b]), doc([b], { deleted: { a: 50 } }), base);
  assert.deepEqual(r.doc.positions.map(p => p.id).sort(), ["a", "b"]);
  assert.equal(r.doc.deleted.a, undefined);
  assert.equal(r.conflicts[0].other, null);
});

test("fusion : position retirée à la main du fichier distant (sans trace)", () => {
  const a = pos("a", "A"), b = pos("b", "B");
  const base = E.baseOf(doc([a, b]));
  assert.deepEqual(E.mergeSyncDocs(doc([a, b]), doc([b]), base).doc.positions.map(p => p.id), ["b"]);
  // … mais modifiée ici entre-temps : conservée.
  const kept = E.mergeSyncDocs(doc([pos("a", "A", { feePercent: 4 }), b]), doc([b]), base);
  assert.equal(kept.doc.positions.length, 2);
});

test("fusion : ordre du côté modifié en dernier, historiques importés suivis", () => {
  const a = pos("a", "A"), b = pos("b", "B"), c = pos("c", "C");
  const manual = { name: "SCPI", fileName: null, kind: "close", importedAt: 1, rows: [[86400, 1.5]] };
  const local = doc([a, b, c], { orderAt: 10 });
  const remote = doc([c, b, a], { orderAt: 20, manual: { b: manual } });
  const base = E.baseOf(doc([a, b, c]));
  const { doc: m } = E.mergeSyncDocs(local, remote, base);
  assert.deepEqual(m.positions.map(p => p.id), ["c", "b", "a"]);
  assert.deepEqual(m.manual.b, manual);
  assert.equal(m.orderAt, 20);
});

test("fichier distant : format de sauvegarde, relu à l'identique ; fichier inconnu refusé", () => {
  const a = pos("a", "Été 2026");
  a.transactions = [{ id: "t1", iso: "2026-01-01", amount: -100, quantity: 1 }];
  const d = doc([a], { deleted: { z: 9 }, orderAt: 3, manual: { a: { name: "X", fileName: null, kind: "close", importedAt: null, rows: [[86400, 2]] } } });
  const text = E.serializeSyncDoc(d, { device: "iPad" });
  const raw = JSON.parse(text);
  assert.equal(raw.app, "IRRViz2");
  assert.equal(raw.device, "iPad");
  assert.match(text, /\n\s*\[86400, 2\]\n/, "une ligne de cours par ligne de fichier");
  assert.match(text, /\{ "id": "t1", "iso": "2026-01-01", "amount": -100, "quantity": 1 \}/, "une transaction par ligne");
  const back = E.parseSyncDoc(raw);
  assert.equal(E.docHash(back), E.docHash(d));
  // Lisible aussi par « Restaurer une sauvegarde ».
  const store = St.createStore({ storage: memoryStorage() });
  assert.equal(store.restoreBackup(raw).mode, "all");
  assert.equal(store.state.name, "Été 2026");
  assert.throws(() => E.parseSyncDoc({ hello: "world" }));
});

/* ---------------------------------------------------------------------
   Adaptateur GitHub (requêtes simulées)
   --------------------------------------------------------------------- */

function fakeFetch(routes){
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const route = routes.find(r => r.match(url, init));
    if(!route) throw new TypeError("Failed to fetch");
    const { status = 200, body = {}, headers = {} } = route.reply(url, init);
    return {
      status, ok: status >= 200 && status < 300,
      headers: { get: k => headers[k.toLowerCase()] || null },
      json: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

test("github : saisie du dépôt et du fichier", () => {
  assert.deepEqual(GH.parseRepo("moi/irrviz-data"), { owner: "moi", repo: "irrviz-data" });
  assert.deepEqual(GH.parseRepo("https://github.com/moi/irrviz-data.git"), { owner: "moi", repo: "irrviz-data" });
  assert.equal(GH.parseRepo("irrviz-data"), null);
  assert.equal(GH.normalizePath(""), "irrviz.json");
  assert.equal(GH.normalizePath("data/positions"), "data/positions.json");
  assert.equal(GH.normalizePath("../x.json"), null);
  assert.equal(GH.decodeBase64(GH.encodeBase64("Été € 🙂")), "Été € 🙂");
});

test("github : lecture, écriture conditionnelle par sha, erreurs", async () => {
  const content = GH.encodeBase64('{"state":{"positions":[]}}');
  const f = fakeFetch([
    { match: (u, i) => i.method === "GET" && u.endsWith("/contents/irrviz.json"), reply: () => ({ body: { type: "file", sha: "abc", encoding: "base64", content, size: 10 } }) },
    { match: (u, i) => i.method === "PUT" && JSON.parse(i.body).sha === "abc", reply: () => ({ body: { content: { sha: "def" }, commit: { html_url: "u" } } }) },
    { match: (u, i) => i.method === "PUT", reply: () => ({ status: 409, body: { message: "is at def but expected abc" } }) },
  ]);
  const a = GH.createGitHubAdapter(CONFIG, { fetchImpl: f });
  const file = await a.read();
  assert.equal(file.sha, "abc");
  assert.equal(file.text, '{"state":{"positions":[]}}');
  const init = f.calls[0].init;
  assert.equal(init.headers.Authorization, "Bearer github_pat_test");
  assert.equal(init.cache, "no-store");
  assert.equal((await a.write("{}", "abc", "msg")).sha, "def");
  const body = JSON.parse(f.calls[1].init.body);
  assert.equal(body.message, "msg");
  assert.equal(GH.decodeBase64(body.content), "{}");
  assert.equal(body.branch, undefined, "branche par défaut du dépôt");
  await assert.rejects(a.write("{}", "old", "msg"), e => e.code === "conflict");

  const errors = GH.createGitHubAdapter(Object.assign({}, CONFIG, { branch: "data" }), { fetchImpl: fakeFetch([
    { match: u => u.includes("?ref=data"), reply: () => ({ status: 404 }) },
    { match: u => u.endsWith("/irrviz-data"), reply: () => ({ status: 401, body: { message: "Bad credentials" } }) },
  ]) });
  assert.equal(await errors.read(), null, "fichier absent : sera créé");
  await assert.rejects(errors.checkRepo(), e => e.code === "auth");
  const offline = GH.createGitHubAdapter(CONFIG, { fetchImpl: fakeFetch([]) });
  await assert.rejects(offline.read(), e => e.code === "network");
});

test("github : fichier de plus de 1 Mo lu par son blob", async () => {
  const f = fakeFetch([
    { match: u => u.includes("/contents/"), reply: () => ({ body: { type: "file", sha: "big", encoding: "none", content: "", size: 2e6 } }) },
    { match: u => u.endsWith("/git/blobs/big"), reply: () => ({ body: { content: GH.encodeBase64("gros fichier"), encoding: "base64" } }) },
  ]);
  const file = await GH.createGitHubAdapter(CONFIG, { fetchImpl: f }).read();
  assert.equal(file.text, "gros fichier");
});

/* ---------------------------------------------------------------------
   Orchestration : deux appareils, un fichier distant
   --------------------------------------------------------------------- */

test("deux appareils : premier envoi, reprise sur le second, modifications dans les deux sens", async () => {
  const remote = fakeRemote();
  const pc = device(remote, "PC");
  pc.store.update(s => { s.feePercent = 1.5; });
  await pc.connect();
  assert.equal(remote.commits.length, 1);
  assert.match(remote.commits[0], /^IRRViz \(PC\) : création/);
  assert.equal(pc.sync.status.state, "synced");

  // Le second appareil n'a que l'exemple : il remplace ses données par celles du dépôt.
  const ipad = device(remote, "iPad");
  assert.equal(ipad.store.isPristine(), true);
  const t = await ipad.sync.test(CONFIG);
  assert.equal(t.remote.positions, 1);
  await ipad.connect("replace", t.remote);
  assert.equal(remote.commits.length, 1, "rien à renvoyer");
  assert.deepEqual(ipad.store.positions.map(p => p.id), pc.store.positions.map(p => p.id));
  assert.equal(ipad.store.state.feePercent, 1.5);

  // Modification sur l'iPad, reçue par le PC.
  ipad.store.update(s => { s.horizonIso = "2030-01-01"; });
  assert.equal(ipad.sync.status.state, "pending");
  await ipad.sync.syncNow();
  assert.equal(remote.commits.length, 2);
  assert.match(remote.commits[1], /^IRRViz \(iPad\) : modifié Exemple/);
  const res = await pc.sync.syncNow();
  assert.deepEqual(res.pulled, [pc.store.activeId]);
  assert.equal(pc.store.state.horizonIso, "2030-01-01");
  assert.equal(pc.store.canUndo(), false, "l'historique d'annulation périmé est effacé");
  assert.equal(remote.commits.length, 2, "réception seule : pas de commit");

  // Synchroniser sans rien changer ne fait aucun commit.
  await pc.sync.syncNow();
  await ipad.sync.syncNow();
  assert.equal(remote.commits.length, 2);
});

test("deux appareils : suppression propagée, positions créées des deux côtés fusionnées", async () => {
  const remote = fakeRemote();
  const pc = device(remote, "PC");
  const keep = pc.store.createPosition({ name: "PEA" });
  const gone = pc.store.createPosition({ name: "Crypto" });
  await pc.connect();
  const ipad = device(remote, "iPad");
  const t = await ipad.sync.test(CONFIG);
  await ipad.connect("replace", t.remote);

  pc.store.deletePosition(gone);
  ipad.store.createPosition({ name: "Livret" });
  await pc.sync.syncNow();
  await ipad.sync.syncNow();
  await pc.sync.syncNow();
  const names = s => s.store.positions.map(p => p.name).sort();
  assert.deepEqual(names(pc), ["Exemple", "Livret", "PEA"]);
  assert.deepEqual(names(ipad), names(pc));
  assert.ok(keep);
  assert.ok(remote.doc().deleted[gone] > 0);
});

test("écriture refusée car un autre appareil a écrit entre-temps : relecture, fusion, réécriture", async () => {
  const remote = fakeRemote();
  const pc = device(remote, "PC");
  await pc.connect();
  const ipad = device(remote, "iPad");
  await ipad.connect("replace", (await ipad.sync.test(CONFIG)).remote);

  const b = ipad.store.createPosition({ name: "Créée sur iPad" });
  pc.store.update(s => { s.feePercent = 0.9; });
  // L'iPad écrit juste avant le PC.
  remote.beforeWrite = () => ipad.sync.syncNow();
  await pc.sync.syncNow();
  assert.equal(pc.sync.status.state, "synced");
  const final = remote.doc();
  assert.ok(final.positions.some(p => p.id === b));
  assert.equal(final.positions.find(p => p.id === pc.store.positions[0].id).feePercent, 0.9);
  assert.ok(pc.store.positions.some(p => p.id === b), "la position de l'iPad est arrivée sur le PC");
});

test("conflit sur une même position : la plus récente gagne, l'autre version peut être reprise", async () => {
  const remote = fakeRemote();
  const pc = device(remote, "PC");
  await pc.connect();
  const ipad = device(remote, "iPad");
  await ipad.connect("replace", (await ipad.sync.test(CONFIG)).remote);
  const id = pc.store.activeId;

  pc.store.update(s => { s.feePercent = 1; });
  await sleep(3);
  ipad.store.update(s => { s.feePercent = 2; });
  await ipad.sync.syncNow();
  const res = await pc.sync.syncNow();
  assert.equal(res.conflicts.length, 1);
  assert.equal(pc.store.state.feePercent, 2, "la version la plus récente (iPad) est gardée");
  const st = pc.sync.status;
  assert.equal(st.state, "conflict");
  assert.equal(st.conflicts[0].other.pos.feePercent, 1);

  // « Garder les deux » : la version écartée devient une nouvelle position.
  pc.sync.resolveConflict(0, "both");
  assert.equal(pc.sync.status.conflicts.length, 0);
  assert.equal(pc.store.positions.length, 2);
  assert.equal(pc.store.state.feePercent, 1);
  assert.match(pc.store.state.name, /autre version/);
  assert.equal(pc.store.positions.find(p => p.id === id).feePercent, 2);
  await pc.sync.syncNow();
  await ipad.sync.syncNow();
  assert.equal(ipad.store.positions.length, 2);
});

test("jeton refusé, fichier distant illisible, dépôt public", async () => {
  const remote = fakeRemote();
  const pc = device(remote, "PC");
  await pc.connect();
  remote.adapter = () => ({ async read(){ throw Object.assign(new Error("Jeton refusé"), { code: "auth" }); }, describe(){ return {}; } });
  const st = St.createStore({ storage: pc.storage });
  const again = Sync.createSync({ store: st, createAdapter: remote.adapter, timers: noTimers });
  await again.syncNow();
  assert.equal(again.status.state, "auth");

  const bad = fakeRemote();
  bad.text = '{"autre":"chose"}';
  bad.sha = "x";
  const dev = device(bad);
  await assert.rejects(dev.sync.test(CONFIG), e => e.code === "invalid");
  await assert.rejects(dev.connect(), e => e.code === "invalid");
  assert.equal(bad.text, '{"autre":"chose"}', "un fichier inconnu n'est jamais écrasé");

  const pub = fakeRemote();
  const a = pub.adapter;
  pub.adapter = () => Object.assign(a(), { async checkRepo(){ return { private: false }; } });
  await assert.rejects(device(pub).sync.test(CONFIG), e => e.code === "public");
});

test("envoi regroupé : une modification programme un envoi différé, pas immédiat", () => {
  const remote = fakeRemote();
  const storage = memoryStorage();
  const store = St.createStore({ storage });
  const planned = [];
  const timers = { set: (fn, ms) => { planned.push(ms); return planned.length; }, clear: () => {} };
  let t = 1000000;
  const sync = Sync.createSync({ store, createAdapter: remote.adapter, timers, now: () => t });
  store.writeSyncMeta({ config: CONFIG });
  const s2 = Sync.createSync({ store, createAdapter: remote.adapter, timers, now: () => t });
  store.update(x => { x.feePercent = 3; });
  assert.equal(planned.at(-1), Sync.DEFAULTS.pushDelay);
  t += 30000;
  store.update(x => { x.feePercent = 4; });
  assert.equal(planned.at(-1), Sync.DEFAULTS.pushDelay, "délai repoussé à chaque modification…");
  t += 240000;
  store.update(x => { x.feePercent = 5; });
  assert.equal(planned.at(-1), Sync.DEFAULTS.maxDelay - 270000, "… sans dépasser maxDelay après la première");
  assert.equal(remote.commits.length, 0);
  assert.equal(s2.status.state, "pending");
  assert.equal(sync.status.state, "off");
  sync.stop(); s2.stop();
});

test("jeton : expiration proche signalée, expiré = à reconnecter ; aucune donnée de jeton dans l'état exposé", () => {
  const store = St.createStore({ storage: memoryStorage() });
  const day = 86400000;
  const iso = ms => new Date(ms).toISOString().slice(0, 10);
  store.writeSyncMeta({ config: Object.assign({}, CONFIG, { expiresAt: iso(Date.now() + 3 * day) }) });
  const s = Sync.createSync({ store, createAdapter: fakeRemote().adapter, timers: noTimers });
  assert.match(s.status.warning, /expire dans [34] jours/);
  assert.equal(s.status.config.token, undefined);
  s.updateSettings({ expiresAt: iso(Date.now() - 2 * day) });
  assert.equal(s.status.state, "auth");
  s.disconnect();
  assert.equal(store.readSyncMeta(), null);
  assert.equal(s.status.state, "off");
});

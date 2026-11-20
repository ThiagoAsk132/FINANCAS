// FINANÇAS DA CASA — armazenamento local, login Google e acesso ao arquivo no Google Drive.
// Escopo "drive": precisa enxergar o arquivo que o marido/esposa compartilhou (drive.file não enxerga).
// O app só lê e grava o arquivo FINANCAS DA CASA.json; não mexe em mais nada do Drive.
// Modo demonstração (?demo=1): dados só neste navegador, sem Google.
(() => {
"use strict";
const CFG = window.FIN_CONFIG || {};
const DEMO = new URLSearchParams(location.search).has("demo");
const ESCOPO = "https://www.googleapis.com/auth/drive";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const P = DEMO ? "finDemo_" : "fin_";

const loc = {
  ler(k, padrao) { try { const v = localStorage.getItem(P + k); return v === null ? padrao : JSON.parse(v); } catch { return padrao; } },
  gravar(k, v) { try { localStorage.setItem(P + k, JSON.stringify(v)); return true; } catch { return false; } },
  apagar(k) { try { localStorage.removeItem(P + k); } catch { } }
};

const $ = id => document.getElementById(id);
function toast(msg, ms = 3200) {
  const t = $("toast"); if (!t) return;
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, ms);
}
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

// ---------- login (redirecionamento: funciona no app da tela de início do iPhone) ----------
function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ""); }
function configurado() { return DEMO || !!CFG.CLIENT_ID; }
function token() {
  if (DEMO) return "demo";
  const t = loc.ler("token", null);
  return t && t.exp > Date.now() + 60000 ? t.v : null;
}
function entrar() {
  if (!CFG.CLIENT_ID) { toast("Falta o ID do cliente do Google em config.js (veja o LEIA-ME)."); return; }
  const st = Math.random().toString(36).slice(2);
  loc.gravar("estadoOauth", st);
  const p = new URLSearchParams({
    client_id: CFG.CLIENT_ID, redirect_uri: redirectUri(), response_type: "token",
    scope: ESCOPO, include_granted_scopes: "true", state: st, prompt: "select_account"
  });
  const dica = loc.ler("email", "");
  if (dica) { p.set("login_hint", dica); p.delete("prompt"); }
  location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + p;
}
function sair() { loc.apagar("token"); loc.apagar("email"); loc.apagar("arqId"); }
function lerRetornoLogin() {
  if (!location.hash.includes("access_token") && !location.hash.includes("error")) return false;
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);
  if (h.get("error")) { toast("Login cancelado: " + h.get("error")); return false; }
  if (h.get("state") !== loc.ler("estadoOauth", "")) { toast("Login recusado (estado não confere). Tente de novo."); return false; }
  loc.gravar("token", { v: h.get("access_token"), exp: Date.now() + Number(h.get("expires_in") || 3600) * 1000 });
  return true;
}

class SemLogin extends Error { }
async function api(url, opc = {}) {
  const t = token();
  if (!t) throw new SemLogin();
  const r = await fetch(url, { ...opc, headers: { ...(opc.headers || {}), Authorization: "Bearer " + t } });
  if (r.status === 401) { loc.apagar("token"); throw new SemLogin(); }
  if (!r.ok) throw new Error("Google Drive respondeu " + r.status + ": " + (await r.text()).slice(0, 200));
  return r;
}

function multipart(meta, texto) {
  const lim = "fin" + Date.now();
  const corpo = "--" + lim + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) +
    "\r\n--" + lim + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + texto + "\r\n--" + lim + "--";
  return { corpo, tipo: "multipart/related; boundary=" + lim };
}

// ---------- arquivo de dados ----------
const drive = {
  // devolve {id, dono, meu} do arquivo de finanças (próprio ou compartilhado), ou null
  async achar() {
    if (DEMO) return loc.ler("demoArq", null) ? { id: "demo", dono: "demonstração", meu: true } : null;
    // Sempre procura de novo e escolhe o arquivo MAIS ANTIGO: se existirem dois (criados por engano),
    // todos os aparelhos acabam no mesmo. Um arquivo compartilhado por outra pessoa vem antes do próprio.
    const campos = "id,createdTime,ownedByMe,owners(displayName,emailAddress)";
    const q = encodeURIComponent("name = '" + CFG.NOME_ARQUIVO.replace(/'/g, "\\'") + "' and trashed = false");
    const j = await (await api(API + "/files?q=" + q + "&orderBy=createdTime&fields=files(" + campos + ")&spaces=drive&pageSize=20")).json();
    const lista = j.files || [];
    const f = lista.find(x => !x.ownedByMe) || lista[0];
    if (!f) { loc.apagar("arqId"); return null; }
    loc.gravar("arqId", f.id);
    const r = info(f); r.total = lista.length;
    return r;
    function info(x) {
      const o = (x.owners || [])[0] || {};
      return { id: x.id, dono: o.displayName || o.emailAddress || "", meu: !!x.ownedByMe };
    }
  },
  async criar(obj) {
    const texto = JSON.stringify(obj);
    if (DEMO) { loc.gravar("demoArq", texto); return "demo"; }
    const pasta = (await (await api(API + "/files?fields=id", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: CFG.NOME_PASTA, mimeType: "application/vnd.google-apps.folder" })
    })).json()).id;
    const m = multipart({ name: CFG.NOME_ARQUIVO, parents: [pasta], mimeType: "application/json" }, texto);
    const id = (await (await api(UPLOAD + "/files?uploadType=multipart&fields=id", { method: "POST", headers: { "Content-Type": m.tipo }, body: m.corpo })).json()).id;
    loc.gravar("arqId", id);
    return id;
  },
  async baixar(id) {
    if (DEMO) return JSON.parse(loc.ler("demoArq", "{}"));
    const t = await (await api(API + "/files/" + id + "?alt=media")).text();
    return t.trim() ? JSON.parse(t) : {};
  },
  async subir(id, obj) {
    const texto = JSON.stringify(obj);
    if (DEMO) { loc.gravar("demoArq", texto); return; }
    await api(UPLOAD + "/files/" + id + "?uploadType=media", { method: "PATCH", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: texto });
  },
  // dá acesso de edição ao e-mail (o Google manda um aviso por e-mail para a pessoa)
  async compartilhar(id, email) {
    if (DEMO) return;
    await api(API + "/files/" + id + "/permissions?sendNotificationEmail=true&fields=id", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "writer", type: "user", emailAddress: email })
    });
  },
  async quemSou() {
    if (DEMO) return "demonstração";
    const j = await (await api(API + "/about?fields=user(displayName,emailAddress)")).json();
    const e = (j.user && j.user.emailAddress) || "";
    if (e) loc.gravar("email", e);
    return e;
  }
};

window.FIN = { CFG, DEMO, loc, $, toast, esc, token, configurado, entrar, sair, lerRetornoLogin, SemLogin, drive };
})();

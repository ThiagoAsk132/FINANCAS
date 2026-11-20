// FINANÇAS DA CASA — telas, cálculos e sincronização.
// Dados: um mapa de registros {id: {...}} guardado no aparelho e num arquivo JSON do Google Drive.
// Cada registro tem "upd" (hora da última mudança); na sincronização vale o mais novo de cada registro,
// e excluir grava uma marca {del:true}. Assim o que os dois lançam ao mesmo tempo se junta sem perder nada.
// Valores sempre em centavos (inteiros).
(() => {
"use strict";
const { loc, $, toast, esc, drive, SemLogin } = window.FIN;

// ---------- formatação e datas ----------
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const R = c => BRL.format((c || 0) / 100);
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const p2 = n => String(n).padStart(2, "0");
const hojeISO = () => { const d = new Date(); return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()); };
const mesAtual = () => hojeISO().slice(0, 7);
const mesDe = iso => String(iso || "").slice(0, 7);
function addMes(k, n) { let [y, m] = k.split("-").map(Number); m += n; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1; return y + "-" + p2(m); }
const entreMeses = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5) - +a.slice(5));
const nomeMes = k => MESES[+k.slice(5) - 1] + " " + k.slice(0, 4);
const soMes = k => MESES[+k.slice(5) - 1];
const curtoMes = k => MESES[+k.slice(5) - 1].slice(0, 3) + "/" + k.slice(2, 4);
const diasNoMes = k => new Date(+k.slice(0, 4), +k.slice(5), 0).getDate();
const dataBR = iso => iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) : "";
const dataBRano = iso => iso ? dataBR(iso) + "/" + iso.slice(0, 4) : "";
function centavos(s) {
  s = String(s ?? "").trim().replace(/[R$\s]/g, "");
  if (!s) return 0;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return isFinite(n) ? Math.round(n * 100) : NaN;
}
// dias úteis: seg–sex fora dos feriados nacionais (fixos + Sexta-feira Santa). Feriados municipais não entram.
function pascoa(y) { const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1; return new Date(y, mes - 1, dia); }
function feriado(dt) {
  const md = p2(dt.getMonth() + 1) + "-" + p2(dt.getDate());
  if (["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "11-20", "12-25"].includes(md)) return true;
  const sexta = pascoa(dt.getFullYear()); sexta.setDate(sexta.getDate() - 2);
  return sexta.getMonth() === dt.getMonth() && sexta.getDate() === dt.getDate();
}
function diaUtil(mes, n) {
  let c = 0;
  for (let d = 1; d <= diasNoMes(mes); d++) { const dt = new Date(+mes.slice(0, 4), +mes.slice(5) - 1, d), w = dt.getDay(); if (w && w !== 6 && !feriado(dt) && ++c === n) return d; }
  return diasNoMes(mes);
}
const quandoRenda = (r, m) => r.util ? `${r.dia}º dia útil (${p2(diaUtil(m, r.dia))}/${m.slice(5)})` : "dia " + (r.dia || 1);
const valorCampo = c => c ? (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
const pct = (a, b) => b > 0 ? Math.round(a / b * 100) : 0;

const CATS = ["Moradia", "Contas da casa", "Mercado", "Transporte", "Saúde", "Educação", "Filhos", "Dívidas e empréstimos",
  "Lazer", "Restaurante", "Delivery", "Assinaturas", "Vestuário e cuidados", "Pets", "Presentes", "Outros"];
const NECESSIDADE = new Set(CATS.slice(0, 8));
const FORMAS = { pix: "Pix", debito: "Débito", credito: "Crédito" };

// ---------- registros ----------
let reg = loc.ler("reg", {});
const eu = () => loc.ler("eu", "a");
const vivo = r => r && !r.del;
const todos = tipo => Object.values(reg).filter(r => r.tipo === tipo && !r.del);
const novoId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function gravar(rec, semRender) {
  rec.upd = Date.now(); rec.por = eu();
  reg[rec.id] = rec;
  if (!loc.gravar("reg", reg)) toast("O aparelho está sem espaço para guardar.");
  agendarSync();
  if (!semRender) render();
}
function apagar(id) { const r = reg[id]; if (r) gravar({ id, tipo: r.tipo, del: true }); }

const CFG0 = { pessoas: { a: "Thiago", b: "Esposa" }, meta: { modo: "pct", pct: 20, valor: 0 }, limites: {}, reservaIni: 0 };
function cfg() {
  const c = vivo(reg.config) ? reg.config : {};
  return { ...CFG0, ...c, pessoas: { ...CFG0.pessoas, ...(c.pessoas || {}) }, meta: { ...CFG0.meta, ...(c.meta || {}) }, limites: { ...(c.limites || {}) } };
}
function salvarCfg(patch, semRender) { gravar({ ...cfg(), ...patch, id: "config", tipo: "config" }, semRender); }
const nomeP = k => cfg().pessoas[k] || (k === "a" ? "Pessoa 1" : "Pessoa 2");

// valor de uma renda/conta fixa num mês (histórico de reajustes em "valores")
function valorEm(rec, m) { let v = 0; for (const x of rec.valores || []) if (x.ini <= m) v = x.v; return v; }
const ativo = (rec, m) => (rec.ini || "0000-00") <= m && (!rec.fim || m <= rec.fim);
const cartoes = () => Object.fromEntries(todos("cartao").map(c => [c.id, c]));
const nomeCartao = id => (vivo(reg[id]) ? reg[id].nome : "Cartão excluído");

// mês em que a fatura com essa compra vence (é o mês em que o dinheiro sai)
function vencMes(dataISO, cartao) {
  const d = +dataISO.slice(8, 10), F = (cartao && cartao.fech) || 1, V = (cartao && cartao.venc) || 10;
  let M = mesDe(dataISO);
  if (d >= F) M = addMes(M, 1);           // comprou no dia do fechamento ou depois: fatura seguinte
  return V > F ? M : addMes(M, 1);
}
function vencData(mes, cartao) { const V = (cartao && cartao.venc) || 10; return mes + "-" + p2(Math.min(V, diasNoMes(mes))); }

// tudo o que SAI da conta no mês m (Pix/débito pagos no mês + faturas que vencem no mês)
function itensMes(m) {
  const out = [], cs = cartoes();
  for (const f of todos("fixa")) {
    if (f.forma !== "credito") {
      if (!ativo(f, m)) continue;
      const ch = "fm|" + f.id + "|" + m, o = vivo(reg[ch]) ? reg[ch] : null;
      out.push({ k: "fixa", forma: "pix", rec: f, desc: f.desc, cat: f.cat, valor: o && o.valor != null ? o.valor : valorEm(f, m), est: !!f.varia && !(o && o.valor != null), pago: !!(o && o.pago), dia: f.dia || 0, mesRef: m, data: m + "-" + p2(Math.min(f.dia || 31, diasNoMes(m))) });
    } else {
      for (const c of [addMes(m, -2), addMes(m, -1), m]) {
        if (!ativo(f, c)) continue;
        const data = c + "-" + p2(Math.min(f.dia || 1, diasNoMes(c)));
        if (vencMes(data, cs[f.cartao]) !== m) continue;
        const ch = "fm|" + f.id + "|" + c, o = vivo(reg[ch]) ? reg[ch] : null;
        out.push({ k: "fixa", forma: "credito", cartao: f.cartao, rec: f, desc: f.desc, cat: f.cat, valor: o && o.valor != null ? o.valor : valorEm(f, c), est: !!f.varia && !(o && o.valor != null), data, mesRef: c });
      }
    }
  }
  for (const g of todos("gasto")) {
    if (g.forma !== "credito") { if (mesDe(g.data) === m) out.push({ k: "gasto", forma: g.forma || "pix", rec: g, desc: g.desc, cat: g.cat, valor: g.valor, data: g.data }); continue; }
    const n = Math.max(1, g.parc || 1), i = entreMeses(vencMes(g.data, cs[g.cartao]), m);
    if (i < 0 || i >= n) continue;
    const base = Math.floor(g.valor / n);
    out.push({ k: "gasto", forma: "credito", cartao: g.cartao, rec: g, desc: g.desc, cat: g.cat, valor: i === 0 ? g.valor - base * (n - 1) : base, data: g.data, parcela: n > 1 ? (i + 1) + "/" + n : "" });
  }
  return out;
}
function entradasMes(m) {
  const out = [];
  for (const r of todos("renda")) {
    if (!ativo(r, m)) continue;
    const ch = "rm|" + r.id + "|" + m, o = vivo(reg[ch]) ? reg[ch] : null;
    out.push({ k: "renda", rec: r, desc: r.desc, valor: o && o.valor != null ? o.valor : valorEm(r, m), pessoa: r.pessoa, dia: r.dia || 1, ajustado: !!(o && o.valor != null) });
  }
  for (const e of todos("entrada")) if (mesDe(e.data) === m) out.push({ k: "entrada", rec: e, desc: e.desc, valor: e.valor, pessoa: e.pessoa, data: e.data });
  return out;
}
const soma = a => a.reduce((s, x) => s + (x.valor || 0), 0);
function metaDe(ent) { const c = cfg().meta; return c.modo === "valor" ? (c.valor || 0) : Math.round(ent * (c.pct || 0) / 100); }
function resumo(m) {
  const its = itensMes(m), ents = entradasMes(m), ent = soma(ents);
  const pixFix = soma(its.filter(i => i.forma !== "credito" && i.k === "fixa"));
  const pixVar = soma(its.filter(i => i.forma !== "credito" && i.k === "gasto"));
  const fat = soma(its.filter(i => i.forma === "credito"));
  const meta = metaDe(ent);
  // a meta NÃO sai do "pode gastar": só o que foi guardado de fato no mês (Mês › Guardar) é descontado
  const g = reg["gd|" + m], guard = vivo(g) ? (g.valor || 0) : 0;
  // mercado: o que ainda falta comprar no mês (média dos últimos meses − o já comprado) fica reservado
  const merc = mercadoMes(m), reservaMerc = merc ? merc.falta : 0;
  return { its, ents, ent, pixFix, pixVar, fat, meta, guard, merc, reservaMerc, livre: ent - pixFix - pixVar - fat - guard - reservaMerc };
}
// ---------- envelope do mercado ----------
// Previsto = média das compras de mercado (categoria Mercado, qualquer forma, pela data da compra) nos últimos
// 3 meses já fechados que têm compra. "Já compramos" = compras de mercado com data no mês.
// Se o mercado ainda está como conta fixa naquele mês, não tem envelope (a fixa já desconta).
const MERC_DESDE = "2026-12";
const ehMerc = c => (c || "") === "Mercado";
function mercadoGasto(m) { return todos("gasto").filter(g => ehMerc(g.cat) && g.data && mesDe(g.data) === m).reduce((s, g) => s + (g.valor || 0), 0); }
function mercadoMes(m) {
  if (todos("fixa").some(f => ehMerc(f.cat) && ativo(f, m))) return null;
  const base = m < mesAtual() ? m : mesAtual(), meses = [];
  // só conta a partir de dez/2026 (antes o mercado não era todo registrado) e só liga com 3 meses completos
  for (let i = 1; i <= 12 && meses.length < 3; i++) { const k = addMes(base, -i); if (k < MERC_DESDE) break; const v = mercadoGasto(k); if (v > 0) meses.push({ k, v }); }
  if (meses.length < 3) return null;
  const prev = Math.round(meses.reduce((s, x) => s + x.v, 0) / meses.length), gasto = mercadoGasto(m);
  return { prev, gasto, falta: m < mesAtual() ? 0 : Math.max(0, prev - gasto), meses };
}
// média mensal dos gastos variáveis (não fixos) nos últimos 3 meses fechados que têm lançamentos
function mediaVariavel(m0) {
  const tot = [], porCat = {};
  for (let i = 1; i <= 3; i++) {
    const its = itensMes(addMes(m0, -i)).filter(x => x.k === "gasto");
    if (!its.length) continue;
    tot.push(soma(its));
    for (const x of its) porCat[x.cat || "Outros"] = (porCat[x.cat || "Outros"] || 0) + x.valor;
  }
  if (!tot.length) return null;
  for (const k in porCat) porCat[k] = Math.round(porCat[k] / tot.length);
  return { media: Math.round(tot.reduce((a, b) => a + b, 0) / tot.length), meses: tot.length, porCat };
}
function guardadoTotal() { return (cfg().reservaIni || 0) + todos("guardado").reduce((s, g) => s + (g.valor || 0), 0); }

// ---------- divisão das contas pela renda ----------
// dono do cartão: campo "dono" ou, se não tiver, o nome da pessoa escrito no nome do cartão
function donoCartao(id) {
  const k = reg[id]; if (!vivo(k)) return "";
  if (k.dono) return k.dono;
  const n = (k.nome || "").toLowerCase();
  return ["a", "b"].find(p => n.includes(nomeP(p).toLowerCase())) || "";
}
// quem tira o dinheiro do bolso: cartão = dono do cartão; Pix/débito avulso = quem lançou; fixa no Pix = campo "pagador"
function pagadorDe(i) {
  if (i.forma === "credito") return donoCartao(i.cartao);
  if (i.k === "gasto") return i.rec.pessoa || "";
  return i.rec.pagador || "";
}
function divisao(m) {
  const r = resumo(m), renda = { a: 0, b: 0 };
  for (const e of r.ents) if (renda[e.pessoa] != null) renda[e.pessoa] += e.valor;
  const tot = renda.a + renda.b, pct = { a: tot ? renda.a / tot : 0.5, b: tot ? renda.b / tot : 0.5 };
  let casal = 0; const so = { a: 0, b: 0 }, pagou = { a: 0, b: 0 }, semPag = [], itensSo = { a: [], b: [] };
  for (const i of r.its) {
    const rat = i.rec.rateio === "a" || i.rec.rateio === "b" ? i.rec.rateio : "casal";
    if (rat === "casal") casal += i.valor; else { so[rat] += i.valor; itensSo[rat].push(i); }
    const p = pagadorDe(i);
    if (p === "a" || p === "b") pagou[p] += i.valor; else semPag.push(i);
  }
  const parteA = Math.round(casal * pct.a), parte = { a: parteA, b: casal - parteA };
  const deve = { a: parte.a + so.a, b: parte.b + so.b };
  return { r, renda, tot, pct, casal, parte, so, itensSo, deve, pagou, semPag, sobra: { a: renda.a - deve.a, b: renda.b - deve.b } };
}
function telaDivisao() {
  const m = mesSel, d = divisao(m), A = nomeP("a"), B = nomeP("b");
  let h = mesbar(m);
  if (!d.tot) return h + `<div class="card"><span class="empty">Cadastre as rendas de cada um na aba Fixas para o app dividir as contas.</span></div>`;
  const pc = p => Math.round(d.pct[p] * 100);
  h += `<section class="hero"><span class="label">Quem ganha quanto em ${soMes(m)}</span>
    <div class="stack" style="height:16px;margin-top:6px"><span style="width:${(d.pct.a * 100).toFixed(2)}%;background:var(--c1)"></span><span style="width:${(d.pct.b * 100).toFixed(2)}%;background:var(--c5)"></span></div>
    <div class="legend"><span><i style="background:var(--c1)"></i>${esc(A)} ${pc("a")}% · ${R0(d.renda.a)}</span><span><i style="background:var(--c5)"></i>${esc(B)} ${pc("b")}% · ${R0(d.renda.b)}</span></div>
    <span class="small muted">As contas da casa (${R(d.casal)} neste mês) são divididas nessa mesma proporção: quem ganha mais paga uma parte maior.</span></section>`;
  const cartaoPessoa = p => `<div class="card divp"><h3>${esc(nomeP(p))} <small class="muted">${pc(p)}%</small></h3><ul class="list num">
      <li><span>Renda do mês</span><b class="pos">${R(d.renda[p])}</b></li>
      <li><span>Parte das contas da casa (${pc(p)}%)</span><b>${R(d.parte[p])}</b></li>
      ${d.so[p] ? `<li><span>Gastos só ${p === "a" ? "dele" : "dela"}</span><b>${R(d.so[p])}</b></li>` : ""}
      <li class="tot"><span>Tem que pagar</span><b>${R(d.deve[p])}</b></li>
      <li class="tot"><span>Sobra para ${p === "a" ? "ele" : "ela"}</span><b class="${d.sobra[p] < 0 ? "neg" : "pos"}">${d.sobra[p] < 0 ? "−" : ""}${R(Math.abs(d.sobra[p]))}</b></li></ul></div>`;
  h += `<section><h2>Quanto cada um paga e quanto sobra</h2><div class="divgrid">${cartaoPessoa("a")}${cartaoPessoa("b")}</div></section>`;

  // acerto: o que cada um já tira do bolso x a parte de cada um
  const dif = d.pagou.a - d.deve.a;   // > 0: a pessoa A paga mais do que a parte dela
  h += `<section><h2>Acerto entre vocês</h2><div class="card">
    <ul class="list num"><li><span>${esc(A)} já paga (Pix dele, cartões dele)</span><b>${R(d.pagou.a)}</b></li><li><span>${esc(B)} já paga (Pix dela, cartões dela)</span><b>${R(d.pagou.b)}</b></li></ul>`;
  if (d.semPag.length) {
    h += `<div class="alert"><strong>Falta dizer quem paga ${d.semPag.length === 1 ? "esta conta" : "estas contas"}</strong><span class="small">Sem isso o acerto fica incompleto (${R(soma(d.semPag))} sem dono).</span><ul class="list">` +
      d.semPag.map(i => `<li class="dupl"><div class="li-main"><span>${esc(i.desc)}</span><small>${R(i.valor)}</small></div><span class="row" style="gap:6px;flex:none"><button type="button" class="btn small" data-act="pagador" data-id="${i.rec.id}" data-p="a">${esc(A)}</button><button type="button" class="btn small" data-act="pagador" data-id="${i.rec.id}" data-p="b">${esc(B)}</button></span></li>`).join("") + `</ul></div>`;
  }
  const quem = dif > 0 ? B : A, pra = dif > 0 ? A : B, v = Math.abs(dif), lado = dif > 0 ? "a" : "b";
  h += d.semPag.length ? `<div class="acerto"><span class="small muted">Toque em quem paga cada conta acima para o app calcular quanto um tem que passar para o outro.</span></div>`
    : v < 100 ? `<div class="okcard">✓ Está equilibrado: cada um já paga a sua parte.</div>`
    : `<div class="acerto"><span class="label">Para ficar justo</span><div class="big num">${esc(quem)} passa ${R(v)} para ${esc(pra)}</div>
      <span class="small muted">${esc(pra)} paga hoje ${R(d.pagou[lado])}, mas a parte ${lado === "a" ? "dele" : "dela"} é ${R(d.deve[lado])}.</span></div>`;
  h += `</div></section>`;

  const so = [...d.itensSo.a.map(i => [i, "a"]), ...d.itensSo.b.map(i => [i, "b"])];
  h += `<details class="dobra"><summary><span>Gastos individuais (não divididos)</span><b class="num">${R(d.so.a + d.so.b)}</b></summary><ul class="list">` +
    (so.length ? so.map(([i, p]) => li(esc(i.desc), R(i.valor), { act: i.k === "fixa" ? `data-act="fixa-mes" data-id="${i.rec.id}" data-mes="${i.mesRef}"` : `data-act="edit" data-id="${i.rec.id}"`, sub: "só " + esc(nomeP(p)) + " · " + esc(i.cat || "") })).join("")
      : `<li><span class="small muted">Nenhum. Para marcar um gasto ou conta como só de um de vocês, abra o lançamento e mude "Dividir".</span></li>`) + `</ul></details>`;
  h += `<p class="small muted" style="padding:0 4px">Entram aqui todas as contas fixas, as faturas que vencem no mês e os gastos no Pix/débito. O dinheiro guardado não entra. Quem paga: o cartão conta para o dono do cartão; Pix e débito, para quem lançou.</p>`;
  return h;
}

// ---------- estado da tela ----------
let aba = "inicio";
let mesSel = mesAtual();
let sync = { s: "local", arq: null, email: loc.ler("email", "") };
let renderPendente = false;

const ICON_OK = "✓";
function li(main, val, opts = {}) {
  return `<li>${opts.pre || ""}<button type="button" class="li-main" ${opts.act || ""}><span class="t">${main}</span>${opts.sub ? `<small>${opts.sub}</small>` : ""}</button><span class="li-val num${opts.cls ? " " + opts.cls : ""}">${val}</span></li>`;
}

function render() {
  const ae = document.activeElement;
  if (ae && $("main").contains(ae) && /^(INPUT|SELECT)$/.test(ae.tagName)) { renderPendente = true; return; }
  renderPendente = false;
  const abaNav = SUB_MAIS.includes(aba) ? "mais" : aba;
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-current", b.dataset.tab === abaNav ? "page" : "false"));
  $("fab").hidden = !(aba === "inicio" || aba === "mes" || aba === "fixas");
  const tela = { inicio: telaInicio, mes: telaMes, mais: telaMais, graficos: telaGraficos, divisao: telaDivisao, fixas: telaFixas, planejar: telaPlanejar, ajustes: telaAjustes }[aba] || telaInicio;
  const html = (SUB_MAIS.includes(aba) ? voltarMais() : "") + tela();
  $("main").innerHTML = html;
  renderSync();
}
document.addEventListener("focusout", () => setTimeout(() => { if (renderPendente) render(); }, 0));


// ---------- aba Início (versão simples: entrou, gastamos, sobra, guardar) ----------
const SUB_MAIS = ["graficos", "fixas", "planejar", "ajustes"];
function telaInicio() {
  const m = mesSel, r = resumo(m), sai = r.pixFix + r.pixVar + r.fat, sobra = r.livre;
  let h = avisoArquivo() + avisoDuplicados() + mesbar(m);
  if (!r.ent) return h + `<div class="card"><b>Falta cadastrar os salários</b><span class="small muted">Sem o quanto entra, o app não consegue dizer quanto dá para gastar.</span><button type="button" class="btn primary" data-act="ir-aba" data-tab="fixas">Cadastrar salários</button></div>`;
  const pg = Math.min(100, Math.round(sai / r.ent * 100));
  h += `<section class="simples num">
    <div class="srow"><span class="sic">💵</span><div class="st"><b>Entrou</b><small>salários e outras entradas</small></div><b class="sv pos">${R0(r.ent)}</b></div>
    <div class="srow"><span class="sic">🛒</span><div class="st"><b>Gastamos</b><small>contas, cartão e compras do mês</small></div><b class="sv">${R0(sai)}</b></div>
    ${r.merc ? `<div class="srow"><span class="sic">🧺</span><div class="st"><b>${r.merc.falta ? "Mercado que ainda vamos comprar" : "Mercado do mês"}</b><small>média ${R0(r.merc.prev)} · já compramos ${R0(r.merc.gasto)}${r.merc.gasto > r.merc.prev ? ` · <span style="color:var(--danger);font-weight:600">passou ${R0(r.merc.gasto - r.merc.prev)} da média</span>` : ""}</small></div><b class="sv">${r.merc.falta ? R0(r.merc.falta) : "✓"}</b></div>` : ""}
    ${r.guard ? `<div class="srow"><span class="sic">🐷</span><div class="st"><b>Guardamos</b><small>já separado este mês</small></div><b class="sv pos">${R0(r.guard)}</b></div>` : ""}
    <div class="gbar" aria-hidden="true"><span style="width:${pg}%" class="${sai > r.ent ? "over" : ""}"></span></div>
    <span class="small muted">${sai > r.ent ? "Os gastos passaram do que entrou." : `Já foi ${pg}% do que entrou.`}${r.reservaMerc ? " O mercado que ainda falta comprar já está descontado abaixo." : ""}</span>
    <div class="sobra ${sobra < 0 ? "neg" : ""}"><span>${sobra < 0 ? "Gastamos a mais" : "Ainda dá para gastar ou guardar"}</span><b>${sobra < 0 ? "−" : ""}${R0(Math.abs(sobra))}</b>`;
  const ehAtual = m === mesAtual(), restam = ehAtual ? diasNoMes(m) - +hojeISO().slice(8, 10) + 1 : 0;
  if (ehAtual && sobra > 0) h += `<small>uns ${R0(Math.floor(sobra / restam))} por dia nos ${restam} dias que faltam</small>`;
  h += `</div></section>`;

  // ----- quanto dá para guardar (a meta é referência; não sai do "dá para gastar")
  const falta = Math.max(0, r.meta - r.guard);
  let txt;
  if (r.meta && r.guard >= r.meta) txt = `✓ Vocês já guardaram ${R0(r.guard)}: a meta do mês está cumprida.`;
  else if (sobra <= 0) txt = `Este mês não sobrou para guardar. Para voltar ao azul, seria preciso gastar ${R0(-sobra)} a menos.`;
  else if (!r.meta) txt = `Tudo o que sobrar (${R0(sobra)}) pode ir para a poupança.`;
  else if (sobra >= falta) txt = `Dá para guardar <b>${R0(falta)}</b> (a meta) e ainda sobram <b>${R0(sobra - falta)}</b> para gastar.`;
  else txt = `Dá para guardar até <b>${R0(sobra)}</b>. Para chegar na meta de ${R0(r.meta)}, precisariam gastar ${R0(falta - sobra)} a menos.`;
  const gd = vivo(reg["gd|" + m]) ? reg["gd|" + m].valor : null;
  h += `<section><h2>Quanto podemos guardar <small class="num">meta ${R0(r.meta)}</small></h2><div class="card"><span>${txt}</span>
    <label class="field"><span class="label">Quanto guardaram de verdade em ${soMes(m)}</span><input inputmode="decimal" data-chg="guardado" data-mes="${m}" placeholder="R$ 0,00" value="${gd != null ? valorCampo(gd) : ""}"></label></div></section>`;

  // ----- falta pagar
  const hoje = hojeISO(), cs = cartoes();
  const contas = r.its.filter(i => i.forma !== "credito" && i.k === "fixa" && !i.pago).sort((a, b) => (a.dia || 99) - (b.dia || 99));
  const porCartao = {};
  for (const i of r.its.filter(i => i.forma === "credito")) (porCartao[i.cartao] ||= []).push(i);
  const fats = Object.entries(porCartao).filter(([cid]) => { const o = reg["fp|" + cid + "|" + m]; return !(vivo(o) && o.pago); });
  const totFalta = soma(contas) + fats.reduce((s, [, its]) => s + soma(its), 0);
  h += `<section><h2>Falta pagar <small class="num">${totFalta ? R0(totFalta) : ""}</small></h2>`;
  if (!contas.length && !fats.length) h += `<div class="card okcard"><b>✓ Tudo pago neste mês.</b></div>`;
  else {
    h += `<div class="card flat"><ul class="list">`;
    for (const i of contas) h += linhaFixaPix(i, m, hoje);
    for (const [cid, its] of fats) {
      const vd = vencData(m, cs[cid]), atr = vd < hoje;
      h += li("Fatura " + esc(nomeCartao(cid)), R(soma(its)), { pre: `<button type="button" class="chk" data-act="fatura-paga" data-id="${cid}" data-mes="${m}" aria-pressed="false" aria-label="Marcar fatura como paga: ${esc(nomeCartao(cid))}">${ICON_OK}</button>`, act: `data-act="ir-aba" data-tab="mes"`, sub: atr ? `<span style="color:var(--danger);font-weight:600">venceu ${dataBR(vd)}</span>` : "vence " + dataBR(vd) });
    }
    h += `</ul><span class="small muted">Toque no círculo quando pagar.</span></div>`;
  }
  h += `</section>`;

  // ----- onde foi o dinheiro (as 5 maiores categorias)
  const porCat = {};
  for (const i of r.its) porCat[i.cat || "Outros"] = (porCat[i.cat || "Outros"] || 0) + i.valor;
  const cats = Object.entries(porCat).sort((a, b) => b[1] - a[1]), top = cats.slice(0, 5), resto = cats.slice(5).reduce((s, [, v]) => s + v, 0);
  if (resto) top.push(["Outras coisas", resto]);
  if (top.length) {
    const max = top[0][1];
    h += `<section><h2>Onde foi o dinheiro</h2><div class="card">` + top.map(([c, v]) => `<div class="catrow num"><span>${esc(c)}</span><b>${R0(v)}</b><div class="bar"><span style="width:${(v / max * 100).toFixed(1)}%"></span></div></div>`).join("") +
      `<button type="button" class="btn" data-act="ir-aba" data-tab="mes">Ver cada gasto</button></div></section>`;
  }

  // ----- mês que vem
  const prox = addMes(m, 1), r2 = resumo(prox), comp = r2.pixFix + r2.pixVar + r2.fat;
  if (comp) h += `<button type="button" class="nextcard num" data-act="mes" data-d="1"><span>Em ${soMes(prox)} já tem <b>${R0(comp)}</b> de contas e parcelas marcadas.</span><span class="nv">›</span></button>`;
  return h;
}
function telaMais() {
  const it = (tab, ic, t, s) => `<button type="button" class="mais-it" data-act="ir-aba" data-tab="${tab}"><span class="sic">${ic}</span><span class="st"><b>${t}</b><small>${s}</small></span><span class="muted">›</span></button>`;
  return `<section class="card flat mais">${it("graficos", "📊", "Gráficos", "gastos por categoria e por mês")}${it("fixas", "📋", "Contas fixas e salários", "aluguel, luz, escola, rendas")}${it("planejar", "🎯", "Planejar", "meta de guardar e limites")}${it("ajustes", "⚙️", "Ajustes", "nomes, cartões, Google, cópia")}</section>`;
}
const voltarMais = () => `<button type="button" class="voltar" data-act="ir-aba" data-tab="mais">‹ Mais</button>`;

// ---------- aba Mês ----------
function avisoArquivo() {
  if (sync.s === "semArquivo") return `<div class="alert info"><strong>Conectado ao Google, falta o arquivo da casa</strong>
    <span class="small">Se você é o primeiro a usar, crie o arquivo. Se seu marido/esposa já criou, peça para compartilhar com você (Ajustes › Compartilhar) e toque em Procurar.</span>
    <div class="row"><button class="btn primary" data-act="criar-arq">Criar arquivo da casa</button><button class="btn" data-act="sync">Procurar de novo</button></div></div>`;
  return "";
}
const mesbar = m => `<div class="mesbar"><button class="icon" data-act="mes" data-d="-1" aria-label="Mês anterior">‹</button><strong>${nomeMes(m)}</strong><button class="icon" data-act="mes" data-d="1" aria-label="Próximo mês">›</button></div>`;
const R0 = c => "R$ " + Math.round((c || 0) / 100).toLocaleString("pt-BR");
const Maius = s => s.replace(/^./, x => x.toUpperCase());

function linhaFixaPix(i, m, hoje) {
  const atrasada = !i.pago && i.dia && i.data < hoje;
  return li(esc(i.desc), (i.est ? "≈ " : "") + R(i.valor), {
    pre: `<button type="button" class="chk${i.pago ? " on" : ""}" data-act="pago" data-id="${i.rec.id}" data-mes="${m}" aria-label="${i.pago ? "Marcar como não paga" : "Marcar como paga"}: ${esc(i.desc)}" aria-pressed="${i.pago}">${ICON_OK}</button>`,
    act: `data-act="fixa-mes" data-id="${i.rec.id}" data-mes="${m}"`,
    sub: (!i.dia ? "sem vencimento" : atrasada ? `<span style="color:var(--danger);font-weight:600">venceu dia ${i.dia}</span>` : "vence dia " + i.dia) + " · " + (i.est ? `<span style="color:var(--warn);font-weight:600">valor estimado, toque para pôr o real</span>` : esc(i.cat || ""))
  });
}

// ---------- lançamentos duplicados ----------
// mesmo valor, datas até 3 dias de diferença (o banco às vezes registra o débito dias depois),
// mesma forma de pagamento (Pix e débito contam como iguais; no crédito, o mesmo cartão).
// Não acusa dois itens vindos do mesmo extrato/fatura (cada linha do banco é uma compra diferente).
const IMPORTADO = /^(ofx-|bbc-|nut-|nu20|nc-)/;
const diasISO = d => Math.round(new Date(d + "T12:00").getTime() / 864e5);
const origemDe = x => IMPORTADO.test(x.id) ? (x.conta || x.cartao || "importado") : "";
const parDup = (a, b) => "dok|" + [a, b].sort().join("|");
function duplicados() {
  const porValor = {};
  for (const g of todos("gasto")) if (g.valor > 0 && g.data) (porValor[g.valor] = porValor[g.valor] || []).push(g);
  const pares = [];
  for (const lista of Object.values(porValor)) {
    if (lista.length < 2) continue;
    for (let i = 0; i < lista.length; i++) for (let j = i + 1; j < lista.length; j++) {
      const a = lista[i], b = lista[j];
      if (Math.abs(diasISO(a.data) - diasISO(b.data)) > 3) continue;
      const credA = a.forma === "credito", credB = b.forma === "credito";
      if (credA !== credB || (credA && a.cartao !== b.cartao)) continue;
      const oa = origemDe(a), ob = origemDe(b);
      if (oa && ob && oa === ob) continue;
      if (vivo(reg[parDup(a.id, b.id)])) continue;   // já disseram que não é duplicado
      // sugestão: manter o que veio do extrato/fatura; apagar o lançado à mão (ou o mais novo)
      const [fica, sai] = oa && !ob ? [a, b] : ob && !oa ? [b, a] : (a.upd || 0) <= (b.upd || 0) ? [a, b] : [b, a];
      pares.push({ fica, sai });
    }
  }
  return pares;
}
function avisoDuplicados() {
  const pares = duplicados();
  if (!pares.length) return "";
  const linha = (x, sugerido) => `<li class="dupl"><div class="li-main"><span>${esc(x.desc)}</span><small>${dataBRano(x.data)} · ${x.forma === "credito" ? esc(nomeCartao(x.cartao)) : (FORMAS[x.forma] || "Pix") + (x.conta ? " · " + esc(x.conta) : "")} · ${esc(nomeP(x.pessoa))}${IMPORTADO.test(x.id) ? " · do extrato/fatura" : x.origem === "comprovante" ? " · do comprovante" : " · lançado à mão"}</small></div>
    <button type="button" class="btn small${sugerido ? " danger" : ""}" data-act="dup-apagar" data-id="${x.id}">Apagar este</button></li>`;
  let h = `<section><div class="alert warn"><strong>⚠ ${pares.length === 1 ? "Parece que tem um lançamento duplicado" : `Parece que tem ${pares.length} lançamentos duplicados`}</strong>
    <span class="small">Mesmo valor, mesma forma de pagamento e datas próximas. Posso apagar a cópia? O botão vermelho é o que eu sugiro apagar.</span>`;
  for (const { fica, sai } of pares.slice(0, 10)) {
    h += `<div class="card dupcard"><div class="duptop"><b class="num">${R(fica.valor)}</b><button type="button" class="btn small" data-act="dup-ok" data-a="${fica.id}" data-b="${sai.id}">Não é duplicado</button></div>
      <ul class="list">${linha(sai, true)}${linha(fica, false)}</ul></div>`;
  }
  if (pares.length > 10) h += `<span class="small">E mais ${pares.length - 10}. Resolva estes primeiro.</span>`;
  return h + `</div></section>`;
}

function telaMes() {
  const m = mesSel, r = resumo(m), c = cfg();
  const vazio = !todos("renda").length && !todos("fixa").length && !todos("gasto").length;
  let h = avisoArquivo() + avisoDuplicados() + mesbar(m);
  if (vazio) h += `<div class="alert info"><strong>Primeiros passos</strong><ol class="steps small">
    <li>Em <b>Ajustes</b>: os nomes de vocês e os cartões de crédito (dia do fechamento e do vencimento).</li>
    <li>Em <b>Fixas</b>: as rendas (salários) e todas as contas fixas, dizendo se cada uma é paga no Pix ou no crédito.</li>
    <li>Em <b>Planejar</b>: quanto querem guardar por mês.</li>
    <li>No dia a dia: <b>+ Lançar</b> cada gasto que não é fixo.</li></ol></div>`;

  const sai0 = r.pixFix + r.pixVar + r.fat;
  h += `<div class="card"><span>Entrou <b class="pos num">${R(r.ent)}</b> · gastamos <b class="num">${R(sai0)}</b></span><span class="small muted">Aqui está cada conta, fatura e compra do mês. O resumo fica na aba Início.</span></div>`;
  // ----- contas fixas no Pix
  const hoje = hojeISO();
  const fixPix = r.its.filter(i => i.forma !== "credito" && i.k === "fixa").sort((a, b) => (a.dia || 99) - (b.dia || 99));
  const abertas = fixPix.filter(i => !i.pago), pagas = fixPix.filter(i => i.pago);
  if (fixPix.length) {
    h += `<section><h2>Contas no Pix <small class="num">${abertas.length ? "falta pagar " + R(soma(abertas)) : "tudo pago"}</small></h2>`;
    if (abertas.length) { h += `<div class="card flat"><ul class="list">`; for (const i of abertas) h += linhaFixaPix(i, m, hoje); h += `</ul></div>`; }
    else h += `<div class="card okcard"><b>✓ Todas as ${fixPix.length} contas do mês estão pagas.</b></div>`;
    if (pagas.length) {
      h += `<details class="card flat dobra"><summary><span>Já pagas (${pagas.length})</span><b class="num">${R(soma(pagas))}</b></summary><ul class="list">`;
      for (const i of pagas) h += linhaFixaPix(i, m, hoje);
      h += `</ul></details>`;
    }
    h += `</section>`;
  }

  // ----- faturas
  const cred = r.its.filter(i => i.forma === "credito"), porCartao = {};
  for (const i of cred) (porCartao[i.cartao] ||= []).push(i);
  const fpaga = cid => { const o = reg["fp|" + cid + "|" + m]; return !!(vivo(o) && o.pago); };
  const fAbertas = Object.entries(porCartao).filter(([cid]) => !fpaga(cid));
  h += `<section><h2>Faturas do cartão <small class="num">${!cred.length ? "" : fAbertas.length ? "falta pagar " + R(fAbertas.reduce((s, [, its]) => s + soma(its), 0)) : "tudo pago"}</small></h2>`;
  if (!cred.length) h += `<div class="card"><span class="empty">Nenhuma fatura vencendo em ${soMes(m)}.</span></div>`;
  const cs = cartoes();
  for (const [cid, its] of Object.entries(porCartao)) {
    its.sort((a, b) => a.data.localeCompare(b.data));
    const pg = fpaga(cid), vd = vencData(m, cs[cid]), atr = !pg && vd < hoje;
    h += `<details class="fatura${pg ? " paga" : ""}"><summary><button type="button" class="chk${pg ? " on" : ""}" data-act="fatura-paga" data-id="${cid}" data-mes="${m}" aria-pressed="${pg}" aria-label="${pg ? "Marcar fatura como não paga" : "Marcar fatura como paga"}: ${esc(nomeCartao(cid))}">${ICON_OK}</button><span style="flex:1;min-width:0"><b>${esc(nomeCartao(cid))}</b><br><span class="small muted">${pg ? "paga · " : atr ? `<span style="color:var(--danger);font-weight:600">venceu ${dataBR(vd)}</span> · ` : "vence " + dataBR(vd) + " · "}${its.length} ${its.length === 1 ? "item" : "itens"} · toque para ver</span></span><b class="num">${R(soma(its))}</b></summary><div class="in"><ul class="list">`;
    for (const i of its) {
      if (i.k === "fixa") h += li(esc(i.desc), (i.est ? "≈ " : "") + R(i.valor), { act: `data-act="fixa-mes" data-id="${i.rec.id}" data-mes="${i.mesRef}"`, sub: "conta fixa · cobra dia " + (i.rec.dia || 1) + " · " + esc(i.cat || "") });
      else h += li(esc(i.desc) + (i.parcela ? ` <span class="tag cred">${i.parcela}</span>` : ""), R(i.valor), { act: `data-act="edit" data-id="${i.rec.id}"`, sub: "compra " + dataBR(i.data) + " · " + esc(i.cat || "") + (i.parcela ? " · total " + R(i.rec.valor) : "") });
    }
    h += `</ul></div></details>`;
  }
  h += `</section>`;

  // ----- débito e Pix avulsos (do extrato da conta ou lançados à mão), separados por forma
  const varPix = r.its.filter(i => i.forma !== "credito" && i.k === "gasto").sort((a, b) => b.data.localeCompare(a.data));
  h += `<section><h2>Débito e Pix <small class="num">${R(r.pixVar)}</small></h2>`;
  if (!varPix.length) h += `<div class="card"><span class="empty">Nada no débito ou Pix avulso. Mande o extrato da conta (OFX) ou toque em <b>+ Lançar</b> a cada gasto.</span></div>`;
  for (const [forma, titulo] of [["debito", "Cartão de débito"], ["pix", "Pix avulsos"]]) {
    const its = varPix.filter(i => (i.forma === "debito") === (forma === "debito"));
    if (!its.length) continue;
    h += `<details class="card flat dobra"${forma === "debito" ? " open" : ""}><summary><span>${titulo} (${its.length})</span><b class="num">${R(soma(its))}</b></summary><ul class="list">`;
    for (const i of its) h += li(esc(i.desc), R(i.valor), { act: `data-act="edit" data-id="${i.rec.id}"`, sub: dataBR(i.data) + " · " + esc(i.cat || "") + (i.rec.conta ? " · " + esc(i.rec.conta) : "") + " · " + esc(nomeP(i.rec.pessoa)) });
    h += `</ul></details>`;
  }
  h += `</section>`;

  // ----- limites (só as categorias com teto)
  const porCat = {};
  for (const i of r.its) porCat[i.cat || "Outros"] = (porCat[i.cat || "Outros"] || 0) + i.valor;
  const lims = Object.entries(c.limites).filter(([, v]) => v > 0);
  if (lims.length) {
    h += `<section><h2>Limites do mês</h2><div class="card">`;
    for (const [cat, lim] of lims) {
      const v = porCat[cat] || 0, over = v > lim;
      h += `<div class="catrow num"><span>${esc(cat)}</span><span><b>${R(v)}</b> <span class="muted small">de ${R(lim)}</span></span><div class="bar"><span class="${over ? "over" : ""}" style="width:${Math.min(100, v / lim * 100).toFixed(1)}%"></span></div><span class="small muted" style="grid-column:1/-1">${over ? `<span style="color:var(--danger);font-weight:600">Passou ${R(v - lim)}</span>` : "Ainda pode " + R(lim - v)}</span></div>`;
    }
    h += `</div></section>`;
  }
  h += `<button type="button" class="btn" data-act="ir-aba" data-tab="graficos">Ver gráficos do mês</button>`;

  // ----- entradas (recolhidas)
  h += `<details class="card flat dobra"><summary><span>Entradas</span><b class="num pos">${R(r.ent)}</b></summary><ul class="list">`;
  if (!r.ents.length) h += `<li class="empty" style="display:block">Nenhuma renda neste mês.</li>`;
  for (const e of r.ents) {
    if (e.k === "renda") h += li(esc(e.desc), R(e.valor), { act: `data-act="renda-mes" data-id="${e.rec.id}"`, sub: esc(nomeP(e.pessoa)) + " · " + quandoRenda(e.rec, m) + (e.ajustado ? " · valor ajustado neste mês" : ""), cls: "pos" });
    else h += li(esc(e.desc), R(e.valor), { act: `data-act="edit" data-id="${e.rec.id}"`, sub: dataBR(e.data) + " · " + esc(nomeP(e.pessoa)) + " · entrada avulsa", cls: "pos" });
  }
  h += `</ul></details>`;

  return h;
}

// ---------- aba Gráficos ----------
// rosca em SVG: fatias = [{rot, v, cor}]; folga de 2px entre as fatias
function rosca(fatias, centroTopo, centroValor) {
  const tot = fatias.reduce((s, f) => s + Math.max(f.v, 0), 0);
  const Rr = 64, C = 2 * Math.PI * Rr, gap = fatias.filter(f => f.v > 0).length > 1 ? 3 : 0;
  let off = 0, arcos = "";
  for (const f of fatias) {
    if (!(f.v > 0) || !tot) continue;
    const len = f.v / tot * C;
    arcos += `<circle cx="80" cy="80" r="${Rr}" fill="none" stroke="${f.cor}" stroke-width="22" stroke-dasharray="${Math.max(len - gap, 0.5).toFixed(2)} ${(C - Math.max(len - gap, 0.5)).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 80 80)"><title>${esc(f.rot)}: ${R(f.v)} (${pct(f.v, tot)}%)</title></circle>`;
    off += len;
  }
  if (!tot) arcos = `<circle cx="80" cy="80" r="${Rr}" fill="none" stroke="var(--free)" stroke-width="22"/>`;
  const linha = f => `<i style="background:${f.cor}"></i><span class="t">${esc(f.rot)}${f.itens ? ` <small class="muted">(${f.n})</small>` : ""}</span><span class="p">${pct(f.v, tot)}%</span><b>${R(f.v)}</b>`;
  const leg = fatias.filter(f => f.v > 0).map(f => f.itens
    ? `<li class="abre"><details><summary>${linha(f)}</summary><ul class="list">${f.itens}</ul></details></li>`
    : `<li>${linha(f)}</li>`).join("");
  return `<div class="donut"><svg viewBox="0 0 160 160" role="img" aria-label="${esc(centroTopo)} ${R(centroValor)}">${arcos}
    <text x="80" y="74" text-anchor="middle" class="dt">${esc(centroTopo)}</text><text x="80" y="94" text-anchor="middle" class="dv">${R(centroValor).replace(/,\d\d$/, "")}</text></svg>
    <ul class="dleg num">${leg}</ul></div>`;
}

// barras empilhadas por mês: meses=[{rot, partes:[{rot,v,cor}], ref, nota, notaCor}]
function barras(meses, legenda) {
  const W = 340, H = 190, top = 14, base = 150, n = meses.length, bw = 30, passo = W / n;
  const max = Math.max(1, ...meses.map(m => Math.max(m.ref || 0, m.partes.reduce((s, p) => s + Math.max(p.v, 0), 0))));
  const y = v => base - v / max * (base - top);
  let g = `<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="var(--line)"/>`;
  meses.forEach((m, i) => {
    const x = i * passo + (passo - bw) / 2;
    let acc = 0;
    const vis = m.partes.filter(p => p.v > 0);
    vis.forEach((p, j) => {
      const y0 = y(acc), y1 = y(acc + p.v), hgt = Math.max(y0 - y1 - (j < vis.length - 1 ? 2 : 0), 0.5);
      const ult = j === vis.length - 1;
      g += ult ? `<path d="M${x} ${y1 + hgt}V${y1 + 4}a4 4 0 0 1 4 -4h${bw - 8}a4 4 0 0 1 4 4V${y1 + hgt}Z" fill="${p.cor}"><title>${m.rot} · ${esc(p.rot)}: ${R(p.v)}</title></path>`
        : `<rect x="${x}" y="${y1}" width="${bw}" height="${hgt}" fill="${p.cor}"><title>${m.rot} · ${esc(p.rot)}: ${R(p.v)}</title></rect>`;
      acc += p.v;
    });
    if (m.ref) g += `<line x1="${x - 5}" x2="${x + bw + 5}" y1="${y(m.ref)}" y2="${y(m.ref)}" stroke="var(--fg)" stroke-width="2" stroke-dasharray="3 2"><title>${m.rot} · renda ${R(m.ref)}</title></line>`;
    g += `<text x="${x + bw / 2}" y="${base + 16}" text-anchor="middle" class="bx">${m.rot}</text>`;
    if (m.nota) g += `<text x="${x + bw / 2}" y="${base + 32}" text-anchor="middle" class="bn" style="fill:${m.notaCor || "var(--fg)"}">${m.nota}</text>`;
  });
  const leg = legenda.map(l => `<span><i style="background:${l.cor}${l.tracejado ? ";height:3px;border-radius:0" : ""}"></i>${esc(l.rot)}</span>`).join("");
  return `<svg class="bars" viewBox="0 0 ${W} ${H}" role="img">${g}</svg><div class="legend">${leg}</div>`;
}
const mil = v => { const a = Math.abs(v) / 100; return (v < 0 ? "−" : "") + (a >= 1000 ? (a / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil" : Math.round(a)); };
const CORES_CAT = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)"];

function telaGraficos() {
  const m = mesSel, r = resumo(m);
  let h = mesbar(m);
  if (!r.ent && !r.its.length) return h + `<div class="card"><span class="empty">Sem dados neste mês ainda.</span></div>`;

  // 1. renda dividida
  const falta = r.livre < 0 ? -r.livre : 0;
  h += `<section><h2>Para onde vai a renda</h2><div class="card">${rosca([
    { rot: "Contas no Pix", v: r.pixFix, cor: "var(--pix)" },
    { rot: "Faturas do cartão", v: r.fat, cor: "var(--cred)" },
    { rot: "Débito e Pix avulsos", v: r.pixVar, cor: "var(--warn)" },
    { rot: "Guardado", v: r.guard, cor: "var(--save)" },
    { rot: "Mercado ainda a comprar", v: r.reservaMerc, cor: "var(--c4)" },
    { rot: "Livre para gastar", v: Math.max(r.livre, 0), cor: "var(--free)" }
  ], "Renda", r.ent)}
  ${falta ? `<span class="small" style="color:var(--danger);font-weight:600">Faltam ${R(falta)} para fechar o mês.</span>` : ""}</div></section>`;

  // 2. por categoria (todas as que têm lançamento)
  const porCat = {};
  for (const i of r.its) porCat[i.cat || "Outros"] = (porCat[i.cat || "Outros"] || 0) + i.valor;
  const cats = Object.entries(porCat).sort((a, b) => b[1] - a[1]);
  const cs0 = cartoes();
  const itemCat = (i, mostrarCat) => {
    const onde = i.forma === "credito" ? esc(nomeCartao(i.cartao)) + (i.parcela ? " · parc. " + i.parcela : "") : i.k === "fixa" ? "conta fixa Pix" : (FORMAS[i.forma] || "Pix");
    const quando = i.k === "fixa" && i.forma !== "credito" ? (i.dia ? "dia " + i.dia : "sem vencimento") : dataBR(i.data);
    const act = i.k === "fixa" ? `data-act="fixa-mes" data-id="${i.rec.id}" data-mes="${i.mesRef}"` : `data-act="edit" data-id="${i.rec.id}"`;
    return li(esc(i.desc), R(i.valor), { act, sub: quando + " · " + onde + (mostrarCat ? " · " + esc(i.cat || "Outros") : "") });
  };
  const itensDe = (lista, mostrarCat) => lista.sort((a, b) => b.valor - a.valor).map(i => itemCat(i, mostrarCat)).join("");
  // todas as categorias com lançamento aparecem; as 7 maiores têm cor própria, as menores ficam em cinza
  const fat = cats.map(([cat, v], i) => { const its = r.its.filter(x => (x.cat || "Outros") === cat); return { rot: cat, v, cor: i < 7 ? CORES_CAT[i] : "var(--muted)", n: its.length, itens: itensDe(its, false) }; });
  h += `<section><h2>Gastos por categoria</h2><div class="card">${rosca(fat, "Total", soma(r.its))}
    <span class="small muted">Toque numa categoria para ver os lançamentos dela. Contas fixas, faturas e gastos do mês, pela categoria de cada um.</span></div></section>`;

  // 3. próximos 6 meses
  const ms = [];
  for (let i = 0; i < 6; i++) {
    const k = addMes(m, i), x = resumo(k);
    ms.push({ rot: curtoMes(k).slice(0, 3), ref: x.ent, nota: mil(x.livre), notaCor: x.livre < 0 ? "var(--danger)" : "var(--save)",
      partes: [{ rot: "Contas Pix", v: x.pixFix + x.pixVar, cor: "var(--pix)" }, { rot: "Cartão", v: x.fat, cor: "var(--cred)" }, { rot: "Guardado", v: x.guard, cor: "var(--save)" }, { rot: "Mercado previsto", v: x.reservaMerc, cor: "var(--c4)" }] });
  }
  h += `<section><h2>Próximos 6 meses</h2><div class="card">${barras(ms, [{ rot: "Contas Pix", cor: "var(--pix)" }, { rot: "Cartão", cor: "var(--cred)" }, { rot: "Guardado", cor: "var(--save)" }, { rot: "Renda", cor: "var(--fg)", tracejado: true }])}
    <span class="small muted">A linha tracejada é a renda. O número embaixo de cada mês é quanto sobra livre (em reais). Barra acima da linha = mês no vermelho.</span></div></section>`;

  // 4. faturas por cartão
  const cs = todos("cartao").sort((a, b) => a.nome.localeCompare(b.nome));
  if (cs.length) {
    const fs = [];
    for (let i = 0; i < 6; i++) {
      const k = addMes(m, i), its = itensMes(k).filter(x => x.forma === "credito");
      fs.push({ rot: curtoMes(k).slice(0, 3), nota: mil(soma(its)), partes: cs.map((c, j) => ({ rot: c.nome, v: soma(its.filter(x => x.cartao === c.id)), cor: CORES_CAT[j % 8] })) });
    }
    h += `<section><h2>Faturas dos próximos meses</h2><div class="card">${barras(fs, cs.map((c, j) => ({ rot: c.nome, cor: CORES_CAT[j % 8] })))}
      <span class="small muted">Só o que já foi lançado (parcelas e contas fixas no cartão). Compras novas aumentam esses valores.</span></div></section>`;
  }
  return h;
}

// ---------- aba Fixas ----------
// linha "Quem paga" de cada conta fixa: no Pix escolhe com um toque; no crédito é o dono do cartão
function quemPaga(f) {
  if (f.forma === "credito") { const d = donoCartao(f.cartao); return `<div class="quem"><span>Quem paga:</span><b>${d ? esc(nomeP(d)) : "?"}</b><small class="muted">(dono do cartão)</small></div>`; }
  const b = p => `<button type="button" class="pill${f.pagador === p ? " on" : ""}" data-act="pagador" data-id="${f.id}" data-p="${p}" aria-pressed="${f.pagador === p}">${esc(nomeP(p))}</button>`;
  return `<div class="quem"><span class="${f.pagador ? "" : "falta"}">${f.pagador ? "Quem paga:" : "Quem paga? Toque:"}</span>${b("a")}${b("b")}</div>`;
}
function telaFixas() {
  const m = mesAtual();
  const rendas = todos("renda").sort((a, b) => (a.pessoa || "").localeCompare(b.pessoa || "") || (a.dia || 0) - (b.dia || 0));
  const fixas = todos("fixa").sort((a, b) => (a.dia || 99) - (b.dia || 99));
  const atv = fixas.filter(f => !f.fim || f.fim >= m), enc = fixas.filter(f => f.fim && f.fim < m);
  const rendaTot = rendas.filter(r => ativo(r, m)).reduce((s, r) => s + valorEm(r, m), 0);
  const tot = forma => atv.filter(f => (f.forma === "credito") === (forma === "credito") && ativo(f, m)).reduce((s, f) => s + valorEm(f, m), 0);
  const tPix = tot("pix"), tCred = tot("credito");
  let h = `<section class="hero"><span class="label">Contas fixas por mês (${soMes(m)})</span><div class="big num">${R(tPix + tCred)}</div>
    <div class="kv num"><span>No Pix</span><span class="v">${R(tPix)}</span><span>No crédito</span><span class="v">${R(tCred)}</span><span>Renda fixa</span><span class="v">${R(rendaTot)}</span>
    ${rendaTot ? `<span class="sep"></span><span>As fixas levam</span><span class="v">${pct(tPix + tCred, rendaTot)}% da renda</span>` : ""}</div></section>`;
  h += `<section><h2>Rendas <button class="btn small" data-act="nova-renda">+ Renda</button></h2><div class="card flat"><ul class="list">`;
  if (!rendas.length) h += `<li class="empty" style="display:block">Cadastre o salário de cada um (e outras rendas que se repetem).</li>`;
  for (const r of rendas) h += li(esc(r.desc), R(valorEm(r, m)), { act: `data-act="edit" data-id="${r.id}"`, sub: esc(nomeP(r.pessoa)) + " · " + quandoRenda(r, m) + (r.fim ? " · até " + curtoMes(r.fim) : ""), cls: "pos" });
  h += `</ul></div></section>`;
  const linha = f => {
    const base = li(esc(f.desc) + (f.ini > m ? ` <span class="tag pix">a partir de ${curtoMes(f.ini)}</span>` : ""), (f.varia ? "≈ " : "") + R(valorEm(f, f.ini > m ? f.ini : m)), { act: `data-act="edit" data-id="${f.id}"`, sub: (f.forma === "credito" ? "cobra dia " + (f.dia || 1) : f.dia ? "vence dia " + f.dia : "sem vencimento") + " · " + esc(f.cat || "") + (f.fim ? " · até " + curtoMes(f.fim) : "") });
    const pv = (v, t) => `<button type="button" class="pill${!!f.varia === !!v ? " on" : ""}" data-act="varia" data-id="${f.id}" data-v="${v ? 1 : ""}" aria-pressed="${!!f.varia === !!v}">${t}</button>`;
    return base.replace(/^<li>/, '<li class="fx"><div class="fx-top">').replace(/<\/li>$/, "</div>" + quemPaga(f) + `<div class="quem"><span>Valor:</span>${pv(false, "Sempre igual")}${pv(true, "Muda todo mês")}</div></li>`);
  };
  const grupo = (lst, vazio) => {
    if (!lst.length) return `<li class="empty" style="display:block">${vazio}</li>`;
    const fixo = lst.filter(f => !f.varia), varia = lst.filter(f => f.varia);
    return (fixo.length ? `<li class="sub">Valor sempre igual · ${R(fixo.reduce((s, f) => s + valorEm(f, m), 0))}</li>` + fixo.map(linha).join("") : "") +
      (varia.length ? `<li class="sub">Valor muda todo mês · ≈ ${R(varia.reduce((s, f) => s + valorEm(f, m), 0))}</li>` + varia.map(linha).join("") : "");
  };
  const pixL = atv.filter(f => f.forma !== "credito"), credL = atv.filter(f => f.forma === "credito");
  h += `<section><h2>Pagas no Pix, boleto ou débito <button class="btn small" data-act="nova-fixa" data-forma="pix">+ Conta</button></h2><span class="small muted">Saem da conta do banco. Marque como paga no mês.</span><div class="card flat"><ul class="list">${grupo(pixL, "Ex.: aluguel, luz, água, internet, escola, financiamento.")}</ul></div></section>`;
  h += `<section><h2>Caem no cartão de crédito <button class="btn small" data-act="nova-fixa" data-forma="credito">+ Conta</button></h2><span class="small muted">Não se paga uma por uma: entram na fatura do cartão.</span>`;
  if (!credL.length) h += `<div class="card flat"><ul class="list"><li class="empty" style="display:block">Ex.: streaming, academia, plano de celular, seguro.</li></ul></div>`;
  const porC = {};
  for (const f of credL) (porC[f.cartao] ||= []).push(f);
  for (const [cid, lst] of Object.entries(porC)) h += `<div class="card flat"><h3 class="ctit">💳 ${esc(nomeCartao(cid))} <small class="muted num">${R(lst.reduce((s, f) => s + valorEm(f, m), 0))}/mês</small></h3><ul class="list">${grupo(lst, "")}</ul></div>`;
  h += `</section>`;
  if (enc.length) {
    h += `<details class="card"><summary class="small muted">Contas encerradas (${enc.length})</summary><ul class="list">`;
    for (const f of enc) h += li(esc(f.desc), R(valorEm(f, f.fim)), { act: `data-act="edit" data-id="${f.id}"`, sub: "terminou em " + curtoMes(f.fim) });
    h += `</ul></details>`;
  }
  h += `<span class="small muted">Conta que muda todo mês (luz, água)? Marque "Muda todo mês" e cadastre a média. No mês ela aparece com ≈ até vocês porem o valor real (toque na conta na aba Gastos ou no Início). Quem paga cada conta entra no cálculo da aba Divisão.</span>`;
  return h;
}

// ---------- aba Planejar ----------
function telaPlanejar() {
  const m0 = mesAtual(), c = cfg();
  const rendaFixa = todos("renda").filter(r => ativo(r, m0)).reduce((s, r) => s + valorEm(r, m0), 0);
  const fixasTot = todos("fixa").filter(f => ativo(f, m0)).reduce((s, f) => s + valorEm(f, m0), 0);
  const meta = metaDe(rendaFixa);
  const mv = mediaVariavel(m0);
  const diaADia = rendaFixa - fixasTot - meta;
  const parcProx = soma(itensMes(addMes(m0, 1)).filter(i => i.k === "gasto" && i.forma === "credito"));
  let h = `<section class="hero"><span class="label">Estimativa mensal (com base em ${soMes(m0)})</span>`;
  if (!rendaFixa) h += `<span class="small muted">Cadastre as rendas e as contas fixas na aba Fixas para ver a estimativa.</span></section>`;
  else {
    h += `<div class="kv num"><span>Renda fixa do casal</span><span class="v">${R(rendaFixa)}</span>
      <span>− Contas fixas (Pix + crédito)</span><span class="v">${R(fixasTot)}</span>
      <span>− Meta de guardar</span><span class="v" style="color:var(--save)">${R(meta)}</span>
      <span class="sep"></span><span class="strong">Para o dia a dia</span><span class="v strong" style="color:${diaADia < 0 ? "var(--danger)" : "var(--fg)"}">${R(diaADia)}</span>
      <span class="muted small">por semana</span><span class="v small">${R(Math.round(diaADia / 4.35))}</span></div>
      <span class="small muted">"Dia a dia" é mercado, combustível, farmácia, lazer, compras — tudo que não é conta fixa.${parcProx ? ` Parcelas já assumidas no cartão para ${soMes(addMes(m0, 1))}: <b>${R(parcProx)}</b> — saem desse valor.` : ""}</span>`;
    if (mv) {
      const cap = rendaFixa - fixasTot - mv.media;
      h += `<div class="next num" style="flex-direction:column;gap:4px"><span>Gastos do dia a dia, média de ${mv.meses} ${mv.meses === 1 ? "mês" : "meses"}: <b>${R(mv.media)}</b></span>
        <span>Pelo que vocês gastam hoje, dá para guardar <b style="color:${cap < 0 ? "var(--danger)" : "var(--save)"}">${R(cap)}/mês</b> (${pct(cap, rendaFixa)}% da renda)${cap < meta ? " — menos que a meta: cortem " + R(meta - cap) + " por mês ou ajustem a meta." : "."}</span></div>`;
    } else h += `<span class="small muted">Depois de um mês completo lançando os gastos, aparece aqui quanto vocês realmente conseguem guardar.</span>`;
    h += `</section>`;
  }

  // meta
  h += `<section><h2>Meta de guardar</h2><div class="card">
    <div class="seg" role="radiogroup"><label><input type="radio" name="metaModo" value="pct" data-chg="metaModo" ${c.meta.modo !== "valor" ? "checked" : ""}>% da renda</label><label><input type="radio" name="metaModo" value="valor" data-chg="metaModo" ${c.meta.modo === "valor" ? "checked" : ""}>Valor fixo</label></div>
    ${c.meta.modo === "valor"
      ? `<label class="field"><span class="label">Guardar por mês</span><input inputmode="decimal" data-chg="metaValor" value="${valorCampo(c.meta.valor)}" placeholder="R$ 0,00"></label>`
      : `<label class="field"><span class="label">Porcentagem da renda</span><input inputmode="numeric" data-chg="metaPct" value="${c.meta.pct}" placeholder="20"></label>`}
    <span class="small muted">Regra de vocês (60/30/10): guardar pelo menos 10% da renda. Se hoje não dá, comecem com 5% e subam aos poucos.</span></div></section>`;

  // 60/30/10 (regra escolhida pelo casal em 19/11/2026)
  if (rendaFixa) {
    let nec = 0, des = 0;
    for (const f of todos("fixa").filter(f => ativo(f, m0))) (NECESSIDADE.has(f.cat) ? (nec += valorEm(f, m0)) : (des += valorEm(f, m0)));
    if (mv) for (const [cat, v] of Object.entries(mv.porCat)) (NECESSIDADE.has(cat) ? (nec += v) : (des += v));
    const barra = (rot, v, ideal, cor, txt) => `<div class="catrow num"><span>${rot}</span><span><b>${pct(v, rendaFixa)}%</b> <span class="muted small">${txt} ${ideal}%</span></span><div class="bar"><span style="width:${Math.min(100, pct(v, rendaFixa))}%;background:${cor}"></span></div></div>`;
    h += `<section><h2>Regra 60/30/10</h2><div class="card">
      ${barra("Necessidades (casa, contas, mercado, saúde…)", nec, 60, nec / rendaFixa > .6 ? "var(--danger)" : "var(--pix)", "ideal até")}
      ${barra("Desejos (lazer, delivery, assinaturas…)", des, 30, des / rendaFixa > .3 ? "var(--danger)" : "var(--cred)", "ideal até")}
      ${barra("Guardar", meta, 10, meta / rendaFixa < .1 ? "var(--warn)" : "var(--save)", "ideal pelo menos")}
      <span class="small muted">${mv ? "Fixas + média dos gastos lançados" : "Só as contas fixas por enquanto; os gastos do dia a dia entram depois de um mês de lançamentos"}. A categoria de cada conta decide se ela é necessidade ou desejo.</span></div></section>`;
  }

  // projeção
  h += `<section><h2>Próximos 6 meses</h2><div class="card"><div class="tablewrap"><table class="num"><thead><tr><th>Mês</th><th>Entra</th><th>Já sai</th><th>Guardado</th><th>Livre</th></tr></thead><tbody>`;
  for (let i = 0; i < 6; i++) {
    const k = addMes(m0, i), r = resumo(k);
    h += `<tr><td>${curtoMes(k)}</td><td>${R(r.ent)}</td><td>${R(r.pixFix + r.pixVar + r.fat)}</td><td>${R(r.guard)}</td><td class="${r.livre < 0 ? "neg" : "posv"}">${R(r.livre)}</td></tr>`;
  }
  h += `</tbody></table></div><span class="small muted">"Já sai" = contas fixas + faturas com parcelas e compras já lançadas. "Livre" já desconta o mercado pela média dos últimos meses. Antes de parcelar algo, olhe se os próximos meses aguentam.</span></div></section>`;

  // reserva
  const custoVida = fixasTot + (mv ? mv.media : 0), alvo = custoVida * 6, tem = guardadoTotal();
  const falta = Math.max(0, alvo - tem), meses = meta > 0 ? Math.ceil(falta / meta) : null;
  h += `<section><h2>Reserva de emergência</h2><div class="card">
    <div class="kv num"><span>Custo de vida por mês</span><span class="v">${R(custoVida)}</span><span>Alvo (6 meses de custo)</span><span class="v">${R(alvo)}</span><span>Guardado até agora</span><span class="v" style="color:var(--save)">${R(tem)}</span></div>
    <div class="stack"><span style="width:${alvo ? Math.min(100, tem / alvo * 100).toFixed(1) : 0}%;background:var(--save)"></span></div>
    <span class="small muted">${!alvo ? "Cadastre as contas fixas para calcular o alvo." : falta === 0 ? "Reserva completa. A partir daqui, o que guardarem pode ir para objetivos (viagem, carro, investimentos)." : meses ? `Faltam ${R(falta)} — cerca de ${meses} ${meses === 1 ? "mês" : "meses"} guardando a meta atual.` : `Faltam ${R(falta)}. Defina uma meta de guardar para ver o prazo.`}
    Deixem a reserva num lugar com resgate rápido e separado da conta do dia a dia.</span>
    <label class="field"><span class="label">Já tinham guardado antes do app</span><input inputmode="decimal" data-chg="reservaIni" value="${valorCampo(c.reservaIni)}" placeholder="R$ 0,00"></label></div></section>`;

  // limites
  h += `<section><h2>Limite por categoria <small>opcional</small></h2><div class="card"><span class="small muted">Um teto por mês para as categorias que mais escapam (mercado, delivery, lazer). Aparece como barra na aba Mês.</span>`;
  for (const cat of CATS) h += `<label class="field"><span class="label">${esc(cat)}${mv && mv.porCat[cat] ? ` · média ${R(mv.porCat[cat])}` : ""}</span><input inputmode="decimal" data-chg="limite" data-cat="${esc(cat)}" value="${valorCampo(c.limites[cat] || 0)}" placeholder="sem limite"></label>`;
  h += `</div></section>`;

  h += `<section><h2>Ideias para o controle de vocês</h2><div class="card"><ul class="tips">
    <li><b>Pague-se primeiro:</b> no dia do salário, transfiram a meta para a reserva. O que sobra é o que dá para gastar.</li>
    <li><b>15 minutos por semana juntos</b> (domingo, por exemplo): lancem o que faltou, marquem as contas pagas e olhem o "ainda pode gastar".</li>
    <li><b>Parcelamento é gasto do mês que vem:</b> antes de parcelar, olhem a tabela dos próximos 6 meses.</li>
    <li><b>Melhor dia de compra</b> é o dia do fechamento do cartão: a compra só é paga cerca de 40 dias depois. Não é dinheiro a mais — lancem do mesmo jeito.</li>
    <li><b>Contas no débito automático ou no crédito</b> evitam multa por esquecimento; só confiram a fatura todo mês.</li>
    <li><b>Revisem as assinaturas</b> a cada 3 meses: streaming, apps e planos que ninguém usa somam rápido.</li>
    <li><b>Uma "mesada" para cada um</b> sem precisar dar satisfação ajuda a evitar brigas — lancem como "Lazer" no nome de quem gastou.</li></ul></div></section>`;
  return h;
}

// ---------- aba Ajustes ----------
function telaAjustes() {
  const c = cfg(), cs = todos("cartao").sort((a, b) => a.nome.localeCompare(b.nome));
  let h = avisoArquivo();
  h += `<section><h2>Quem está usando este aparelho</h2><div class="card"><div class="seg" role="radiogroup">
    <label><input type="radio" name="eu" value="a" data-chg="eu" ${eu() === "a" ? "checked" : ""}>${esc(c.pessoas.a)}</label>
    <label><input type="radio" name="eu" value="b" data-chg="eu" ${eu() === "b" ? "checked" : ""}>${esc(c.pessoas.b)}</label></div>
    <span class="small muted">Os gastos lançados neste celular saem no nome de quem está marcado.</span>
    <div class="sheet-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
    <label class="field"><span class="label">Nome 1</span><input data-chg="nomeA" maxlength="20" value="${esc(c.pessoas.a)}"></label>
    <label class="field"><span class="label">Nome 2</span><input data-chg="nomeB" maxlength="20" value="${esc(c.pessoas.b)}"></label></div></div></section>`;
  h += `<section><h2>Cartões de crédito <button class="btn small" data-act="novo-cartao">+ Cartão</button></h2><div class="card flat"><ul class="list">`;
  if (!cs.length) h += `<li class="empty" style="display:block">Cadastre cada cartão com o dia do fechamento e do vencimento da fatura.</li>`;
  for (const k of cs) h += li(esc(k.nome), "", { act: `data-act="edit" data-id="${k.id}"`, sub: "fecha dia " + k.fech + " · vence dia " + k.venc });
  h += `</ul></div></section>`;

  h += `<section><h2>Google Drive</h2><div class="card">`;
  if (!window.FIN.configurado()) h += `<span class="small">O login do Google ainda não foi configurado (falta o ID do cliente em config.js — veja o LEIA-ME). Por enquanto, tudo fica guardado só neste aparelho.</span>`;
  else if (!window.FIN.token()) h += `<span class="small">${sync.email ? "O login de " + esc(sync.email) + " expirou (vale 1 hora). O que foi lançado está guardado e sobe quando entrar de novo." : "Entre com sua conta Google para guardar os dados no Drive e dividir com seu marido/esposa."}</span><button class="btn primary" data-act="entrar">Entrar com Google</button>`;
  else {
    h += `<div class="kv small"><span>Conta</span><span class="v">${esc(sync.email || "…")}</span><span>Arquivo</span><span class="v">${sync.arq ? (sync.arq.meu ? "seu" : "de " + esc(sync.arq.dono)) : sync.s === "semArquivo" ? "ainda não existe" : "…"}</span><span>Última sincronização</span><span class="v">${loc.ler("ultimoSync", 0) ? new Date(loc.ler("ultimoSync", 0)).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—"}</span></div>
      <div class="row"><button class="btn" data-act="sync">Sincronizar agora</button><button class="btn" data-act="sair">Sair</button></div>`;
    if (sync.arq && sync.arq.total > 1) h += `<span class="small muted">Há ${sync.arq.total} arquivos "FINANCAS DA CASA.json" no Drive; o app usa sempre o mais antigo. Os outros podem ir para a lixeira.</span>`;
    if (sync.arq) h += `<label class="field"><span class="label">Compartilhar com (e-mail Google)</span><input type="email" id="emailComp" autocomplete="email" placeholder="email@gmail.com"></label>
      <button class="btn primary" data-act="compartilhar">Compartilhar o arquivo</button>
      <span class="small muted">A pessoa recebe um e-mail do Google, abre este app no celular dela, entra com a conta dela e passa a ver e lançar no mesmo arquivo.</span>`;
  }
  h += `</div></section>`;

  h += `<section><h2>Cópias e planilha</h2><div class="card">
    <div class="row"><button class="btn" data-act="csv">Baixar planilha (Excel)</button><button class="btn" data-act="backup">Baixar cópia completa</button></div>
    <label class="field"><span class="label">Restaurar cópia (junta com o que já está aqui)</span><input type="file" accept=".json,application/json" data-chg="restaurar"></label></div></section>
    <p class="small muted" style="text-align:center">Finanças da Casa · versão 24 · ${window.FIN.DEMO ? "modo demonstração" : "dados no seu Google Drive"}</p>`;
  return h;
}

// ---------- folha (formulário que sobe de baixo) ----------
let folha = null;
function abrir(def) {
  folha = def;
  const f = $("sheet");
  let h = `<h3>${esc(def.titulo)}</h3>`;
  for (const c of def.campos) {
    const id = "f_" + c.n;
    if (c.tipo === "seg") {
      h += `<div class="field" data-campo="${c.n}">${c.rot ? `<span class="label">${esc(c.rot)}</span>` : ""}<div class="seg" role="radiogroup">` +
        c.ops.map(o => `<label><input type="radio" name="${c.n}" value="${esc(o.v)}" ${String(o.v) === String(c.v) ? "checked" : ""}>${esc(o.t)}</label>`).join("") + `</div></div>`;
    } else if (c.tipo === "sel") {
      h += `<label class="field" data-campo="${c.n}"><span class="label">${esc(c.rot)}</span><select name="${c.n}" id="${id}">` +
        c.ops.map(o => `<option value="${esc(o.v)}" ${String(o.v) === String(c.v) ? "selected" : ""}>${esc(o.t)}</option>`).join("") + `</select></label>`;
    } else {
      const tipo = { valor: "text", data: "date", mes: "month", int: "number", texto: "text" }[c.tipo] || "text";
      const extra = c.tipo === "valor" ? `inputmode="decimal" placeholder="R$ 0,00"` : c.tipo === "int" ? `inputmode="numeric" min="${c.min ?? 1}" max="${c.max ?? 31}"` : c.tipo === "texto" ? `maxlength="60" autocomplete="off" ${c.lista ? `list="lst_${c.n}"` : ""}` : "";
      const v = c.tipo === "valor" ? valorCampo(c.v) : (c.v ?? "");
      h += `<label class="field" data-campo="${c.n}"><span class="label">${esc(c.rot)}</span><input name="${c.n}" id="${id}" type="${tipo}" ${extra} placeholder="${esc(c.ph || "")}" value="${esc(v)}"></label>`;
      if (c.lista) h += `<datalist id="lst_${c.n}">${c.lista.map(x => `<option value="${esc(x)}">`).join("")}</datalist>`;
    }
    if (c.dica) h += `<div class="hint" data-dica="${c.n}"></div>`;
  }
  h += `<span class="err" id="sheetErr" hidden></span><div class="acts">`;
  if (def.excluir) h += `<button type="button" class="btn danger" data-sh="excluir">${esc(def.textoExcluir || "Excluir")}</button>`;
  if (def.extra) h += `<button type="button" class="btn" data-sh="extra">${esc(def.extra.t)}</button>`;
  h += `<div class="right"><button type="button" class="btn" data-sh="fechar">Cancelar</button><button type="submit" class="btn primary">${esc(def.textoSalvar || "Salvar")}</button></div></div>`;
  f.innerHTML = h;
  atualizarFolha();
  $("dlg").showModal();
  const prim = f.querySelector(def.foco ? `[name="${def.foco}"]` : "input:not([type=radio])");
  if (prim && def.novo) setTimeout(() => prim.focus(), 50);
}
function valsFolha() {
  const f = $("sheet"), v = {};
  for (const c of folha.campos) { const el = f.elements[c.n]; v[c.n] = el ? el.value : ""; }
  return v;
}
function atualizarFolha() {
  if (!folha) return;
  const v = valsFolha(), f = $("sheet");
  for (const c of folha.campos) {
    const box = f.querySelector(`[data-campo="${c.n}"]`), dica = f.querySelector(`[data-dica="${c.n}"]`);
    const vis = !c.se || c.se(v);
    if (box) box.hidden = !vis;
    if (dica) { dica.hidden = !vis; dica.innerHTML = vis ? (c.dica(v) || "") : ""; }
  }
}
function fecharFolha() { $("dlg").close(); folha = null; }
$("sheet").addEventListener("input", atualizarFolha);
$("sheet").addEventListener("change", atualizarFolha);
$("sheet").addEventListener("submit", e => {
  e.preventDefault();
  const v = valsFolha(), err = $("sheetErr");
  const msg = folha.salvar(v);
  if (msg) { err.textContent = msg; err.hidden = false; return; }
  fecharFolha();
});
$("sheet").addEventListener("click", e => {
  const b = e.target.closest("[data-sh]"); if (!b) return;
  if (b.dataset.sh === "fechar") fecharFolha();
  else if (b.dataset.sh === "extra") { const fn = folha.extra.fn; fecharFolha(); fn(); }
  else if (b.dataset.sh === "excluir") {
    if (!b.dataset.armado) { b.dataset.armado = "1"; b.textContent = "Toque de novo para confirmar"; return; }
    const fn = folha.excluir; fecharFolha(); fn();
  }
});
$("dlg").addEventListener("click", e => { if (e.target === $("dlg")) fecharFolha(); });
$("dlg").addEventListener("close", () => { folha = null; });

const opsPessoa = () => [{ v: "a", t: nomeP("a") }, { v: "b", t: nomeP("b") }];
const opsCartao = () => todos("cartao").sort((a, b) => a.nome.localeCompare(b.nome)).map(k => ({ v: k.id, t: k.nome }));
const opsCat = () => CATS.map(c => ({ v: c, t: c }));
const opsDividir = () => [{ v: "casal", t: "Casal (pela renda de cada um)" }, { v: "a", t: "Só " + nomeP("a") }, { v: "b", t: "Só " + nomeP("b") }];
const exigir = (v, campos) => {
  if (campos.includes("desc") && !v.desc.trim()) return "Escreva uma descrição.";
  if (campos.includes("valor")) { const c = centavos(v.valor); if (!(c > 0)) return "Informe um valor maior que zero (ex.: 150,90)."; }
  return "";
};
const sugestoes = tipo => [...new Set(todos(tipo).map(x => x.desc))].slice(0, 40);

// lançamento do dia a dia (gasto ou entrada avulsa)
// pre = dados lidos de um comprovante (lançamento novo já preenchido)
function formLancamento(rec, pre) {
  const novo = !rec, g = rec || pre || {};
  const cs = opsCartao();
  const tipoIni = g.tipo === "entrada" ? "entrada" : "gasto";
  abrir({
    titulo: pre ? "Comprovante lido" : novo ? "Novo lançamento" : (tipoIni === "entrada" ? "Entrada avulsa" : "Gasto"), novo, foco: "desc",
    extra: novo && !pre ? { t: "📷 Comprovante", fn: escolherComprovante } : null,
    campos: [
      ...(novo ? [{ n: "tipo", tipo: "seg", v: "gasto", ops: [{ v: "gasto", t: "Gasto" }, { v: "entrada", t: "Entrada extra" }] }] : [{ n: "tipo", tipo: "seg", v: tipoIni, ops: [{ v: tipoIni, t: tipoIni === "gasto" ? "Gasto" : "Entrada extra" }] }]),
      { n: "desc", rot: pre ? "O que foi comprado" : "Descrição", tipo: "texto", v: pre ? "" : g.desc, ph: pre && pre.quem ? "Ex.: faxina, remédio, presente" : "Ex.: Mercado, gasolina, farmácia", lista: sugestoes("gasto"),
        dica: pre ? () => pre.aviso : null },
      { n: "valor", rot: "Valor total", tipo: "valor", v: g.valor },
      { n: "data", rot: "Data", tipo: "data", v: g.data || hojeISO() },
      { n: "forma", rot: "Pago com", tipo: "seg", v: g.forma || (cs.length ? "credito" : "pix"), ops: [{ v: "pix", t: "Pix" }, { v: "debito", t: "Débito" }, { v: "credito", t: "Crédito" }], se: v => v.tipo === "gasto" },
      { n: "cartao", rot: "Cartão", tipo: "sel", v: g.cartao || (cs[0] && cs[0].v), ops: cs.length ? cs : [{ v: "", t: "Nenhum cartão cadastrado" }], se: v => v.tipo === "gasto" && v.forma === "credito" },
      { n: "parc", rot: "Parcelas", tipo: "int", v: g.parc || 1, min: 1, max: 24, se: v => v.tipo === "gasto" && v.forma === "credito",
        dica: v => {
          const k = reg[v.cartao]; if (!vivo(k)) return "Cadastre o cartão em Ajustes para o app saber em que fatura a compra cai.";
          if (!/^\d{4}-\d{2}-\d{2}$/.test(v.data)) return "";
          const n = Math.max(1, Math.min(24, parseInt(v.parc) || 1)), vm = vencMes(v.data, k), c = centavos(v.valor);
          return `Primeira parcela na fatura que vence <b>${dataBRano(vencData(vm, k))}</b>` + (n > 1 ? `; última em ${curtoMes(addMes(vm, n - 1))}.` : ".") + (c > 0 && n > 1 ? ` ${n}× de ${R(Math.floor(c / n))}.` : "");
        } },
      { n: "cat", rot: "Categoria", tipo: "sel", v: g.cat || "Mercado", ops: opsCat(), se: v => v.tipo === "gasto" },
      { n: "pessoa", rot: "Quem", tipo: "seg", v: g.pessoa || eu(), ops: opsPessoa() },
      { n: "rateio", rot: "Dividir", tipo: "sel", v: g.rateio || "casal", ops: opsDividir(), se: v => v.tipo === "gasto" }
    ],
    salvar(v) {
      if (pre && pre.quem && !v.desc.trim()) v.desc = pre.quem;
      const e = exigir(v, ["desc", "valor"]); if (e) return e;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.data)) return "Informe a data.";
      let desc = v.desc.trim();
      if (pre && pre.quem && !desc.toLowerCase().includes(pre.quem.toLowerCase())) desc += " (" + pre.quem + ")";
      const base = { id: g.id || novoId(v.tipo === "entrada" ? "e" : "g"), tipo: v.tipo, desc, valor: centavos(v.valor), data: v.data, pessoa: v.pessoa };
      if (g.conta && v.forma !== "credito") base.conta = g.conta;
      if (pre) base.origem = "comprovante";
      if (v.tipo === "gasto") {
        Object.assign(base, { forma: v.forma, cat: v.cat });
        if (v.rateio === "a" || v.rateio === "b") base.rateio = v.rateio;
        if (v.forma === "credito") {
          if (!vivo(reg[v.cartao])) return "Cadastre um cartão em Ajustes ou escolha Pix/Débito.";
          const n = parseInt(v.parc); if (!(n >= 1 && n <= 24)) return "Parcelas: de 1 a 24.";
          Object.assign(base, { cartao: v.cartao, parc: n });
        }
      }
      gravar(base);
      const dup = novo && v.tipo === "gasto" && duplicados().some(p => p.fica.id === base.id || p.sai.id === base.id);
      if (dup) toast("⚠ Já existe um gasto igual a este. Veja o aviso no topo da aba Mês.", 6000);
      else if (novo) toast(v.tipo === "entrada" ? "Entrada lançada." : v.forma === "credito" ? "Lançado na fatura de " + soMes(vencMes(v.data, reg[v.cartao])) + "." : "Gasto lançado.");
      if (novo && mesDe(v.data) !== mesSel && v.forma !== "credito") mesSel = mesDe(v.data), render();
    },
    excluir: novo ? null : () => { apagar(g.id); toast("Lançamento excluído."); }
  });
}

// ---------- comprovante (foto/print ou PDF) ----------
function escolherComprovante() {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*,application/pdf";
  inp.onchange = () => inp.files[0] && processarComprovante(inp.files[0]);
  inp.click();
}
const PALAVRAS_CAT = [[/ifood|99 ?food|rappi|aiqfome/i, "Delivery"], [/posto|combust|auto ?posto|shell|ipiranga|uber|99 ?pop|estaciona|park/i, "Transporte"],
  [/farmac|drogar|droga|raia|panvel|clinica|medic|odonto|psicolog/i, "Saúde"], [/mercad|supermerc|atacad|padaria|pao|acougue|hortifruti/i, "Mercado"],
  [/restaurante|lanch|pizz|cantina|bar\b|cafe|sorvet|hamburg/i, "Restaurante"], [/copel|sanepar|tim\b|vivo|claro|oi\b|internet|faxin/i, "Contas da casa"],
  [/pet|veterin|ra[çc][aã]o/i, "Pets"], [/escola|faculd|curso|unipar|unimeo|senac/i, "Educação"], [/netflix|spotify|amazon prime|disney|youtube|chatgpt|openai/i, "Assinaturas"]];
function catPalpite(quem) {
  if (!quem) return "";
  const q = quem.toLowerCase().split(" ").filter(w => w.length > 2).slice(0, 2).join(" ");
  if (q) { const ant = todos("gasto").filter(x => x.cat && (x.desc || "").toLowerCase().includes(q)).sort((a, b) => (b.upd || 0) - (a.upd || 0))[0]; if (ant) return ant.cat; }
  for (const [re, c] of PALAVRAS_CAT) if (re.test(quem.normalize("NFD").replace(/[̀-ͯ]/g, ""))) return c;
  return "";
}
async function processarComprovante(arq) {
  if (!window.COMPROVANTE) { toast("O leitor de comprovante não carregou. Abra o app com internet."); return; }
  toast("Lendo o comprovante…");
  let r;
  try { r = await window.COMPROVANTE.ler(arq, p => toast("Lendo o comprovante… " + p + "%")); }
  catch (err) { toast("Não consegui ler: " + err.message + ". Lance à mão."); formLancamento(null); return; }
  const quem = eu(), cs = todos("cartao");
  // cartão: o do banco do comprovante, de quem está usando o aparelho
  const nomeQuem = nomeP(quem).toLowerCase();
  const doBanco = cs.filter(k => r.banco && k.nome.toUpperCase().includes(r.banco.split(" ")[0]));
  const cartao = (doBanco.find(k => k.nome.toLowerCase().includes(nomeQuem)) || doBanco[0] || cs[0] || {}).id;
  const pre = { tipo: "gasto", valor: r.valor || null, data: r.data || hojeISO(), forma: r.forma, cartao, parc: 1, pessoa: quem,
    cat: catPalpite(r.quem) || "Outros", quem: r.quem, conta: r.banco && r.forma !== "credito" ? r.banco + " " + nomeP(quem).toUpperCase() : "" };
  const lidos = [r.valor ? "valor " + R(r.valor) : "", r.data ? "data " + dataBR(r.data) : "", FORMAS[r.forma], r.quem ? "para <b>" + esc(r.quem) + "</b>" : "", r.banco ? esc(r.banco) : ""].filter(Boolean);
  const faltou = [!r.valor && "valor", !r.data && "data"].filter(Boolean);
  const igual = r.valor && r.data && todos("gasto").find(x => x.valor === r.valor && x.data === r.data);
  // mesmo recebedor já lançado perto dessa data (ex.: Pix no crédito, que já está na fatura com juros)
  const chaveQuem = (r.quem || "").toLowerCase().split(" ").filter(w => w.length > 2).slice(0, 2).join(" ");
  const dias = d => new Date(d + "T12:00").getTime() / 864e5, dRef = dias(pre.data);
  const mesmoQuem = !igual && chaveQuem && todos("gasto").find(x => (x.desc || "").toLowerCase().includes(chaveQuem) && Math.abs(dias(x.data) - dRef) <= 75);
  pre.aviso = "Li no comprovante: " + (lidos.join(" · ") || "quase nada") + ". Confira antes de salvar." +
    (faltou.length ? ` <b>Não achei ${faltou.join(" e ")}</b>: preencha à mão.` : "") +
    (r.quem ? " O nome de quem recebeu vai junto na descrição." : "") +
    (igual ? ` <b style="color:var(--danger)">Atenção: já existe "${esc(igual.desc)}" com o mesmo valor e data.</b>` : "") +
    (mesmoQuem ? ` <b style="color:var(--danger)">Atenção: já existe "${esc(mesmoQuem.desc)}" (${R(mesmoQuem.valor)}, ${FORMAS[mesmoQuem.forma] || ""}). Se for o mesmo pagamento, não salve de novo.</b>` : "");
  formLancamento(null, pre);
}
// comprovante compartilhado direto do app do banco (Android): o service worker guarda o arquivo e abre ?comprovante=1
async function comprovanteCompartilhado() {
  if (!/[?&]comprovante=1/.test(location.search) || !("caches" in window)) return;
  const q = new URLSearchParams(location.search); q.delete("comprovante");
  history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : ""));
  try {
    const c = await caches.open("comprovante-recebido"), resp = await c.match("ultimo-comprovante");
    if (!resp) return;
    const blob = await resp.blob(); await c.delete("ultimo-comprovante");
    processarComprovante(new File([blob], decodeURIComponent(resp.headers.get("x-nome") || "comprovante"), { type: blob.type }));
  } catch (err) { toast("Não consegui abrir o comprovante compartilhado."); }
}
setTimeout(comprovanteCompartilhado, 300);

function formFixa(rec, formaIni) {
  const novo = !rec, f = rec || {}, cs = opsCartao(), mDef = novo ? mesSel : (mesSel > (f.ini || "") ? mesSel : f.ini);
  abrir({
    titulo: novo ? "Nova conta fixa" : "Conta fixa", novo, foco: "desc",
    campos: [
      { n: "desc", rot: "Conta", tipo: "texto", v: f.desc, ph: "Ex.: Aluguel, luz, internet, Netflix", lista: sugestoes("fixa") },
      { n: "varia", rot: "O valor", tipo: "seg", v: f.varia ? "1" : "", ops: [{ v: "", t: "É sempre o mesmo" }, { v: "1", t: "Muda todo mês" }] },
      { n: "valor", rot: "Valor por mês", tipo: "valor", v: novo ? 0 : valorEm(f, mDef), dica: v => v.varia === "1" ? "Coloque a média. Em cada mês o app mostra ≈ até vocês porem o valor real." : "" },
      { n: "apartir", rot: novo ? "Começa em" : "Este valor vale a partir de", tipo: "mes", v: mDef,
        dica: v => novo ? "" : "Mudou o valor (reajuste)? Os meses antes deste continuam com o valor antigo." },
      { n: "forma", rot: "Como é paga", tipo: "seg", v: f.forma || formaIni || "pix", ops: [{ v: "pix", t: "Pix / boleto / débito" }, { v: "credito", t: "Cartão de crédito" }] },
      { n: "cartao", rot: "Cartão", tipo: "sel", v: f.cartao || (cs[0] && cs[0].v), ops: cs.length ? cs : [{ v: "", t: "Nenhum cartão cadastrado" }], se: v => v.forma === "credito" },
      { n: "dia", rot: "Dia do vencimento", tipo: "int", v: novo ? 10 : (f.dia || ""), min: 1, max: 31, ph: "sem vencimento",
        dica: v => v.forma === "credito" ? "No crédito, é o dia em que a cobrança entra no cartão." : "Deixe vazio se não tem vencimento (mercado, remédio)." },
      { n: "cat", rot: "Categoria", tipo: "sel", v: f.cat || "Contas da casa", ops: opsCat() },
      { n: "pagador", rot: "Quem paga", tipo: "seg", v: f.pagador || "", ops: [...opsPessoa(), { v: "", t: "Não sei" }], se: v => v.forma !== "credito" },
      { n: "rateio", rot: "Dividir", tipo: "sel", v: f.rateio || "casal", ops: opsDividir() },
      { n: "fim", rot: "Último mês (deixe vazio se não tem fim)", tipo: "mes", v: f.fim || "" }
    ],
    salvar(v) {
      const e = exigir(v, ["desc", "valor"]); if (e) return e;
      if (!/^\d{4}-\d{2}$/.test(v.apartir)) return "Informe o mês.";
      const dia = String(v.dia).trim() === "" && v.forma !== "credito" ? 0 : parseInt(v.dia);
      if (!(dia === 0 || (dia >= 1 && dia <= 31))) return v.forma === "credito" ? "No crédito, informe o dia da cobrança (1 a 31)." : "Dia: de 1 a 31, ou vazio.";
      if (v.forma === "credito" && !vivo(reg[v.cartao])) return "Cadastre um cartão em Ajustes ou escolha Pix.";
      if (v.fim && v.fim < v.apartir && novo) return "O último mês não pode ser antes do começo.";
      const c = centavos(v.valor);
      let valores = (f.valores || []).slice();
      if (novo) valores = [{ ini: v.apartir, v: c }];
      else if (valorEm(f, v.apartir) !== c || valores.some(x => x.ini > v.apartir) || !valores.length) {
        valores = valores.filter(x => x.ini < v.apartir).concat({ ini: v.apartir, v: c });
      }
      valores.sort((a, b) => a.ini.localeCompare(b.ini));
      gravar({ id: f.id || novoId("f"), tipo: "fixa", desc: v.desc.trim(), valores, ini: valores[0].ini, forma: v.forma, cartao: v.forma === "credito" ? v.cartao : "", dia, cat: v.cat, fim: v.fim || "",
        varia: v.varia === "1", pagador: v.forma !== "credito" && (v.pagador === "a" || v.pagador === "b") ? v.pagador : "", rateio: v.rateio === "a" || v.rateio === "b" ? v.rateio : "" });
      if (novo) toast("Conta fixa cadastrada. Ela aparece em todos os meses a partir de " + curtoMes(v.apartir) + ".");
    },
    textoExcluir: "Excluir de todos os meses",
    excluir: novo ? null : () => { apagar(f.id); toast("Conta excluída. Para só encerrar, use o campo Último mês."); }
  });
}

function formRenda(rec) {
  const novo = !rec, r = rec || {}, mDef = novo ? mesSel : (mesSel > (r.ini || "") ? mesSel : r.ini);
  abrir({
    titulo: novo ? "Nova renda fixa" : "Renda fixa", novo, foco: "desc",
    campos: [
      { n: "desc", rot: "Descrição", tipo: "texto", v: r.desc, ph: "Ex.: Salário, pró-labore, aluguel recebido" },
      { n: "pessoa", rot: "De quem", tipo: "seg", v: r.pessoa || eu(), ops: opsPessoa() },
      { n: "valor", rot: "Valor líquido por mês (o que cai na conta)", tipo: "valor", v: novo ? 0 : valorEm(r, mDef) },
      { n: "apartir", rot: novo ? "Começa em" : "Este valor vale a partir de", tipo: "mes", v: mDef },
      { n: "quando", rot: "Quando cai", tipo: "seg", v: r.util ? "util" : (novo ? "util" : "dia"), ops: [{ v: "util", t: "Dia útil" }, { v: "dia", t: "Dia fixo do mês" }] },
      { n: "dia", rot: "Dia", tipo: "int", v: r.dia || 5, min: 1, max: 31,
        dica: v => { const n = parseInt(v.dia) || 1, m = mesAtual(); return v.quando === "util" ? `${n}º dia útil — em ${soMes(m)} cai dia ${diaUtil(m, n)} (conta seg–sex e feriados nacionais).` : ""; } },
      { n: "fim", rot: "Último mês (deixe vazio se não tem fim)", tipo: "mes", v: r.fim || "" }
    ],
    salvar(v) {
      const e = exigir(v, ["desc", "valor"]); if (e) return e;
      if (!/^\d{4}-\d{2}$/.test(v.apartir)) return "Informe o mês.";
      const dia = parseInt(v.dia); if (!(dia >= 1 && dia <= (v.quando === "util" ? 23 : 31))) return "Dia inválido.";
      const c = centavos(v.valor);
      let valores = (r.valores || []).slice();
      if (novo) valores = [{ ini: v.apartir, v: c }];
      else if (valorEm(r, v.apartir) !== c || valores.some(x => x.ini > v.apartir) || !valores.length) valores = valores.filter(x => x.ini < v.apartir).concat({ ini: v.apartir, v: c });
      valores.sort((a, b) => a.ini.localeCompare(b.ini));
      gravar({ id: r.id || novoId("r"), tipo: "renda", desc: v.desc.trim(), pessoa: v.pessoa, valores, ini: valores[0].ini, dia, util: v.quando === "util", fim: v.fim || "" });
    },
    excluir: novo ? null : () => apagar(r.id)
  });
}

function formFixaMes(fid, mes) {
  const f = reg[fid]; if (!vivo(f)) return;
  const ch = "fm|" + fid + "|" + mes, o = vivo(reg[ch]) ? reg[ch] : {};
  const padrao = valorEm(f, mes), cred = f.forma === "credito";
  abrir({
    titulo: f.desc + " · " + nomeMes(mes),
    campos: [
      { n: "valor", rot: "Valor neste mês", tipo: "valor", v: o.valor != null ? o.valor : padrao, dica: () => f.varia ? `Conta que varia: a média é ${R(padrao)}. Ponha o valor que veio neste mês.` : `Valor padrão da conta: ${R(padrao)}. Mude aqui só se neste mês veio diferente.` },
      ...(cred ? [] : [{ n: "pago", rot: "Situação", tipo: "seg", v: o.pago ? "1" : "", ops: [{ v: "", t: "A pagar" }, { v: "1", t: "Paga" }] }])
    ],
    salvar(v) {
      const c = centavos(v.valor); if (!(c >= 0)) return "Valor inválido.";
      gravar({ id: ch, tipo: "fixaMes", fixaId: fid, mes, valor: c === padrao && !f.varia ? null : c, pago: !cred && v.pago === "1" });
    },
    extra: { t: "Editar a conta", fn: () => formFixa(f) }
  });
}
function formRendaMes(rid, mes) {
  const r = reg[rid]; if (!vivo(r)) return;
  const ch = "rm|" + rid + "|" + mes, o = vivo(reg[ch]) ? reg[ch] : {}, padrao = valorEm(r, mes);
  abrir({
    titulo: r.desc + " · " + nomeMes(mes),
    campos: [{ n: "valor", rot: "Valor neste mês", tipo: "valor", v: o.valor != null ? o.valor : padrao, dica: () => `Valor padrão: ${R(padrao)}. Mude só se neste mês veio diferente (férias, 13º, hora extra).` }],
    salvar(v) { const c = centavos(v.valor); if (!(c >= 0)) return "Valor inválido."; gravar({ id: ch, tipo: "rendaMes", rendaId: rid, mes, valor: c === padrao ? null : c }); },
    extra: { t: "Editar a renda", fn: () => formRenda(r) }
  });
}
function formCartao(rec) {
  const novo = !rec, k = rec || {};
  abrir({
    titulo: novo ? "Novo cartão" : "Cartão", novo, foco: "nome",
    campos: [
      { n: "nome", rot: "Nome", tipo: "texto", v: k.nome, ph: "Ex.: Nubank Thiago, Itaú casal" },
      { n: "dono", rot: "De quem é (quem paga a fatura)", tipo: "seg", v: k.dono || donoCartao(k.id) || eu(), ops: opsPessoa() },
      { n: "fech", rot: "Dia do fechamento", tipo: "int", v: k.fech || 1, min: 1, max: 31 },
      { n: "venc", rot: "Dia do vencimento", tipo: "int", v: k.venc || 10, min: 1, max: 31,
        dica: v => { const F = parseInt(v.fech) || 1; return `Compras feitas do dia ${F} em diante já vão para a fatura seguinte — o dia ${F} é o "melhor dia de compra".`; } }
    ],
    salvar(v) {
      if (!v.nome.trim()) return "Dê um nome ao cartão.";
      const fe = parseInt(v.fech), ve = parseInt(v.venc);
      if (!(fe >= 1 && fe <= 31 && ve >= 1 && ve <= 31)) return "Dias: de 1 a 31.";
      gravar({ id: k.id || novoId("c"), tipo: "cartao", nome: v.nome.trim(), fech: fe, venc: ve, dono: v.dono });
    },
    excluir: novo ? null : () => {
      const usado = todos("gasto").some(g => g.cartao === k.id) || todos("fixa").some(f => f.cartao === k.id);
      if (usado) { toast("Este cartão tem lançamentos; mude-os de cartão antes de excluir."); return; }
      apagar(k.id);
    }
  });
}
function editar(id) {
  const r = reg[id]; if (!vivo(r)) return;
  ({ gasto: formLancamento, entrada: formLancamento, fixa: formFixa, renda: formRenda, cartao: formCartao })[r.tipo]?.(r);
}

// ---------- eventos da tela ----------
document.querySelector("nav.tabs").addEventListener("click", e => {
  const b = e.target.closest("[data-tab]"); if (!b) return;
  aba = b.dataset.tab; loc.gravar("aba", aba); render(); window.scrollTo(0, 0);
});
$("fab").onclick = () => formLancamento(null);
$("sync").onclick = () => {
  if (sync.s === "entrar") window.FIN.entrar();
  else if (sync.s === "local" || sync.s === "semArquivo") { aba = "ajustes"; render(); }
  else sincronizar(true);
};
$("main").addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act, id = b.dataset.id;
  if (a === "mes") { mesSel = addMes(mesSel, +b.dataset.d); render(); }
  else if (a === "varia") { const f = reg[id]; if (vivo(f)) { gravar({ ...f, varia: b.dataset.v === "1" }); toast(b.dataset.v === "1" ? `"${f.desc}": valor muda todo mês (fica como média).` : `"${f.desc}": valor sempre igual.`); } }
  else if (a === "pagador") { const f = reg[id]; if (vivo(f)) { gravar({ ...f, pagador: b.dataset.p }); toast(`"${f.desc}" fica com ${nomeP(b.dataset.p)}.`); } }
  else if (a === "dup-apagar") { const x = reg[id]; apagar(id); toast(`"${x ? x.desc : "Lançamento"}" apagado.`); }
  else if (a === "dup-ok") { const k = parDup(b.dataset.a, b.dataset.b); gravar({ id: k, tipo: "dupOk" }); toast("Certo, não vou mais avisar sobre esses dois."); }
  else if (a === "ir-aba") { aba = b.dataset.tab; loc.gravar("aba", aba); render(); window.scrollTo(0, 0); }
  else if (a === "edit") editar(id);
  else if (a === "fixa-mes") formFixaMes(id, b.dataset.mes);
  else if (a === "renda-mes") formRendaMes(id, mesSel);
  else if (a === "fatura-paga") {
    e.preventDefault();
    const ch = "fp|" + id + "|" + b.dataset.mes, o = vivo(reg[ch]) ? reg[ch] : { id: ch, tipo: "faturaMes", cartao: id, mes: b.dataset.mes };
    gravar({ ...o, pago: !o.pago });
  }
  else if (a === "pago") {
    const ch = "fm|" + id + "|" + b.dataset.mes, o = vivo(reg[ch]) ? reg[ch] : { id: ch, tipo: "fixaMes", fixaId: id, mes: b.dataset.mes, valor: null };
    gravar({ ...o, pago: !o.pago });
  }
  else if (a === "nova-renda") formRenda(null);
  else if (a === "nova-fixa") formFixa(null, b.dataset.forma);
  else if (a === "novo-cartao") formCartao(null);
  else if (a === "entrar") window.FIN.entrar();
  else if (a === "sair") { window.FIN.sair(); sync = { s: "entrar", arq: null, email: "" }; render(); }
  else if (a === "sync") sincronizar(true);
  else if (a === "criar-arq") criarArquivo();
  else if (a === "compartilhar") {
    const em = ($("emailComp").value || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { toast("Digite um e-mail válido."); return; }
    b.disabled = true;
    try { await drive.compartilhar(sync.arq.id, em); toast("Compartilhado com " + em + "."); $("emailComp").value = ""; }
    catch (err) { toast(err instanceof SemLogin ? "Entre de novo com o Google." : "Não consegui compartilhar: " + err.message); }
    b.disabled = false;
  }
  else if (a === "csv") baixarCSV();
  else if (a === "backup") baixar("financas-casa-copia-" + hojeISO() + ".json", JSON.stringify({ formato: "financas-casa-1", registros: reg }, null, 1), "application/json");
});
$("main").addEventListener("change", e => {
  const el = e.target, k = el.dataset.chg; if (!k) return;
  const c = cfg();
  if (k === "guardado") {
    const v = el.value.trim() === "" ? null : centavos(el.value);
    if (v !== null && !(v >= 0)) { toast("Valor inválido."); return; }
    if (v === null) apagar("gd|" + el.dataset.mes); else gravar({ id: "gd|" + el.dataset.mes, tipo: "guardado", mes: el.dataset.mes, valor: v });
  }
  else if (k === "metaModo") salvarCfg({ meta: { ...c.meta, modo: el.value } });
  else if (k === "metaPct") { const p = Number(el.value.replace(",", ".")); if (!(p >= 0 && p <= 100)) { toast("Porcentagem de 0 a 100."); return; } salvarCfg({ meta: { ...c.meta, pct: p } }); }
  else if (k === "metaValor") { const v = centavos(el.value); if (!(v >= 0)) { toast("Valor inválido."); return; } salvarCfg({ meta: { ...c.meta, valor: v } }); }
  else if (k === "reservaIni") { const v = centavos(el.value); if (!(v >= 0)) { toast("Valor inválido."); return; } salvarCfg({ reservaIni: v }); }
  else if (k === "limite") { const v = centavos(el.value); const lim = { ...c.limites }; if (v > 0) lim[el.dataset.cat] = v; else delete lim[el.dataset.cat]; salvarCfg({ limites: lim }); }
  else if (k === "eu") { loc.gravar("eu", el.value); render(); }
  else if (k === "nomeA" || k === "nomeB") salvarCfg({ pessoas: { ...c.pessoas, [k === "nomeA" ? "a" : "b"]: el.value.trim() || (k === "nomeA" ? "Pessoa 1" : "Pessoa 2") } });
  else if (k === "restaurar") restaurar(el.files[0]);
});

// ---------- arquivos ----------
function baixar(nome, texto, tipo) {
  const url = URL.createObjectURL(new Blob([texto], { type: tipo }));
  const a = document.createElement("a"); a.href = url; a.download = nome; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
function baixarCSV() {
  const num = c => ((c || 0) / 100).toFixed(2).replace(".", ",");
  const q = s => '"' + String(s ?? "").replace(/"/g, '""') + '"';
  const linhas = [["Tipo", "Data/Início", "Descrição", "Categoria", "Forma", "Cartão", "Parcelas", "Valor", "Quem", "Dia", "Último mês"].join(";")];
  for (const g of todos("gasto").sort((a, b) => a.data.localeCompare(b.data))) linhas.push(["Gasto", dataBRano(g.data), q(g.desc), q(g.cat), FORMAS[g.forma] || "", q(g.forma === "credito" ? nomeCartao(g.cartao) : ""), g.forma === "credito" ? g.parc : "", num(g.valor), q(nomeP(g.pessoa)), "", ""].join(";"));
  for (const e of todos("entrada").sort((a, b) => a.data.localeCompare(b.data))) linhas.push(["Entrada", dataBRano(e.data), q(e.desc), "", "", "", "", num(e.valor), q(nomeP(e.pessoa)), "", ""].join(";"));
  const m = mesAtual();
  for (const f of todos("fixa")) linhas.push(["Conta fixa", curtoMes(f.ini), q(f.desc), q(f.cat), f.forma === "credito" ? "Crédito" : "Pix", q(f.forma === "credito" ? nomeCartao(f.cartao) : ""), "", num(valorEm(f, m > f.ini ? m : f.ini)), "", f.dia, f.fim ? curtoMes(f.fim) : ""].join(";"));
  for (const r of todos("renda")) linhas.push(["Renda fixa", curtoMes(r.ini), q(r.desc), "", "", "", "", num(valorEm(r, m > r.ini ? m : r.ini)), q(nomeP(r.pessoa)), r.dia, r.fim ? curtoMes(r.fim) : ""].join(";"));
  baixar("financas-casa-" + hojeISO() + ".csv", "﻿" + linhas.join("\r\n"), "text/csv;charset=utf-8");
}
async function restaurar(arq) {
  if (!arq) return;
  try {
    const j = JSON.parse(await arq.text());
    if (!j || typeof j.registros !== "object") throw new Error("formato");
    const { mesclado, mudouLocal } = mesclar(reg, j.registros);
    reg = mesclado; loc.gravar("reg", reg); render(); agendarSync();
    toast(mudouLocal ? "Cópia restaurada e juntada aos dados." : "Nada novo nessa cópia.");
  } catch { toast("Esse arquivo não é uma cópia do Finanças da Casa."); }
}

// ---------- sincronização ----------
function mesclar(local, remoto) {
  const out = { ...remoto }; let mudouLocal = false, mudouRemoto = false;
  for (const [id, r] of Object.entries(local)) { const x = remoto[id]; if (!x || (r.upd || 0) > (x.upd || 0)) { out[id] = r; mudouRemoto = true; } }
  for (const [id, x] of Object.entries(remoto)) { const r = local[id]; if (!r || (x.upd || 0) > (r.upd || 0)) mudouLocal = true; }
  return { mesclado: out, mudouLocal, mudouRemoto };
}
function renderSync() {
  const b = $("sync"), t = $("syncTxt");
  const map = {
    local: ["", window.FIN.configurado() ? "Entrar no Google" : "Só neste aparelho"],
    busy: ["busy", "Sincronizando…"],
    ok: ["ok", "Sincronizado " + (loc.ler("ultimoSync", 0) ? new Date(loc.ler("ultimoSync", 0)).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "")],
    entrar: ["entrar", "Entrar de novo"],
    erro: ["erro", "Sem conexão · tentar"],
    semArquivo: ["entrar", "Falta o arquivo"]
  }[sync.s] || ["", ""];
  b.className = "sync " + map[0]; t.textContent = map[1];
}
let timer = null, rodando = false, deNovo = false;
function agendarSync() { clearTimeout(timer); timer = setTimeout(() => sincronizar(false), 1500); }
async function sincronizar(manual) {
  if (!window.FIN.configurado()) { sync.s = "local"; renderSync(); return; }
  if (!window.FIN.token()) { sync.s = loc.ler("email", "") ? "entrar" : "local"; renderSync(); if (manual) window.FIN.entrar(); return; }
  if (rodando) { deNovo = true; return; }
  rodando = true; sync.s = "busy"; renderSync();
  try {
    if (!sync.email) sync.email = await drive.quemSou();
    const arq = await drive.achar();
    sync.arq = arq;
    if (!arq) { sync.s = "semArquivo"; render(); return; }
    const remoto = (await drive.baixar(arq.id)).registros || {};
    const { mesclado, mudouLocal, mudouRemoto } = mesclar(reg, remoto);
    if (mudouLocal) { reg = mesclado; loc.gravar("reg", reg); }
    if (mudouRemoto) await drive.subir(arq.id, { formato: "financas-casa-1", atualizado: new Date().toISOString(), registros: mesclado });
    loc.gravar("ultimoSync", Date.now());
    sync.s = "ok";
    if (mudouLocal || aba === "ajustes") render(); else renderSync();
    if (manual) toast("Sincronizado.");
  } catch (e) {
    if (e instanceof SemLogin) sync.s = "entrar";
    else { sync.s = "erro"; console.error(e); if (manual) toast("Não consegui sincronizar: " + e.message); }
    render();
  } finally {
    rodando = false;
    if (deNovo) { deNovo = false; agendarSync(); }
  }
}
let criando = false;
async function criarArquivo() {
  if (criando) return;                       // toque duplo não cria dois arquivos
  criando = true;
  document.querySelectorAll('[data-act="criar-arq"]').forEach(b => { b.disabled = true; b.textContent = "Criando…"; });
  try {
    if (await drive.achar()) { toast("O arquivo da casa já existe; usando ele."); }
    else {
      await drive.criar({ formato: "financas-casa-1", atualizado: new Date().toISOString(), registros: reg });
      toast("Arquivo criado no seu Google Drive (pasta FINANCAS DA CASA).");
    }
  } catch (e) { toast(e instanceof SemLogin ? "Entre de novo com o Google." : "Não consegui criar: " + e.message); }
  criando = false;
  sincronizar(false);
}

// ---------- início ----------
const voltouDoLogin = window.FIN.lerRetornoLogin();
if (voltouDoLogin) { aba = loc.ler("aba", "inicio"); }
render();
sincronizar(false);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sincronizar(false); });
setInterval(() => { if (document.visibilityState === "visible" && !$("dlg").open) sincronizar(false); }, 60000);
})();

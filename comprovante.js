// Leitura de comprovante (foto/print ou PDF do banco).
// Tudo roda no próprio aparelho: a imagem não sai do celular. Só as bibliotecas de leitura são baixadas
// (Tesseract.js para imagem, pdf.js para PDF) na primeira vez e depois ficam no cache do navegador.
(function () {
  const TESS = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const PDFJS_W = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const carregados = {};
  const carregar = src => carregados[src] || (carregados[src] = new Promise((ok, falha) => {
    const s = document.createElement("script"); s.src = src; s.onload = ok;
    s.onerror = () => { delete carregados[src]; falha(new Error("sem internet para baixar o leitor")); };
    document.head.appendChild(s);
  }));

  async function textoDoPdf(arq) {
    await carregar(PDFJS);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_W;
    const pdf = await pdfjsLib.getDocument({ data: await arq.arrayBuffer() }).promise;
    let linhas = [];
    for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
      const pg = await pdf.getPage(p), tc = await pg.getTextContent();
      // junta os pedaços por linha (mesma altura)
      const porY = new Map();
      for (const it of tc.items) { const y = Math.round(it.transform[5]); porY.set(y, (porY.get(y) || []).concat(it)); }
      [...porY.keys()].sort((a, b) => b - a).forEach(y => linhas.push(porY.get(y).sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str).join(" ").trim()));
    }
    return linhas.filter(Boolean).join("\n");
  }
  async function textoDaImagem(arq, aviso) {
    await carregar(TESS);
    const r = await Tesseract.recognize(arq, "por", { logger: m => { if (m.status === "recognizing text" && aviso) aviso(Math.round(m.progress * 100)); } });
    return r.data.text || "";
  }

  // ---------- interpretar o texto ----------
  const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
  const p2 = n => String(n).padStart(2, "0");
  const semAcento = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const num = s => Math.round(parseFloat(s.replace(/\./g, "").replace(",", ".")) * 100);

  function acharValor(t) {
    const linhas = t.split("\n");
    // 1º: o que saiu de fato ("Você pagou", "Valor pago", "Total"); 2º: qualquer linha de "Valor"
    for (const re of [/voce pagou|valor pago|valor total|total pago|\btotal\b/, /valor|quantia/]) {
      for (let i = 0; i < linhas.length; i++) {
        const l = semAcento(linhas[i]).toLowerCase();
        if (re.test(l) && !/tarifa|juros|multa|desconto|saldo|limite/.test(l)) {
          const m = (linhas[i] + " " + (linhas[i + 1] || "")).match(/R\$\s*([\d.]{1,9},\d{2})/);
          if (m && num(m[1]) > 0) return num(m[1]);
        }
      }
    }
    // 2º: o maior valor em R$ que não seja saldo/limite
    let maior = 0;
    for (const l of linhas) {
      if (/saldo|limite|tarifa/i.test(semAcento(l))) continue;
      for (const m of l.matchAll(/R\$\s*([\d.]{1,9},\d{2})/g)) maior = Math.max(maior, num(m[1]));
    }
    if (maior) return maior;
    const solto = t.match(/\b(\d{1,3}(?:\.\d{3})*,\d{2})\b/);
    return solto ? num(solto[1]) : 0;
  }
  function acharData(t) {
    const s = semAcento(t).toLowerCase();
    let m = s.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    m = s.match(/\b(\d{1,2})\s*(?:de\s+)?(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\.?\s*(?:de\s+)?(\d{4})\b/);
    if (m) return `${m[3]}-${p2(MESES[m[2]])}-${p2(m[1])}`;
    m = s.match(/\b(\d{2})\/(\d{2})\/(\d{2})\b/);
    if (m) return `20${m[3]}-${m[2]}-${m[1]}`;
    return "";
  }
  function acharForma(t) {
    const s = semAcento(t).toLowerCase();
    if (/pix no credito|pix com cartao de credito|pix parcelado/.test(s)) return "credito";
    if (/\bpix\b/.test(s)) return "pix";
    if (/debito/.test(s) && !/credito/.test(s)) return "debito";
    if (/boleto|pagamento de conta|codigo de barras/.test(s)) return "pix";
    if (/credito/.test(s)) return "credito";
    return "pix";
  }
  function acharBanco(t) {
    const s = semAcento(t).toLowerCase();
    if (/nubank|nu pagamentos/.test(s)) return "NUBANK";
    if (/sicredi/.test(s)) return "SICREDI";
    if (/banco do brasil|\bbb\b/.test(s)) return "BANCO DO BRASIL";
    if (/itau/.test(s)) return "ITAU";
    if (/bradesco/.test(s)) return "BRADESCO";
    if (/caixa economica/.test(s)) return "CAIXA";
    if (/inter\b/.test(s)) return "INTER";
    return "";
  }
  const ROTULOS = /^(destino|destinatario|recebedor|favorecido|beneficiario|pago para|para|estabelecimento|quem recebeu|dados do recebedor|dados do favorecido)\b/;
  const LIXO = /^(nome|cpf|cnpj|instituicao|banco|agencia|conta|chave|tipo|origem|de\b|data|valor|id|autenticacao|\*|•)/;
  function acharQuem(t) {
    const linhas = t.split("\n").map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < linhas.length; i++) {
      const l = semAcento(linhas[i]).toLowerCase().replace(/[:\-]/g, " ").trim();
      if (!ROTULOS.test(l)) continue;
      // o nome pode estar na mesma linha ("Para: FULANO") ou nas próximas ("Nome  FULANO")
      const resto = linhas[i].replace(/^[^:]*:/, "").trim();
      if (resto && resto !== linhas[i] && /[a-z]{3}/i.test(resto)) return limpar(resto);
      for (let j = i + 1; j < Math.min(i + 5, linhas.length); j++) {
        const c = linhas[j], cs = semAcento(c).toLowerCase();
        if (/^nome\b/.test(cs)) { const r = c.replace(/^nome\s*:?\s*/i, ""); if (/[a-z]{3}/i.test(r)) return limpar(r); continue; }
        if (LIXO.test(cs) || ROTULOS.test(cs) || /\d{3}\.\d{3}|\d{2}\/\d{2}|R\$/.test(c)) continue;
        if (/[a-z]{3}/i.test(c)) return limpar(c);
      }
    }
    return "";
  }
  const limpar = s => s.replace(/\s+/g, " ").replace(/[|_]/g, "").trim().slice(0, 50);

  function interpretar(t) {
    return { valor: acharValor(t), data: acharData(t), forma: acharForma(t), banco: acharBanco(t), quem: acharQuem(t), texto: t };
  }

  async function ler(arq, aviso) {
    const pdf = arq.type === "application/pdf" || /\.pdf$/i.test(arq.name || "");
    const texto = pdf ? await textoDoPdf(arq) : await textoDaImagem(arq, aviso);
    return interpretar(texto);
  }

  window.COMPROVANTE = { ler, interpretar };
})();

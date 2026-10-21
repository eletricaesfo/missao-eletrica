// =====================================================================
// Missão Elétrica EsFO — aplicativo de gestão de missões
// HTML + JavaScript puro, Firebase (Auth + Firestore), sem compilação.
// =====================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, collection, doc, getDoc, getDocs,
  setDoc, addDoc, updateDoc, deleteDoc, query, where, onSnapshot, writeBatch,
  increment, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  firebaseConfig, CICLO_INICIO, HORAS_ALERTA_PAINEL, TIPOS, PRIORIDADES, PESOS,
} from "./config.js";
import { ic } from "./icones.js";

// ---------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------
const $app = document.getElementById("app");

if (firebaseConfig.apiKey === "COLE_AQUI") {
  $app.innerHTML = `<div class="centro"><h1>Configuração pendente</h1>
    <p>Abra o arquivo <code>js/config.js</code> e cole a configuração do Firebase.</p></div>`;
  throw new Error("firebaseConfig não preenchido");
}

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = initializeFirestore(fb, { localCache: persistentLocalCache() });

// Estado global do app
const S = {
  me: null,            // membro logado {id: email, nome, perfil, ...}
  membros: [], missoes: [], materiais: [], locais: [],
  unsub: [], loaded: new Set(),
  dirty: false,        // há formulário sendo preenchido (não redesenhar a tela)
  cur: null,           // id da missão aberta
  fotos: {},           // cache de fotos por missão
  tab: "painel", filtroTipo: "",
  rel: null, importPend: null,
};

const STATUS = {
  painel: "No painel",
  em_execucao: "Em execução",
  aguardando_material: "Aguardando material",
  concluida: "Aguardando validação",
  validada: "Validada",
  arquivada: "Arquivada",
};
const ABERTAS = ["painel", "em_execucao", "aguardando_material", "concluida"];
const EM_ANDAMENTO = ["em_execucao", "aguardando_material", "concluida"];

// ---------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtData = (ms) => (ms ? new Date(ms).toLocaleDateString("pt-BR") : "—");
const fmtDH = (ms) => (ms ? new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
const slug = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const hojeISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const isCmd = () => S.me?.perfil === "comandante";
const nomeDe = (email) => S.membros.find((m) => m.id === email)?.nome || email || "—";
const prioNome = (p) => (PRIORIDADES.find(([k]) => k === p) || [p, p])[1];
const H = (acao) => arrayUnion({ em: Date.now(), por: S.me.id, acao });

function toast(msg, erro) {
  const t = document.createElement("div");
  t.className = "toast" + (erro ? " erro" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

async function acao(fn, ok) {
  try {
    await fn();
    if (ok) toast(ok);
    return true;
  } catch (e) {
    console.error(e);
    const msg = e.code === "permission-denied" ? "sem permissão para esta ação" : (e.message || e.code);
    toast("Erro: " + msg, true);
    return false;
  }
}

// Comprime a foto no próprio celular (≈ 100–300 KB) antes de gravar.
async function comprimir(file) {
  let img;
  try {
    img = await createImageBitmap(file);
  } catch {
    img = await new Promise((ok, erro) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = erro;
      i.src = URL.createObjectURL(file);
    });
  }
  const max = 1280;
  const r = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.round(img.width * r), h = Math.round(img.height * r);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  let q = 0.7, out = c.toDataURL("image/jpeg", q);
  while (out.length > 900000 && q > 0.3) { q -= 0.1; out = c.toDataURL("image/jpeg", q); }
  return out;
}

let XLSX = null;
async function xlsx() {
  if (!XLSX) XLSX = await import("https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs");
  return XLSX;
}

// ---------------------------------------------------------------------
// Rodízio: pontos, carga e "vez" de cada cadete
// ---------------------------------------------------------------------
function efetivo() {
  const ini = Date.parse(CICLO_INICIO + "T00:00:00");
  const agora = Date.now();
  return S.membros
    .filter((m) => m.ativo !== false)
    .map((m) => {
      const minhas = S.missoes.filter((x) => x.executor === m.id);
      const val = minhas.filter((x) => x.status === "validada");
      const pontos = val.filter((x) => (x.validadaEm || 0) >= ini).reduce((a, x) => a + (Number(x.peso) || 1), 0);
      const andamento = minhas.filter((x) => EM_ANDAMENTO.includes(x.status)).length;
      const ultima = val.reduce((a, x) => Math.max(a, x.validadaEm || 0), 0);
      const indisp = !!m.indisponivelAte && Date.parse(m.indisponivelAte + "T23:59:59") >= agora;
      return { ...m, pontos, concluidas: val.length, concluidasCiclo: val.filter((x) => (x.validadaEm || 0) >= ini).length, andamento, ultima, indisp };
    })
    .sort((a, b) => (a.indisp - b.indisp) || (a.pontos - b.pontos) || (a.andamento - b.andamento)
      || String(a.nome).localeCompare(String(b.nome)));
}
const daVez = () => efetivo().find((m) => !m.indisp);

// ---------------------------------------------------------------------
// Login e carregamento de dados
// ---------------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  S.unsub.forEach((u) => u());
  S.unsub = []; S.loaded = new Set(); S.me = null;
  if (!user) return renderLogin();
  const email = (user.email || "").toLowerCase();
  let snap = null;
  try { snap = await getDoc(doc(db, "membros", email)); } catch (e) { console.error(e); }
  if (!snap || !snap.exists() || snap.data().ativo === false) return renderSemAcesso(email);
  S.me = { id: email, ...snap.data() };
  $app.innerHTML = `<div class="centro"><p>Carregando…</p></div>`;
  startListeners();
});

function startListeners() {
  const L = (nome, ordenar) => {
    S.unsub.push(onSnapshot(collection(db, nome), (snap) => {
      S[nome] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (ordenar) S[nome].sort(ordenar);
      if (nome === "membros") {
        const me = S.membros.find((x) => x.id === S.me?.id);
        if (!me || me.ativo === false) return renderSemAcesso(S.me?.id);
        S.me = me;
      }
      S.loaded.add(nome);
      if (S.loaded.size >= 4 && !S.dirty) route();
    }, (err) => {
      console.error(err);
      toast(`Erro ao carregar ${nome}: ${err.code}`, true);
    }));
  };
  const porNome = (a, b) => String(a.nome).localeCompare(String(b.nome));
  L("membros", porNome);
  L("missoes", (a, b) => (b.criadaEm || 0) - (a.criadaEm || 0));
  L("materiais", porNome);
  L("locais", porNome);
}

function renderLogin() {
  $app.innerHTML = `<div class="centro login">
    <div class="brasoes"><img src="icons/apmg.png" alt="Brasão da APMG"><img src="icons/esfo.png" alt="Brasão da EsFO"></div>
    <div class="selo">${ic("raio")} Missão Elétrica</div>
    <h1>Gestão de Manutenção Elétrica</h1>
    <p>Escola de Formação de Oficiais · Academia Policial Militar do Guatupê</p>
    <button class="btn ouro" data-act="entrar">${ic("usuario")} Entrar com Google</button>
  </div>`;
}

function renderSemAcesso(email) {
  S.unsub.forEach((u) => u());
  S.unsub = []; S.me = null;
  $app.innerHTML = `<div class="centro">
    <h1>Acesso não liberado</h1>
    <p>A conta <b>${esc(email)}</b> não está na lista de integrantes da missão elétrica.</p>
    <p>Peça a um dos responsáveis da missão para cadastrar este e-mail.</p>
    <button class="btn sec" data-act="sair">Sair</button>
  </div>`;
}

// ---------------------------------------------------------------------
// Rotas e estrutura da tela
// ---------------------------------------------------------------------
window.addEventListener("hashchange", () => {
  S.dirty = false;
  route();
  window.scrollTo(0, 0);
});

function route() {
  if (!S.me) return;
  const p = location.hash.replace(/^#\/?/, "").split("/");
  const v = p[0] || "painel";
  S.cur = p[1] ? decodeURIComponent(p[1]) : null;
  const views = {
    painel: viewPainel, nova: viewNova, missao: () => viewMissao(S.cur),
    minhas: viewMinhas, efetivo: viewEfetivo, mais: viewMais,
    materiais: viewMateriais, relatorios: viewRelatorios, admin: viewAdmin,
  };
  (views[v] || viewPainel)();
}

function shell(titulo, corpo, ativo) {
  const itens = [["painel", "Painel", "painel"], ["nova", "Nova", "nova"], ["minhas", "Minhas", "minhas"], ["efetivo", "Efetivo", "efetivo"], ["mais", "Mais", "mais"]];
  $app.innerHTML = `
    <header class="topo">
      <img class="brasao" src="icons/apmg.png" alt="APMG">
      <div class="titulo"><small>Missão Elétrica · EsFO</small><h1>${esc(titulo)}</h1></div>
      <img class="brasao" src="icons/esfo.png" alt="EsFO">
    </header>
    <div class="faixa"><span>${ic("usuario")} ${esc(S.me.nome || S.me.id)}</span>${isCmd() ? '<b class="tag">RESPONSÁVEL</b>' : ""}</div>
    <main>${corpo}</main>
    <nav class="menu">${itens.map(([k, l, i]) => `<a href="#/${k}" class="${ativo === k ? "on" : ""}">${ic(i)}<span>${l}</span></a>`).join("")}</nav>`;
}

const opts = (lista, sel) => lista.map((o) => {
  const [v, l] = Array.isArray(o) ? o : [o, o];
  return `<option value="${esc(v)}" ${String(v) === String(sel) ? "selected" : ""}>${esc(l)}</option>`;
}).join("");

// ---------------------------------------------------------------------
// Painel de missões
// ---------------------------------------------------------------------
function cartao(m) {
  const parada = m.status === "painel" && Date.now() - (m.criadaEm || 0) > HORAS_ALERTA_PAINEL * 3600e3;
  return `<a class="card prio-${esc(m.prioridade)}" href="#/missao/${encodeURIComponent(m.id)}">
    <div class="tipo-ic">${ic(m.tipo)}</div><div class="card-corpo">
    <div class="linha-t"><b>${esc(m.titulo)}</b>
      ${m.risco ? '<span class="badge risco">RISCO</span>' : ""}
      ${parada ? '<span class="badge parada">PARADA</span>' : ""}</div>
    <div class="meta">${ic("local", "mini-ic")} ${esc(m.local)} · ${esc(prioNome(m.prioridade))} · peso ${Number(m.peso) || 1}</div>
    <div class="meta">${ic("usuario", "mini-ic")} ${m.executor ? "Executor: " + esc(nomeDe(m.executor)) : "Cadastrada por " + esc(nomeDe(m.criadoPor))} · ${fmtData(m.criadaEm)}</div>
  </div></a>`;
}

function ordenarMissoes(lista) {
  const ordem = { urgente: 0, alta: 1, media: 2, baixa: 3 };
  return lista.sort((a, b) => ((b.risco ? 1 : 0) - (a.risco ? 1 : 0))
    || ((ordem[a.prioridade] ?? 9) - (ordem[b.prioridade] ?? 9))
    || ((a.criadaEm || 0) - (b.criadaEm || 0)));
}

function viewPainel() {
  const abas = [["painel", "Painel"], ["em_execucao", "Execução"], ["aguardando_material", "Material"], ["concluida", "Validar"], ["validada", "Validadas"]];
  const tab = S.tab;
  let lista = S.missoes.filter((m) => m.status === tab && (!S.filtroTipo || m.tipo === S.filtroTipo));
  lista = tab === "validada"
    ? lista.sort((a, b) => (b.validadaEm || 0) - (a.validadaEm || 0)).slice(0, 50)
    : ordenarMissoes(lista);
  const vez = daVez();
  const paradas = S.missoes.filter((m) => m.status === "painel" && Date.now() - (m.criadaEm || 0) > HORAS_ALERTA_PAINEL * 3600e3);
  shell("Painel de Missões", `
    <div class="vez">${ic("estrela")} Na vez: <b>${vez ? esc(vez.nome) : "—"}</b>${vez ? ` <small>${vez.pontos} pts no ciclo</small>` : ""}</div>
    ${isCmd() && paradas.length ? `<div class="aviso">${ic("alerta")} ${paradas.length} missão(ões) parada(s) há mais de ${HORAS_ALERTA_PAINEL} h sem captura. Considere designar para <b>${vez ? esc(vez.nome) : "—"}</b>.</div>` : ""}
    <div class="abas">${abas.map(([k, l]) => `<button data-act="aba" data-aba="${k}" class="${k === tab ? "on" : ""}">${l} <small>${S.missoes.filter((m) => m.status === k).length}</small></button>`).join("")}</div>
    <select id="filtroTipo"><option value="">Todos os tipos</option>${opts(TIPOS, S.filtroTipo)}</select>
    ${lista.length ? lista.map(cartao).join("") : '<p class="vazio">Nenhuma missão aqui.</p>'}
  `, "painel");
}

// ---------------------------------------------------------------------
// Nova missão
// ---------------------------------------------------------------------
function viewNova() {
  shell("Nova missão", `
    <form id="fNova" class="form">
      <label>O que está com problema?*<input name="titulo" required maxlength="80" placeholder="Ex.: lâmpada queimada no corredor"></label>
      <label>Local*<input name="local" required list="listaLocais" placeholder="Ex.: Bloco A – Alojamento 3">
        <datalist id="listaLocais">${S.locais.map((l) => `<option value="${esc(l.nome)}">`).join("")}</datalist></label>
      <label>Tipo de serviço<select name="tipo">${opts(TIPOS)}</select></label>
      <div class="dupla">
        <label>Prioridade<select name="prioridade">${opts(PRIORIDADES, "media")}</select></label>
        <label>Peso<select name="peso">${opts(PESOS, 1)}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="risco"> Risco à segurança (fio exposto, cheiro de queimado, choque)</label>
      <label>Descrição<textarea name="descricao" rows="3" placeholder="Detalhes que ajudem quem vai executar"></textarea></label>
      <label>Materiais necessários (se souber)<input name="materiais" placeholder="Ex.: 2 lâmpadas LED 9 W"></label>
      <label>${ic("foto", "mini-ic")} Foto do problema<input type="file" name="foto" accept="image/*" capture="environment"></label>
      <button class="btn">${ic("nova")} Cadastrar missão</button>
    </form>`, "nova");
}

async function salvarNova(f) {
  const d = Object.fromEntries(new FormData(f));
  const local = d.local.trim();
  const abertas = S.missoes.filter((m) => ABERTAS.includes(m.status) && String(m.local).toLowerCase() === local.toLowerCase());
  if (abertas.length && !confirm(`Já existe(m) ${abertas.length} missão(ões) aberta(s) em "${local}":\n${abertas.map((m) => "• " + m.titulo).join("\n")}\n\nCadastrar mesmo assim?`)) return;
  const btn = f.querySelector("button"); btn.disabled = true; btn.textContent = "Salvando…";
  let novoId = null;
  const ok = await acao(async () => {
    const agora = Date.now();
    const ref = await addDoc(collection(db, "missoes"), {
      titulo: d.titulo.trim(), descricao: (d.descricao || "").trim(), local, tipo: d.tipo,
      prioridade: d.prioridade, peso: Number(d.peso) || 1, risco: !!d.risco,
      materiaisNecessarios: (d.materiais || "").trim(),
      status: "painel", executor: null, criadoPor: S.me.id, criadaEm: agora,
      historico: [{ em: agora, por: S.me.id, acao: "Cadastrou a missão" }],
    });
    novoId = ref.id;
    if (d.foto && d.foto.size) {
      await addDoc(collection(db, "fotos"), { missaoId: ref.id, tipo: "antes", img: await comprimir(d.foto), por: S.me.id, em: Date.now() });
    }
  }, "Missão cadastrada");
  btn.disabled = false; btn.innerHTML = `${ic("nova")} Cadastrar missão`;
  if (ok && novoId) { S.dirty = false; location.hash = "#/missao/" + novoId; }
}

// ---------------------------------------------------------------------
// Detalhe da missão
// ---------------------------------------------------------------------
function viewMissao(id) {
  const m = S.missoes.find((x) => x.id === id);
  if (!m) return shell("Missão", '<p class="vazio">Missão não encontrada.</p>', "painel");
  const souExec = m.executor === S.me.id;
  const final = ["validada", "arquivada"].includes(m.status);
  let acoes = "";

  if (m.status === "painel") {
    acoes += `<button class="btn" data-act="capturar">${ic("capturar")} Capturar missão</button>`;
    if (isCmd()) {
      const ef = efetivo().filter((x) => !x.indisp);
      acoes += `<div class="linha">
        <select id="designarSel">${ef.map((x, i) => `<option value="${esc(x.id)}">${i === 0 ? "★ " : ""}${esc(x.nome)} — ${x.pontos} pts, ${x.andamento} em andamento</option>`).join("")}</select>
        <button class="btn sec" data-act="designar">${ic("designar")} Designar</button></div>
        <button class="btn perigo" data-act="arquivar">${ic("arquivar")} Arquivar (duplicada)</button>`;
    }
  }
  if (m.status === "em_execucao" && (souExec || isCmd())) {
    acoes += `<button class="btn sec" data-act="esperar">${ic("esperar")} Aguardando material</button>`;
    if (souExec) acoes += formConcluir();
  }
  if (m.status === "aguardando_material" && (souExec || isCmd())) {
    acoes += `<button class="btn" data-act="retomar">${ic("retomar")} Material chegou — retomar</button>`;
  }
  if (m.status === "concluida" && isCmd()) {
    acoes += `<button class="btn verde" data-act="validar">${ic("validar")} Validar conclusão</button>
      <button class="btn perigo" data-act="reprovar">${ic("reprovar")} Reprovar (refazer)</button>`;
  }
  if (isCmd() && !final) {
    acoes += `<div class="box"><h3>Ajustes do responsável</h3><div class="dupla">
      <label>Prioridade<select id="cmdPrio">${opts(PRIORIDADES, m.prioridade)}</select></label>
      <label>Peso<select id="cmdPeso">${opts(PESOS, m.peso || 1)}</select></label></div>
      <button class="btn sec" data-act="ajustar">${ic("salvar")} Salvar ajustes</button></div>`;
  }

  const usados = (m.materiaisUsados || []).map((u) => `${u.qtd} ${esc(u.unidade)} ${esc(u.nome)}`).join(", ");
  const hist = [...(m.historico || [])].sort((a, b) => b.em - a.em);
  shell("Missão", `
    <div class="det">
      <div class="det-topo"><div class="tipo-ic grande">${ic(m.tipo)}</div><h2>${esc(m.titulo)}</h2></div>
      <div><span class="badge st-${m.status}">${STATUS[m.status] || m.status}</span>
        ${m.risco ? '<span class="badge risco">RISCO</span>' : ""}</div>
      ${m.descricao ? `<p>${esc(m.descricao)}</p>` : ""}
      <dl>
        <dt>Local</dt><dd>${esc(m.local)}</dd>
        <dt>Tipo</dt><dd>${esc(m.tipo)}</dd>
        <dt>Prioridade</dt><dd>${esc(prioNome(m.prioridade))} · peso ${Number(m.peso) || 1}</dd>
        <dt>Cadastrada</dt><dd>${esc(nomeDe(m.criadoPor))} em ${fmtDH(m.criadaEm)}</dd>
        <dt>Executor</dt><dd>${m.executor ? esc(nomeDe(m.executor)) + (m.designadoPor ? ` (designado por ${esc(nomeDe(m.designadoPor))})` : "") : "—"}</dd>
        ${m.materiaisNecessarios ? `<dt>Material previsto</dt><dd>${esc(m.materiaisNecessarios)}</dd>` : ""}
        ${m.status === "aguardando_material" && m.motivoEspera ? `<dt>Falta</dt><dd>${esc(m.motivoEspera)}</dd>` : ""}
        ${m.concluidaEm ? `<dt>Concluída</dt><dd>${fmtDH(m.concluidaEm)}${m.tempoMin ? ` · ${m.tempoMin} min` : ""}</dd>` : ""}
        ${usados ? `<dt>Material usado</dt><dd>${usados}</dd>` : ""}
        ${m.obs ? `<dt>Observações</dt><dd>${esc(m.obs)}</dd>` : ""}
        ${m.validadaEm ? `<dt>Validada</dt><dd>${esc(nomeDe(m.validadoPor))} em ${fmtDH(m.validadaEm)}</dd>` : ""}
      </dl>
      <h3>${ic("foto", "mini-ic")} Fotos</h3><div id="fotos" class="fotos"><p class="vazio">Carregando…</p></div>
      ${acoes ? `<div class="acoes">${acoes}</div>` : ""}
      <h3>${ic("calendario", "mini-ic")} Histórico</h3>
      <ul class="hist">${hist.map((h) => `<li><small>${fmtDH(h.em)}</small> ${esc(nomeDe(h.por))}: ${esc(h.acao)}</li>`).join("")}</ul>
    </div>`, "painel");
  carregarFotos(id);
}

async function carregarFotos(id) {
  try {
    if (!S.fotos[id]) {
      const q = await getDocs(query(collection(db, "fotos"), where("missaoId", "==", id)));
      S.fotos[id] = q.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.em - b.em);
    }
  } catch (e) { console.error(e); S.fotos[id] = []; }
  const el = document.getElementById("fotos");
  if (!el || S.cur !== id) return;
  const lista = S.fotos[id].filter((f) => String(f.img).startsWith("data:image/"));
  el.innerHTML = lista.length
    ? lista.map((f) => `<figure><img src="${f.img}" loading="lazy" data-act="zoom" alt="Foto ${esc(f.tipo)}"><figcaption>${esc(f.tipo)} · ${fmtData(f.em)}</figcaption></figure>`).join("")
    : '<p class="vazio">Sem fotos.</p>';
}

function formConcluir() {
  return `<form id="fConcluir" class="box destaque"><h3>${ic("concluir", "mini-ic")} Concluir missão</h3>
    <label>${ic("foto", "mini-ic")} Fotos do serviço concluído<input type="file" name="fotosDepois" accept="image/*" multiple></label>
    <div id="usados"></div>
    <button type="button" class="btn sec" data-act="addUsado">${ic("materiais")} Material usado</button>
    <label>Tempo gasto (min)<input type="number" name="tempo" min="0" inputmode="numeric"></label>
    <label>Observações<textarea name="obs" rows="2"></textarea></label>
    <button class="btn verde">${ic("concluir")} Concluir missão</button>
  </form>`;
}

async function concluir(f) {
  const files = [...f.fotosDepois.files];
  if (!files.length && !confirm("Concluir sem foto de depois?")) return;
  const usados = [...f.querySelectorAll(".usado")]
    .map((r) => ({ id: r.querySelector("select").value, qtd: Number(r.querySelector("input").value) }))
    .filter((u) => u.id && u.qtd > 0)
    .map((u) => {
      const mt = S.materiais.find((x) => x.id === u.id);
      return { ...u, nome: mt?.nome || u.id, unidade: mt?.unidade || "" };
    });
  const btn = f.querySelector("button:last-of-type"); btn.disabled = true; btn.textContent = "Enviando…";
  const id = S.cur;
  const ok = await acao(async () => {
    for (const file of files) {
      await addDoc(collection(db, "fotos"), { missaoId: id, tipo: "depois", img: await comprimir(file), por: S.me.id, em: Date.now() });
    }
    const b = writeBatch(db);
    b.update(doc(db, "missoes", id), {
      status: "concluida", concluidaEm: Date.now(), tempoMin: Number(f.tempo.value) || 0,
      obs: f.obs.value.trim(), materiaisUsados: usados, historico: H("Concluiu a missão"),
    });
    for (const u of usados) {
      b.update(doc(db, "materiais", u.id), { qtd: increment(-u.qtd), atualizadoEm: Date.now() });
      b.set(doc(collection(db, "movimentacoes")), { materialId: u.id, tipo: "saida", qtd: u.qtd, missaoId: id, por: S.me.id, em: Date.now() });
    }
    await b.commit();
  }, "Missão concluída — aguardando validação");
  delete S.fotos[id];
  if (ok) { S.dirty = false; route(); } else { btn.disabled = false; btn.innerHTML = `${ic("concluir")} Concluir missão`; }
}

// ---------------------------------------------------------------------
// Minhas missões e Efetivo
// ---------------------------------------------------------------------
function viewMinhas() {
  const eu = S.me.id;
  const meu = efetivo().find((x) => x.id === eu) || { pontos: 0, concluidas: 0, andamento: 0 };
  const and = ordenarMissoes(S.missoes.filter((m) => m.executor === eu && EM_ANDAMENTO.includes(m.status)));
  const cad = S.missoes.filter((m) => m.criadoPor === eu && ABERTAS.includes(m.status) && m.executor !== eu);
  const feitas = S.missoes.filter((m) => m.executor === eu && m.status === "validada").sort((a, b) => b.validadaEm - a.validadaEm);
  shell("Minhas missões", `
    <div class="stats">
      <div>${ic("estrela")}<b>${meu.pontos}</b><small>pontos no ciclo</small></div>
      <div>${ic("concluir")}<b>${meu.concluidas}</b><small>concluídas</small></div>
      <div>${ic("capturar")}<b>${meu.andamento}</b><small>em andamento</small></div>
    </div>
    <form id="fIndisp" class="box linha">
      <label>Indisponível até<input type="date" name="ate" value="${esc(S.me.indisponivelAte || "")}"></label>
      <button class="btn sec">${ic("salvar")} Salvar</button>
    </form>
    <h3>Em andamento</h3>${and.length ? and.map(cartao).join("") : '<p class="vazio">Nenhuma.</p>'}
    <h3>Cadastradas por mim (abertas)</h3>${cad.length ? cad.map(cartao).join("") : '<p class="vazio">Nenhuma.</p>'}
    <h3>Concluídas e validadas</h3>${feitas.length ? feitas.slice(0, 30).map(cartao).join("") : '<p class="vazio">Nenhuma ainda.</p>'}
  `, "minhas");
}

function viewEfetivo() {
  const ef = efetivo();
  shell("Efetivo", `
    <p class="dica">Ciclo desde ${fmtData(Date.parse(CICLO_INICIO + "T00:00:00"))}. A vez é de quem tem menos pontos; em empate, de quem tem menos missões em andamento.</p>
    <table class="tab">
      <tr><th>#</th><th>Cadete</th><th>Pts</th><th>Concl.</th><th>And.</th><th>Última</th></tr>
      ${ef.map((m, i) => `<tr class="${m.indisp ? "indisp" : ""}">
        <td>${m.indisp ? "—" : i + 1}</td>
        <td>${esc(m.nome)}${m.perfil === "comandante" ? ' <b class="tag">RESP</b>' : ""}${m.indisp ? `<br><small>indisponível até ${fmtData(Date.parse(m.indisponivelAte + "T12:00:00"))}</small>` : ""}</td>
        <td><b>${m.pontos}</b></td><td>${m.concluidas}</td><td>${m.andamento}</td><td>${fmtData(m.ultima)}</td></tr>`).join("")}
    </table>`, "efetivo");
}

function viewMais() {
  shell("Mais", `
    <div class="lista-links">
      <a href="#/materiais">${ic("materiais")}<span>Materiais e estoque<small>Estoque, entradas e lista de compras</small></span></a>
      <a href="#/relatorios">${ic("relatorios")}<span>Relatórios<small>Missões concluídas em PDF ou planilha</small></span></a>
      ${isCmd() ? `<a href="#/admin">${ic("admin")}<span>Administração<small>Integrantes, responsáveis e locais</small></span></a>` : ""}
      <button class="link" data-act="sair">${ic("sair")}<span>Sair<small>${esc(S.me.id)}</small></span></button>
    </div>
    <p class="dica">Para instalar no celular: no Chrome (Android), menu ⋮ › "Instalar app"; no Safari (iPhone), Compartilhar › "Adicionar à Tela de Início".</p>
  `, "mais");
}

// ---------------------------------------------------------------------
// Materiais
// ---------------------------------------------------------------------
// Categorias de material (ícone + palavras-chave para sugerir a categoria pelo nome)
const CATS_MAT = [
  ["Iluminação", "Iluminação", /lampada|reator|soquete|luminaria|refletor|plafon|led/],
  ["Tomadas e interruptores", "Tomadas e interruptores", /tomada|interruptor|placa|plugue|pino/],
  ["Fiação", "Fiação", /cabo|fio|fiacao|conector|wago|terminal|ilhos|fita|emenda/],
  ["Disjuntores e quadros", "Quadros e disjuntores", /disjuntor|\bdr\b|quadro|barramento|dps/],
  ["Chuveiros", "Chuveiros", /chuveiro|resistencia|ducha/],
  ["Ventiladores", "Ventiladores e equipamentos", /ventilador|capacitor|exaustor/],
  ["Eletrodutos e caixas", "materiais", /eletroduto|condulete|caixa|curva|luva|abracadeira|conduite/],
  ["Outros", "Outros", /$^/],
];
const NOMES_CATS = CATS_MAT.map(([n]) => n);
const semAcento = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function inferirCategoria(nome) {
  const n = semAcento(nome);
  if (/^(cabo|fio|fita|conector|terminal)/.test(n)) return "Fiação";
  // Itens mais específicos primeiro (ex.: "ventilador de teto com luminária" é Ventilador)
  const ordem = ["Chuveiros", "Ventiladores", "Disjuntores e quadros", "Iluminação", "Tomadas e interruptores", "Eletrodutos e caixas", "Fiação"];
  const c = ordem.map((o) => CATS_MAT.find(([x]) => x === o)).find(([, , re]) => re.test(n));
  return c ? c[0] : "Outros";
}
const catDe = (m) => (NOMES_CATS.includes(m.categoria) ? m.categoria : inferirCategoria(m.nome));
const baixo = (m) => Number(m.qtd) < Number(m.min || 0);

function itemMaterial(m) {
  const aberto = S.matSel === m.id;
  return `<div class="mat-item ${baixo(m) ? "baixo" : ""} ${aberto ? "aberto" : ""}" data-busca="${esc(semAcento(m.nome))}">
    <button class="mat-linha" data-act="matItem" data-id="${esc(m.id)}">
      <span class="mat-nome">${esc(m.nome)}</span>
      <span class="mat-qtd">${baixo(m) ? ic("alerta", "mini-ic") : ""} ${m.qtd} ${esc(m.unidade)}</span>
    </button>
    ${aberto ? `<div class="mat-det">
      <div class="mat-info">
        <div><small>Em estoque</small><b>${m.qtd} ${esc(m.unidade)}</b></div>
        <div><small>Mínimo</small><b>${m.min || 0} ${esc(m.unidade)}</b></div>
        <div><small>Categoria</small><b>${esc(catDe(m))}</b></div>
      </div>
      ${baixo(m) ? `<p class="dica">${ic("alerta", "mini-ic")} Abaixo do mínimo: faltam ${Number(m.min) - Number(m.qtd)} ${esc(m.unidade)}.</p>` : ""}
      ${isCmd() ? `<div class="linha">
        <button class="btn" data-act="entrada" data-id="${esc(m.id)}">${ic("entrada")} Entrada</button>
        <button class="btn sec" data-act="ajustarMat" data-id="${esc(m.id)}">${ic("salvar")} Ajustar</button>
        <button class="btn perigo" data-act="delMat" data-id="${esc(m.id)}">${ic("excluir")} Excluir</button>
      </div>` : ""}
    </div>` : ""}
  </div>`;
}

function viewMateriais() {
  S.matAbertos ||= new Set();
  const faltando = S.materiais.filter(baixo);
  const grupos = NOMES_CATS.map((nome) => ({
    nome, icone: CATS_MAT.find(([n]) => n === nome)[1],
    itens: S.materiais.filter((m) => catDe(m) === nome),
  })).filter((g) => g.itens.length);
  const painel = S.matPainel;
  shell("Materiais", `
    <div class="mat-acoes">
      ${isCmd() ? `<button class="btn ${painel === "novo" ? "" : "sec"}" data-act="matPainel" data-p="novo">${ic("nova")} Novo material</button>
      <button class="btn ${painel === "importar" ? "" : "sec"}" data-act="matPainel" data-p="importar">${ic("importar")} Importar</button>` : ""}
      <button class="btn sec" data-act="exportar" data-tipo="materiais">${ic("exportar")} Exportar</button>
    </div>
    ${painel === "novo" && isCmd() ? `
    <form id="fMaterial" class="box"><h3>${ic("nova", "mini-ic")} Cadastrar ou atualizar material</h3>
      <label>Nome*<input name="nome" required placeholder="Ex.: Lâmpada LED 9 W"></label>
      <label>Categoria<select name="categoria"><option value="">Automática (pelo nome)</option>${opts(NOMES_CATS)}</select></label>
      <div class="dupla">
        <label>Unidade<input name="unidade" value="un"></label>
        <label>Quantidade<input name="qtd" type="number" min="0" step="any" value="0"></label>
        <label>Mínimo<input name="min" type="number" min="0" step="any" value="0"></label>
      </div>
      <button class="btn">${ic("salvar")} Salvar material</button>
      <button type="button" class="btn sec" data-act="matPainel" data-p="">Cancelar</button>
    </form>` : ""}
    ${painel === "importar" && isCmd() ? painelImport("materiais") : ""}
    ${faltando.length ? `<details class="aviso compras"><summary>${ic("alerta")} <b>${faltando.length} item(ns) abaixo do mínimo</b> · ver lista de compras</summary>
      <ul>${faltando.map((m) => `<li>${esc(m.nome)}: tem ${m.qtd} ${esc(m.unidade)}, mínimo ${m.min}</li>`).join("")}</ul></details>` : ""}
    ${S.materiais.length ? `
    <div class="busca">${ic("relatorios", "mini-ic")}<input id="matBusca" type="search" placeholder="Buscar material (ex.: disjuntor)" autocomplete="off"></div>
    <div id="matGrupos">
    ${grupos.map((g) => {
      const nBaixo = g.itens.filter(baixo).length;
      return `<details class="grupo" data-grupo="${esc(g.nome)}" ${S.matAbertos.has(g.nome) ? "open" : ""}>
        <summary><span class="tipo-ic">${ic(g.icone)}</span>
          <span class="grupo-nome">${esc(g.nome)}<small>${g.itens.length} ${g.itens.length === 1 ? "item" : "itens"}</small></span>
          ${nBaixo ? `<span class="badge parada">${nBaixo} abaixo</span>` : ""}
          <span class="seta">›</span></summary>
        <div class="grupo-itens">${g.itens.map(itemMaterial).join("")}</div>
      </details>`;
    }).join("")}
    </div>
    <p class="vazio" id="matNada" hidden>Nenhum material encontrado.</p>` : '<p class="vazio">Nenhum material cadastrado.</p>'}
  `, "mais");
  // Lembra quais grupos ficaram abertos
  document.querySelectorAll("details.grupo").forEach((d) => d.addEventListener("toggle", () => {
    if (document.getElementById("matBusca")?.value) return;
    d.open ? S.matAbertos.add(d.dataset.grupo) : S.matAbertos.delete(d.dataset.grupo);
  }));
}

function filtrarMateriais(texto) {
  const t = semAcento(texto.trim());
  let total = 0;
  document.querySelectorAll("details.grupo").forEach((g) => {
    let n = 0;
    g.querySelectorAll(".mat-item").forEach((it) => {
      const ok = !t || it.dataset.busca.includes(t);
      it.hidden = !ok;
      if (ok) n++;
    });
    g.hidden = n === 0;
    g.open = t ? n > 0 : S.matAbertos.has(g.dataset.grupo);
    total += n;
  });
  const nada = document.getElementById("matNada");
  if (nada) nada.hidden = total > 0;
}

// ---------------------------------------------------------------------
// Relatórios
// ---------------------------------------------------------------------
function viewRelatorios() {
  S.rel ||= { de: CICLO_INICIO, ate: hojeISO(), cadete: "" };
  const { de, ate, cadete } = S.rel;
  const ini = Date.parse(de + "T00:00:00"), fim = Date.parse(ate + "T23:59:59");
  const lista = S.missoes
    .filter((m) => m.status === "validada" && m.validadaEm >= ini && m.validadaEm <= fim && (!cadete || m.executor === cadete))
    .sort((a, b) => a.validadaEm - b.validadaEm);
  const pontos = lista.reduce((a, m) => a + (Number(m.peso) || 1), 0);
  const porCadete = {};
  lista.forEach((m) => { porCadete[m.executor] = (porCadete[m.executor] || 0) + 1; });
  shell("Relatórios", `
    <div class="filtros no-print">
      <label>De<input type="date" id="relDe" value="${esc(de)}"></label>
      <label>Até<input type="date" id="relAte" value="${esc(ate)}"></label>
      <label>Cadete<select id="relCadete"><option value="">Todos</option>${opts(S.membros.map((m) => [m.id, m.nome]), cadete)}</select></label>
    </div>
    <div class="impresso">
      <div class="cab-rel"><img src="icons/apmg.png" alt=""><div><b>Academia Policial Militar do Guatupê · Escola de Formação de Oficiais</b><h2>Relatório de missões concluídas — Missão Elétrica</h2></div><img src="icons/esfo.png" alt=""></div>
      <p>Período: ${fmtData(ini)} a ${fmtData(fim)}${cadete ? " · Cadete: " + esc(nomeDe(cadete)) : ""} · ${lista.length} missões · ${pontos} pontos</p>
      ${!cadete && lista.length ? `<p><b>Por cadete:</b> ${Object.entries(porCadete).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${esc(nomeDe(e))} (${n})`).join(", ")}</p>` : ""}
      <table class="tab">
        <tr><th>Data</th><th>Missão</th><th>Local</th><th>Executor</th><th>Material usado</th></tr>
        ${lista.map((m) => `<tr><td>${fmtData(m.validadaEm)}</td><td>${esc(m.titulo)}<br><small>${esc(m.tipo)} · peso ${Number(m.peso) || 1}</small></td>
          <td>${esc(m.local)}</td><td>${esc(nomeDe(m.executor))}</td>
          <td>${(m.materiaisUsados || []).map((u) => `${u.qtd} ${esc(u.unidade)} ${esc(u.nome)}`).join(", ") || "—"}</td></tr>`).join("")}
      </table>
      ${lista.length ? "" : '<p class="vazio">Nenhuma missão validada no período.</p>'}
    </div>
    <div class="linha no-print">
      <button class="btn" data-act="imprimir">${ic("imprimir")} Gerar PDF / Imprimir</button>
      <button class="btn sec" data-act="exportar" data-tipo="relatorio">${ic("exportar")} Exportar planilha</button>
    </div>`, "mais");
}

// ---------------------------------------------------------------------
// Administração (comandantes)
// ---------------------------------------------------------------------
function viewAdmin() {
  if (!isCmd()) return viewMais();
  shell("Administração", `
    <h3>Integrantes da missão (${S.membros.length})</h3>
    <table class="tab">
      <tr><th>Nome / e-mail</th><th>Perfil</th><th>Ativo</th><th></th></tr>
      ${S.membros.map((m) => `<tr>
        <td>${esc(m.nome)}<br><small>${esc(m.id)}</small></td>
        <td><select data-perfil="${esc(m.id)}" ${m.id === S.me.id ? 'disabled title="Você não pode alterar o próprio perfil"' : ""}>${opts([["cadete", "Cadete"], ["comandante", "Responsável"]], m.perfil)}</select></td>
        <td><input type="checkbox" data-ativo="${esc(m.id)}" ${m.ativo !== false ? "checked" : ""} ${m.id === S.me.id ? "disabled" : ""}></td>
        <td>${m.id !== S.me.id ? `<button class="mini perigo" data-act="delMembro" data-id="${esc(m.id)}" title="Remover">${ic("excluir", "mini-ic")}</button>` : ""}</td></tr>`).join("")}
    </table>
    <form id="fMembro" class="box"><h3>Incluir integrante</h3>
      <label>E-mail Google*<input name="email" type="email" required placeholder="nome@gmail.com"></label>
      <label>Nome de guerra*<input name="nome" required placeholder="Cad. Fulano"></label>
      <label>Perfil<select name="perfil">${opts([["cadete", "Cadete"], ["comandante", "Responsável"]])}</select></label>
      <button class="btn">${ic("designar")} Incluir</button>
    </form>
    ${painelImport("membros")}
    <h3>Locais (${S.locais.length})</h3>
    <ul class="locais">${S.locais.map((l) => `<li>${esc(l.nome)} <button class="mini perigo" data-act="delLocal" data-id="${esc(l.id)}" title="Remover">${ic("excluir", "mini-ic")}</button></li>`).join("")}</ul>
    <form id="fLocal" class="box linha">
      <label>Novo local<input name="nome" required placeholder="Ex.: Bloco B – Sala de aula 2"></label>
      <button class="btn sec">${ic("local")} Incluir</button>
    </form>
    ${painelImport("locais")}
  `, "mais");
}

// ---------------------------------------------------------------------
// Importação e exportação de planilhas
// ---------------------------------------------------------------------
const MODELOS = {
  materiais: {
    titulo: "materiais", cab: ["Nome", "Unidade", "Quantidade", "Minimo", "Categoria"],
    conv: (r) => {
      const nome = String(r.nome ?? "").trim();
      if (!nome) return { erro: "sem nome" };
      const qtd = Number(String(r.quantidade ?? 0).replace(",", "."));
      const min = Number(String(r.minimo ?? 0).replace(",", "."));
      if (!(qtd >= 0)) return { erro: `quantidade inválida (${r.quantidade})` };
      const unidade = String(r.unidade || "un").trim();
      const cInf = String(r.categoria ?? "").trim();
      const categoria = NOMES_CATS.find((c) => semAcento(c) === semAcento(cInf)) || inferirCategoria(nome);
      return { id: slug(nome), dados: { nome, unidade, qtd, min: min >= 0 ? min : 0, categoria, atualizadoEm: Date.now() }, prev: [nome, unidade, qtd, min || 0, categoria] };
    },
  },
  membros: {
    titulo: "integrantes", cab: ["Email", "Nome", "Perfil"],
    conv: (r) => {
      const email = String(r.email ?? "").trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return { erro: `e-mail inválido (${r.email})` };
      const perfil = /respons|coman|cmt/i.test(String(r.perfil ?? "")) ? "comandante" : "cadete";
      const nome = String(r.nome || email).trim();
      return { id: email, dados: { nome, perfil, ativo: true }, prev: [email, nome, perfil] };
    },
  },
  locais: {
    titulo: "locais", cab: ["Nome"],
    conv: (r) => {
      const nome = String(r.nome ?? "").trim();
      if (!nome) return { erro: "sem nome" };
      return { id: slug(nome), dados: { nome }, prev: [nome] };
    },
  },
};

function painelImport(tipo) {
  const M = MODELOS[tipo];
  return `<div class="box"><h3>Importar ${M.titulo} de planilha</h3>
    <p class="dica">Colunas: ${M.cab.join(", ")}. Itens já cadastrados são atualizados, sem duplicar.${tipo === "materiais" ? " A quantidade da planilha substitui o estoque atual." : ""}</p>
    <div class="linha">
      <button class="btn sec" data-act="modelo" data-tipo="${tipo}">${ic("exportar")} Baixar modelo</button>
      <label class="btn sec arquivo">${ic("importar")} Escolher planilha<input type="file" accept=".xlsx,.xls,.csv" data-import="${tipo}" hidden></label>
    </div>
    <div id="prev-${tipo}"></div></div>`;
}

const normChaves = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [slug(k).replace(/-/g, ""), v]));

async function lerPlanilha(input) {
  const tipo = input.dataset.import, M = MODELOS[tipo];
  const file = input.files[0];
  if (!file) return;
  const X = await xlsx();
  const wb = X.read(await file.arrayBuffer());
  const linhas = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  const res = linhas.map((r, i) => ({ linha: i + 2, ...M.conv(normChaves(r)) }));
  const ok = res.filter((r) => !r.erro), erros = res.filter((r) => r.erro);
  S.importPend = { tipo, ok };
  S.dirty = true;
  document.getElementById("prev-" + tipo).innerHTML = `
    <p>${ok.length} linha(s) válida(s)${erros.length ? `, ${erros.length} com erro (serão ignoradas):` : "."}</p>
    ${erros.length ? `<ul class="erros">${erros.map((r) => `<li>Linha ${r.linha}: ${esc(r.erro)}</li>`).join("")}</ul>` : ""}
    ${ok.length ? `<table class="tab"><tr>${M.cab.map((c) => `<th>${c}</th>`).join("")}</tr>
      ${ok.slice(0, 30).map((r) => `<tr>${r.prev.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</table>
      ${ok.length > 30 ? `<p class="dica">… e mais ${ok.length - 30}.</p>` : ""}
      <button class="btn" data-act="confirmarImport">${ic("salvar")} Gravar ${ok.length} registro(s)</button>` : ""}`;
}

async function confirmarImport() {
  const { tipo, ok } = S.importPend || {};
  if (!ok?.length) return;
  const sucesso = await acao(async () => {
    for (let i = 0; i < ok.length; i += 400) {
      const b = writeBatch(db);
      ok.slice(i, i + 400).forEach((r) => b.set(doc(db, tipo, r.id), r.dados, { merge: true }));
      await b.commit();
    }
  }, `${ok.length} registro(s) importado(s)`);
  if (sucesso) { S.importPend = null; S.dirty = false; S.matPainel = null; route(); }
}

async function baixarModelo(tipo) {
  const X = await xlsx();
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([MODELOS[tipo].cab]), "Dados");
  X.writeFile(wb, `modelo-${tipo}.xlsx`);
}

async function exportar(tipo) {
  const X = await xlsx();
  let linhas, nome;
  if (tipo === "materiais") {
    linhas = S.materiais.map((m) => ({ Nome: m.nome, Unidade: m.unidade, Quantidade: m.qtd, Minimo: m.min || 0, Categoria: catDe(m) }));
    nome = `materiais-${hojeISO()}.xlsx`;
  } else {
    const { de, ate, cadete } = S.rel;
    const ini = Date.parse(de + "T00:00:00"), fim = Date.parse(ate + "T23:59:59");
    linhas = S.missoes
      .filter((m) => m.status === "validada" && m.validadaEm >= ini && m.validadaEm <= fim && (!cadete || m.executor === cadete))
      .sort((a, b) => a.validadaEm - b.validadaEm)
      .map((m) => ({
        "Validada em": fmtData(m.validadaEm), Missão: m.titulo, Tipo: m.tipo, Local: m.local,
        Executor: nomeDe(m.executor), Peso: Number(m.peso) || 1, "Cadastrada por": nomeDe(m.criadoPor),
        "Cadastrada em": fmtData(m.criadaEm), "Concluída em": fmtData(m.concluidaEm), "Tempo (min)": m.tempoMin || "",
        "Material usado": (m.materiaisUsados || []).map((u) => `${u.qtd} ${u.unidade} ${u.nome}`).join("; "),
        Observações: m.obs || "",
      }));
    nome = `relatorio-missoes-${de}-a-${ate}.xlsx`;
  }
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.json_to_sheet(linhas), "Dados");
  X.writeFile(wb, nome);
}

// Impede alterar o próprio cadastro e deixar a missão sem comandante ativo.
function protegeComandante(email, vaiPerderComando) {
  if (!vaiPerderComando) return true;
  if (email === S.me.id) { toast("Você não pode remover o seu próprio acesso de responsável.", true); return false; }
  const alvo = S.membros.find((m) => m.id === email);
  if (alvo?.perfil !== "comandante") return true;
  const cmdsAtivos = S.membros.filter((m) => m.perfil === "comandante" && m.ativo !== false);
  if (alvo?.perfil === "comandante" && alvo.ativo !== false && cmdsAtivos.length <= 1) {
    toast("A missão precisa de pelo menos um responsável ativo.", true);
    return false;
  }
  return confirm(`Confirma tirar o acesso de responsável de ${alvo?.nome || email}?`);
}

// ---------------------------------------------------------------------
// Ações (botões com data-act)
// ---------------------------------------------------------------------
const upd = (dados, msg) => acao(() => updateDoc(doc(db, "missoes", S.cur), dados), msg);

const ACOES = {
  entrar: async () => {
    const p = new GoogleAuthProvider();
    p.setCustomParameters({ prompt: "select_account" });
    try { await signInWithPopup(auth, p); } catch (e) {
      if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"].includes(e.code)) await signInWithRedirect(auth, p);
      else if (e.code !== "auth/popup-closed-by-user") toast("Erro no login: " + e.code, true);
    }
  },
  sair: () => signOut(auth),
  aba: (b) => { S.tab = b.dataset.aba; route(); },
  zoom: (b) => b.closest("figure").classList.toggle("zoom"),
  capturar: () => upd({ status: "em_execucao", executor: S.me.id, capturadaEm: Date.now(), historico: H("Capturou a missão") }, "Missão capturada. Boa execução!"),
  designar: () => {
    const sel = document.getElementById("designarSel").value;
    if (!sel) return;
    return upd({ status: "em_execucao", executor: sel, capturadaEm: Date.now(), designadoPor: S.me.id, historico: H("Designou para " + nomeDe(sel)) }, "Missão designada");
  },
  arquivar: () => confirm("Arquivar esta missão como duplicada?") && upd({ status: "arquivada", historico: H("Arquivou a missão (duplicada)") }, "Missão arquivada"),
  esperar: () => {
    const motivo = prompt("O que está faltando?");
    if (motivo === null) return;
    return upd({ status: "aguardando_material", motivoEspera: motivo.trim(), historico: H("Aguardando material: " + motivo.trim()) }, "Missão em espera");
  },
  retomar: () => upd({ status: "em_execucao", motivoEspera: "", historico: H("Retomou a execução") }, "Execução retomada"),
  validar: () => upd({ status: "validada", validadaEm: Date.now(), validadoPor: S.me.id, historico: H("Validou a conclusão") }, "Missão validada"),
  reprovar: () => {
    const motivo = prompt("Motivo da reprovação (o que refazer)?");
    if (!motivo) return;
    return upd({ status: "em_execucao", historico: H("Reprovou: " + motivo.trim()) }, "Missão devolvida para execução");
  },
  ajustar: () => upd({
    prioridade: document.getElementById("cmdPrio").value,
    peso: Number(document.getElementById("cmdPeso").value) || 1,
    historico: H("Ajustou prioridade/peso"),
  }, "Ajustes salvos"),
  addUsado: () => {
    S.dirty = true;
    const div = document.createElement("div");
    div.className = "usado linha";
    div.innerHTML = `<select><option value="">Material…</option>${S.materiais.map((m) => `<option value="${esc(m.id)}">${esc(m.nome)} (${m.qtd} ${esc(m.unidade)})</option>`).join("")}</select>
      <input type="number" min="0" step="any" placeholder="Qtd" inputmode="decimal">`;
    document.getElementById("usados").appendChild(div);
  },
  entrada: (b) => {
    const m = S.materiais.find((x) => x.id === b.dataset.id);
    const q = Number(String(prompt(`Quantidade recebida de "${m.nome}" (${m.unidade}):`) || "").replace(",", "."));
    if (!(q > 0)) return;
    return acao(async () => {
      const batch = writeBatch(db);
      batch.update(doc(db, "materiais", m.id), { qtd: increment(q), atualizadoEm: Date.now() });
      batch.set(doc(collection(db, "movimentacoes")), { materialId: m.id, tipo: "entrada", qtd: q, por: S.me.id, em: Date.now() });
      await batch.commit();
    }, "Entrada registrada");
  },
  matItem: (b) => { S.matSel = S.matSel === b.dataset.id ? null : b.dataset.id; const busca = document.getElementById("matBusca")?.value || ""; route(); if (busca) { document.getElementById("matBusca").value = busca; filtrarMateriais(busca); } },
  matPainel: (b) => { S.matPainel = S.matPainel === b.dataset.p ? null : (b.dataset.p || null); S.dirty = false; route(); },
  ajustarMat: (b) => {
    const m = S.materiais.find((x) => x.id === b.dataset.id);
    const v = prompt(`Quantidade correta em estoque de "${m.nome}" (${m.unidade}):`, m.qtd);
    if (v === null) return;
    const q = Number(String(v).replace(",", "."));
    if (!(q >= 0)) return toast("Quantidade inválida", true);
    return acao(async () => {
      const batch = writeBatch(db);
      batch.update(doc(db, "materiais", m.id), { qtd: q, atualizadoEm: Date.now() });
      batch.set(doc(collection(db, "movimentacoes")), { materialId: m.id, tipo: "ajuste", qtd: q - Number(m.qtd), por: S.me.id, em: Date.now() });
      await batch.commit();
    }, "Estoque ajustado");
  },
  delMat: (b) => confirm("Excluir este material?") && acao(() => deleteDoc(doc(db, "materiais", b.dataset.id)), "Material excluído"),
  delMembro: (b) => protegeComandante(b.dataset.id, true) && confirm(`Remover ${b.dataset.id} da missão?`) && acao(() => deleteDoc(doc(db, "membros", b.dataset.id)), "Integrante removido"),
  delLocal: (b) => acao(() => deleteDoc(doc(db, "locais", b.dataset.id)), "Local removido"),
  modelo: (b) => baixarModelo(b.dataset.tipo),
  exportar: (b) => exportar(b.dataset.tipo),
  confirmarImport,
  imprimir: () => window.print(),
};

$app.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !ACOES[b.dataset.act]) return;
  e.preventDefault();
  if (b.tagName === "BUTTON") b.disabled = true;
  try { await ACOES[b.dataset.act](b); } finally { if (b.isConnected && b.tagName === "BUTTON") b.disabled = false; }
});

// ---------------------------------------------------------------------
// Formulários
// ---------------------------------------------------------------------
const FORMS = {
  fNova: salvarNova,
  fConcluir: concluir,
  fIndisp: (f) => acao(() => updateDoc(doc(db, "membros", S.me.id), { indisponivelAte: f.ate.value || null }),
    f.ate.value ? "Indisponibilidade registrada" : "Indisponibilidade removida").then(() => { S.dirty = false; }),
  fMaterial: (f) => {
    const d = Object.fromEntries(new FormData(f));
    const nome = d.nome.trim();
    return acao(() => setDoc(doc(db, "materiais", slug(nome)), {
      nome, unidade: d.unidade.trim() || "un", qtd: Number(d.qtd) || 0, min: Number(d.min) || 0,
      categoria: d.categoria || inferirCategoria(nome), atualizadoEm: Date.now(),
    }, { merge: true }), "Material salvo").then((ok) => { if (ok) { S.dirty = false; S.matPainel = null; route(); } });
  },
  fMembro: (f) => {
    const d = Object.fromEntries(new FormData(f));
    const email = d.email.trim().toLowerCase();
    return acao(() => setDoc(doc(db, "membros", email), { nome: d.nome.trim(), perfil: d.perfil, ativo: true }, { merge: true }),
      "Integrante incluído").then((ok) => { if (ok) { S.dirty = false; route(); } });
  },
  fLocal: (f) => {
    const nome = f.nome.value.trim();
    return acao(() => setDoc(doc(db, "locais", slug(nome)), { nome }), "Local incluído").then((ok) => { if (ok) { S.dirty = false; route(); } });
  },
};

$app.addEventListener("submit", (e) => {
  const h = FORMS[e.target.id];
  if (!h) return;
  e.preventDefault();
  h(e.target);
});

$app.addEventListener("input", (e) => {
  if (e.target.id === "matBusca") return filtrarMateriais(e.target.value);
  if (e.target.closest("form")) S.dirty = true;
});

$app.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.id === "filtroTipo") { S.filtroTipo = t.value; route(); }
  else if (["relDe", "relAte", "relCadete"].includes(t.id)) {
    S.rel = { de: document.getElementById("relDe").value || CICLO_INICIO, ate: document.getElementById("relAte").value || hojeISO(), cadete: document.getElementById("relCadete").value };
    route();
  } else if (t.dataset.import) await lerPlanilha(t);
  else if (t.dataset.perfil) {
    if (!protegeComandante(t.dataset.perfil, t.value !== "comandante")) { t.value = "comandante"; return; }
    acao(() => updateDoc(doc(db, "membros", t.dataset.perfil), { perfil: t.value }), "Perfil alterado");
  } else if (t.dataset.ativo) {
    if (!protegeComandante(t.dataset.ativo, !t.checked)) { t.checked = true; return; }
    acao(() => updateDoc(doc(db, "membros", t.dataset.ativo), { ativo: t.checked }), t.checked ? "Integrante reativado" : "Integrante desativado");
  }
});

// Service worker (permite instalar como app no celular)
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

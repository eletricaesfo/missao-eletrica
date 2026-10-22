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
  increment, arrayUnion, runTransaction, getCountFromServer, getAggregateFromServer, sum, count,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  firebaseConfig, CICLO_INICIO, HORAS_ALERTA_PAINEL, TIPOS, PRIORIDADES, PESOS,
  ORIGENS, MOTIVOS_SEM_EXEC, TEXTO_COMPRAS,
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
  membros: [], missoes: [], materiais: [], locais: [], compras: [],
  unsub: [], loaded: new Set(),
  dirty: false,        // há formulário sendo preenchido (não redesenhar a tela)
  cur: null,           // id da missão aberta
  fotos: {},           // cache de fotos por missão
  tab: "painel", filtroTipo: "",
  rel: null, importPend: null,
  designar: null,      // janela "Designar para…" aberta: {id da missão, sel: e-mail escolhido}
};

const STATUS = {
  painel: "No painel",
  em_execucao: "Em execução",
  aguardando_material: "Aguardando material",
  concluida: "Aguardando validação",
  validada: "Validada",
  sem_execucao: "Encerrada sem execução",
  arquivada: "Arquivada",
};
const FINAIS = ["validada", "sem_execucao", "arquivada"];
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

// Origem da demanda (como o problema chegou à missão) e motivo do encerramento sem execução
const origemNome = (k) => (ORIGENS.find(([c]) => c === k) || [k, k ? k : "Não informada"])[1];
const origemTexto = (m) => {
  if (!m.origem) return "Não informada";
  const det = m.origem === "dia_a_esfo" && /^\d{4}-\d{2}-\d{2}$/.test(m.origemDetalhe || "")
    ? fmtData(Date.parse(m.origemDetalhe + "T12:00:00")) : m.origemDetalhe;
  return origemNome(m.origem) + (det ? ` — ${det}` : "");
};
const motivoNome = (k) => (MOTIVOS_SEM_EXEC.find(([c]) => c === k) || [k, k || "—"])[1];
const FOTO_TIPO = { antes: "antes", depois: "depois", verificacao: "verificação" };

// Campo complementar da origem (aparece conforme a opção escolhida no cadastro)
function campoOrigem(cod) {
  const o = ORIGENS.find(([c]) => c === cod);
  if (!o || !o[2]) return "";
  if (cod === "dia_a_esfo") return `<label>${esc(o[2])}*<input type="date" name="origemDetalhe" required value="${hojeISO()}" max="${hojeISO()}"></label>`;
  return `<label>${esc(o[2])}*<input name="origemDetalhe" required maxlength="80"></label>`;
}

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
// Aceita foto da câmera ou da galeria; sempre grava em JPEG (converte HEIC/PNG/WebP).
async function comprimir(file) {
  let img;
  try {
    img = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      img = await new Promise((ok, erro) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = erro;
        i.src = url;
      });
    } catch {
      throw new Error(`não foi possível abrir a foto "${file.name}". Escolha outra imagem ou tire a foto pela câmera.`);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
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
      // Encerradas sem execução não dão pontos no rodízio: são contadas à parte.
      const semExec = minhas.filter((x) => x.status === "sem_execucao").length;
      return { ...m, pontos, concluidas: val.length, concluidasCiclo: val.filter((x) => (x.validadaEm || 0) >= ini).length, andamento, ultima, indisp, semExec };
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
      if (S.loaded.size >= 5 && !S.dirty) route();
      if (S.loaded.size >= 5 && !S.armazChecado && isCmd()) { S.armazChecado = true; avisoArmazenamento(); }
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
  L("compras", (a, b) => (b.em || 0) - (a.em || 0));
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
  S.dirty = false; S.designar = null; S.semExec = null;
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
  const abas = [["painel", "Painel"], ["em_execucao", "Execução"], ["aguardando_material", "Material"], ["concluida", "Validar"], ["validada", "Validadas"], ["sem_execucao", "Sem execução"]];
  const tab = S.tab;
  let lista = S.missoes.filter((m) => m.status === tab && (!S.filtroTipo || m.tipo === S.filtroTipo));
  lista = tab === "validada"
    ? lista.sort((a, b) => (b.validadaEm || 0) - (a.validadaEm || 0)).slice(0, 50)
    : tab === "sem_execucao"
      ? lista.sort((a, b) => (b.semExecEm || 0) - (a.semExecEm || 0)).slice(0, 50)
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
      <label>Como o problema chegou à missão?*<select name="origem" required>
        <option value="" selected disabled>Selecione…</option>${opts(ORIGENS.map(([c, n]) => [c, n]))}</select></label>
      <div id="origemDet"></div>
      <label>Tipo de serviço<select name="tipo">${opts(TIPOS)}</select></label>
      <div class="dupla">
        <label>Prioridade<select name="prioridade">${opts(PRIORIDADES, "media")}</select></label>
        <label>Peso<select name="peso">${opts(PESOS, 1)}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="risco"> Risco à segurança (fio exposto, cheiro de queimado, choque)</label>
      <label>Descrição<textarea name="descricao" rows="3" placeholder="Detalhes que ajudem quem vai executar"></textarea></label>
      <label>Materiais necessários (se souber)<input name="materiais" placeholder="Ex.: 2 lâmpadas LED 9 W"></label>
      <label>${ic("foto", "mini-ic")} Foto do problema<input type="file" name="foto" accept="image/*"></label>
      <button class="btn">${ic("nova")} Cadastrar missão</button>
    </form>`, "nova");
}

async function salvarNova(f) {
  const d = Object.fromEntries(new FormData(f));
  const local = d.local.trim();
  if (!ORIGENS.some(([c]) => c === d.origem)) return toast("Informe como o problema chegou à missão.", true);
  const precisaDet = ORIGENS.find(([c]) => c === d.origem)[2];
  const origemDetalhe = precisaDet ? String(d.origemDetalhe || "").trim() : "";
  if (precisaDet && !origemDetalhe) return toast(`Preencha: ${precisaDet}.`, true);
  const abertas = S.missoes.filter((m) => ABERTAS.includes(m.status) && String(m.local).toLowerCase() === local.toLowerCase());
  if (abertas.length && !confirm(`Já existe(m) ${abertas.length} missão(ões) aberta(s) em "${local}":\n${abertas.map((m) => "• " + m.titulo).join("\n")}\n\nCadastrar mesmo assim?`)) return;
  const btn = f.querySelector("button"); btn.disabled = true; btn.textContent = "Salvando…";
  let novoId = null;
  const ok = await acao(async () => {
    // Prepara a foto antes de gravar: se ela não abrir, a missão não é criada pela metade.
    const foto = d.foto && d.foto.size ? await comprimir(d.foto) : null;
    const agora = Date.now();
    const ref = await addDoc(collection(db, "missoes"), {
      titulo: d.titulo.trim(), descricao: (d.descricao || "").trim(), local, tipo: d.tipo,
      prioridade: d.prioridade, peso: Number(d.peso) || 1, risco: !!d.risco,
      materiaisNecessarios: (d.materiais || "").trim(),
      origem: d.origem, origemDetalhe,
      status: "painel", executor: null, criadoPor: S.me.id, criadaEm: agora,
      historico: [{ em: agora, por: S.me.id, acao: "Cadastrou a missão" }],
    });
    novoId = ref.id;
    if (foto) {
      await addDoc(collection(db, "fotos"), { missaoId: ref.id, tipo: "antes", img: foto, tam: foto.length, por: S.me.id, em: Date.now() });
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
  const final = FINAIS.includes(m.status);
  let acoes = "";

  if (m.status === "painel") {
    acoes += `<button class="btn" data-act="capturar">${ic("capturar")} Capturar missão</button>`;
    if (isCmd()) {
      acoes += `<button class="btn sec" data-act="abrirDesignar">${ic("designar")} Designar para…</button>
        <button class="btn perigo" data-act="arquivar">${ic("arquivar")} Arquivar (duplicada)</button>`;
    }
  }
  // Responsável retira a missão do executor e a devolve ao painel
  // (designação errada, cadete indisponível, missão abandonada etc.).
  if (isCmd() && ["em_execucao", "aguardando_material"].includes(m.status) && m.executor) {
    acoes += `<button class="btn perigo" data-act="resgatar">${ic("reprovar")} Resgatar missão (voltar ao painel)</button>`;
  }
  if (m.status === "em_execucao" && (souExec || isCmd())) {
    acoes += `<button class="btn sec" data-act="esperar">${ic("esperar")} Aguardando material</button>`;
    if (souExec) acoes += formConcluir();
  }
  if (m.status === "aguardando_material" && (souExec || isCmd())) {
    acoes += `<button class="btn" data-act="retomar">${ic("retomar")} Material chegou — retomar</button>`;
  }
  // Executor encerra sem executar: problema não existe ou já foi solucionado.
  if (souExec && ["em_execucao", "aguardando_material"].includes(m.status)) {
    acoes += S.semExec === m.id
      ? formSemExec()
      : `<button class="btn sec" data-act="abrirSemExec">${ic("arquivar")} Encerrar sem execução</button>`;
  }
  // Responsável reabre uma missão encerrada sem execução (problema voltou ou verificação mal feita).
  if (m.status === "sem_execucao" && isCmd()) {
    acoes += `<button class="btn perigo" data-act="reabrir">${ic("retomar")} Reabrir missão (voltar ao painel)</button>`;
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
        <dt>Origem</dt><dd>${esc(origemTexto(m))}</dd>
        <dt>Cadastrada</dt><dd>${esc(nomeDe(m.criadoPor))} em ${fmtDH(m.criadaEm)}</dd>
        <dt>Executor</dt><dd>${m.executor ? esc(nomeDe(m.executor)) + (m.designadoPor ? ` (designado por ${esc(nomeDe(m.designadoPor))})` : "") : "—"}</dd>
        ${m.materiaisNecessarios ? `<dt>Material previsto</dt><dd>${esc(m.materiaisNecessarios)}</dd>` : ""}
        ${m.status === "aguardando_material" && m.motivoEspera ? `<dt>Falta</dt><dd>${esc(m.motivoEspera)}</dd>` : ""}
        ${m.concluidaEm ? `<dt>Concluída</dt><dd>${fmtDH(m.concluidaEm)}${m.tempoMin ? ` · ${m.tempoMin} min` : ""}</dd>` : ""}
        ${usados ? `<dt>Material usado</dt><dd>${usados}</dd>` : ""}
        ${m.obs ? `<dt>Observações</dt><dd>${esc(m.obs)}</dd>` : ""}
        ${m.validadaEm ? `<dt>Validada</dt><dd>${esc(nomeDe(m.validadoPor))} em ${fmtDH(m.validadaEm)}</dd>` : ""}
        ${m.status === "sem_execucao" ? `<dt>Sem execução</dt><dd>${esc(motivoNome(m.motivoSemExec))}<br><small>${esc(nomeDe(m.semExecPor))} em ${fmtDH(m.semExecEm)}</small></dd>
          ${m.solucionadoPor ? `<dt>Solucionado por</dt><dd>${esc(m.solucionadoPor)}</dd>` : ""}
          ${m.semExecObs ? `<dt>Justificativa</dt><dd>${esc(m.semExecObs)}</dd>` : ""}` : ""}
      </dl>
      <h3>${ic("foto", "mini-ic")} Fotos</h3><div id="fotos" class="fotos"><p class="vazio">Carregando…</p></div>
      ${acoes ? `<div class="acoes">${acoes}</div>` : ""}
      <h3>${ic("calendario", "mini-ic")} Histórico</h3>
      <ul class="hist">${hist.map((h) => `<li><small>${fmtDH(h.em)}</small> ${esc(nomeDe(h.por))}: ${esc(h.acao)}</li>`).join("")}</ul>
    </div>
    ${S.designar?.id === m.id && m.status === "painel" && isCmd() ? janelaDesignar(m) : ""}`, "painel");
  carregarFotos(id);
}

// Janela "Designar para…": o responsável escolhe o cadete na lista e confirma com OK.
// Ninguém vem pré-selecionado, para evitar designar a pessoa errada por engano.
function janelaDesignar(m) {
  const ef = efetivo();
  const vez = ef.find((x) => !x.indisp);
  const sel = S.designar.sel;
  const item = (x) => `
    <button type="button" class="cad-op${x.id === sel ? " on" : ""}" ${x.indisp ? "disabled" : `data-act="escolherCadete" data-id="${esc(x.id)}"`}>
      <span class="cad-radio"></span>
      <span class="cad-txt"><b>${esc(x.nome)}${x.id === vez?.id ? ` <span class="badge vez-b">${ic("estrela", "mini-ic")} da vez</span>` : ""}</b>
        <small>${x.indisp ? "Indisponível" : `${x.pontos} pts · ${x.andamento} em andamento`}</small></span>
    </button>`;
  return `
    <div class="sobre" data-act="fecharDesignar">
      <div class="janela" role="dialog" aria-modal="true" aria-labelledby="desTit">
        <h3 id="desTit">${ic("designar")} Designar para…</h3>
        <p class="dica">${esc(m.titulo)}</p>
        <div class="cad-lista">${ef.map(item).join("")}</div>
        <div class="janela-bt">
          <button type="button" class="btn sec" data-act="fecharDesignar">Cancelar</button>
          <button type="button" class="btn" data-act="confirmarDesignar" id="desOk" ${sel ? "" : "disabled"}>
            ${sel ? `OK — ${esc(nomeDe(sel))}` : "OK"}</button>
        </div>
      </div>
    </div>`;
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
    ? lista.map((f) => `<figure><img src="${f.img}" loading="lazy" data-act="zoom" alt="Foto ${esc(FOTO_TIPO[f.tipo] || f.tipo)}"><figcaption>${esc(FOTO_TIPO[f.tipo] || f.tipo)} · ${fmtData(f.em)}</figcaption></figure>`).join("")
    : (S.missoes.find((m) => m.id === id)?.fotosLimpasEm
      ? `<p class="vazio">Fotos removidas em ${fmtData(S.missoes.find((m) => m.id === id).fotosLimpasEm)} para liberar espaço (guardadas no backup baixado pelo responsável).</p>`
      : '<p class="vazio">Sem fotos.</p>');
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
    // Comprime todas antes de enviar: se uma falhar, nada é gravado pela metade.
    const imgs = [];
    for (const file of files) imgs.push(await comprimir(file));
    for (const img of imgs) {
      await addDoc(collection(db, "fotos"), { missaoId: id, tipo: "depois", img, tam: img.length, por: S.me.id, em: Date.now() });
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

// Encerrar sem execução: o executor foi ao local e não havia serviço a fazer.
// Exige motivo, justificativa e foto do local (prova de que está funcionando).
function formSemExec() {
  return `<form id="fSemExec" class="box sem-exec"><h3>${ic("arquivar", "mini-ic")} Encerrar sem execução</h3>
    <p class="dica">Use quando, ao chegar no local, não houver serviço a fazer. A missão não conta pontos no rodízio e os responsáveis podem reabri-la.</p>
    <label>Motivo*<select name="motivoSemExec" required>
      <option value="" selected disabled>Selecione…</option>${opts(MOTIVOS_SEM_EXEC)}</select></label>
    <div id="solDet"></div>
    <label>Justificativa*<textarea name="semExecObs" rows="2" required maxlength="500" placeholder="Ex.: testei as 4 tomadas da sala, todas funcionando"></textarea></label>
    <label>${ic("foto", "mini-ic")} Foto do local verificado*<input type="file" name="fotoVerif" accept="image/*" required></label>
    <button class="btn">${ic("arquivar")} Confirmar encerramento</button>
    <button type="button" class="btn sec" data-act="fecharSemExec">Cancelar</button>
  </form>`;
}

async function salvarSemExec(f) {
  const d = Object.fromEntries(new FormData(f));
  if (!MOTIVOS_SEM_EXEC.some(([c]) => c === d.motivoSemExec)) return toast("Escolha o motivo.", true);
  const obs = String(d.semExecObs || "").trim();
  if (!obs) return toast("Escreva a justificativa.", true);
  const file = f.fotoVerif.files[0];
  if (!file) return toast("Tire ou escolha uma foto do local verificado.", true);
  const sol = d.motivoSemExec === "ja_solucionado" ? String(d.solucionadoPor || "").trim() : "";
  const btn = f.querySelector("button.btn:not(.sec)"); btn.disabled = true; btn.textContent = "Enviando…";
  const id = S.cur;
  const ok = await acao(async () => {
    const img = await comprimir(file);
    await addDoc(collection(db, "fotos"), { missaoId: id, tipo: "verificacao", img, tam: img.length, por: S.me.id, em: Date.now() });
    await updateDoc(doc(db, "missoes", id), {
      status: "sem_execucao", motivoSemExec: d.motivoSemExec, semExecObs: obs, solucionadoPor: sol,
      semExecPor: S.me.id, semExecEm: Date.now(), motivoEspera: "",
      historico: H(`Encerrou sem execução — ${motivoNome(d.motivoSemExec)}${sol ? " (por " + sol + ")" : ""}: ${obs}`),
    });
  }, "Missão encerrada sem execução");
  delete S.fotos[id];
  if (ok) { S.semExec = null; S.dirty = false; route(); }
  else { btn.disabled = false; btn.innerHTML = `${ic("arquivar")} Confirmar encerramento`; }
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
  const semExec = S.missoes.filter((m) => m.executor === eu && m.status === "sem_execucao").sort((a, b) => (b.semExecEm || 0) - (a.semExecEm || 0));
  shell("Minhas missões", `
    <div class="stats">
      <div>${ic("estrela")}<b>${meu.pontos}</b><small>pontos no ciclo</small></div>
      <div>${ic("concluir")}<b>${meu.concluidas}</b><small>concluídas</small></div>
      <div>${ic("capturar")}<b>${meu.andamento}</b><small>em andamento</small></div>
    </div>
    ${semExec.length ? `<p class="dica">${semExec.length} missão(ões) encerrada(s) sem execução (não contam pontos no rodízio).</p>` : ""}
    <form id="fIndisp" class="box linha">
      <label>Indisponível até<input type="date" name="ate" value="${esc(S.me.indisponivelAte || "")}"></label>
      <button class="btn sec">${ic("salvar")} Salvar</button>
    </form>
    <h3>Em andamento</h3>${and.length ? and.map(cartao).join("") : '<p class="vazio">Nenhuma.</p>'}
    <h3>Cadastradas por mim (abertas)</h3>${cad.length ? cad.map(cartao).join("") : '<p class="vazio">Nenhuma.</p>'}
    <h3>Concluídas e validadas</h3>${feitas.length ? feitas.slice(0, 30).map(cartao).join("") : '<p class="vazio">Nenhuma ainda.</p>'}
    ${semExec.length ? `<h3>Encerradas sem execução</h3>${semExec.slice(0, 30).map(cartao).join("")}` : ""}
  `, "minhas");
}

function viewEfetivo() {
  // O rodízio é um só (responsáveis também entram na vez); a tabela só é dividida para leitura.
  // O "#" é a posição de cada um no rodízio geral.
  const ef = efetivo().map((m, i) => ({ ...m, pos: m.indisp ? null : i + 1 }));
  const resp = ef.filter((m) => m.perfil === "comandante");
  const cads = ef.filter((m) => m.perfil !== "comandante");
  const cab = (titulo) => `<tr><th>#</th><th>${titulo}</th><th>Pts</th><th>Concl.</th><th>S/E</th><th>And.</th><th>Última</th></tr>`;
  const linha = (m) => `<tr class="${m.indisp ? "indisp" : ""}">
    <td>${m.pos ?? "—"}</td>
    <td>${esc(m.nome)}${m.indisp ? `<br><small>indisponível até ${fmtData(Date.parse(m.indisponivelAte + "T12:00:00"))}</small>` : ""}</td>
    <td><b>${m.pontos}</b></td><td>${m.concluidas}</td><td>${m.semExec}</td><td>${m.andamento}</td><td>${fmtData(m.ultima)}</td></tr>`;
  shell("Efetivo", `
    <p class="dica">Ciclo desde ${fmtData(Date.parse(CICLO_INICIO + "T00:00:00"))}. A vez é de quem tem menos pontos; em empate, de quem tem menos missões em andamento. O # é a posição no rodízio geral (responsáveis e cadetes juntos). S/E = encerradas sem execução (não contam pontos).</p>
    <h3>${ic("estrela", "mini-ic")} Responsáveis (${resp.length})</h3>
    ${resp.length ? `<table class="tab tab-resp">${cab("Responsável")}${resp.map(linha).join("")}</table>` : '<p class="vazio">Nenhum responsável ativo.</p>'}
    <h3>${ic("efetivo", "mini-ic")} Cadetes (${cads.length})</h3>
    ${cads.length ? `<table class="tab">${cab("Cadete")}${cads.map(linha).join("")}</table>` : '<p class="vazio">Nenhum cadete ativo.</p>'}`, "efetivo");
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

function itemMaterial(m) {
  const aberto = S.matSel === m.id;
  return `<div class="mat-item ${aberto ? "aberto" : ""}" data-busca="${esc(semAcento(m.nome))}">
    <button class="mat-linha" data-act="matItem" data-id="${esc(m.id)}">
      <span class="mat-nome">${esc(m.nome)}</span>
      <span class="mat-qtd">${m.qtd} ${esc(m.unidade)}</span>
    </button>
    ${aberto ? `<div class="mat-det">
      <div class="mat-info">
        <div><small>Em estoque</small><b>${m.qtd} ${esc(m.unidade)}</b></div>
        <div><small>Categoria</small><b>${esc(catDe(m))}</b></div>
      </div>
      ${isCmd() ? `<div class="linha">
        <button class="btn" data-act="entrada" data-id="${esc(m.id)}">${ic("entrada")} Entrada</button>
        <button class="btn sec" data-act="ajustarMat" data-id="${esc(m.id)}">${ic("salvar")} Ajustar</button>
        <button class="btn perigo" data-act="delMat" data-id="${esc(m.id)}">${ic("excluir")} Excluir</button>
      </div>` : ""}
      <button class="btn sec" data-act="comprarMat" data-id="${esc(m.id)}">${ic("entrada")} Pôr na lista de compras</button>
    </div>` : ""}
  </div>`;
}

function viewMateriais() {
  S.matAbertos ||= new Set();
  const grupos = NOMES_CATS.map((nome) => ({
    nome, icone: CATS_MAT.find(([n]) => n === nome)[1],
    itens: S.materiais.filter((m) => catDe(m) === nome),
  })).filter((g) => g.itens.length);
  const painel = S.matPainel;
  if (S.matAba === "compras") return viewCompras();
  shell("Materiais", `
    ${abasMateriais("estoque")}
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
      </div>
      <button class="btn">${ic("salvar")} Salvar material</button>
      <button type="button" class="btn sec" data-act="matPainel" data-p="">Cancelar</button>
    </form>` : ""}
    ${painel === "importar" && isCmd() ? painelImport("materiais") : ""}
    ${S.materiais.length ? `
    <div class="busca">${ic("relatorios", "mini-ic")}<input id="matBusca" type="search" placeholder="Buscar material (ex.: disjuntor)" autocomplete="off"></div>
    <div id="matGrupos">
    ${grupos.map((g) => {
      return `<details class="grupo" data-grupo="${esc(g.nome)}" ${S.matAbertos.has(g.nome) ? "open" : ""}>
        <summary><span class="tipo-ic">${ic(g.icone)}</span>
          <span class="grupo-nome">${esc(g.nome)}<small>${g.itens.length} ${g.itens.length === 1 ? "item" : "itens"}</small></span>
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

function abasMateriais(ativa) {
  const pend = S.compras.filter((c) => c.status !== "comprado").length;
  return `<div class="abas abas-mat">
    <button data-act="matAba" data-aba="estoque" class="${ativa === "estoque" ? "on" : ""}">${ic("materiais", "mini-ic")} Estoque <small>${S.materiais.length}</small></button>
    <button data-act="matAba" data-aba="compras" class="${ativa === "compras" ? "on" : ""}">${ic("relatorios", "mini-ic")} Lista de compras <small>${pend}</small></button>
  </div>`;
}

// Lista de compras: qualquer integrante pede; responsáveis marcam como comprado
function viewCompras() {
  const pend = S.compras.filter((c) => c.status !== "comprado");
  const feitos = S.compras.filter((c) => c.status === "comprado").sort((a, b) => (b.compradoEm || 0) - (a.compradoEm || 0));
  const linha = (c) => `<div class="compra ${c.status === "comprado" ? "ok" : ""}">
    <div class="compra-txt"><b>${esc(c.qtd)} ${esc(c.unidade)} · ${esc(c.item)}</b>
      <small>${c.obs ? esc(c.obs) + " · " : ""}pedido por ${esc(nomeDe(c.criadoPor))} em ${fmtData(c.em)}${c.status === "comprado" ? ` · comprado em ${fmtData(c.compradoEm)}` : ""}</small></div>
    ${c.status !== "comprado" ? `<div class="compra-bt">
      ${isCmd() ? `<button class="mini" data-act="comprado" data-id="${esc(c.id)}" title="Marcar como comprado">${ic("concluir", "mini-ic")} Comprado</button>` : ""}
      ${isCmd() || c.criadoPor === S.me.id ? `<button class="mini perigo" data-act="delCompra" data-id="${esc(c.id)}" title="Remover">${ic("excluir", "mini-ic")}</button>` : ""}
    </div>` : ""}
  </div>`;
  shell("Materiais", `
    <div class="no-print">
    ${abasMateriais("compras")}
    <form id="fCompra" class="box">
      <h3>${ic("nova", "mini-ic")} Adicionar à lista de compras</h3>
      <label>Material*<input name="item" required list="listaMat" placeholder="Escolha da lista ou digite um novo"
        value="${esc(S.compraPre?.nome || "")}">
        <datalist id="listaMat">${S.materiais.map((m) => `<option value="${esc(m.nome)}">`).join("")}</datalist></label>
      <div class="dupla">
        <label>Quantidade*<input name="qtd" type="number" min="0" step="any" required inputmode="decimal"></label>
        <label>Unidade<input name="unidade" value="${esc(S.compraPre?.unidade || "un")}"></label>
      </div>
      <label>Observação<input name="obs" placeholder="Ex.: para a missão do Bloco B, marca, modelo"></label>
      <button class="btn">${ic("salvar")} Adicionar</button>
    </form>
    ${isCmd() ? `<details class="grupo imp-compras" ${S.importPend?.tipo === "compras" ? "open" : ""}><summary><span class="tipo-ic">${ic("importar")}</span>
      <span class="grupo-nome">Importar lista de planilha<small>Excel ou CSV com vários itens de uma vez</small></span><span class="seta">›</span></summary>
      ${painelImport("compras")}</details>` : ""}
    <h3>${ic("relatorios", "mini-ic")} A comprar (${pend.length})</h3>
    ${pend.length ? pend.map(linha).join("") : '<p class="vazio">Nada pendente na lista de compras.</p>'}
    ${pend.length ? `<div class="linha">
      <button class="btn" data-act="pdfCompras">${ic("imprimir")} Gerar PDF</button>
      <button class="btn sec" data-act="exportar" data-tipo="compras">${ic("exportar")} Exportar planilha</button></div>` : ""}
    ${feitos.length ? `<details class="grupo hist-compras"><summary><span class="grupo-nome">Já comprados<small>${feitos.length} itens</small></span><span class="seta">›</span></summary>
      <div class="grupo-itens">${feitos.slice(0, 50).map(linha).join("")}</div></details>` : ""}
    </div>
    ${pend.length ? docCompras(pend) : ""}
  `, "mais");
}

// Documento da lista de compras: só aparece na impressão / PDF.
function docCompras(pend) {
  const resp = S.membros.filter((m) => m.perfil === "comandante" && m.ativo !== false);
  return `<div class="doc-compras so-print">
    <div class="cab-rel"><img src="icons/apmg.png" alt=""><div><b>Academia Policial Militar do Guatupê · Escola de Formação de Oficiais</b>
      <h2>Lista de materiais para aquisição — Missão Elétrica</h2></div><img src="icons/esfo.png" alt=""></div>
    <p class="doc-texto">${esc(TEXTO_COMPRAS)}</p>
    <table class="tab">
      <tr><th>Nº</th><th>Material</th><th>Qtd.</th><th>Unid.</th><th>Observação</th></tr>
      ${pend.map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.item)}</td><td>${esc(c.qtd)}</td><td>${esc(c.unidade)}</td><td>${esc(c.obs || "")}</td></tr>`).join("")}
    </table>
    <p class="doc-data">Total: ${pend.length} ${pend.length === 1 ? "item" : "itens"} · Emitido em ${fmtData(Date.now())}</p>
    ${resp.length ? `<div class="doc-assin">${resp.map((m) => `<div><span></span>${esc(m.nome)}<small>Responsável pela Missão Elétrica</small></div>`).join("")}</div>` : ""}
  </div>`;
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
function semExecNoPeriodo(ini, fim, cadete) {
  return S.missoes
    .filter((m) => m.status === "sem_execucao" && m.semExecEm >= ini && m.semExecEm <= fim && (!cadete || m.executor === cadete))
    .sort((a, b) => a.semExecEm - b.semExecEm);
}

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
  const semExec = semExecNoPeriodo(ini, fim, cadete);
  // Por origem: quantas demandas de cada canal foram resolvidas e quantas eram alarme falso
  const porOrigem = {};
  lista.forEach((m) => { (porOrigem[m.origem || ""] ||= { feitas: 0, sem: 0 }).feitas++; });
  semExec.forEach((m) => { (porOrigem[m.origem || ""] ||= { feitas: 0, sem: 0 }).sem++; });
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
      ${Object.keys(porOrigem).length ? `<p><b>Por origem:</b> ${Object.entries(porOrigem).sort((a, b) => (b[1].feitas + b[1].sem) - (a[1].feitas + a[1].sem))
        .map(([o, n]) => `${esc(origemNome(o))} (${n.feitas} executada${n.feitas === 1 ? "" : "s"}${n.sem ? `, ${n.sem} sem execução` : ""})`).join("; ")}</p>` : ""}
      <table class="tab">
        <tr><th>Data</th><th>Missão</th><th>Local</th><th>Executor</th><th>Material usado</th></tr>
        ${lista.map((m) => `<tr><td>${fmtData(m.validadaEm)}</td><td>${esc(m.titulo)}<br><small>${esc(m.tipo)} · peso ${Number(m.peso) || 1} · origem: ${esc(origemTexto(m))}</small></td>
          <td>${esc(m.local)}</td><td>${esc(nomeDe(m.executor))}</td>
          <td>${(m.materiaisUsados || []).map((u) => `${u.qtd} ${esc(u.unidade)} ${esc(u.nome)}`).join(", ") || "—"}</td></tr>`).join("")}
      </table>
      ${lista.length ? "" : '<p class="vazio">Nenhuma missão validada no período.</p>'}
      ${semExec.length ? `<h3>Encerradas sem execução (${semExec.length})</h3>
      <table class="tab">
        <tr><th>Data</th><th>Missão</th><th>Local</th><th>Executor</th><th>Motivo</th></tr>
        ${semExec.map((m) => `<tr><td>${fmtData(m.semExecEm)}</td><td>${esc(m.titulo)}<br><small>origem: ${esc(origemTexto(m))}</small></td>
          <td>${esc(m.local)}</td><td>${esc(nomeDe(m.executor))}</td>
          <td>${esc(motivoNome(m.motivoSemExec))}${m.solucionadoPor ? ` (por ${esc(m.solucionadoPor)})` : ""}${m.semExecObs ? `<br><small>${esc(m.semExecObs)}</small>` : ""}</td></tr>`).join("")}
      </table>` : ""}
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
  const resp = S.membros.filter((m) => m.perfil === "comandante");
  const cads = S.membros.filter((m) => m.perfil !== "comandante");
  // Linha de integrante: o botão troca o perfil (Responsável ⇄ Cadete); ninguém altera o próprio.
  const linha = (m, ehResp) => `<tr class="${m.ativo === false ? "indisp" : ""}">
    <td>${esc(m.nome)}${m.id === S.me.id ? ' <b class="tag">VOCÊ</b>' : ""}<br><small>${esc(m.id)}</small></td>
    <td>${m.id === S.me.id ? "" : `<button class="mini" data-act="${ehResp ? "tornarCadete" : "tornarResp"}" data-id="${esc(m.id)}">
      ${ic(ehResp ? "usuario" : "estrela", "mini-ic")} ${ehResp ? "Tornar cadete" : "Tornar responsável"}</button>`}</td>
    <td><input type="checkbox" data-ativo="${esc(m.id)}" ${m.ativo !== false ? "checked" : ""} ${m.id === S.me.id ? "disabled" : ""} title="Ativo"></td>
    <td>${m.id !== S.me.id ? `<button class="mini perigo" data-act="delMembro" data-id="${esc(m.id)}" title="Remover">${ic("excluir", "mini-ic")}</button>` : ""}</td></tr>`;
  const cab = `<tr><th>Nome / e-mail</th><th>Perfil</th><th>Ativo</th><th></th></tr>`;
  shell("Administração", `
    <h3>${ic("estrela", "mini-ic")} Responsáveis pela missão (${resp.length})</h3>
    <table class="tab tab-resp">${cab}${resp.map((m) => linha(m, true)).join("")}</table>
    <h3>${ic("efetivo", "mini-ic")} Cadetes da missão (${cads.length})</h3>
    ${cads.length ? `<table class="tab">${cab}${cads.map((m) => linha(m, false)).join("")}</table>` : '<p class="vazio">Nenhum cadete cadastrado.</p>'}
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
    <h3>${ic("foto", "mini-ic")} Armazenamento de fotos</h3>
    <div id="armaz" class="box"><p class="vazio">Calculando…</p></div>
    ${painelZerar()}
  `, "mais");
  carregarArmaz();
}

// ---------------------------------------------------------------------
// Armazenamento de fotos (plano gratuito do Firebase: 1 GiB no total)
// ---------------------------------------------------------------------
const LIMITE_BYTES = 1024 ** 3;     // 1 GiB do plano gratuito
const ALERTA_PCT = 70;              // avisa os responsáveis a partir daqui
const MESES_FOTOS = 6;              // fotos de missões encerradas há mais tempo podem ser limpas
const LOTE_LIMPEZA = 150;           // fotos por rodada (mantém o .zip leve no celular)
const TAM_MEDIO = 250 * 1024;       // estimativa para fotos antigas sem tamanho gravado

const fmtBytes = (b) => b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + " GB" : b >= 1024 ** 2 ? (b / 1024 ** 2).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";

// Data em que a missão foi encerrada (validada ou arquivada)
function encerradaEm(m) {
  if (m.validadaEm) return m.validadaEm;
  if (m.status === "sem_execucao" && m.semExecEm) return m.semExecEm;
  const h = (m.historico || []).reduce((a, x) => Math.max(a, x.em || 0), 0);
  return h || m.criadaEm || 0;
}

// Missões cujas fotos já podem ser limpas
function missoesParaLimpar() {
  const corte = new Date(); corte.setMonth(corte.getMonth() - MESES_FOTOS);
  return S.missoes.filter((m) => FINAIS.includes(m.status) && encerradaEm(m) < corte.getTime());
}

// Uso total, sem baixar as fotos (consultas de contagem/soma do Firestore)
async function medirArmaz() {
  const col = collection(db, "fotos");
  const [tot, comTam] = await Promise.all([
    getCountFromServer(col),
    getAggregateFromServer(query(col, where("tam", ">", 0)), { n: count(), bytes: sum("tam") }),
  ]);
  const n = tot.data().count;
  const { n: nTam, bytes } = comTam.data();
  const usado = (bytes || 0) + Math.max(0, n - nTam) * TAM_MEDIO;
  return { n, usado, pct: Math.min(100, (usado / LIMITE_BYTES) * 100) };
}

// Conta as fotos antigas (de missões encerradas há 6+ meses)
async function contarAntigas() {
  const ids = missoesParaLimpar().map((m) => m.id);
  let n = 0;
  for (let i = 0; i < ids.length; i += 30) {
    const r = await getCountFromServer(query(collection(db, "fotos"), where("missaoId", "in", ids.slice(i, i + 30))));
    n += r.data().count;
  }
  return { n, missoes: ids.length };
}

async function avisoArmazenamento() {
  try {
    const a = await medirArmaz();
    S.armaz = a;
    if (a.pct >= ALERTA_PCT) toast(`Atenção: fotos ocupam ${a.pct.toFixed(0)}% do espaço gratuito. Faça a limpeza em Mais → Administração.`, true);
  } catch (e) { console.error(e); }
}

async function carregarArmaz() {
  const el = () => document.getElementById("armaz");
  try {
    const [a, ant] = await Promise.all([medirArmaz(), contarAntigas()]);
    S.armaz = a; S.antigas = ant;
    if (!el()) return;
    const cor = a.pct >= 90 ? "critico" : a.pct >= ALERTA_PCT ? "alerta" : "";
    el().innerHTML = `
      <p><b>${a.n}</b> fotos · <b>${fmtBytes(a.usado)}</b> de 1 GB (${a.pct.toFixed(1)}%)</p>
      <div class="barra ${cor}"><span style="width:${Math.max(a.pct, 0.5).toFixed(1)}%"></span></div>
      ${cor ? `<p class="aviso-armaz">${ic("alerta", "mini-ic")} Espaço ${a.pct >= 90 ? "quase esgotado" : "acima de " + ALERTA_PCT + "%"}. Faça a limpeza abaixo; se o limite for atingido, novas fotos deixam de ser gravadas.</p>` : ""}
      <p class="dica">Fotos de missões validadas, encerradas sem execução ou arquivadas há mais de ${MESES_FOTOS} meses podem ser limpas. Antes de apagar, o app baixa um arquivo .zip com as fotos e um relatório das missões — guarde-o no Drive da missão.</p>
      ${ant.n
        ? `<p><b>${ant.n}</b> foto(s) antiga(s) de ${ant.missoes} missão(ões) encerrada(s) há mais de ${MESES_FOTOS} meses.</p>
           <button class="btn sec" data-act="limparFotos">${ic("exportar")} Baixar backup e limpar${ant.n > LOTE_LIMPEZA ? ` (${LOTE_LIMPEZA} por vez)` : ""}</button>`
        : `<p class="vazio">Nenhuma foto antiga para limpar.</p>`}`;
  } catch (e) {
    console.error(e);
    if (el()) el().innerHTML = `<p class="vazio">Não foi possível calcular o uso agora (${esc(e.code || e.message)}).</p>`;
  }
}

// ---------------------------------------------------------------------
// Zerar dados de teste (só responsáveis). Integrantes e locais não são tocados.
// ---------------------------------------------------------------------
function painelZerar() {
  const ms = [...S.missoes].sort((a, b) => (b.criadaEm || 0) - (a.criadaEm || 0));
  return `<h3>${ic("excluir", "mini-ic")} Zerar dados de teste</h3>
    <form id="fZerar" class="box zerar">
      <p class="dica">Apaga dados inseridos para teste antes de começar com os dados reais. Integrantes e locais <b>não</b> são apagados.</p>
      <label class="check"><input type="checkbox" id="zEstoque"> Estoque: ${S.materiais.length} material(is) e todo o histórico de entradas/saídas</label>
      <label class="check"><input type="checkbox" id="zCompras"> Lista de compras: ${S.compras.length} pedido(s)</label>
      <label class="check"><input type="checkbox" id="zMissoes"> Todas as missões: ${S.missoes.length} missão(ões), com as fotos</label>
      ${ms.length ? `<details class="grupo"><summary><span class="grupo-nome">Ou escolher missões específicas<small>marque só as de teste</small></span><span class="seta">›</span></summary>
        <div class="lista-zerar">${ms.map((m) => `<label class="check"><input type="checkbox" class="zMissao" value="${esc(m.id)}">
          <span>${esc(m.titulo)}<small>${STATUS[m.status] || esc(m.status)} · ${esc(m.local)} · ${fmtData(m.criadaEm)}</small></span></label>`).join("")}</div>
      </details>` : ""}
      <fieldset class="backup-op"><legend>Backup antes de apagar</legend>
        <label class="check"><input type="radio" name="zBackup" value="planilha" checked> Baixar planilha com tudo o que será apagado</label>
        <label class="check"><input type="radio" name="zBackup" value="nenhum"> Não baixar nada (apagar sem backup)</label>
      </fieldset>
      <button type="button" class="btn perigo" data-act="zerar">${ic("excluir")} Zerar selecionados</button>
    </form>`;
}

async function apagarDocs(refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const b = writeBatch(db);
    refs.slice(i, i + 400).forEach((r) => b.delete(r));
    await b.commit();
  }
}

async function zerarDados(b) {
  const estoque = document.getElementById("zEstoque")?.checked;
  const compras = document.getElementById("zCompras")?.checked;
  const todas = document.getElementById("zMissoes")?.checked;
  const escolhidas = new Set([...document.querySelectorAll(".zMissao:checked")].map((x) => x.value));
  const missoes = todas ? [...S.missoes] : S.missoes.filter((m) => escolhidas.has(m.id));
  if (!estoque && !compras && !missoes.length) return toast("Marque o que deseja apagar.", true);
  const comBackup = document.querySelector('input[name="zBackup"]:checked')?.value !== "nenhum";

  const itens = [];
  if (estoque) itens.push(`• ${S.materiais.length} material(is) e o histórico do estoque`);
  if (compras) itens.push(`• ${S.compras.length} pedido(s) da lista de compras`);
  if (missoes.length) itens.push(`• ${missoes.length} missão(ões) e suas fotos`);
  // Sem backup, a confirmação é mais forte: não há como recuperar depois.
  const palavra = comBackup ? "ZERAR" : "APAGAR SEM BACKUP";
  const conf = prompt(`Serão APAGADOS definitivamente:\n${itens.join("\n")}\n\n${comBackup
    ? "Uma planilha de backup será baixada antes."
    : "ATENÇÃO: nenhum backup será baixado. Não será possível recuperar esses dados."}\nPara confirmar, digite ${palavra}:`);
  if (conf === null) return;
  if (conf.trim().toUpperCase() !== palavra) return toast("Confirmação incorreta. Nada foi apagado.", true);

  b.textContent = comBackup ? "Preparando backup…" : "Apagando…";
  const ok = await acao(async () => {
    // 1) Lê o que será apagado (movimentações e fotos não ficam carregadas no app)
    const movs = estoque ? (await getDocs(collection(db, "movimentacoes"))).docs : [];
    let fotos = [];
    if (todas) fotos = (await getDocs(collection(db, "fotos"))).docs;
    else {
      const ids = missoes.map((m) => m.id);
      for (let i = 0; i < ids.length; i += 30) {
        fotos.push(...(await getDocs(query(collection(db, "fotos"), where("missaoId", "in", ids.slice(i, i + 30))))).docs);
      }
    }

    // 2) Planilha de backup (se escolhida)
    if (comBackup) {
      const X = await xlsx();
      const wb = X.utils.book_new();
      const aba = (nome, linhas) => linhas.length && X.utils.book_append_sheet(wb, X.utils.json_to_sheet(linhas), nome);
      aba("Missões", missoes.map((m) => ({
        Missão: m.titulo, Tipo: m.tipo, Local: m.local, Situação: STATUS[m.status] || m.status, Prioridade: prioNome(m.prioridade),
        Peso: Number(m.peso) || 1, Origem: origemTexto(m), "Cadastrada por": nomeDe(m.criadoPor), "Cadastrada em": fmtDH(m.criadaEm), Executor: nomeDe(m.executor),
        "Concluída em": fmtDH(m.concluidaEm), "Validada em": fmtDH(m.validadaEm), Descrição: m.descricao || "",
        "Material usado": (m.materiaisUsados || []).map((u) => `${u.qtd} ${u.unidade} ${u.nome}`).join("; "), Fotos: fotos.filter((f) => f.data().missaoId === m.id).length,
      })));
      if (estoque) {
        aba("Materiais", S.materiais.map((m) => ({ Nome: m.nome, Unidade: m.unidade, Quantidade: m.qtd, Categoria: catDe(m) })));
        aba("Movimentações", movs.map((d) => d.data()).sort((x, y) => (x.em || 0) - (y.em || 0)).map((v) => ({
          Data: fmtDH(v.em), Material: S.materiais.find((m) => m.id === v.materialId)?.nome || v.materialId, Tipo: v.tipo, Quantidade: v.qtd, Por: nomeDe(v.por),
        })));
      }
      if (compras) aba("Compras", S.compras.map((c) => ({
        Material: c.item, Quantidade: c.qtd, Unidade: c.unidade, Situação: c.status, "Pedido por": nomeDe(c.criadoPor), Data: fmtDH(c.em),
      })));
      if (wb.SheetNames.length) X.writeFile(wb, `backup-antes-de-zerar-${hojeISO()}.xlsx`);
    }

    // 3) Apaga
    b.textContent = "Apagando…";
    await apagarDocs(fotos.map((d) => d.ref));
    await apagarDocs(missoes.map((m) => doc(db, "missoes", m.id)));
    if (estoque) {
      await apagarDocs(movs.map((d) => d.ref));
      await apagarDocs(S.materiais.map((m) => doc(db, "materiais", m.id)));
    }
    if (compras) await apagarDocs(S.compras.map((c) => doc(db, "compras", c.id)));
  }, comBackup ? "Dados apagados. Backup baixado." : "Dados apagados (sem backup).");
  if (ok) { S.fotos = {}; S.dirty = false; }
  route();
}

let FFLATE = null;
async function fflate() {
  if (!FFLATE) FFLATE = await import("https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js");
  return FFLATE;
}

const nomeArq = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w\- ]+/g, "").trim().slice(0, 50) || "missao";

// Baixa um .zip com as fotos antigas + relatório e, após confirmação, apaga do banco
async function limparFotos(b) {
  const alvo = new Map(missoesParaLimpar().map((m) => [m.id, m]));
  const ids = [...alvo.keys()];
  if (!ids.length) return toast("Nenhuma foto antiga para limpar.");
  b.textContent = "Preparando backup…";
  const fotos = [];
  try {
    for (let i = 0; i < ids.length && fotos.length < LOTE_LIMPEZA; i += 30) {
      const q = await getDocs(query(collection(db, "fotos"), where("missaoId", "in", ids.slice(i, i + 30))));
      q.docs.forEach((d) => fotos.length < LOTE_LIMPEZA && fotos.push({ id: d.id, ...d.data() }));
    }
  } catch (e) { console.error(e); toast("Erro ao ler as fotos: " + (e.code || e.message), true); return carregarArmaz(); }
  if (!fotos.length) { toast("Nenhuma foto antiga para limpar."); return carregarArmaz(); }

  // Monta o .zip: uma pasta por missão + planilha com os dados das missões
  const { zipSync, strToU8 } = await fflate();
  const X = await xlsx();
  const arquivos = {}, missoesNoZip = new Map(), contador = {};
  for (const f of fotos) {
    const m = alvo.get(f.missaoId);
    const pasta = `${new Date(encerradaEm(m)).toISOString().slice(0, 10)} - ${nomeArq(m.titulo)} (${m.id.slice(0, 6)})`;
    missoesNoZip.set(m.id, { m, pasta });
    const k = pasta + f.tipo; contador[k] = (contador[k] || 0) + 1;
    const b64 = String(f.img).split(",")[1] || "";
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    arquivos[`${pasta}/${f.tipo}-${contador[k]}.jpg`] = [bin, { level: 0 }];
  }
  const linhas = [...missoesNoZip.values()].map(({ m, pasta }) => ({
    Pasta: pasta, Missão: m.titulo, Tipo: m.tipo, Local: m.local, Situação: STATUS[m.status] || m.status,
    "Cadastrada por": nomeDe(m.criadoPor), "Cadastrada em": fmtData(m.criadaEm), Executor: nomeDe(m.executor),
    "Concluída em": fmtData(m.concluidaEm), "Encerrada em": fmtData(encerradaEm(m)), Origem: origemTexto(m), Descrição: m.descricao || "",
    "Material usado": (m.materiaisUsados || []).map((u) => `${u.qtd} ${u.unidade} ${u.nome}`).join("; "),
    Observações: m.status === "sem_execucao" ? `${motivoNome(m.motivoSemExec)}: ${m.semExecObs || ""}` : (m.obs || ""),
  }));
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.json_to_sheet(linhas), "Missões");
  arquivos["missoes.xlsx"] = new Uint8Array(X.write(wb, { type: "array", bookType: "xlsx" }));
  arquivos["LEIA-ME.txt"] = strToU8(`Backup de fotos da Missão Elétrica EsFO\r\nGerado em ${fmtDH(Date.now())} por ${nomeDe(S.me.id)}\r\n${fotos.length} foto(s) de ${missoesNoZip.size} missão(ões) encerrada(s) há mais de ${MESES_FOTOS} meses.\r\n`);
  const nomeZip = `backup-fotos-missao-eletrica-${hojeISO()}.zip`;
  const blob = new Blob([zipSync(arquivos)], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = nomeZip;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);

  if (!confirm(`O arquivo "${nomeZip}" (${fmtBytes(blob.size)}) foi baixado.\n\nConfira se ele está salvo no celular/computador antes de continuar.\n\nApagar agora ${fotos.length} foto(s) de ${missoesNoZip.size} missão(ões) do app?`)) {
    toast("Limpeza cancelada. Nada foi apagado.");
    return carregarArmaz();
  }
  b.textContent = "Apagando…";
  const ok = await acao(async () => {
    for (let i = 0; i < fotos.length; i += 400) {
      const bt = writeBatch(db);
      fotos.slice(i, i + 400).forEach((f) => bt.delete(doc(db, "fotos", f.id)));
      await bt.commit();
    }
    const bt = writeBatch(db);
    [...missoesNoZip.keys()].forEach((id) => bt.update(doc(db, "missoes", id), { fotosLimpasEm: Date.now() }));
    await bt.commit();
  }, `${fotos.length} foto(s) apagada(s). Espaço liberado.`);
  if (ok) missoesNoZip.forEach((_, id) => delete S.fotos[id]);
  carregarArmaz();
}

// ---------------------------------------------------------------------
// Importação e exportação de planilhas
// ---------------------------------------------------------------------
const MODELOS = {
  materiais: {
    titulo: "materiais", cab: ["Nome", "Unidade", "Quantidade", "Categoria"],
    conv: (r) => {
      const nome = String(r.nome ?? "").trim();
      if (!nome) return { erro: "sem nome" };
      const qtd = Number(String(r.quantidade ?? 0).replace(",", "."));
      if (!(qtd >= 0)) return { erro: `quantidade inválida (${r.quantidade})` };
      const unidade = String(r.unidade || "un").trim();
      const cInf = String(r.categoria ?? "").trim();
      const categoria = NOMES_CATS.find((c) => semAcento(c) === semAcento(cInf)) || inferirCategoria(nome);
      return { id: slug(nome), dados: { nome, unidade, qtd, categoria, atualizadoEm: Date.now() }, prev: [nome, unidade, qtd, categoria] };
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
  // Lista de compras: cada linha vira um pedido pendente, em nome de quem importou.
  compras: {
    titulo: "lista de compras", cab: ["Material", "Quantidade", "Unidade", "Observação"],
    conv: (r) => {
      const item = String(r.material ?? "").trim();
      if (!item) return { erro: "sem material" };
      const qtd = Number(String(r.quantidade ?? "").replace(",", "."));
      if (!(qtd > 0)) return { erro: `quantidade inválida (${r.quantidade})` };
      const unidade = String(r.unidade || "un").trim();
      const obs = String(r.observacao ?? "").trim();
      if (S.compras.some((c) => c.status !== "comprado" && semAcento(c.item) === semAcento(item))) return { erro: `"${item}" já está na lista (pendente)` };
      return { id: null, dados: { item, qtd, unidade, obs, status: "pendente", criadoPor: S.me.id, em: Date.now() }, prev: [item, qtd, unidade, obs] };
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
    <p class="dica">Colunas: ${M.cab.join(", ")}. ${tipo === "compras"
      ? "Cada linha entra como pedido pendente; itens que já estão pendentes na lista são ignorados."
      : "Itens já cadastrados são atualizados, sem duplicar."}${tipo === "materiais" ? " A quantidade da planilha substitui o estoque atual." : ""}</p>
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
      // Sem id (lista de compras): cada linha vira um documento novo.
      ok.slice(i, i + 400).forEach((r) => b.set(r.id ? doc(db, tipo, r.id) : doc(collection(db, tipo)), r.dados, { merge: true }));
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
  let linhas, nome, extra = null;
  if (tipo === "compras") {
    linhas = S.compras.filter((c) => c.status !== "comprado").map((c) => ({
      Material: c.item, Quantidade: c.qtd, Unidade: c.unidade, Observação: c.obs || "", "Pedido por": nomeDe(c.criadoPor), Data: fmtData(c.em),
    }));
    nome = `lista-de-compras-${hojeISO()}.xlsx`;
  } else if (tipo === "materiais") {
    linhas = S.materiais.map((m) => ({ Nome: m.nome, Unidade: m.unidade, Quantidade: m.qtd, Categoria: catDe(m) }));
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
        "Cadastrada em": fmtData(m.criadaEm), Origem: origemTexto(m), "Concluída em": fmtData(m.concluidaEm), "Tempo (min)": m.tempoMin || "",
        "Material usado": (m.materiaisUsados || []).map((u) => `${u.qtd} ${u.unidade} ${u.nome}`).join("; "),
        Observações: m.obs || "",
      }));
    extra = semExecNoPeriodo(ini, fim, cadete).map((m) => ({
      "Encerrada em": fmtData(m.semExecEm), Missão: m.titulo, Tipo: m.tipo, Local: m.local, Executor: nomeDe(m.executor),
      Motivo: motivoNome(m.motivoSemExec), "Solucionado por": m.solucionadoPor || "", Justificativa: m.semExecObs || "",
      Origem: origemTexto(m), "Cadastrada por": nomeDe(m.criadoPor), "Cadastrada em": fmtData(m.criadaEm),
    }));
    nome = `relatorio-missoes-${de}-a-${ate}.xlsx`;
  }
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.json_to_sheet(linhas), extra ? "Validadas" : "Dados");
  if (extra?.length) X.utils.book_append_sheet(wb, X.utils.json_to_sheet(extra), "Sem execução");
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
  abrirDesignar: () => { S.designar = { id: S.cur, sel: null }; S.dirty = true; route(); },
  fecharDesignar: (b, e) => {
    // Clique no fundo escuro fecha; clique dentro da janela não.
    if (b.classList.contains("sobre") && e.target !== b) return;
    S.designar = null; S.dirty = false; route();
  },
  escolherCadete: (b) => {
    S.designar.sel = b.dataset.id;
    document.querySelectorAll(".cad-op").forEach((x) => x.classList.toggle("on", x === b));
    const ok = document.getElementById("desOk");
    ok.disabled = false;
    ok.textContent = "OK — " + nomeDe(b.dataset.id);
  },
  confirmarDesignar: async () => {
    const { id, sel } = S.designar || {};
    if (!id || !sel) return;
    // Transação: só designa se a missão ainda estiver no painel, sem executor.
    const ok = await acao(() => runTransaction(db, async (t) => {
      const ref = doc(db, "missoes", id);
      const atual = await t.get(ref);
      const d = atual.data();
      if (!d || d.status !== "painel" || d.executor) throw new Error(`a missão já foi capturada${d?.executor ? " por " + nomeDe(d.executor) : ""}. Atualize a tela.`);
      t.update(ref, { status: "em_execucao", executor: sel, capturadaEm: Date.now(), designadoPor: S.me.id, historico: H("Designou para " + nomeDe(sel)) });
    }), "Missão designada para " + nomeDe(sel));
    S.designar = null; S.dirty = false; route();
    return ok;
  },
  resgatar: () => {
    const m = S.missoes.find((x) => x.id === S.cur);
    if (!m?.executor) return;
    const motivo = prompt(`Resgatar a missão de ${nomeDe(m.executor)} e devolvê-la ao painel?\n\nMotivo (opcional):`);
    if (motivo === null) return;
    const txt = "Resgatou a missão de " + nomeDe(m.executor) + (motivo.trim() ? ": " + motivo.trim() : "");
    return upd({ status: "painel", executor: null, designadoPor: null, capturadaEm: null, motivoEspera: "", historico: H(txt) }, "Missão de volta ao painel");
  },
  abrirSemExec: () => { S.semExec = S.cur; S.dirty = true; route(); document.getElementById("fSemExec")?.scrollIntoView({ behavior: "smooth", block: "start" }); },
  fecharSemExec: () => { S.semExec = null; S.dirty = false; route(); },
  reabrir: () => {
    const m = S.missoes.find((x) => x.id === S.cur);
    if (!m) return;
    const motivo = prompt(`Reabrir a missão e devolvê-la ao painel?\n(Encerrada sem execução por ${nomeDe(m.semExecPor || m.executor)}: ${motivoNome(m.motivoSemExec)})\n\nMotivo da reabertura*:`);
    if (motivo === null) return;
    if (!motivo.trim()) return toast("Informe o motivo da reabertura.", true);
    return upd({
      status: "painel", executor: null, designadoPor: null, capturadaEm: null,
      motivoSemExec: null, semExecObs: null, solucionadoPor: null, semExecPor: null, semExecEm: null,
      historico: H("Reabriu a missão: " + motivo.trim()),
    }, "Missão reaberta e de volta ao painel");
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
  matAba: (b) => { S.matAba = b.dataset.aba; S.matPainel = null; S.dirty = false; route(); },
  comprarMat: (b) => { const m = S.materiais.find((x) => x.id === b.dataset.id); S.compraPre = m ? { nome: m.nome, unidade: m.unidade } : null; S.matAba = "compras"; route(); window.scrollTo(0, 0); },
  comprado: (b) => {
    const c = S.compras.find((x) => x.id === b.dataset.id);
    const mat = S.materiais.find((m) => semAcento(m.nome) === semAcento(c.item));
    const somar = mat && confirm(`Marcar "${c.item}" como comprado.\n\nSomar ${c.qtd} ${c.unidade} ao estoque agora?`);
    return acao(async () => {
      const batch = writeBatch(db);
      batch.update(doc(db, "compras", c.id), { status: "comprado", compradoEm: Date.now(), compradoPor: S.me.id });
      if (somar) {
        batch.update(doc(db, "materiais", mat.id), { qtd: increment(Number(c.qtd) || 0), atualizadoEm: Date.now() });
        batch.set(doc(collection(db, "movimentacoes")), { materialId: mat.id, tipo: "entrada", qtd: Number(c.qtd) || 0, compraId: c.id, por: S.me.id, em: Date.now() });
      }
      await batch.commit();
    }, somar ? "Comprado e somado ao estoque" : "Marcado como comprado");
  },
  delCompra: (b) => confirm("Remover este item da lista de compras?") && acao(() => deleteDoc(doc(db, "compras", b.dataset.id)), "Item removido"),
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
  tornarResp: (b) => {
    const m = S.membros.find((x) => x.id === b.dataset.id);
    if (!m || !confirm(`Tornar ${m.nome} responsável pela missão?\n\nEle poderá designar, validar, reabrir e arquivar missões, gerir o estoque e administrar os integrantes.`)) return;
    return acao(() => updateDoc(doc(db, "membros", m.id), { perfil: "comandante" }), `${m.nome} agora é responsável`);
  },
  tornarCadete: (b) => {
    const m = S.membros.find((x) => x.id === b.dataset.id);
    if (!m || !protegeComandante(m.id, true)) return;
    return acao(() => updateDoc(doc(db, "membros", m.id), { perfil: "cadete" }), `${m.nome} agora é cadete`);
  },
  delMembro: (b) => protegeComandante(b.dataset.id, true) && confirm(`Remover ${b.dataset.id} da missão?`) && acao(() => deleteDoc(doc(db, "membros", b.dataset.id)), "Integrante removido"),
  delLocal: (b) => acao(() => deleteDoc(doc(db, "locais", b.dataset.id)), "Local removido"),
  modelo: (b) => baixarModelo(b.dataset.tipo),
  exportar: (b) => exportar(b.dataset.tipo),
  limparFotos: (b) => limparFotos(b),
  zerar: (b) => zerarDados(b),
  confirmarImport,
  imprimir: () => window.print(),
  pdfCompras: () => {
    // O título vira o nome sugerido do arquivo PDF.
    const antes = document.title;
    document.title = `Lista de compras - Missão Elétrica - ${hojeISO()}`;
    window.print();
    setTimeout(() => { document.title = antes; }, 1000);
  },
};

$app.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !ACOES[b.dataset.act]) return;
  e.preventDefault();
  if (b.tagName === "BUTTON") b.disabled = true;
  try { await ACOES[b.dataset.act](b, e); } finally { if (b.isConnected && b.tagName === "BUTTON") b.disabled = false; }
});

// ---------------------------------------------------------------------
// Formulários
// ---------------------------------------------------------------------
const FORMS = {
  fNova: salvarNova,
  fConcluir: concluir,
  fSemExec: salvarSemExec,
  fIndisp: (f) => acao(() => updateDoc(doc(db, "membros", S.me.id), { indisponivelAte: f.ate.value || null }),
    f.ate.value ? "Indisponibilidade registrada" : "Indisponibilidade removida").then(() => { S.dirty = false; }),
  fCompra: (f) => {
    const d = Object.fromEntries(new FormData(f));
    const q = Number(String(d.qtd).replace(",", "."));
    if (!(q > 0)) return toast("Informe a quantidade", true);
    return acao(() => addDoc(collection(db, "compras"), {
      item: d.item.trim(), qtd: q, unidade: (d.unidade || "un").trim(), obs: (d.obs || "").trim(),
      status: "pendente", criadoPor: S.me.id, em: Date.now(),
    }), "Adicionado à lista de compras").then((ok) => { if (ok) { S.compraPre = null; S.dirty = false; route(); } });
  },
  fMaterial: (f) => {
    const d = Object.fromEntries(new FormData(f));
    const nome = d.nome.trim();
    return acao(() => setDoc(doc(db, "materiais", slug(nome)), {
      nome, unidade: d.unidade.trim() || "un", qtd: Number(d.qtd) || 0,
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

// Esc fecha a janela "Designar para…".
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S.designar) { S.designar = null; S.dirty = false; route(); }
});

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
  else if (t.name === "origem" && t.form?.id === "fNova") document.getElementById("origemDet").innerHTML = campoOrigem(t.value);
  else if (t.name === "motivoSemExec" && t.form?.id === "fSemExec") {
    document.getElementById("solDet").innerHTML = t.value === "ja_solucionado"
      ? `<label>Quem solucionou (se souber)<input name="solucionadoPor" maxlength="80" placeholder="Ex.: empresa terceirizada, outra missão"></label>` : "";
  }
  else if (["relDe", "relAte", "relCadete"].includes(t.id)) {
    S.rel = { de: document.getElementById("relDe").value || CICLO_INICIO, ate: document.getElementById("relAte").value || hojeISO(), cadete: document.getElementById("relCadete").value };
    route();
  } else if (t.dataset.import) await lerPlanilha(t);
  else if (t.dataset.ativo) {
    if (!protegeComandante(t.dataset.ativo, !t.checked)) { t.checked = true; return; }
    acao(() => updateDoc(doc(db, "membros", t.dataset.ativo), { ativo: t.checked }), t.checked ? "Integrante reativado" : "Integrante desativado");
  }
});

// Service worker (permite instalar como app no celular)
// updateViaCache "none": o celular sempre confere se há um sw.js novo, sem usar cópia guardada.
if ("serviceWorker" in navigator) {
  const tinhaVersao = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(() => {});
  // Quando uma versão nova do app assume, recarrega a tela (se ninguém estiver preenchendo um formulário).
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!tinhaVersao) return;
    if (!S.dirty) location.reload();
    else toast("Há uma versão nova do app. Ela entra quando você recarregar a página.");
  });
}

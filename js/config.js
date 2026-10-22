// =====================================================================
// CONFIGURAÇÃO DO APP — Missão Elétrica EsFO
// Este é o único arquivo que precisa ser editado na instalação.
// =====================================================================

// 1) Cole aqui o objeto "firebaseConfig" que o Firebase mostra ao
//    registrar o app web (Configurações do projeto > Seus apps).
export const firebaseConfig = {
  apiKey: "AIzaSyBZ5CoFsUpeszkMRK_oSunGTtcaIIbCo7I",
  authDomain: "missao-eletrica-esfo.firebaseapp.com",
  projectId: "missao-eletrica-esfo",
  storageBucket: "missao-eletrica-esfo.firebasestorage.app",
  messagingSenderId: "736061426507",
  appId: "1:736061426507:web:2fc95b18ce179568d076ce",
};

// 2) Início do ciclo atual (os pontos do rodízio contam a partir desta data).
//    Para "zerar" o rodízio em um novo semestre, basta trocar a data.
export const CICLO_INICIO = "2026-08-01";

// 3) Depois de quantas horas sem captura a missão aparece como PARADA.
export const HORAS_ALERTA_PAINEL = 48;

// 4) Listas usadas nos formulários.
export const TIPOS = [
  "Iluminação",
  "Tomadas e interruptores",
  "Quadros e disjuntores",
  "Fiação",
  "Chuveiros",
  "Ventiladores e equipamentos",
  "Outros",
];

export const PRIORIDADES = [
  ["urgente", "Urgente"],
  ["alta", "Alta"],
  ["media", "Média"],
  ["baixa", "Baixa"],
];

// Como o problema chegou ao conhecimento da missão elétrica.
// [código interno, nome exibido, complemento pedido no cadastro (null = nenhum)]
// O código é o que fica gravado no banco: não altere os códigos já em uso.
export const ORIGENS = [
  ["proprio", "Constatado por integrante da missão", null],
  ["terceiro", "Informado por cadete de fora da missão", "Quem informou (nome e turma)"],
  ["dia_a_esfo", "Relatório do Dia-à-EsFO", "Data do relatório"],
  ["outro", "Outro", "Especifique (ex.: pedido de oficial, servidor)"],
];

// Motivos para encerrar uma missão sem executar o serviço.
export const MOTIVOS_SEM_EXEC = [
  ["nao_constatado", "Problema não constatado (não existe)"],
  ["ja_solucionado", "Problema já solucionado"],
];

// Texto fixo do PDF da lista de compras (Materiais › Lista de compras › Gerar PDF).
export const TEXTO_COMPRAS =
  "A Missão Elétrica da Escola de Formação de Oficiais, responsável pela manutenção das instalações " +
  "elétricas da EsFO, apresenta a relação de materiais necessários à continuidade dos serviços. " +
  "Os itens abaixo destinam-se ao atendimento das demandas de manutenção identificadas pela missão " +
  "e à reposição do estoque de materiais elétricos.";

export const PESOS = [
  [1, "1 · Simples (ex.: trocar lâmpada)"],
  [2, "2 · Média (ex.: trocar tomada)"],
  [3, "3 · Complexa (ex.: refazer circuito)"],
];

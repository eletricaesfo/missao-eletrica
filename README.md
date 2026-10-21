# Missão Elétrica · EsFO

Aplicativo web (instalável no celular) para gerir as missões de manutenção elétrica da EsFO.
Feito em HTML + JavaScript puro, hospedado no GitHub Pages, com dados no Firebase (plano gratuito Spark).

## O que o app faz

- Qualquer cadete da missão cadastra uma missão ao encontrar um problema elétrico (com foto).
- Painel com as missões abertas; o cadete captura a missão e executa.
- Os responsáveis pela missão designam um cadete apenas para missões que ninguém capturou, arquivam duplicadas e validam conclusões.
- Conclusão com fotos de depois, material usado (baixa automática do estoque), tempo e observações.
- Rodízio por pontos (peso 1 a 3 por missão) e contador por cadete (aba Efetivo).
- Estoque de materiais com lista de compras, importação e exportação de planilhas.
- Relatórios por período e por cadete, em PDF (impressão) e planilha.

## Instalação (uma vez)

### 1. Firebase
1. Em https://console.firebase.google.com crie um projeto (pode desativar o Google Analytics).
2. **Authentication › Sign-in method**: ative o provedor **Google**.
3. **Firestore Database**: crie o banco em modo de produção, local `southamerica-east1` (São Paulo).
4. **Firestore › Regras**: apague o conteúdo e cole o arquivo `firestore.rules`. Clique em Publicar.
5. **Configurações do projeto › Seus apps › Web (</>)**: registre o app e copie o objeto `firebaseConfig`.
6. Cole esse objeto em `js/config.js`.

### 2. Primeiro responsável
No **Firestore › Dados**, crie a coleção `membros` e um documento:
- ID do documento: o e-mail Google do responsável, em minúsculas (ex.: `fulano@gmail.com`)
- Campos: `nome` (string) = `Cad. Fulano`, `perfil` (string) = `comandante` (é o valor interno do perfil "Responsável"), `ativo` (boolean) = `true`

Os demais integrantes e o segundo responsável são incluídos pelo próprio app (Mais › Administração), à mão ou por planilha.

### 3. GitHub Pages
1. Crie um repositório público (ex.: `missao-eletrica`) e envie todos os arquivos desta pasta.
2. **Settings › Pages**: Source = *Deploy from a branch*, branch `main`, pasta `/ (root)`.
3. O endereço será `https://SEU-USUARIO.github.io/missao-eletrica/`.
4. No Firebase, **Authentication › Settings › Authorized domains**: adicione `SEU-USUARIO.github.io`.

## Manutenção
- Novo semestre: altere `CICLO_INICIO` em `js/config.js` para zerar o rodízio (o histórico continua).
- Tipos de serviço, prioridades e pesos também ficam em `js/config.js`.
- Para editar qualquer arquivo, use o lápis ✏️ no próprio site do GitHub; o Pages publica sozinho em 1–2 minutos.
- Mantenha sempre os dois responsáveis como administradores e passe o acesso à turma seguinte.

## Custos
Zero, dentro do plano Spark: 50 mil leituras e 20 mil gravações por dia e 1 GiB de dados.
As fotos são comprimidas no celular e gravadas no Firestore (o Cloud Storage exige plano pago).

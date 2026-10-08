# JEV — credencial protegida e teste de conexão

## Credencial

A chave fornecida pelo proprietário em **08/10/2026** está provisionada somente
no ambiente local, em `infra/secrets/local/jev_api_key`. Seu valor não integra
este documento, código, fixtures, logs ou exemplos de comandos.

O diretório usa permissão `0700` e o arquivo `0600`. O caminho está ignorado
pelo Git nos dois checkouts locais; o arquivo não é rastreado. O scanner de
segredos do projeto lê os arquivos desse diretório para detectar reutilização
do conteúdo fora dele, sem imprimir o valor encontrado.

O contrato atual do backend lê a credencial em `/run/secrets/jev_api_key`,
conforme [jev-config.ts](../../apps/api/src/models/jev-config.ts).
O arquivo local é a origem protegida para eventual provisionamento nesse
caminho. Este teste não instalou a chave no servidor nem alterou o Compose,
a configuração do challenger, seus orçamentos ou a ativação das estratégias.

## Teste real observado

Executado em **08/10/2026 às 00:06:20, America/Sao_Paulo**
(`2026-10-08T03:06:20.182Z`), a partir do checkout local.

| Campo | Resultado |
| --- | --- |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` |
| Autenticação | Chave aceita em cabeçalho Bearer; valor omitido |
| Modelo solicitado e retornado | `jev-1.13.0` |
| Tentativas | 1, sem retry automático |
| HTTP | **200** |
| Duração observada | **391 ms**, incluindo rede e leitura da resposta |
| Pergunta | Noul: a mensagem sintética comunica urgência? |
| Resposta | `type: noul`, `noul: 0.98` |
| Uso retornado pela API | **289 tokens de entrada; 23 de saída** |
| Validação | Modelo esperado, tipo Noul, probabilidade entre 0 e 1 e uso inteiro não negativo |

O estado enviado foi uma mensagem sintética de suporte em inglês, sem dados
reais de mercado, contas ou operadores. A chave foi enviada somente no cabeçalho
de autenticação ao domínio oficial do fornecedor. Nenhuma ordem foi gerada.

A chamada comprova autenticação, conectividade e o contrato HTTP de uma resposta
Noul. Não qualifica o filtro Choice do adaptador existente, as decisões do novo
motor JEV, o runtime em produção, a precisão financeira ou uma distribuição de
latência. A ativação operacional continua seguindo os gates do projeto.

Também passaram nove cenários offline com credencial fictícia: resposta válida,
HTTP de erro, modelo divergente, probabilidade inválida, corpo excessivo, exceção
com texto sensível, permissão inadequada, symlink de arquivo e symlink de diretório.
Esses cenários não fizeram chamadas ao fornecedor. O scanner de segredos passou.

## Repetir o teste

Com Node.js 24–26 e a credencial local já provisionada:

```sh
node scripts/check_jev_api.mjs
python3 scripts/scan_secrets.py
```

[check_jev_api.mjs](../../scripts/check_jev_api.mjs) faz uma única chamada real,
com timeout de 30 segundos, modelo fixado e bloqueio de redirecionamentos.
Cada execução pode consumir créditos da API; o script não integra os testes
automáticos nem o startup dos serviços.

O script recusa diretório acessível a outros usuários, arquivo com permissões
inadequadas e link simbólico no caminho final. A saída contém somente campos
validados da resposta. Em falhas, apresenta códigos sanitizados; não imprime
corpos de erro, cabeçalhos nem exceções brutas do fornecedor.

Nunca passe a chave como argumento de comando, copie seu conteúdo para arquivos
versionados ou use `git add -f` no diretório de segredos. Para provisionar outro
ambiente, use um canal privado e mantenha o arquivo no backend com acesso restrito.

Referências consultadas em 08/10/2026: [skill TypeSafe](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md),
[API HTTP](https://docs.typesafe.ai/api), [Noul](https://docs.typesafe.ai/primitives/noul)
e [modelos e aliases](https://docs.typesafe.ai/models).

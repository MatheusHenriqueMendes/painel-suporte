# Painel de suporte para clientes (Bitrix24, pipeline 17)

Painel somente leitura, hospedado no GitHub Pages, em que cada escritório cliente consulta os próprios pedidos de suporte: kanban por etapa, lista, filtros (solicitante, situação, tipo e demais campos de lista), campos do negócio e comentários.

## Como funciona

1. A cada 15 minutos o GitHub Actions roda `scripts/build.mjs`, que lê a pipeline 17 pelo webhook do Bitrix24.
2. Para cada escritório é gerado **um arquivo criptografado** (AES-256-GCM) cuja chave é derivada da senha do escritório (PBKDF2-SHA256, 600 mil iterações).
3. O site é publicado no GitHub Pages. O login acontece no navegador: a senha descriptografa o arquivo. Sem a senha certa, o conteúdo é ilegível.

Nenhum dado de cliente e nenhum segredo fica no repositório: os arquivos só existem no site publicado, já criptografados.

## Instalação

1. Crie o repositório e envie estes arquivos para a branch `main`.
2. No Bitrix24, crie um **webhook de entrada** com os escopos `crm` e `user`.
3. Em *Settings → Secrets and variables → Actions*, crie dois secrets:
   - `BITRIX_WEBHOOK_URL`: `https://SEUPORTAL.bitrix24.com.br/rest/ID/TOKEN/`
   - `OFFICES_JSON`: lista de escritórios (veja abaixo).
4. Em *Settings → Pages*, escolha **Source: GitHub Actions**.
5. Rode o workflow **Publicar painel** em *Actions* (ou faça um push).

### Cadastro de escritórios (`OFFICES_JSON`)

```json
[
  { "login": "engel", "password": "4Mned-nxYuB-NfHGF-UGn4E", "office": "Engel Advogados" },
  { "login": "outro", "password": "…", "office": ["Opção A", "Opção B"], "name": "Nome exibido no painel" }
]
```

- `office`: opção (texto ou ID) do campo de lista **Solicitante** do negócio (`officeField` no `panel.config.json`). Só os negócios da pipeline 17 com essa opção entram no arquivo do escritório. Também é aceito `companyId` (empresa vinculada ao negócio).
- `name` é opcional (padrão: o texto da opção).
- Gere senhas fortes com `node scripts/new-office.mjs <login> 1` e troque `companyId` por `office`.
- Trocar a senha ou remover o escritório do secret revoga o acesso na próxima execução.

**Use sempre senhas geradas (mínimo de 12 caracteres, o build recusa menos).** Os arquivos criptografados são públicos; a senha é a única barreira, e senha fraca pode ser quebrada por tentativa.

## Configuração (`panel.config.json`)

| Chave | Função |
|---|---|
| `categoryId` | Pipeline do Bitrix24 (17). |
| `officeField` | Campo de lista que identifica o escritório solicitante. |
| `titleField` / `descField` | Campo usado como título do cartão e como descrição do chamado. |
| `cardField` | Campo mostrado como etiqueta no cartão. |
| `closedDays` | Chamados encerrados há mais de N dias saem do painel. |
| `fields.standard` | Campos padrão do negócio exibidos. |
| `fields.exclude` | Campos personalizados que **não** devem aparecer para o cliente. |
| `fields.only` | Se preenchido, só estes campos aparecem (ignora os demais). É o modo em uso. |
| `fields.filters` | Campos de texto que também devem virar filtro. |
| `fields.labels` | Renomeia campos: `{ "UF_CRM_123": "Prioridade" }`. |
| `comments.hideTag` | Comentários contendo este texto (padrão `#interno`) não são publicados. |

Com `fields.only` vazio, **todos os campos personalizados (UF_)** seriam exibidos; mantenha a lista preenchida. **Todos os comentários da timeline** são exibidos, exceto os que contêm o `hideTag`. Rode `npm run fields` (com `BITRIX_WEBHOOK_URL` definido) para ver os códigos dos campos ao ajustar a lista.

Campos dos tipos lista, status e sim/não viram filtros automaticamente. Campos de arquivo e vínculos de CRM não são exibidos.

## Testar localmente

```bash
npm run demo     # dados fictícios em http://localhost:8080 (login demo / senha demonstracao-2026)
```

## Limites

- Somente leitura; os dados têm até ~15 minutos de atraso (o agendamento do GitHub pode atrasar mais em horários de pico).
- Até 50 comentários mais recentes por chamado.
- Em repositório público o Actions é gratuito. Em repositório privado, o agendamento de 15 min consome a cota de minutos, e o Pages exige plano pago; ajuste o `cron` em `.github/workflows/deploy.yml` se necessário.
- O GitHub desativa workflows agendados após 60 dias sem atividade no repositório; basta reativar em *Actions*.

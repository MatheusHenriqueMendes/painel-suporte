#!/usr/bin/env node
// Gera o site estático em dist/: copia site/ e cria um arquivo de dados
// criptografado por escritório (AES-256-GCM, chave derivada da senha via PBKDF2).
//
//   node scripts/build.mjs           -> lê o Bitrix24 (BITRIX_WEBHOOK_URL + OFFICES_JSON)
//   node scripts/build.mjs --mock    -> dados de exemplo (login: demo / senha: demonstracao-2026)
//   node scripts/build.mjs --fields  -> lista os campos do negócio para montar o panel.config.json

import { createHash, pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const ITER = 600_000;
const MIN_PASSWORD = 12;
const args = new Set(process.argv.slice(2));

const config = JSON.parse(await readFile(path.join(ROOT, 'panel.config.json'), 'utf8'));
const CATEGORY = Number(config.categoryId);

// ---------------------------------------------------------------- Bitrix24
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let BASE = '';

async function call(method, params = {}) {
  for (let attempt = 1; ; attempt++) {
    let res, json;
    try {
      res = await fetch(`${BASE}/${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      json = await res.json();
    } catch (e) {
      if (attempt >= 5) throw new Error(`${method}: falha de rede (${e.message})`);
      await sleep(1000 * attempt);
      continue;
    }
    const limited = res.status === 503 || res.status === 429 || json.error === 'QUERY_LIMIT_EXCEEDED';
    if (limited && attempt < 6) { await sleep(1000 * attempt); continue; }
    if (json.error) throw new Error(`${method}: ${json.error} ${json.error_description || ''}`);
    return json.result;
  }
}

// Paginação por ID (start=-1), recomendada pelo Bitrix24 para listas grandes.
async function listAll(method, { filter = {}, select = ['*'] } = {}) {
  const out = [];
  let lastId = 0;
  for (;;) {
    const page = await call(method, { order: { ID: 'ASC' }, filter: { ...filter, '>ID': lastId }, select, start: -1 });
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    lastId = Number(page[page.length - 1].ID);
    if (page.length < 50) break;
  }
  return out;
}

async function batch(cmds) {
  const keys = Object.keys(cmds);
  const out = {};
  for (let i = 0; i < keys.length; i += 50) {
    const cmd = Object.fromEntries(keys.slice(i, i + 50).map((k) => [k, cmds[k]]));
    const r = await call('batch', { halt: 0, cmd });
    Object.assign(out, r.result || {});
  }
  return out;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// ---------------------------------------------------------------- texto
const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'" };
function plainText(s) {
  if (!s) return '';
  return String(s)
    .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_, u, t) => (t.trim() && t.trim() !== u ? `${t} (${u})` : u))
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/\[\/?(?:\*|[a-z][a-z0-9]*)(?:=[^\]]*)?\]/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#0?39);/g, (m) => ENTITIES[m])
    .replace(/\r/g, '')
    .replace(/^[ \t\u00a0]+|[ \t\u00a0]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function shortTitle(raw) {
  const line = plainText(raw).split('\n').find((l) => l.trim())?.trim() || '';
  return line.length > 110 ? line.slice(0, 107).trimEnd() + '…' : line;
}
const personName = (p) => [p?.NAME, p?.LAST_NAME].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- campos
const SKIP_TYPES = new Set(['file', 'crm', 'crm_entity', 'crm_category', 'crm_company', 'crm_contact', 'iblock_section', 'iblock_element', 'resourcebooking', 'object', 'attached_diskfile']);
const FILTER_TYPES = new Set(['enumeration', 'crm_status', 'boolean']);
const ALWAYS_HIDDEN = new Set(['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'COMPANY_ID', 'CONTACT_ID', 'CONTACT_IDS', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'DATE_MODIFY', 'COMMENTS', 'CLOSED', 'STAGE_SEMANTIC_ID']);

function pickFields(dealFields) {
  const fc = config.fields || {};
  const only = new Set(fc.only || []);
  const exclude = new Set(fc.exclude || []);
  const standard = new Set(fc.standard || []);
  const out = [];
  for (const [code, f] of Object.entries(dealFields)) {
    if (ALWAYS_HIDDEN.has(code) || SKIP_TYPES.has(f.type) || code === config.officeField) continue;
    const isUf = code.startsWith('UF_');
    if (only.size ? !only.has(code) : exclude.has(code) || (!isUf && !standard.has(code))) continue;
    out.push({
      code,
      label: fc.labels?.[code] || f.formLabel || f.listLabel || f.filterLabel || f.title || code,
      type: f.type,
      filter: FILTER_TYPES.has(f.type) || (fc.filters || []).includes(code),
      forced: (fc.filters || []).includes(code),
      def: f,
    });
  }
  return out;
}

function formatValue(field, raw, ctx) {
  const one = (v) => {
    if (v === null || v === undefined || v === '' || typeof v === 'object') return null;
    switch (field.type) {
      case 'enumeration': return field.def.items?.find((i) => String(i.ID) === String(v))?.VALUE ?? null;
      case 'crm_status': return ctx.statuses[field.def.statusType]?.[v] ?? String(v);
      case 'boolean': return v === true || v === 'Y' || v === '1' || v === 1 ? 'Sim' : 'Não';
      case 'employee':
      case 'user': return ctx.users[v] || null;
      case 'money': {
        const [amount, cur] = String(v).split('|');
        if (!amount) return null;
        try { return Number(amount).toLocaleString('pt-BR', { style: 'currency', currency: cur || 'BRL' }); }
        catch { return `${amount} ${cur || ''}`.trim(); }
      }
      case 'address': return String(v).split('|')[0] || null;
      case 'date':
      case 'datetime': return String(v);
      default: {
        const t = plainText(v);
        if (!t) return null;
        // campos de texto usados como filtro: unifica maiúsculas/minúsculas ("Erro Sistêmico" = "Erro sistêmico")
        return field.forced ? t[0].toUpperCase() + t.slice(1).toLowerCase() : t;
      }
    }
  };
  if (Array.isArray(raw)) {
    const vals = raw.map(one).filter((v) => v !== null);
    return vals.length ? vals : null;
  }
  if (field.type === 'boolean' && (raw === null || raw === undefined || raw === '')) return null;
  return one(raw);
}

// ---------------------------------------------------------------- coleta
async function collect(offices) {
  const companyIds = [...new Set(offices.flatMap((o) => o.companyIds))];
  console.log(`Pipeline ${CATEGORY}: ${offices.length} escritório(s)`);

  const [dealFields, stagesRaw] = await Promise.all([
    call('crm.deal.fields'),
    call('crm.status.list', { order: { SORT: 'ASC' }, filter: { ENTITY_ID: CATEGORY === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${CATEGORY}` } }),
  ]);
  if (!stagesRaw.length) throw new Error(`Nenhuma etapa encontrada para a pipeline ${CATEGORY}. Confira o categoryId e o portal do webhook.`);
  const stages = stagesRaw
    .sort((a, b) => Number(a.SORT) - Number(b.SORT))
    .map((s) => ({ id: s.STATUS_ID, name: s.NAME, color: s.COLOR || s.EXTRA?.COLOR || '', sem: ({ S: 'S', F: 'F' })[String(s.SEMANTICS || s.EXTRA?.SEMANTICS || 'P')[0].toUpperCase()] || 'P' }));

  const fields = pickFields(dealFields);

  // escritórios identificados por um campo de lista do negócio (config.officeField)
  const officeField = config.officeField;
  for (const o of offices) {
    o.fieldIds = [];
    if (!o.officeValues.length) continue;
    const items = dealFields[officeField]?.items;
    if (!officeField || !items) throw new Error(`Escritório "${o.login}": "office" exige "officeField" (campo de lista) no panel.config.json.`);
    for (const v of o.officeValues) {
      const it = items.find((i) => String(i.ID) === v || String(i.VALUE).trim().toLowerCase() === v.toLowerCase());
      if (!it) throw new Error(`Escritório "${o.login}": opção "${v}" não existe no campo ${officeField}.`);
      o.fieldIds.push(String(it.ID));
    }
    o.name ||= items.find((i) => String(i.ID) === o.fieldIds[0]).VALUE;
  }
  const fieldIds = [...new Set(offices.flatMap((o) => o.fieldIds))];

  const statuses = {};
  for (const type of new Set(fields.filter((f) => f.type === 'crm_status').map((f) => f.def.statusType).filter(Boolean))) {
    const list = await call('crm.status.list', { filter: { ENTITY_ID: type } });
    statuses[type] = Object.fromEntries(list.map((s) => [s.STATUS_ID, s.NAME]));
  }

  // abertos + encerrados recentes (o corte de data é feito no Bitrix24 para não baixar o histórico todo)
  const cutoff = new Date(Date.now() - Number(config.closedDays ?? 90) * 864e5).toISOString();
  const scopes = [];
  if (fieldIds.length) scopes.push({ [officeField]: fieldIds });
  for (const ids of chunk(companyIds, 50)) scopes.push({ '@COMPANY_ID': ids });
  const byId = new Map();
  for (const scope of scopes) {
    for (const extra of [{ CLOSED: 'N' }, { CLOSED: 'Y', '>=DATE_MODIFY': cutoff }]) {
      const page = await listAll('crm.deal.list', { filter: { CATEGORY_ID: CATEGORY, ...scope, ...extra }, select: ['*', 'UF_*'] });
      for (const d of page) byId.set(d.ID, d);
    }
  }
  const deals = [...byId.values()];
  console.log(`${deals.length} chamado(s) no período`);

  // comentários da timeline
  const comments = {};
  if (config.comments?.enabled !== false && deals.length) {
    const cmds = {};
    for (const d of deals) {
      const qs = new URLSearchParams({ 'filter[ENTITY_ID]': d.ID, 'filter[ENTITY_TYPE]': 'deal', 'order[ID]': 'DESC' });
      for (const s of ['ID', 'CREATED', 'AUTHOR_ID', 'COMMENT']) qs.append('select[]', s);
      cmds[`c${d.ID}`] = `crm.timeline.comment.list?${qs}`;
    }
    const res = await batch(cmds);
    const hide = (config.comments?.hideTag || '').toLowerCase();
    for (const d of deals) {
      comments[d.ID] = (res[`c${d.ID}`] || [])
        .filter((c) => !hide || !String(c.COMMENT || '').toLowerCase().includes(hide))
        .sort((a, b) => Number(a.ID) - Number(b.ID));
    }
  }

  // nomes de contatos
  const contacts = {};
  const contactIds = [...new Set(deals.map((d) => d.CONTACT_ID).filter((v) => v && v !== '0'))];
  for (const ids of chunk(contactIds, 50)) {
    const list = await call('crm.contact.list', { filter: { '@ID': ids }, select: ['ID', 'NAME', 'LAST_NAME'], start: -1 });
    for (const c of list) contacts[c.ID] = personName(c);
  }

  // nomes de usuários (responsável, autores de comentários, campos do tipo usuário)
  const users = {};
  const userIds = new Set();
  const userFields = fields.filter((f) => f.type === 'employee' || f.type === 'user');
  for (const d of deals) {
    if (d.ASSIGNED_BY_ID) userIds.add(String(d.ASSIGNED_BY_ID));
    for (const c of comments[d.ID] || []) if (c.AUTHOR_ID) userIds.add(String(c.AUTHOR_ID));
    for (const f of userFields) for (const v of [].concat(d[f.code] ?? [])) if (v) userIds.add(String(v));
  }
  try {
    const res = await batch(Object.fromEntries([...userIds].map((id) => [`u${id}`, `user.get?ID=${id}`])));
    for (const id of userIds) { const u = res[`u${id}`]?.[0]; if (u) users[id] = personName(u); }
  } catch (e) {
    console.warn(`Aviso: não foi possível ler nomes de usuários (${e.message}). O webhook precisa do escopo "user".`);
  }

  const companies = {};
  for (const ids of chunk(companyIds, 50)) {
    const list = await call('crm.company.list', { filter: { '@ID': ids }, select: ['ID', 'TITLE'], start: -1 });
    for (const c of list) companies[c.ID] = c.TITLE;
  }

  // histórico de etapas dos chamados abertos: usado para descontar o tempo em etapas que suspendem o SLA
  const history = {};
  const paused = new Set(config.sla?.pausedStages || []);
  const openIds = deals.filter((d) => d.CLOSED !== 'Y').map((d) => Number(d.ID));
  if (config.sla && paused.size) {
    try {
      for (const ids of chunk(openIds, 50)) {
        for (let start = 0; start !== null && start !== undefined;) {
          const res = await call('crm.stagehistory.list', { entityTypeId: 2, order: { ID: 'ASC' }, filter: { OWNER_ID: ids }, select: ['ID', 'OWNER_ID', 'STAGE_ID', 'CREATED_TIME'], start });
          for (const it of res.items || []) (history[it.OWNER_ID] ||= []).push({ t: new Date(it.CREATED_TIME).getTime(), stage: it.STAGE_ID });
          start = (res.items || []).length === 50 ? start + 50 : null;
        }
      }
    } catch (e) {
      console.warn(`Aviso: não foi possível ler o histórico de etapas (${e.message}); vencimentos calculados sem suspensões.`);
    }
  }
  const offsetMs = Number(config.sla?.utcOffsetHours ?? -3) * 36e5;
  const holidays = new Set(config.sla?.holidays || []);
  const dayStr = (ms) => new Date(ms + offsetMs).toISOString().slice(0, 10);          // data local
  const noonOf = (str) => Date.parse(`${str}T12:00:00Z`) - offsetMs;                   // meio-dia local em UTC
  const nextDay = (str) => new Date(Date.parse(`${str}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const isBiz = (str) => { const w = new Date(`${str}T12:00:00Z`).getUTCDay(); return w !== 0 && w !== 6 && !holidays.has(str) && !holidays.has(str.slice(5)); };
  const pausedAt = (id, ms) => { let st = null; for (const h of history[id] || []) { if (h.t <= ms) st = h.stage; else break; } return st !== null && paused.has(st); };
  // vencimento = abertura + N dias úteis, sem contar os dias úteis passados em etapa suspensa
  const dueOf = (d, days) => {
    const today = dayStr(Date.now());
    let day = dayStr(new Date(d.DATE_CREATE).getTime()), count = 0, pausedDays = 0;
    for (let guard = 0; guard < 3000 && count < days; guard++) {
      day = nextDay(day);
      if (!isBiz(day)) continue;
      if (day <= today && pausedAt(d.ID, noonOf(day))) { pausedDays++; continue; }
      count++;
    }
    return { due: day, pausedDays };
  };

  const ctx = { statuses, users };

  // prioridade (matriz) e prazo estimado pelo SLA, calculados a partir dos campos do negócio
  const enumLabel = (code, raw) => {
    if (!code || raw === null || raw === undefined || raw === '') return '';
    return String(dealFields[code]?.items?.find((i) => String(i.ID) === String(raw))?.VALUE ?? raw).trim();
  };
  const priorityOf = (d) => {
    const pc = config.priority;
    const n = Number(/\d/.exec(enumLabel(pc?.field, d[pc?.field]))?.[0] || 0);
    return pc?.levels?.[n] ? n : 0;
  };
  const slaOf = (d) => {
    const sc = config.sla;
    if (!sc?.typeField) return null;
    const type = enumLabel(sc.typeField, d[sc.typeField]).toLowerCase();
    const rule = (sc.rules || []).find((r) => type.startsWith(r.type.toLowerCase()));
    if (!rule) return null;
    const size = enumLabel(sc.sizeField, d[sc.sizeField]);
    const val = rule.sizes?.[size] ?? rule.default;
    const base = { type: rule.type, size: sc.sizeNames?.[size] || '', note: rule.note || '' };
    if (val === undefined || val === null) return { ...base, pending: true };
    const [min, max = min] = [].concat(val);
    const out = { ...base, min, max };
    if (d.CLOSED !== 'Y') {
      Object.assign(out, dueOf(d, max));
      if (paused.has(d.STAGE_ID)) out.paused = true;
    }
    return out;
  };
  const payloads = new Map();
  for (const office of offices) {
    const mine = deals.filter((d) => office.companyIds.includes(Number(d.COMPANY_ID))
      || [].concat(d[officeField] ?? []).some((v) => office.fieldIds.includes(String(v))));
    const rows = mine.map((d) => {
      const v = {};
      for (const f of fields) { const val = formatValue(f, d[f.code], ctx); if (val !== null) v[f.code] = val; }
      return [d, v];
    });
    const used = new Set(rows.flatMap(([, v]) => Object.keys(v)));
    const publicFields = fields.filter((f) => used.has(f.code)).map(({ code, label, type, filter }) => ({ code, label, type, filter }));
    payloads.set(office.login, {
      office: { name: office.name || companies[office.companyIds[0]] || office.login },
      generatedAt: new Date().toISOString(),
      product: config.productName || 'Suporte',
      cardField: config.cardField || 'TYPE_ID',
      noteField: config.cardNoteField || '',
      closedDays: Number(config.closedDays ?? 90),
      priority: config.priority ? { label: config.priority.label || 'Prioridade', levels: config.priority.levels } : null,
      sla: config.sla ? { legend: config.sla.legend || [], footnote: config.sla.footnote || '', holidays: config.sla.holidays || [] } : null,
      stages,
      fields: publicFields,
      deals: rows.map(([d, v]) => {
        return {
          id: Number(d.ID),
          title: shortTitle(d[config.titleField]) || d.TITLE || `Chamado #${d.ID}`,
          stage: d.STAGE_ID,
          contact: contacts[d.CONTACT_ID] || '',
          assigned: users[d.ASSIGNED_BY_ID] || '',
          created: d.DATE_CREATE,
          modified: d.DATE_MODIFY,
          desc: plainText(d[config.descField]) || plainText(d.COMMENTS),
          pri: priorityOf(d),
          sla: slaOf(d),
          v,
          comments: (comments[d.ID] || []).map((c) => ({ a: users[c.AUTHOR_ID] || 'Equipe de suporte', d: c.CREATED, t: plainText(c.COMMENT) })).filter((c) => c.t),
        };
      }),
    });
  }
  return payloads;
}

// ---------------------------------------------------------------- criptografia
const normLogin = (s) => String(s).trim().toLowerCase();
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest();

function encrypt(login, password, payload) {
  const salt = sha256(`ae-painel:salt:${login}`).subarray(0, 16);
  const key = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, ITER, 32, 'sha256');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))), cipher.final(), cipher.getAuthTag()]);
  return {
    file: sha256(`ae-painel:file:${login}`).toString('hex').slice(0, 40),
    envelope: { v: 1, iter: ITER, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') },
  };
}

function loadOffices(raw) {
  let list;
  try { list = JSON.parse(raw); } catch { throw new Error('OFFICES_JSON não é um JSON válido.'); }
  if (!Array.isArray(list) || !list.length) throw new Error('OFFICES_JSON precisa ser uma lista com pelo menos um escritório.');
  const seen = new Set();
  return list.map((o, i) => {
    const login = normLogin(o.login || '');
    const companyIds = [].concat(o.companyIds ?? o.companyId ?? []).map(Number).filter(Boolean);
    if (!login) throw new Error(`OFFICES_JSON[${i}]: "login" é obrigatório.`);
    if (seen.has(login)) throw new Error(`OFFICES_JSON: login "${login}" duplicado.`);
    seen.add(login);
    const officeValues = [].concat(o.office ?? []).map((v) => String(v).trim()).filter(Boolean);
    if (!companyIds.length && !officeValues.length) throw new Error(`Escritório "${login}": informe "office" (opção do campo de escritório) ou "companyId".`);
    if (typeof o.password !== 'string' || o.password.length < MIN_PASSWORD) throw new Error(`Escritório "${login}": a senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
    return { login, password: o.password, companyIds, officeValues, name: o.name };
  });
}

// ---------------------------------------------------------------- execução
async function main() {
  const mock = args.has('--mock');
  if (!mock) {
    BASE = (process.env.BITRIX_WEBHOOK_URL || '').trim().replace(/\/+$/, '');
    if (!/^(?:https:\/\/[^/]+|http:\/\/127\.0\.0\.1:\d+)\/rest\/\d+\/[^/]+$/.test(BASE)) throw new Error('BITRIX_WEBHOOK_URL ausente ou inválida. Formato: https://PORTAL.bitrix24.com.br/rest/ID/TOKEN/');
  }

  if (args.has('--fields')) {
    const f = await call('crm.deal.fields');
    for (const [code, d] of Object.entries(f)) console.log(`${code.padEnd(28)} ${String(d.type).padEnd(14)} ${d.formLabel || d.listLabel || d.title || ''}`);
    return;
  }

  let offices, payloads;
  if (mock) {
    const m = await import('./mock.mjs');
    offices = m.offices;
    payloads = m.payloads(config);
  } else {
    offices = loadOffices(process.env.OFFICES_JSON || '');
    payloads = await collect(offices);
  }

  await rm(DIST, { recursive: true, force: true });
  await cp(path.join(ROOT, 'site'), DIST, { recursive: true });
  await mkdir(path.join(DIST, 'data'), { recursive: true });
  await writeFile(path.join(DIST, '.nojekyll'), '');
  for (const office of offices) {
    const payload = payloads.get(office.login);
    const { file, envelope } = encrypt(office.login, office.password, payload);
    await writeFile(path.join(DIST, 'data', `${file}.json`), JSON.stringify(envelope));
    console.log(`  ${office.login}: ${payload.deals.length} chamado(s)`);
  }
  console.log(`Site gerado em dist/ (${offices.length} escritório(s)).`);
}

main().catch((e) => { console.error(`ERRO: ${e.message}`); process.exit(1); });

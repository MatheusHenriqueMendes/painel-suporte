#!/usr/bin/env node
// Gera a entrada de um escritório (com senha forte) para colar no secret OFFICES_JSON.
//   node scripts/new-office.mjs <login> <companyId> ["Nome do escritório"]
import { randomInt } from 'node:crypto';

const [login, companyId, name] = process.argv.slice(2);
if (!login || !Number(companyId)) {
  console.error('Uso: node scripts/new-office.mjs <login> <companyId> ["Nome do escritório"]');
  process.exit(1);
}
const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const block = () => Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
const entry = { login: login.trim().toLowerCase(), password: [block(), block(), block(), block()].join('-'), companyId: Number(companyId) };
if (name) entry.name = name;
console.log(JSON.stringify(entry));

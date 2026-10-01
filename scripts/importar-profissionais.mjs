// Uso: node scripts/importar-profissionais.mjs [arquivo.csv]
// Lê database/profissionais.csv e gera:
//   database/profissionais.sql  -> usuários com senha aleatória (hash PBKDF2)
//   database/credenciais.csv    -> usuário e senha em texto, para entregar a cada pessoa
// Ambos ficam fora do git. Apague credenciais.csv depois de distribuir.
import { pbkdf2Sync, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const entrada = process.argv[2] ?? new URL('../database/profissionais.csv', import.meta.url);
const NIVEIS = ['Super Administrador', 'Gerenciamento', 'Gerenciamento Local', 'Profissional Executante'];
const ALFA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // sem caracteres ambíguos
const senhaAleatoria = (n = 12) => Array.from({ length: n }, () => ALFA[randomInt(ALFA.length)]).join('');
const hash = (s) => { const salt = randomBytes(16); return `${salt.toString('hex')}:${pbkdf2Sync(s, salt, 100000, 32, 'sha256').toString('hex')}`; };
const q = (v) => (v ? `'${String(v).replace(/'/g, "''")}'` : 'NULL');
const semAcento = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim();

const linhas = readFileSync(entrada, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const cab = linhas.shift().split(',').map((c) => c.trim());
const usados = new Set();
let sql = '', cred = 'nome,username,senha\n';

for (const [i, l] of linhas.entries()) {
  const c = Object.fromEntries(l.split(',').map((v, k) => [cab[k], v.trim()]));
  const erro = (m) => { throw new Error(`Linha ${i + 2} (${c.nome}): ${m}`); };
  if (!c.nome) erro('nome vazio');
  if (!NIVEIS.includes(c.nivel_acesso)) erro(`nivel_acesso deve ser um de: ${NIVEIS.join(' | ')}`);
  if (c.nivel_acesso === 'Profissional Executante' && (!c.especialidade || !c.equipe_id)) erro('executante precisa de especialidade e equipe_id');
  if (c.nivel_acesso === 'Gerenciamento Local' && !c.unidade_id) erro('gerenciamento local precisa de unidade_id');
  const p = semAcento(c.nome).split(/\s+/);
  let base = c.username || (p.length > 1 ? `${p[0]}.${p[p.length - 1]}` : p[0]), u = base, n = 2;
  while (usados.has(u)) u = base + n++;
  usados.add(u);
  const senha = senhaAleatoria();
  sql += `INSERT INTO usuarios (id,username,senha_hash,nome_completo,nivel_acesso,especialidade,equipe_id,unidade_id) VALUES (${q(randomUUID())},${q(u)},${q(hash(senha))},${q(c.nome)},${q(c.nivel_acesso)},${q(c.especialidade)},${q(c.equipe_id)},${q(c.unidade_id)});\n`;
  cred += `${c.nome},${u},${senha}\n`;
}
writeFileSync(new URL('../database/profissionais.sql', import.meta.url), sql);
writeFileSync(new URL('../database/credenciais.csv', import.meta.url), cred);
console.log(`${usados.size} usuários gerados.\nAplique: npx wrangler d1 execute emulti-db --remote --file=database/profissionais.sql\nDepois distribua e apague database/credenciais.csv.`);

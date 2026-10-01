// Gera database/seed.sql com senhas em PBKDF2 (compatível com src/index.js).
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const SENHA_TESTE = 'emulti123';
const hash = (s) => { const salt = randomBytes(16); return `${salt.toString('hex')}:${pbkdf2Sync(s, salt, 100000, 32, 'sha256').toString('hex')}`; };
const users = [
  ['u1','admin','Admin Central','Super Administrador',null,null,null],
  ['u2','ana.psi','Ana (Psicologia)','Profissional Executante','Psicologia','comp1',null],
  ['u3','carla.nutri','Carla (Nutrição)','Profissional Executante','Nutrição','est1',null],
  ['u4','gestor.local','Gestor Local UBS Centro','Gerenciamento Local',null,null,'un1'],
];
const q = (v) => v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
let sql = `INSERT INTO unidades (id,nome) VALUES ('un1','UBS Centro'),('un2','UBS Jardim'),('un3','UBS Vila Nova');
INSERT INTO equipes (id,nome) VALUES ('comp1','Complementar 1'),('est1','Estratégica 1');
INSERT INTO equipe_unidades (equipe_id,unidade_id) VALUES ('comp1','un1'),('comp1','un2'),('est1','un3');
`;
for (const u of users) sql += `INSERT INTO usuarios (id,username,senha_hash,nome_completo,nivel_acesso,especialidade,equipe_id,unidade_id) VALUES (${q(u[0])},${q(u[1])},${q(hash(SENHA_TESTE))},${q(u[2])},${q(u[3])},${q(u[4])},${q(u[5])},${q(u[6])});\n`;
writeFileSync(new URL('../database/seed.sql', import.meta.url), sql);
console.log(`seed.sql gerado. Senha de todos os usuários de teste: ${SENHA_TESTE}`);

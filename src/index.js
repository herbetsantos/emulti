import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';

const STATUS = ['Aguardando grupo', 'Em atendimento', 'Pausado', 'Encerrado'];
const app = new Hono();
const novoId = (p) => p + crypto.randomUUID().slice(0, 8);

// ---------- Senhas (PBKDF2-SHA256, formato "saltHex:hashHex") ----------
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function derivar(senha, salt) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, k, 256));
}
async function senhaConfere(senha, armazenado) {
  const [saltHex, hashHex] = String(armazenado).split(':');
  if (!saltHex || !hashHex) return false;
  const h = await derivar(senha, new Uint8Array(saltHex.match(/../g).map((x) => parseInt(x, 16))));
  let d = h.length ^ hashHex.length; // comparação em tempo constante
  for (let i = 0; i < h.length; i++) d |= h.charCodeAt(i) ^ (hashHex.charCodeAt(i) || 0);
  return d === 0;
}

// ---------- Utilidades ----------
function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1+$/.test(cpf)) return false;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 0; i < n; i++) s += +cpf[i] * (n + 1 - i);
    if (((s * 10) % 11) % 10 !== +cpf[n]) return false;
  }
  return true;
}
const txt = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function escopo(u) {
  if (u.role === 'Profissional Executante') return { sql: 'equipe_id = ?', p: [u.eq ?? null] };
  if (u.role === 'Gerenciamento Local')
    return { sql: 'equipe_id IN (SELECT equipe_id FROM equipe_unidades WHERE unidade_id = ?)', p: [u.uni ?? null] };
  return { sql: '1=1', p: [] };
}

async function podeEditarEspecialidade(db, u, esp) {
  if (u.role !== 'Profissional Executante' || u.esp === esp) return true;
  const r = await db.prepare('SELECT 1 FROM permissoes_cruzadas WHERE especialidade_origem = ? AND especialidade_destino = ?')
    .bind(u.esp ?? null, esp).first();
  return !!r;
}

// Valida e normaliza os campos da guia. Retorna { erro } ou { dados }.
function validar(b, parcial = false) {
  const d = {
    cpf_paciente: String(b.cpf ?? '').replace(/\D/g, ''),
    nome_paciente: txt(b.nome),
    especialidade: txt(b.especialidade),
    prioridade: Number(b.prioridade),
    data_emissao: txt(b.data_emissao),
    motivo_encaminhamento: txt(b.motivo_encaminhamento),
    status: txt(b.status) ?? 'Aguardando grupo',
    comunicacao_realizada: txt(b.comunicacao_realizada),
    justificativa_comunicacao: txt(b.justificativa_comunicacao),
    motivo_encerramento: txt(b.motivo_encerramento),
  };
  if (!cpfValido(d.cpf_paciente)) return { erro: 'CPF inválido.' };
  if (!d.nome_paciente) return { erro: 'Informe o nome do paciente.' };
  if (!parcial && !d.especialidade) return { erro: 'Informe a especialidade.' };
  if (![0, 1, 2, 3].includes(d.prioridade)) return { erro: 'Prioridade deve ser de 0 a 3.' };
  if (!d.data_emissao || !/^\d{4}-\d{2}-\d{2}$/.test(d.data_emissao)) return { erro: 'Data de emissão inválida.' };
  if (!d.motivo_encaminhamento) return { erro: 'Informe o motivo do encaminhamento.' };
  if (!STATUS.includes(d.status)) return { erro: 'Status inválido.' };
  if (d.comunicacao_realizada && !['Sim', 'Não'].includes(d.comunicacao_realizada)) return { erro: 'Comunicação deve ser Sim ou Não.' };
  if (d.status === 'Em atendimento' && d.comunicacao_realizada === 'Não' && !d.justificativa_comunicacao)
    return { erro: 'A justificativa é obrigatória quando a comunicação não foi realizada.' };
  if (d.status === 'Encerrado' && !d.motivo_encerramento) return { erro: 'O motivo do encerramento é obrigatório.' };
  return { dados: d };
}

async function emitirToken(c, u) {
  const user = { id: u.id, nome: u.nome_completo, role: u.nivel_acesso, esp: u.especialidade ?? null, eq: u.equipe_id ?? null, uni: u.unidade_id ?? null };
  const token = await sign({ ...user, exp: Math.floor(Date.now() / 1000) + 8 * 3600 }, c.env.JWT_SECRET, 'HS256');
  return { token, user };
}

// ---------- Acesso integrado pelo Apoio APS (mesmo fluxo do portal de Regulação) ----------
// O Apoio APS autentica e devolve a pessoa a "/?handoff=<código de uso único>".
// O código é validado no banco do Apoio APS (binding DB) e associado ao cadastro local pelo username.
app.get('/', async (c) => {
  const handoff = c.req.query('handoff');
  if (!handoff) return c.env.ASSETS.fetch(c.req.raw);
  c.header('Cache-Control', 'no-store');
  try {
    const h = await c.env.DB.prepare(`SELECT h.expires_at, h.used, u.username, u.name, u.active
      FROM handoff_tokens h JOIN users u ON u.id = h.user_id WHERE h.token = ?`).bind(handoff).first();
    if (!h || h.used || !h.active || new Date(h.expires_at).getTime() < Date.now()) return c.redirect('/?erro=handoff', 302);
    const upd = await c.env.DB.prepare('UPDATE handoff_tokens SET used = 1 WHERE token = ? AND used = 0').bind(handoff).run();
    if (!upd.meta?.changes) return c.redirect('/?erro=handoff', 302);
    let u = await c.env.DB_REGULACAO.prepare('SELECT * FROM usuarios WHERE lower(username) = ? AND ativo = 1')
      .bind(String(h.username).trim().toLowerCase()).first();
    if (!u) {
      // Primeiro acesso: cria o cadastro SEM nenhuma permissão (Profissional Executante sem equipe não enxerga guia alguma).
      // O Super Administrador define nível, especialidade, equipe e unidade depois. Nunca se herda cargo do Apoio APS.
      const login = String(h.username).trim().toLowerCase();
      await c.env.DB_REGULACAO.prepare(`INSERT OR IGNORE INTO usuarios (id, username, senha_hash, nome_completo, nivel_acesso, ativo)
        VALUES (?, ?, '00:00', ?, 'Profissional Executante', 1)`).bind(novoId('u'), login, String(h.name || login).trim()).run();
      u = await c.env.DB_REGULACAO.prepare('SELECT * FROM usuarios WHERE lower(username) = ? AND ativo = 1').bind(login).first();
      if (!u) return c.redirect('/?erro=sem-acesso', 302);
    }
    const { token } = await emitirToken(c, u);
    return c.redirect(`/#sso=${token}`, 302); // fragmento não é enviado a servidores nem registrado em logs
  } catch (e) {
    console.error(e);
    return c.redirect('/?erro=handoff', 302);
  }
});

// ---------- Login (público) ----------
app.post('/api/login', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const u = await c.env.DB_REGULACAO.prepare('SELECT * FROM usuarios WHERE username = ? AND ativo = 1')
    .bind(String(b.username ?? '').trim().toLowerCase()).first();
  // Mesmo custo de cálculo quando o usuário não existe (evita revelar contas)
  const ok = await senhaConfere(String(b.senha ?? ''), u?.senha_hash ?? '00:00');
  if (!u || !ok) return c.json({ erro: 'Usuário ou senha incorretos.' }, 401);
  return c.json(await emitirToken(c, u));
});

// ---------- Autenticação: identidade vem só do token assinado ----------
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/login') return next();
  const t = (c.req.header('Authorization') || '').replace(/^Bearer /, '');
  try {
    c.set('user', await verify(t, c.env.JWT_SECRET, 'HS256'));
  } catch {
    return c.json({ erro: 'Sessão inválida ou expirada. Entre novamente.' }, 401);
  }
  await next();
});

app.onError((e, c) => {
  console.error(e);
  return c.json({ erro: 'Erro interno. Tente novamente.' }, 500);
});

app.get('/api/equipes', async (c) => {
  const u = c.get('user');
  const s = u.role === 'Profissional Executante' ? { sql: 'id = ?', p: [u.eq] }
    : u.role === 'Gerenciamento Local' ? { sql: 'id IN (SELECT equipe_id FROM equipe_unidades WHERE unidade_id = ?)', p: [u.uni] }
    : { sql: '1=1', p: [] };
  const { results } = await c.env.DB_REGULACAO.prepare(`SELECT id, nome FROM equipes WHERE ${s.sql} ORDER BY nome`).bind(...s.p).all();
  return c.json(results);
});

app.get('/api/guias', async (c) => {
  const s = escopo(c.get('user'));
  const { results } = await c.env.DB_REGULACAO
    .prepare(`SELECT * FROM guias WHERE ${s.sql} ORDER BY prioridade ASC, data_cadastro ASC`).bind(...s.p).all();
  return c.json(results);
});

app.post('/api/guias', async (c) => {
  const u = c.get('user');
  const db = c.env.DB_REGULACAO;
  const b = await c.req.json().catch(() => ({}));
  const v = validar(b);
  if (v.erro) return c.json({ erro: v.erro }, 400);
  const d = v.dados;

  // A equipe vem do perfil (executante) ou do corpo (demais perfis, dentro do seu escopo)
  const equipeId = u.role === 'Profissional Executante' ? u.eq : txt(b.equipe_id);
  if (!equipeId) return c.json({ erro: 'Informe a equipe responsável pela guia.' }, 400);
  if (u.role === 'Gerenciamento Local') {
    const ok = await db.prepare('SELECT 1 FROM equipe_unidades WHERE equipe_id = ? AND unidade_id = ?').bind(equipeId, u.uni ?? null).first();
    if (!ok) return c.json({ erro: 'Esta equipe não atende a sua unidade.' }, 403);
  }
  if (!(await podeEditarEspecialidade(db, u, d.especialidade)))
    return c.json({ erro: 'Você não tem permissão para cadastrar guias desta especialidade.' }, 403);

  try {
    const info = await db.prepare(`INSERT INTO guias (cpf_paciente, nome_paciente, especialidade, prioridade, data_emissao,
      motivo_encaminhamento, status, comunicacao_realizada, justificativa_comunicacao, motivo_encerramento, equipe_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(d.cpf_paciente, d.nome_paciente, d.especialidade, d.prioridade, d.data_emissao, d.motivo_encaminhamento, d.status,
        d.comunicacao_realizada, d.justificativa_comunicacao, d.motivo_encerramento, equipeId).run();
    return c.json({ sucesso: true, id: info.meta.last_row_id }, 201);
  } catch (e) {
    if (/FOREIGN KEY/i.test(e.message)) return c.json({ erro: 'Equipe inexistente.' }, 400);
    throw e;
  }
});

app.put('/api/guias/:id', async (c) => {
  const u = c.get('user');
  const db = c.env.DB_REGULACAO;
  const id = Number(c.req.param('id'));
  const s = escopo(u);
  const guia = await db.prepare(`SELECT * FROM guias WHERE id = ? AND ${s.sql}`).bind(id, ...s.p).first();
  if (!guia) return c.json({ erro: 'Guia não encontrada.' }, 404);
  if (!(await podeEditarEspecialidade(db, u, guia.especialidade)))
    return c.json({ erro: 'Você não tem permissão para editar guias desta especialidade.' }, 403);

  const v = validar(await c.req.json().catch(() => ({})), true);
  if (v.erro) return c.json({ erro: v.erro }, 400);
  const d = v.dados;
  await db.prepare(`UPDATE guias SET cpf_paciente=?, nome_paciente=?, prioridade=?, data_emissao=?, motivo_encaminhamento=?,
    status=?, comunicacao_realizada=?, justificativa_comunicacao=?, motivo_encerramento=? WHERE id=?`)
    .bind(d.cpf_paciente, d.nome_paciente, d.prioridade, d.data_emissao, d.motivo_encaminhamento, d.status,
      d.comunicacao_realizada, d.justificativa_comunicacao, d.motivo_encerramento, id).run();
  return c.json({ sucesso: true });
});

// ---------- Administração (somente Super Administrador) ----------
const NIVEIS = ['Super Administrador', 'Gerenciamento', 'Gerenciamento Local', 'Profissional Executante'];
const corpo = async (c) => (await c.req.json().catch(() => ({}))) || {};
app.use('/api/admin/*', async (c, next) =>
  c.get('user').role === 'Super Administrador' ? next() : c.json({ erro: 'Acesso restrito ao Super Administrador.' }, 403));

app.get('/api/admin/dados', async (c) => {
  const db = c.env.DB_REGULACAO;
  const [un, eq, eu, us] = await Promise.all([
    db.prepare('SELECT id, nome FROM unidades ORDER BY nome').all(),
    db.prepare('SELECT id, nome FROM equipes ORDER BY nome').all(),
    db.prepare('SELECT equipe_id, unidade_id FROM equipe_unidades').all(),
    db.prepare('SELECT id, username, nome_completo, nivel_acesso, especialidade, equipe_id, unidade_id, ativo FROM usuarios ORDER BY nome_completo').all(),
  ]);
  const equipes = eq.results.map((e) => ({ ...e, unidades: eu.results.filter((r) => r.equipe_id === e.id).map((r) => r.unidade_id) }));
  const pc = await db.prepare('SELECT especialidade_origem, especialidade_destino, concedido_por FROM permissoes_cruzadas ORDER BY especialidade_origem, especialidade_destino').all();
  const permissoes = pc.results.map((r) => ({ id: r.especialidade_origem + '|' + r.especialidade_destino, ...r }));
  return c.json({ unidades: un.results, equipes, usuarios: us.results, permissoes });
});

async function salvarUnidade(c, id) {
  const nome = txt((await corpo(c)).nome);
  if (!nome) return c.json({ erro: 'Informe o nome da unidade.' }, 400);
  const db = c.env.DB_REGULACAO;
  if (id) await db.prepare('UPDATE unidades SET nome = ? WHERE id = ?').bind(nome, id).run();
  else await db.prepare('INSERT INTO unidades (id, nome) VALUES (?, ?)').bind(novoId('un'), nome).run();
  return c.json({ sucesso: true });
}
async function salvarEquipe(c, id) {
  const b = await corpo(c), nome = txt(b.nome);
  if (!nome) return c.json({ erro: 'Informe o nome da equipe.' }, 400);
  const db = c.env.DB_REGULACAO, eid = id || novoId('eq');
  const lista = (v) => (Array.isArray(v) ? [...new Set(v.map(String))] : null);
  const ph = (a) => a.map(() => '?').join(',');
  const un = lista(b.unidades) ?? [], pr = lista(b.profissionais); // pr = null -> não mexe nos profissionais
  if (un.length) {
    const { results } = await db.prepare(`SELECT id FROM unidades WHERE id IN (${ph(un)})`).bind(...un).all();
    if (results.length !== un.length) return c.json({ erro: 'Unidade inexistente.' }, 400);
  }
  const ops = [
    id ? db.prepare('UPDATE equipes SET nome = ? WHERE id = ?').bind(nome, eid) : db.prepare('INSERT INTO equipes (id, nome) VALUES (?, ?)').bind(eid, nome),
    db.prepare('DELETE FROM equipe_unidades WHERE equipe_id = ?').bind(eid),
    ...un.map((x) => db.prepare('INSERT INTO equipe_unidades (equipe_id, unidade_id) VALUES (?, ?)').bind(eid, x)),
  ];
  if (pr) { // vínculo profissional -> equipe (cada Executante pertence a uma equipe; marcar aqui move o profissional)
    ops.push(db.prepare("UPDATE usuarios SET equipe_id = NULL WHERE equipe_id = ? AND nivel_acesso = 'Profissional Executante'").bind(eid));
    if (pr.length) ops.push(db.prepare(`UPDATE usuarios SET equipe_id = ? WHERE nivel_acesso = 'Profissional Executante' AND id IN (${ph(pr)})`).bind(eid, ...pr));
  }
  await db.batch(ops);
  return c.json({ sucesso: true });
}
async function salvarUsuario(c, id) {
  const b = await corpo(c), db = c.env.DB_REGULACAO;
  const d = { username: txt(b.username)?.toLowerCase(), nome: txt(b.nome), nivel: b.nivel, esp: txt(b.especialidade), eq: txt(b.equipe_id), uni: txt(b.unidade_id) };
  if (!d.username || !d.nome || !NIVEIS.includes(d.nivel)) return c.json({ erro: 'Preencha usuário, nome e nível de acesso.' }, 400);
  if (d.nivel === 'Profissional Executante' && (!d.esp || !d.eq)) return c.json({ erro: 'Profissional Executante precisa de especialidade e equipe.' }, 400);
  if (d.nivel === 'Gerenciamento Local' && !d.uni) return c.json({ erro: 'Gerenciamento Local precisa de uma unidade.' }, 400);
  if (d.nivel !== 'Profissional Executante') { d.esp = null; d.eq = null; }
  if (d.nivel !== 'Gerenciamento Local') d.uni = null;
  const senha = String(b.senha || '');
  if (senha && senha.length < 8) return c.json({ erro: 'A senha deve ter ao menos 8 caracteres.' }, 400);
  let hash = null;
  if (senha) { const salt = crypto.getRandomValues(new Uint8Array(16)); hash = hex(salt) + ':' + (await derivar(senha, salt)); }
  const ativo = b.ativo === false || b.ativo === 0 ? 0 : 1;
  try {
    if (id) {
      if (id === c.get('user').id && (!ativo || d.nivel !== 'Super Administrador'))
        return c.json({ erro: 'Você não pode remover o seu próprio acesso de administrador.' }, 400);
      await db.prepare(`UPDATE usuarios SET username=?, nome_completo=?, nivel_acesso=?, especialidade=?, equipe_id=?, unidade_id=?, ativo=?${hash ? ', senha_hash=?' : ''} WHERE id=?`)
        .bind(d.username, d.nome, d.nivel, d.esp, d.eq, d.uni, ativo, ...(hash ? [hash] : []), id).run();
    } else {
      // Sem senha: o acesso só é possível pelo Apoio APS ("00:00" nunca confere em senhaConfere).
      await db.prepare('INSERT INTO usuarios (id, username, senha_hash, nome_completo, nivel_acesso, especialidade, equipe_id, unidade_id, ativo) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(novoId('u'), d.username, hash || '00:00', d.nome, d.nivel, d.esp, d.eq, d.uni, ativo).run();
    }
  } catch (e) {
    if (String(e).includes('UNIQUE')) return c.json({ erro: 'Já existe um usuário com esse login.' }, 409);
    throw e;
  }
  return c.json({ sucesso: true });
}
app.post('/api/admin/permissoes', async (c) => {
  const b = await corpo(c), o = txt(b.origem), d = txt(b.destino);
  if (!o || !d || o === d) return c.json({ erro: 'Escolha duas especialidades diferentes.' }, 400);
  await c.env.DB_REGULACAO.prepare('INSERT OR IGNORE INTO permissoes_cruzadas (especialidade_origem, especialidade_destino, concedido_por) VALUES (?, ?, ?)')
    .bind(o, d, c.get('user').nome).run();
  return c.json({ sucesso: true });
});
app.delete('/api/admin/permissoes', async (c) => {
  await c.env.DB_REGULACAO.prepare('DELETE FROM permissoes_cruzadas WHERE especialidade_origem = ? AND especialidade_destino = ?')
    .bind(c.req.query('origem') ?? '', c.req.query('destino') ?? '').run();
  return c.json({ sucesso: true });
});
app.post('/api/admin/unidades', (c) => salvarUnidade(c));
app.put('/api/admin/unidades/:id', (c) => salvarUnidade(c, c.req.param('id')));
app.post('/api/admin/equipes', (c) => salvarEquipe(c));
app.put('/api/admin/equipes/:id', (c) => salvarEquipe(c, c.req.param('id')));
app.post('/api/admin/usuarios', (c) => salvarUsuario(c));
app.put('/api/admin/usuarios/:id', (c) => salvarUsuario(c, c.req.param('id')));

app.delete('/api/admin/unidades/:id', async (c) => {
  const db = c.env.DB_REGULACAO, id = c.req.param('id');
  if (await db.prepare('SELECT 1 FROM usuarios WHERE unidade_id = ?').bind(id).first())
    return c.json({ erro: 'Há usuários vinculados a esta unidade. Altere o vínculo deles antes de excluir.' }, 409);
  await db.prepare('DELETE FROM unidades WHERE id = ?').bind(id).run(); // equipe_unidades cai por CASCADE
  return c.json({ sucesso: true });
});
app.delete('/api/admin/equipes/:id', async (c) => {
  const db = c.env.DB_REGULACAO, id = c.req.param('id');
  for (const t of ['usuarios', 'guias', 'grupos'])
    if (await db.prepare(`SELECT 1 FROM ${t} WHERE equipe_id = ?`).bind(id).first())
      return c.json({ erro: 'Esta equipe ainda tem profissionais, guias ou grupos vinculados e não pode ser excluída.' }, 409);
  await db.prepare('DELETE FROM equipes WHERE id = ?').bind(id).run();
  return c.json({ sucesso: true });
});

export default app;

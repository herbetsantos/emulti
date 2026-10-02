import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';

const ST = {
  AGUARDANDO: 'Aguardando agendamento',
  AGENDADO: 'Agendamento realizado',
  GRUPO: 'Grupo agendado', // usado na etapa de grupos
  ENCERRADA: 'Encerrada',
  ARQUIVADA: 'Arquivada por falta de contato',
};
const MEIOS = ['Telefone', 'WhatsApp', 'Visita domiciliar', 'Outro'];
const RESULTADOS = ['Contato realizado', 'Sem sucesso'];
const MOTIVOS_FALTA = ['Problema de saúde', 'Sem transporte ou dificuldade de deslocamento', 'Compromisso de trabalho', 'Esqueceu a data',
  'Não tem mais interesse', 'Já foi atendido em outro serviço', 'Outro', 'Não informado'];
// Regra de arquivamento por falta de contato
const MIN_TENTATIVAS = 3, MIN_DIAS = 2, INTERVALO_MIN = 60; // INTERVALO_MIN: minutos mínimos entre tentativas para contarem como "momentos diferentes"
const MODALIDADES = ['Atendimento Individual', 'Atividade Coletiva'];
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
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

// ---------- Datas no fuso de Brasília ----------
const fmtSP = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const agoraSP = (d = new Date()) => fmtSP.format(d).replace(' ', 'T'); // 'YYYY-MM-DDTHH:MM:SS'
const dataValida = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '') && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const horaValida = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v ?? '');
const brData = (v) => String(v).split('-').reverse().join('/');
const consultaPassou = (g) => !!g.data_consulta && `${g.data_consulta}T${g.hora_consulta || '00:00'}:00` <= agoraSP();

// Valida e normaliza os campos da guia. Retorna { erro } ou { dados }. (O status NÃO vem do formulário: muda só pelas ações do fluxo.)
function validar(b, parcial = false) {
  const d = {
    cpf_paciente: String(b.cpf ?? '').replace(/\D/g, ''),
    nome_paciente: txt(b.nome),
    especialidade: txt(b.especialidade),
    prioridade: Number(b.prioridade),
    data_emissao: txt(b.data_emissao),
    motivo_encaminhamento: txt(b.motivo_encaminhamento),
    modalidade: txt(b.modalidade),
  };
  if (!cpfValido(d.cpf_paciente)) return { erro: 'CPF inválido.' };
  if (!d.nome_paciente) return { erro: 'Informe o nome do paciente.' };
  if (!parcial && !d.especialidade) return { erro: 'Informe a especialidade.' };
  if (![0, 1, 2, 3].includes(d.prioridade)) return { erro: 'Prioridade deve ser de 0 a 3.' };
  if (!dataValida(d.data_emissao)) return { erro: 'Data de emissão inválida.' };
  if (!d.motivo_encaminhamento) return { erro: 'Informe o motivo do encaminhamento.' };
  if (d.modalidade && !MODALIDADES.includes(d.modalidade)) return { erro: 'Elegibilidade inválida.' };
  if (!parcial && !d.modalidade) return { erro: 'Defina a elegibilidade: Atendimento Individual ou Atividade Coletiva.' };
  return { dados: d };
}

// Regra de arquivamento: 3 tentativas sem sucesso, em momentos diferentes (>= 60 min entre elas) e em ao menos 2 dias diferentes.
function regraContato(contatos) {
  const semSucesso = contatos.filter((c) => c.resultado === 'Sem sucesso').sort((x, y) => x.data_hora.localeCompare(y.data_hora));
  const validas = []; let ult = null;
  for (const c of semSucesso) {
    const t = new Date(c.data_hora).getTime();
    if (ult === null || t - ult >= INTERVALO_MIN * 60000) { validas.push(c); ult = t; }
  }
  const dias = new Set(validas.map((c) => agoraSP(new Date(c.data_hora)).slice(0, 10))).size;
  return { tentativas: validas.length, registradas: semSucesso.length, dias, min_tentativas: MIN_TENTATIVAS, min_dias: MIN_DIAS,
    intervalo_min: INTERVALO_MIN, ok: validas.length >= MIN_TENTATIVAS && dias >= MIN_DIAS,
    comunicado: contatos.some((c) => c.resultado === 'Contato realizado') };
}
// Só contam os contatos feitos depois do agendamento vigente (se a consulta foi remarcada, o paciente precisa ser avisado de novo).
const contatosVigentes = (g, contatos) => (g.agendamento_registrado_em ? contatos.filter((c) => c.data_hora >= g.agendamento_registrado_em) : contatos);

// Confere se as etiquetas existem. Retorna { erro } ou { ids }. ids = null quando o campo não foi enviado (não mexe nas etiquetas).
async function resolverEtiquetas(db, lista) {
  if (!Array.isArray(lista)) return { ids: null };
  const ids = [...new Set(lista.map(String))];
  if (ids.length) {
    const { results } = await db.prepare(`SELECT id FROM etiquetas WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    if (results.length !== ids.length) return { erro: 'Etiqueta inexistente.' };
  }
  return { ids };
}
const gravarEtiquetas = (db, guiaId, ids) => db.batch([
  db.prepare('DELETE FROM guias_etiquetas WHERE guia_id = ?').bind(guiaId),
  ...ids.map((e) => db.prepare('INSERT INTO guias_etiquetas (guia_id, etiqueta_id) VALUES (?, ?)').bind(guiaId, e)),
]);

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
    .prepare(`SELECT guias.*, (SELECT group_concat(etiqueta_id) FROM guias_etiquetas WHERE guia_id = guias.id) AS etiquetas,
      (SELECT nome FROM equipes WHERE id = guias.equipe_id) AS equipe_nome,
      (SELECT COUNT(*) FROM guia_contatos WHERE guia_id = guias.id) AS n_contatos
      FROM guias WHERE ${s.sql} ORDER BY prioridade ASC, data_cadastro ASC`).bind(...s.p).all();
  return c.json(results.map((g) => ({ ...g, consulta_passou: g.status === ST.AGENDADO && consultaPassou(g) })));
});

app.get('/api/etiquetas', async (c) => {
  const { results } = await c.env.DB_REGULACAO.prepare('SELECT id, nome, escopo FROM etiquetas ORDER BY escopo, nome').all();
  return c.json(results);
});

const hist = (db, id, u, de, para, acao, detalhe) =>
  db.prepare('INSERT INTO guia_historico (guia_id, data_hora, usuario_id, usuario_nome, status_anterior, status_novo, acao, detalhe) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, new Date().toISOString(), u.id, u.nome, de, para, acao, detalhe ?? null);

app.post('/api/guias', async (c) => {
  const u = c.get('user');
  const db = c.env.DB_REGULACAO;
  const b = await c.req.json().catch(() => ({}));
  const v = validar(b);
  if (v.erro) return c.json({ erro: v.erro }, 400);
  const d = v.dados;
  const et = await resolverEtiquetas(db, b.etiquetas);
  if (et.erro) return c.json({ erro: et.erro }, 400);

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
      motivo_encaminhamento, modalidade, status, equipe_id) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(d.cpf_paciente, d.nome_paciente, d.especialidade, d.prioridade, d.data_emissao, d.motivo_encaminhamento, d.modalidade, ST.AGUARDANDO, equipeId).run();
    const id = info.meta.last_row_id;
    await db.batch([
      hist(db, id, u, null, ST.AGUARDANDO, 'Guia cadastrada', `Elegibilidade: ${d.modalidade}`),
      ...(et.ids?.length ? et.ids.map((e) => db.prepare('INSERT INTO guias_etiquetas (guia_id, etiqueta_id) VALUES (?, ?)').bind(id, e)) : []),
    ]);
    return c.json({ sucesso: true, id }, 201);
  } catch (e) {
    if (/FOREIGN KEY/i.test(e.message)) return c.json({ erro: 'Equipe inexistente.' }, 400);
    throw e;
  }
});

// Carrega a guia respeitando escopo e permissão de edição por especialidade
async function guiaEditavel(c) {
  const u = c.get('user'), db = c.env.DB_REGULACAO, id = Number(c.req.param('id')), s = escopo(u);
  const guia = Number.isInteger(id) ? await db.prepare(`SELECT * FROM guias WHERE id = ? AND ${s.sql}`).bind(id, ...s.p).first() : null;
  if (!guia) return { resp: c.json({ erro: 'Guia não encontrada.' }, 404) };
  if (!(await podeEditarEspecialidade(db, u, guia.especialidade)))
    return { resp: c.json({ erro: 'Você não tem permissão para alterar guias desta especialidade.' }, 403) };
  return { u, db, id, guia };
}

// Edição dos dados da guia (o status NÃO muda aqui)
app.put('/api/guias/:id', async (c) => {
  const r = await guiaEditavel(c); if (r.resp) return r.resp;
  const { u, db, id, guia } = r;
  const b = await c.req.json().catch(() => ({}));
  const v = validar(b, true);
  if (v.erro) return c.json({ erro: v.erro }, 400);
  const d = v.dados;
  const et = await resolverEtiquetas(db, b.etiquetas);
  if (et.erro) return c.json({ erro: et.erro }, 400);
  const mudouModal = d.modalidade && d.modalidade !== guia.modalidade;
  if (mudouModal && guia.status !== ST.AGUARDANDO)
    return c.json({ erro: 'A elegibilidade só pode ser alterada enquanto a guia está aguardando agendamento.' }, 409);
  await db.batch([
    db.prepare(`UPDATE guias SET cpf_paciente=?, nome_paciente=?, prioridade=?, data_emissao=?, motivo_encaminhamento=?, modalidade=COALESCE(?, modalidade) WHERE id=?`)
      .bind(d.cpf_paciente, d.nome_paciente, d.prioridade, d.data_emissao, d.motivo_encaminhamento, d.modalidade, id),
    ...(mudouModal ? [hist(db, id, u, guia.status, guia.status, 'Elegibilidade alterada', `${guia.modalidade ?? '—'} → ${d.modalidade}`)] : []),
    ...(et.ids ? [db.prepare('DELETE FROM guias_etiquetas WHERE guia_id = ?').bind(id), ...et.ids.map((e) => db.prepare('INSERT INTO guias_etiquetas (guia_id, etiqueta_id) VALUES (?, ?)').bind(id, e))] : []),
  ]);
  return c.json({ sucesso: true });
});

// Acompanhamento: tentativas de contato, histórico e a situação da regra de arquivamento
app.get('/api/guias/:id/acompanhamento', async (c) => {
  const u = c.get('user'), db = c.env.DB_REGULACAO, id = Number(c.req.param('id')), s = escopo(u);
  const guia = Number.isInteger(id) ? await db.prepare(`SELECT * FROM guias WHERE id = ? AND ${s.sql}`).bind(id, ...s.p).first() : null;
  if (!guia) return c.json({ erro: 'Guia não encontrada.' }, 404);
  const [ct, hs] = await Promise.all([
    db.prepare('SELECT id, data_hora, meio, resultado, observacao, usuario_nome FROM guia_contatos WHERE guia_id = ? ORDER BY data_hora, id').bind(id).all(),
    db.prepare('SELECT id, data_hora, usuario_nome, status_anterior, status_novo, acao, detalhe FROM guia_historico WHERE guia_id = ? ORDER BY data_hora, id').bind(id).all(),
  ]);
  return c.json({
    guia: { ...guia, consulta_passou: guia.status === ST.AGENDADO && consultaPassou(guia) },
    contatos: ct.results.map((x) => ({ ...x, vigente: !guia.agendamento_registrado_em || x.data_hora >= guia.agendamento_registrado_em })),
    historico: hs.results,
    regra: regraContato(contatosVigentes(guia, ct.results)),
    meios: MEIOS, resultados: RESULTADOS, motivos_falta: MOTIVOS_FALTA,
    pode_reabrir: u.role === 'Super Administrador' && [ST.ENCERRADA, ST.ARQUIVADA].includes(guia.status),
  });
});

// 1) Registrar (ou corrigir) o dia e o horário da primeira consulta — atendimento individual
app.post('/api/guias/:id/agendamento', async (c) => {
  const r = await guiaEditavel(c); if (r.resp) return r.resp;
  const { u, db, id, guia } = r; const b = await corpo(c);
  if (guia.modalidade !== 'Atendimento Individual') return c.json({ erro: 'Somente guias elegíveis a atendimento individual têm consulta individual.' }, 409);
  if (![ST.AGUARDANDO, ST.AGENDADO].includes(guia.status)) return c.json({ erro: 'Esta guia não está em fase de agendamento.' }, 409);
  const data = txt(b.data), hora = txt(b.hora);
  if (!dataValida(data) || !horaValida(hora)) return c.json({ erro: 'Informe o dia e o horário da consulta.' }, 400);
  if (data < guia.data_emissao) return c.json({ erro: 'A consulta não pode ser anterior à data de emissão da guia.' }, 400);
  const remarcou = guia.status === ST.AGENDADO;
  const agora = new Date().toISOString();
  await db.batch([
    db.prepare('UPDATE guias SET status = ?, data_consulta = ?, hora_consulta = ?, agendamento_registrado_em = ?, comunicacao_realizada = NULL WHERE id = ?')
      .bind(ST.AGENDADO, data, hora, agora, id),
    hist(db, id, u, guia.status, ST.AGENDADO, remarcou ? 'Consulta remarcada' : 'Agendamento registrado',
      remarcou ? `${brData(guia.data_consulta)} ${guia.hora_consulta} → ${brData(data)} ${hora}` : `Primeira consulta: ${brData(data)} às ${hora}`),
  ]);
  return c.json({ sucesso: true });
});

// 2) Registrar uma tentativa de contato com o paciente
app.post('/api/guias/:id/contatos', async (c) => {
  const r = await guiaEditavel(c); if (r.resp) return r.resp;
  const { u, db, id, guia } = r; const b = await corpo(c);
  if (guia.status !== ST.AGENDADO) return c.json({ erro: 'Só é possível registrar contato depois que o agendamento for registrado.' }, 409);
  const meio = txt(b.meio), resultado = txt(b.resultado), obs = txt(b.observacao);
  if (!MEIOS.includes(meio)) return c.json({ erro: 'Escolha o meio de contato.' }, 400);
  if (!RESULTADOS.includes(resultado)) return c.json({ erro: 'Informe se o contato foi realizado.' }, 400);
  const { results } = await db.prepare('SELECT data_hora, resultado FROM guia_contatos WHERE guia_id = ?').bind(id).all();
  if (regraContato(contatosVigentes(guia, results)).comunicado) return c.json({ erro: 'O paciente já foi comunicado deste agendamento.' }, 409);
  await db.batch([
    db.prepare('INSERT INTO guia_contatos (guia_id, data_hora, meio, resultado, observacao, usuario_id, usuario_nome) VALUES (?,?,?,?,?,?,?)')
      .bind(id, new Date().toISOString(), meio, resultado, obs, u.id, u.nome),
    db.prepare('UPDATE guias SET comunicacao_realizada = ? WHERE id = ?').bind(resultado === 'Contato realizado' ? 'Sim' : 'Não', id),
  ]);
  return c.json({ sucesso: true });
});

// 3) Arquivar por falta de contato — só quando a regra foi cumprida (conferida aqui no servidor)
app.post('/api/guias/:id/arquivar', async (c) => {
  const r = await guiaEditavel(c); if (r.resp) return r.resp;
  const { u, db, id, guia } = r;
  if (guia.status !== ST.AGENDADO) return c.json({ erro: 'Esta guia não está em fase de comunicação.' }, 409);
  const { results } = await db.prepare('SELECT data_hora, resultado FROM guia_contatos WHERE guia_id = ?').bind(id).all();
  const rg = regraContato(contatosVigentes(guia, results));
  if (rg.comunicado) return c.json({ erro: 'O paciente já foi comunicado; não é caso de arquivamento por falta de contato.' }, 409);
  if (!rg.ok) return c.json({ erro: `Ainda não é possível arquivar. A regra exige ${MIN_TENTATIVAS} tentativas em momentos diferentes (mínimo de ${INTERVALO_MIN} min entre elas) e em ${MIN_DIAS} dias diferentes. Hoje: ${rg.tentativas} tentativa(s) válida(s) em ${rg.dias} dia(s).` }, 409);
  await db.batch([
    db.prepare('UPDATE guias SET status = ?, desfecho = ?, data_encerramento = ?, encerrado_por = ? WHERE id = ?')
      .bind(ST.ARQUIVADA, 'Falta de contato', new Date().toISOString(), u.nome, id),
    hist(db, id, u, guia.status, ST.ARQUIVADA, 'Arquivada por falta de contato', `${rg.tentativas} tentativas em ${rg.dias} dias`),
  ]);
  return c.json({ sucesso: true });
});

// 4) Desfecho da consulta: compareceu ou faltou (com motivo, quando possível). Só depois do dia e horário da consulta.
app.post('/api/guias/:id/desfecho', async (c) => {
  const r = await guiaEditavel(c); if (r.resp) return r.resp;
  const { u, db, id, guia } = r; const b = await corpo(c);
  if (guia.status !== ST.AGENDADO) return c.json({ erro: 'Esta guia não tem consulta aguardando desfecho.' }, 409);
  if (!consultaPassou(guia)) return c.json({ erro: `A consulta ainda não ocorreu (${brData(guia.data_consulta)} às ${guia.hora_consulta}).` }, 409);
  const res = txt(b.resultado);
  if (!['Compareceu', 'Faltou'].includes(res)) return c.json({ erro: 'Informe se o paciente compareceu ou faltou.' }, 400);
  let motivo = null, obs = null;
  if (res === 'Faltou') {
    motivo = txt(b.motivo_falta) ?? 'Não informado'; obs = txt(b.motivo_falta_obs);
    if (!MOTIVOS_FALTA.includes(motivo)) return c.json({ erro: 'Motivo da falta inválido.' }, 400);
    if (motivo === 'Outro' && !obs) return c.json({ erro: 'Descreva o motivo da falta.' }, 400);
  }
  await db.batch([
    db.prepare('UPDATE guias SET status = ?, desfecho = ?, motivo_falta = ?, motivo_falta_obs = ?, data_encerramento = ?, encerrado_por = ? WHERE id = ?')
      .bind(ST.ENCERRADA, res, motivo, obs, new Date().toISOString(), u.nome, id),
    hist(db, id, u, guia.status, ST.ENCERRADA, res === 'Compareceu' ? 'Paciente compareceu' : 'Paciente faltou', res === 'Faltou' ? [motivo, obs].filter(Boolean).join(' — ') : null),
  ]);
  return c.json({ sucesso: true });
});

// 5) Reabrir (correção de engano) — somente Super Administrador; fica no histórico
app.post('/api/guias/:id/reabrir', async (c) => {
  const u = c.get('user'), db = c.env.DB_REGULACAO, id = Number(c.req.param('id'));
  if (u.role !== 'Super Administrador') return c.json({ erro: 'Somente o Super Administrador pode reabrir uma guia.' }, 403);
  const guia = Number.isInteger(id) ? await db.prepare('SELECT * FROM guias WHERE id = ?').bind(id).first() : null;
  if (!guia) return c.json({ erro: 'Guia não encontrada.' }, 404);
  if (![ST.ENCERRADA, ST.ARQUIVADA].includes(guia.status)) return c.json({ erro: 'Esta guia não está encerrada.' }, 409);
  const novo = guia.data_consulta ? ST.AGENDADO : ST.AGUARDANDO;
  await db.batch([
    db.prepare('UPDATE guias SET status = ?, desfecho = NULL, motivo_falta = NULL, motivo_falta_obs = NULL, data_encerramento = NULL, encerrado_por = NULL WHERE id = ?').bind(novo, id),
    hist(db, id, u, guia.status, novo, 'Guia reaberta', `Desfecho anterior: ${guia.desfecho ?? '—'}${guia.motivo_falta ? ' (' + guia.motivo_falta + ')' : ''}`),
  ]);
  return c.json({ sucesso: true });
});

// ---------- Grupos: o profissional define seus grupos, dias e horários ----------
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const sobrepoe = (a, b) => a.dia_semana === b.dia_semana && a.hora_inicio < b.hora_fim && b.hora_inicio < a.hora_fim;

function validarHorarios(lista) {
  if (!Array.isArray(lista) || !lista.length) return { erro: 'Informe ao menos um dia e horário para o grupo.' };
  const hs = [];
  for (const h of lista) {
    const dia = Number(h.dia_semana), ini = String(h.hora_inicio ?? ''), fim = String(h.hora_fim ?? '');
    if (!Number.isInteger(dia) || dia < 0 || dia > 6) return { erro: 'Dia da semana inválido.' };
    if (!HORA.test(ini) || !HORA.test(fim)) return { erro: 'Informe horários válidos.' };
    if (ini >= fim) return { erro: 'O horário de término deve ser depois do horário de início.' };
    hs.push({ dia_semana: dia, hora_inicio: ini, hora_fim: fim });
  }
  for (let i = 0; i < hs.length; i++)
    for (let j = i + 1; j < hs.length; j++)
      if (sobrepoe(hs[i], hs[j])) return { erro: `Os horários informados se sobrepõem na ${DIAS[hs[i].dia_semana]}.` };
  return { hs };
}

// Um profissional não pode ser responsável por dois grupos ativos com dia e horário sobrepostos.
async function conflitoProfissional(db, profId, hs, ignorarId) {
  const { results } = await db.prepare(`SELECT g.nome, h.dia_semana, h.hora_inicio, h.hora_fim
    FROM grupo_horarios h JOIN grupos g ON g.id = h.grupo_id
    WHERE g.profissional_id = ? AND g.status = 'Ativo' AND g.id <> ?`).bind(profId, ignorarId ?? '').all();
  for (const n of hs)
    for (const r of results)
      if (sobrepoe(n, r))
        return `Conflito de horário com o grupo "${r.nome}" (${DIAS[r.dia_semana]}, ${r.hora_inicio} às ${r.hora_fim}). O mesmo profissional não pode conduzir grupos com dias e horários que se sobrepõem.`;
  return null;
}

app.get('/api/grupos', async (c) => {
  const s = escopo(c.get('user')), db = c.env.DB_REGULACAO;
  const sub = `SELECT id FROM grupos WHERE ${s.sql}`;
  const [g, h, n, us] = await Promise.all([
    db.prepare(`SELECT * FROM grupos WHERE ${s.sql} ORDER BY nome`).bind(...s.p).all(),
    db.prepare(`SELECT grupo_id, dia_semana, hora_inicio, hora_fim FROM grupo_horarios WHERE grupo_id IN (${sub}) ORDER BY ((dia_semana + 6) % 7), hora_inicio`).bind(...s.p).all(),
    db.prepare(`SELECT grupo_id, COUNT(*) AS n FROM grupo_guias WHERE grupo_id IN (${sub}) GROUP BY grupo_id`).bind(...s.p).all(),
    db.prepare(`SELECT id, nome_completo FROM usuarios WHERE id IN (SELECT profissional_id FROM grupos WHERE ${s.sql})`).bind(...s.p).all(),
  ]);
  return c.json(g.results.map((x) => ({
    ...x,
    profissional_nome: us.results.find((u) => u.id === x.profissional_id)?.nome_completo ?? null,
    horarios: h.results.filter((r) => r.grupo_id === x.id).map(({ dia_semana, hora_inicio, hora_fim }) => ({ dia_semana, hora_inicio, hora_fim })),
    total_guias: n.results.find((r) => r.grupo_id === x.id)?.n ?? 0,
  })));
});

async function salvarGrupo(c, id) {
  const u = c.get('user'), db = c.env.DB_REGULACAO, b = await corpo(c);
  const nome = txt(b.nome);
  if (!nome) return c.json({ erro: 'Informe o nome do grupo.' }, 400);
  const status = b.status === 'Inativo' ? 'Inativo' : 'Ativo';
  const v = validarHorarios(b.horarios);
  if (v.erro) return c.json({ erro: v.erro }, 400);

  let atual = null;
  if (id) {
    atual = await db.prepare('SELECT * FROM grupos WHERE id = ?').bind(id).first();
    if (!atual) return c.json({ erro: 'Grupo não encontrado.' }, 404);
  }
  let prof;
  if (u.role === 'Profissional Executante') {
    if (!u.eq || !u.esp) return c.json({ erro: 'Seu acesso ainda não foi configurado.' }, 403);
    if (atual && atual.profissional_id !== u.id) return c.json({ erro: 'Somente o profissional responsável pode alterar este grupo.' }, 403);
    prof = { id: u.id, equipe_id: u.eq, especialidade: u.esp };
  } else if (u.role === 'Super Administrador') {
    const r = await db.prepare("SELECT id, equipe_id, especialidade FROM usuarios WHERE id = ? AND nivel_acesso = 'Profissional Executante' AND ativo = 1")
      .bind(txt(b.profissional_id) ?? atual?.profissional_id ?? '').first();
    if (!r || !r.equipe_id || !r.especialidade) return c.json({ erro: 'Escolha um profissional responsável com equipe e especialidade definidas.' }, 400);
    prof = r;
  } else return c.json({ erro: 'Você não tem permissão para alterar grupos.' }, 403);

  if (status === 'Ativo') {
    const conf = await conflitoProfissional(db, prof.id, v.hs, id);
    if (conf) return c.json({ erro: conf }, 409);
  }
  const gid = id || novoId('gr');
  await db.batch([
    id ? db.prepare('UPDATE grupos SET nome=?, especialidade=?, equipe_id=?, profissional_id=?, status=? WHERE id=?').bind(nome, prof.especialidade, prof.equipe_id, prof.id, status, gid)
       : db.prepare('INSERT INTO grupos (id, nome, especialidade, equipe_id, profissional_id, status) VALUES (?,?,?,?,?,?)').bind(gid, nome, prof.especialidade, prof.equipe_id, prof.id, status),
    db.prepare('DELETE FROM grupo_horarios WHERE grupo_id = ?').bind(gid),
    ...v.hs.map((h) => db.prepare('INSERT INTO grupo_horarios (grupo_id, dia_semana, hora_inicio, hora_fim) VALUES (?,?,?,?)').bind(gid, h.dia_semana, h.hora_inicio, h.hora_fim)),
  ]);
  return c.json({ sucesso: true, id: gid });
}
app.post('/api/grupos', (c) => salvarGrupo(c));
app.put('/api/grupos/:id', (c) => salvarGrupo(c, c.req.param('id')));
app.delete('/api/grupos/:id', async (c) => {
  const u = c.get('user'), db = c.env.DB_REGULACAO, id = c.req.param('id');
  const g = await db.prepare('SELECT profissional_id FROM grupos WHERE id = ?').bind(id).first();
  if (!g) return c.json({ erro: 'Grupo não encontrado.' }, 404);
  if (!(u.role === 'Super Administrador' || (u.role === 'Profissional Executante' && g.profissional_id === u.id)))
    return c.json({ erro: 'Você não tem permissão para excluir este grupo.' }, 403);
  if (await db.prepare('SELECT 1 FROM grupo_guias WHERE grupo_id = ?').bind(id).first())
    return c.json({ erro: 'Este grupo tem guias alocadas. Marque-o como Inativo em vez de excluir.' }, 409);
  await db.prepare('DELETE FROM grupos WHERE id = ?').bind(id).run();
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
  const et = await db.prepare('SELECT id, nome, escopo FROM etiquetas ORDER BY escopo, nome').all();
  return c.json({ unidades: un.results, equipes, usuarios: us.results, permissoes, etiquetas: et.results });
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

async function salvarEtiqueta(c, id) {
  const b = await corpo(c), nome = txt(b.nome), cat = txt(b.escopo);
  if (!nome || !cat) return c.json({ erro: 'Informe o nome e a categoria profissional da etiqueta.' }, 400);
  const db = c.env.DB_REGULACAO;
  if (id) await db.prepare('UPDATE etiquetas SET nome = ?, escopo = ? WHERE id = ?').bind(nome, cat, id).run();
  else await db.prepare('INSERT INTO etiquetas (id, nome, escopo) VALUES (?, ?, ?)').bind(novoId('et'), nome, cat).run();
  return c.json({ sucesso: true });
}
app.post('/api/admin/etiquetas', (c) => salvarEtiqueta(c));
app.put('/api/admin/etiquetas/:id', (c) => salvarEtiqueta(c, c.req.param('id')));
app.delete('/api/admin/etiquetas/:id', async (c) => {
  await c.env.DB_REGULACAO.prepare('DELETE FROM etiquetas WHERE id = ?').bind(c.req.param('id')).run(); // guias_etiquetas cai por CASCADE
  return c.json({ sucesso: true });
});

app.delete('/api/admin/usuarios/:id', async (c) => {
  const id = c.req.param('id');
  if (id === c.get('user').id) return c.json({ erro: 'Você não pode excluir o seu próprio usuário.' }, 400);
  if (await c.env.DB_REGULACAO.prepare('SELECT 1 FROM grupos WHERE profissional_id = ?').bind(id).first())
    return c.json({ erro: 'Este profissional é responsável por grupos. Transfira ou exclua os grupos antes, ou apenas inative o usuário.' }, 409);
  await c.env.DB_REGULACAO.prepare('DELETE FROM usuarios WHERE id = ?').bind(id).run();
  return c.json({ sucesso: true });
});
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

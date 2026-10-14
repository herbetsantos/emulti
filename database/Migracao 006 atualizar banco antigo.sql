-- Atualiza um banco criado numa versão antiga do schema para a versão atual do código.
-- RODAR UMA ÚNICA VEZ (o SQLite/D1 não tem "ADD COLUMN IF NOT EXISTS"). Faça backup antes (Console > Export).
-- Não apaga nem altera dados, exceto o ajuste de status do final (ver comentário).

-- 1) Colunas que faltam em guias (criar guia falhava por causa de "modalidade")
ALTER TABLE guias ADD COLUMN modalidade TEXT;
ALTER TABLE guias ADD COLUMN data_consulta DATE;
ALTER TABLE guias ADD COLUMN hora_consulta TEXT;
ALTER TABLE guias ADD COLUMN agendamento_registrado_em TEXT;
ALTER TABLE guias ADD COLUMN desfecho TEXT;
ALTER TABLE guias ADD COLUMN motivo_falta TEXT;
ALTER TABLE guias ADD COLUMN motivo_falta_obs TEXT;
ALTER TABLE guias ADD COLUMN data_encerramento DATETIME;
ALTER TABLE guias ADD COLUMN encerrado_por TEXT;

-- 2) Coluna que faltava em grupos (excluir usuário falhava por causa de "profissional_id")
ALTER TABLE grupos ADD COLUMN profissional_id TEXT;

-- 3) Tabelas que faltavam
CREATE TABLE IF NOT EXISTS grupo_horarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grupo_id TEXT NOT NULL,
    dia_semana INTEGER NOT NULL,
    hora_inicio TEXT NOT NULL,
    hora_fim TEXT NOT NULL,
    FOREIGN KEY (grupo_id) REFERENCES grupos(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS login_falhas (
    chave TEXT PRIMARY KEY,
    n INTEGER NOT NULL,
    ate TEXT NOT NULL
);

-- 4) Índices
CREATE INDEX IF NOT EXISTS idx_guias_equipe ON guias(equipe_id);
CREATE INDEX IF NOT EXISTS idx_guias_status ON guias(status);
CREATE INDEX IF NOT EXISTS idx_grupo_horarios_grupo ON grupo_horarios(grupo_id);
CREATE INDEX IF NOT EXISTS idx_guia_contatos_guia ON guia_contatos(guia_id);
CREATE INDEX IF NOT EXISTS idx_guia_historico_guia ON guia_historico(guia_id);

-- 5) Status antigos (ex.: 'Aguardando grupo') não existem no fluxo atual. Só mexe em guias com status desconhecido;
--    guias que já estão com um status atual não são alteradas. Sem guias no banco, esta linha não faz nada.
UPDATE guias SET status = CASE WHEN status = 'Encerrado' THEN 'Encerrada' ELSE 'Aguardando agendamento' END
 WHERE status NOT IN ('Aguardando agendamento','Agendamento realizado','Grupo agendado','Encerrada','Arquivada por falta de contato');

-- ATENÇÃO: rode UMA vez, e só em banco criado antes do fluxo individual (o schema.sql atual já tem estas colunas).
-- Reescreve o status de TODAS as guias existentes (vira 'Aguardando agendamento' ou 'Encerrada'). Faça backup antes.
ALTER TABLE guias ADD COLUMN data_consulta DATE;
ALTER TABLE guias ADD COLUMN hora_consulta TEXT;
ALTER TABLE guias ADD COLUMN agendamento_registrado_em TEXT;
ALTER TABLE guias ADD COLUMN desfecho TEXT;
ALTER TABLE guias ADD COLUMN motivo_falta TEXT;
ALTER TABLE guias ADD COLUMN motivo_falta_obs TEXT;
ALTER TABLE guias ADD COLUMN data_encerramento DATETIME;
ALTER TABLE guias ADD COLUMN encerrado_por TEXT;

UPDATE guias SET status = CASE WHEN status = 'Encerrado' THEN 'Encerrada' ELSE 'Aguardando agendamento' END;

CREATE TABLE IF NOT EXISTS guia_contatos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guia_id INTEGER NOT NULL,
    data_hora TEXT NOT NULL,
    meio TEXT NOT NULL,
    resultado TEXT NOT NULL,
    observacao TEXT,
    usuario_id TEXT,
    usuario_nome TEXT,
    FOREIGN KEY (guia_id) REFERENCES guias(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_guia_contatos_guia ON guia_contatos(guia_id);

CREATE TABLE IF NOT EXISTS guia_historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guia_id INTEGER NOT NULL,
    data_hora TEXT NOT NULL,
    usuario_id TEXT,
    usuario_nome TEXT,
    status_anterior TEXT,
    status_novo TEXT,
    acao TEXT NOT NULL,
    detalhe TEXT,
    FOREIGN KEY (guia_id) REFERENCES guias(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_guia_historico_guia ON guia_historico(guia_id);

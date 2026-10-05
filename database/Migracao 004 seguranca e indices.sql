-- Seguro de rodar mais de uma vez. Aplica em bancos que já existem:
--   npx wrangler d1 execute emulti-db --remote --file="database/Migracao 004 seguranca e indices.sql"
-- Antes, faça backup:  npx wrangler d1 export emulti-db --remote --output=backup.sql
CREATE TABLE IF NOT EXISTS login_falhas (
    chave TEXT PRIMARY KEY,
    n INTEGER NOT NULL,
    ate TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guias_equipe ON guias(equipe_id);
CREATE INDEX IF NOT EXISTS idx_guias_status ON guias(status);
CREATE INDEX IF NOT EXISTS idx_grupo_horarios_grupo ON grupo_horarios(grupo_id);
CREATE INDEX IF NOT EXISTS idx_guia_contatos_guia ON guia_contatos(guia_id);
CREATE INDEX IF NOT EXISTS idx_guia_historico_guia ON guia_historico(guia_id);

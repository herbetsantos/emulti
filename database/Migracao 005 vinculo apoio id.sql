-- Vínculo do login integrado pelo ID imutável do Apoio APS.
-- RODAR UMA ÚNICA VEZ em bancos que já existem (o SQLite/D1 não tem "ADD COLUMN IF NOT EXISTS").
-- Bancos novos já recebem a coluna pelo schema.sql e NÃO precisam desta migração.
--   npx wrangler d1 export emulti-db --remote --output=backup.sql
--   npx wrangler d1 execute emulti-db --remote --file="database/Migracao 005 vinculo apoio id.sql"
ALTER TABLE usuarios ADD COLUMN apoio_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_apoio_id ON usuarios(apoio_id) WHERE apoio_id IS NOT NULL;

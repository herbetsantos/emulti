-- Registra a unidade de origem em cada guia. RODAR UMA ÚNICA VEZ em bancos existentes
-- (bancos novos já recebem a coluna pelo schema.sql). Guias antigas ficam sem unidade (NULL).
ALTER TABLE guias ADD COLUMN unidade_id TEXT REFERENCES unidades(id);
CREATE INDEX IF NOT EXISTS idx_guias_unidade ON guias(unidade_id);

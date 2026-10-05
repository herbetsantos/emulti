-- DESATUALIZADO: serve só como material de leitura. A fonte de verdade é database/schema.sql.
-- ========================================================
-- 1. ESTRUTURA ORGANIZACIONAL (UNIDADES E EQUIPES)
-- ========================================================

-- Unidades de Saúde do município
CREATE TABLE unidades (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL
);

-- Equipes Multidisciplinares (Ex: Complementar 1, Estratégica 2)
CREATE TABLE equipes (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL
);

-- Relação N:N -> Uma equipe cobre uma quantidade determinada de unidades de saúde
CREATE TABLE equipe_unidades (
    equipe_id TEXT NOT NULL,
    unidade_id TEXT NOT NULL,
    PRIMARY KEY (equipe_id, unidade_id),
    FOREIGN KEY (equipe_id) REFERENCES equipes(id) ON DELETE CASCADE,
    FOREIGN KEY (unidade_id) REFERENCES unidades(id) ON DELETE CASCADE
);

-- ========================================================
-- 2. AUTENTICAÇÃO E PERFIS DE USUÁRIO
-- ========================================================

-- Tabela central de usuários com login individual
CREATE TABLE usuarios (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL, -- Login único (ex: ana.psi)
    senha_hash TEXT NOT NULL,
    nome_completo TEXT NOT NULL,
    
    -- Níveis: 'Super Administrador', 'Gerenciamento', 'Gerenciamento Local', 'Profissional Executante'
    nivel_acesso TEXT NOT NULL, 
    
    -- Categoria habilitada (ex: 'Psicologia', 'Fisioterapia'). Nulo para Administradores
    especialidade TEXT, 
    
    -- Vínculos territoriais
    equipe_id TEXT,  -- Preenchido se for Profissional Executante
    unidade_id TEXT, -- Preenchido se for Gerenciamento Local
    
    ativo BOOLEAN DEFAULT 1,
    data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (equipe_id) REFERENCES equipes(id),
    FOREIGN KEY (unidade_id) REFERENCES unidades(id)
);

-- ========================================================
-- 3. REGRAS DE NEGÓCIO E SEGURANÇA (PERMISSÕES)
-- ========================================================

-- Controle de quem pode editar o quê (Permissões Cruzadas)
-- Ex: Se a Psicologia autoriza a Fonoaudiologia a editar suas guias, 
-- haverá um registro ('Fonoaudiologia', 'Psicologia') aqui.
CREATE TABLE permissoes_cruzadas (
    especialidade_origem TEXT NOT NULL,  -- Quem edita
    especialidade_destino TEXT NOT NULL, -- De quem é a guia editada
    concedido_por TEXT NOT NULL,         -- ID do Admin/Gestor que autorizou
    data_concessao DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (especialidade_origem, especialidade_destino)
);

-- ========================================================
-- 4. O CORAÇÃO DO SISTEMA: GUIAS E GRUPOS
-- ========================================================

-- Tabela principal de Guias (Olhar eMulti)
CREATE TABLE guias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cpf_paciente TEXT NOT NULL,
    nome_paciente TEXT NOT NULL,
    especialidade TEXT NOT NULL, 
    
    -- 0 (Vermelho - Max), 1 (Amarelo), 2 (Verde), 3 (Azul - Rotina)
    prioridade INTEGER NOT NULL, 
    
    data_emissao DATE NOT NULL,
    data_cadastro DATETIME DEFAULT CURRENT_TIMESTAMP,
    motivo_encaminhamento TEXT NOT NULL,
    
    -- Status: 'Aguardando grupo', 'Em atendimento', 'Pausado', 'Encerrado'
    status TEXT DEFAULT 'Aguardando grupo', 
    
    comunicacao_realizada TEXT, 
    justificativa_comunicacao TEXT, 
    motivo_encerramento TEXT, 
    
    -- A guia pertence à equipe que cobre a unidade do paciente
    equipe_id TEXT NOT NULL, 
    
    FOREIGN KEY (equipe_id) REFERENCES equipes(id)
);

-- Etiquetas dinâmicas para agrupar guias
CREATE TABLE etiquetas (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    escopo TEXT NOT NULL -- 'global' ou 'equipe:ID' (Apenas o Super Admin exclui)
);

-- Vínculo N:N entre Guias e Etiquetas
CREATE TABLE guias_etiquetas (
    guia_id INTEGER NOT NULL,
    etiqueta_id TEXT NOT NULL,
    PRIMARY KEY (guia_id, etiqueta_id),
    FOREIGN KEY (guia_id) REFERENCES guias(id) ON DELETE CASCADE,
    FOREIGN KEY (etiqueta_id) REFERENCES etiquetas(id) ON DELETE CASCADE
);

-- Formação de Grupos de Atendimento
CREATE TABLE grupos (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL, -- Ex: "Grupo de Ansiedade - Tarde"
    especialidade TEXT NOT NULL,
    equipe_id TEXT NOT NULL,
    data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'Ativo', -- 'Ativo', 'Encerrado'
    FOREIGN KEY (equipe_id) REFERENCES equipes(id)
);

-- Vínculo dos pacientes (guias) aos grupos formados
CREATE TABLE grupo_guias (
    grupo_id TEXT NOT NULL,
    guia_id INTEGER NOT NULL,
    data_inclusao DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (grupo_id, guia_id),
    FOREIGN KEY (grupo_id) REFERENCES grupos(id) ON DELETE CASCADE,
    FOREIGN KEY (guia_id) REFERENCES guias(id) ON DELETE CASCADE
);
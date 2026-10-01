CREATE TABLE unidades (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL
);

CREATE TABLE equipes (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL
);

CREATE TABLE equipe_unidades (
    equipe_id TEXT NOT NULL,
    unidade_id TEXT NOT NULL,
    PRIMARY KEY (equipe_id, unidade_id),
    FOREIGN KEY (equipe_id) REFERENCES equipes(id) ON DELETE CASCADE,
    FOREIGN KEY (unidade_id) REFERENCES unidades(id) ON DELETE CASCADE
);

CREATE TABLE usuarios (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    senha_hash TEXT NOT NULL,
    nome_completo TEXT NOT NULL,
    nivel_acesso TEXT NOT NULL,
    especialidade TEXT,
    equipe_id TEXT,
    unidade_id TEXT,
    ativo BOOLEAN DEFAULT 1,
    data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (equipe_id) REFERENCES equipes(id),
    FOREIGN KEY (unidade_id) REFERENCES unidades(id)
);

CREATE TABLE permissoes_cruzadas (
    especialidade_origem TEXT NOT NULL,
    especialidade_destino TEXT NOT NULL,
    concedido_por TEXT NOT NULL,
    data_concessao DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (especialidade_origem, especialidade_destino)
);

CREATE TABLE guias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cpf_paciente TEXT NOT NULL,
    nome_paciente TEXT NOT NULL,
    especialidade TEXT NOT NULL, 
    prioridade INTEGER NOT NULL, 
    data_emissao DATE NOT NULL,
    data_cadastro DATETIME DEFAULT CURRENT_TIMESTAMP,
    motivo_encaminhamento TEXT NOT NULL,
    status TEXT DEFAULT 'Aguardando grupo', 
    comunicacao_realizada TEXT, 
    justificativa_comunicacao TEXT, 
    motivo_encerramento TEXT, 
    equipe_id TEXT NOT NULL, 
    FOREIGN KEY (equipe_id) REFERENCES equipes(id)
);

CREATE TABLE etiquetas (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    escopo TEXT NOT NULL
);

CREATE TABLE guias_etiquetas (
    guia_id INTEGER NOT NULL,
    etiqueta_id TEXT NOT NULL,
    PRIMARY KEY (guia_id, etiqueta_id),
    FOREIGN KEY (guia_id) REFERENCES guias(id) ON DELETE CASCADE,
    FOREIGN KEY (etiqueta_id) REFERENCES etiquetas(id) ON DELETE CASCADE
);

CREATE TABLE grupos (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    especialidade TEXT NOT NULL,
    equipe_id TEXT NOT NULL,
    data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'Ativo',
    FOREIGN KEY (equipe_id) REFERENCES equipes(id)
);

CREATE TABLE grupo_guias (
    grupo_id TEXT NOT NULL,
    guia_id INTEGER NOT NULL,
    data_inclusao DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (grupo_id, guia_id),
    FOREIGN KEY (grupo_id) REFERENCES grupos(id) ON DELETE CASCADE,
    FOREIGN KEY (guia_id) REFERENCES guias(id) ON DELETE CASCADE
);
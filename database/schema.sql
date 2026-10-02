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
    status TEXT DEFAULT 'Aguardando agendamento', 
    modalidade TEXT, 
    comunicacao_realizada TEXT, 
    justificativa_comunicacao TEXT, 
    motivo_encerramento TEXT, 
    equipe_id TEXT NOT NULL, 
    data_consulta DATE,
    hora_consulta TEXT,
    agendamento_registrado_em TEXT,
    desfecho TEXT,
    motivo_falta TEXT,
    motivo_falta_obs TEXT,
    data_encerramento DATETIME,
    encerrado_por TEXT,
    FOREIGN KEY (equipe_id) REFERENCES equipes(id)
);

CREATE TABLE guia_contatos (
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

CREATE TABLE guia_historico (
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
    profissional_id TEXT,
    FOREIGN KEY (equipe_id) REFERENCES equipes(id)
);

CREATE TABLE grupo_horarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grupo_id TEXT NOT NULL,
    dia_semana INTEGER NOT NULL,
    hora_inicio TEXT NOT NULL,
    hora_fim TEXT NOT NULL,
    FOREIGN KEY (grupo_id) REFERENCES grupos(id) ON DELETE CASCADE
);

CREATE TABLE grupo_guias (
    grupo_id TEXT NOT NULL,
    guia_id INTEGER NOT NULL,
    data_inclusao DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (grupo_id, guia_id),
    FOREIGN KEY (grupo_id) REFERENCES grupos(id) ON DELETE CASCADE,
    FOREIGN KEY (guia_id) REFERENCES guias(id) ON DELETE CASCADE
);

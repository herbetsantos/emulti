# Olhar eMulti

## Rodar localmente
```
cp .dev.vars.example .dev.vars      # troque o JWT_SECRET por uma frase aleatória de 32+ caracteres
npm install
npm run db:local      # cria tabelas e dados de teste no D1 local
npm run dev           # http://localhost:8787
```
Usuários de teste (senha `emulti123`): `admin`, `ana.psi`, `carla.nutri`, `gestor.local`.
Para gerar novos hashes/senhas: edite e rode `npm run seed:gerar`.

## Produção
```
npx wrangler d1 create emulti-db            # cole o database_id no wrangler.toml
npx wrangler d1 execute emulti-db --remote --file=database/schema.sql   # pode ser reaplicado (IF NOT EXISTS)
# Banco já existente (criado antes desta versão): faça backup e rode a migração 004
#   npx wrangler d1 export emulti-db --remote --output=backup.sql
#   npx wrangler d1 execute emulti-db --remote --file="database/Migracao 004 seguranca e indices.sql"
# Crie seus usuários reais (NÃO use o seed de teste em produção)
npx wrangler secret put JWT_SECRET          # frase longa e aleatória
npx wrangler deploy
```

## Login integrado (Apoio APS)
O botão "Acessar com Apoio APS" usa o mesmo fluxo do portal de Regulação. Requisitos:
- o Apoio APS precisa aceitar o endereço deste Worker como destino de retorno do login;
- cada profissional deve ter cadastro no Olhar com o **mesmo username** do Apoio APS (coluna `username` do `profissionais.csv`);
- quem se autentica no Apoio APS sem cadastro ativo vê "sem acesso ao Olhar eMulti" (o cadastro NÃO é criado automaticamente);
- contas de Super Administrador não entram pelo Apoio APS, só com usuário e senha do Olhar (o vínculo é por username).
O teste só funciona no endereço publicado, pois o banco do Apoio APS não existe no ambiente local.

## Segurança (o que o Worker faz)
- O Worker recusa operar se `JWT_SECRET` faltar, tiver menos de 32 caracteres ou for o do exemplo.
- Perfil, equipe e situação do usuário são lidos do banco a cada requisição: inativar ou mudar o perfil vale na hora.
- Login: 5 falhas seguidas bloqueiam usuário+IP por 15 min (tabela `login_falhas`). Recomenda-se também uma regra de Rate Limiting da Cloudflare em `/api/login`.
- Cabeçalhos de segurança (CSP, X-Frame-Options, HSTS, nosniff, Referrer-Policy) em todas as respostas.
- Nunca aplique `database/seed.sql` em produção (senha de teste conhecida).

## Atividade coletiva (alocação em grupos)
Fluxo da guia com elegibilidade "Atividade Coletiva":
1. **Aguardando agendamento** → no painel da guia, o profissional escolhe um grupo ativo da mesma equipe e especialidade e usa **Alocar ao grupo**. A guia passa a **Grupo agendado**.
2. **Remover do grupo** devolve a guia a "Aguardando agendamento".
3. **Encerrar a participação** (motivos: concluiu o ciclo, desistiu, faltas excessivas, outro) leva a guia a **Encerrada**. O Super Administrador pode reabri-la; ela volta a aguardar alocação.

Regras: só o Super Administrador e o profissional responsável pelo grupo alocam, removem ou encerram; a guia precisa ser da mesma equipe e especialidade do grupo; grupo com participantes não pode ser inativado nem trocar de equipe/especialidade. A aba **Grupos** tem o botão **Participantes**. Não há banco novo a migrar: usa as tabelas `grupos` e `grupo_guias` que já existiam.

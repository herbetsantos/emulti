# Olhar eMulti

## Rodar localmente
```
npm install
npm run db:local      # cria tabelas e dados de teste no D1 local
npm run dev           # http://localhost:8787
```
Usuários de teste (senha `emulti123`): `admin`, `ana.psi`, `carla.nutri`, `gestor.local`.
Para gerar novos hashes/senhas: edite e rode `npm run seed:gerar`.

## Produção
```
npx wrangler d1 create emulti-db            # cole o database_id no wrangler.toml
npx wrangler d1 execute emulti-db --remote --file=database/schema.sql
# Crie seus usuários reais (NÃO use o seed de teste em produção)
npx wrangler secret put JWT_SECRET          # frase longa e aleatória
npx wrangler deploy
```

## Login integrado (Apoio APS)
O botão "Acessar com Apoio APS" usa o mesmo fluxo do portal de Regulação. Requisitos:
- o Apoio APS precisa aceitar o endereço deste Worker como destino de retorno do login;
- cada profissional deve ter cadastro no Olhar com o **mesmo username** do Apoio APS (coluna `username` do `profissionais.csv`);
- quem se autentica no Apoio APS sem cadastro ativo vê "sem acesso ao Olhar eMulti".
O teste só funciona no endereço publicado, pois o banco do Apoio APS não existe no ambiente local.

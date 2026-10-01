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

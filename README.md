# Art Studio

Buy paintings, book a wall painting, request custom pottery. Two roles: customer and studio (admin).
Stack: Node.js + Express, SQLite (built into Node), vanilla HTML/JS frontend.

## Run (clean machine)
Requires **Node 22.13+** (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env     # optional; set JWT_SECRET
npm start                # http://localhost:3000
npm test                 # API tests (RBAC, validation, race conditions)
```

The database file `studio.db` is created and seeded on first start. Delete it to reseed.

**Studio login:** the studio account is defined in `seed/seed.json` under `studioAccount`. It is not shown in the UI.
Customers sign up on the login screen.

## Seed data
`seed/seed.json` is the official seed data (paintings, pottery items, glazes, mural rate, studio account); painting images are in `public/images`.
It is loaded into the database on first start. To reseed, delete `studio.db` and restart.

## Layout
- `server.js` - API, auth, RBAC, business rules, schema
- `public/index.html` - the whole UI
- `test.js` - end-to-end API tests
- `DESIGN.md` - design answers

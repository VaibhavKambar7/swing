# Local Docker startup

Copy `.env.example` to `.env` and set independent database, browser-login and
worker-token secrets. Keep `.env` private. Supply a maintained calendar under
`config/` before enabling scheduling. Compose mounts that directory read-only;
`DOCKER_MARKET_CALENDAR_FILE` defaults to `/app/config/market-calendar.local.json`.
A native process can continue using its own host `MARKET_CALENDAR_FILE` path.

```sh
docker compose --profile full build
docker compose up -d --wait db
docker compose --profile full run --rm worker npm run db:migrate
docker compose --profile full up -d --wait
```

Migrate before starting the worker on a new database. An existing native database
is not automatically imported: back it up and restore into a verified empty
Docker database first. Never reset a populated database or remove its volume.
Load maintained constituents into a new installation; migrations alone do not
supply the Nifty 500 membership.

Open http://localhost:3000 using the browser credentials in `.env`. Compose binds
web and PostgreSQL to loopback; the worker is reachable only inside the Compose
network. Both application containers report health, including worker/database
readiness. Use `docker compose --profile full ps` and service logs for diagnostics.
Health does not establish that external feeds or AI are reachable.

The worker receives provider keys. The web service receives only key-presence
flags for its configuration display, together with the shared daily AI limits.
Collection and AI remain opt-in through the worker settings in `.env`.

Stop without deleting data:

```sh
docker compose --profile full stop
```

The `postgres_data` volume persists records across container rebuilds. Hosting,
TLS, unattended operation and off-machine backups still need separate setup.

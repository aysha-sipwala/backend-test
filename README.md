# Orders Ingestion Service

A Node.js API that accepts an orders CSV, stores the original file in Google Cloud
Storage, validates every row while streaming, and batch-inserts the valid rows into
a PostgreSQL setup sharded by `seller_id`.

<!-- The full README (setup, ADC, use case, sharding, trade-offs) is Ticket 9. -->

## Run with Docker

This runs the app and a PostgreSQL server with the 3 shard databases in containers.
It is optional: `npm start` with a native PostgreSQL keeps working exactly as before.

You need Docker Desktop (running), and you must have logged in once with
`gcloud auth application-default login`.

**1. Settings.** Copy `.env.example` to `.env` if you have not already, and check
these values in `.env`:

- `GCP_PROJECT_ID` and `GCS_BUCKET_NAME`
- `POSTGRES_PASSWORD` (letters and numbers only; this becomes the password of the
  database container)

**2. Point Docker at your Google login file.** Run this in the same PowerShell window
you will use for the next commands. It sets the path for this window only:

```powershell
$env:GCLOUD_ADC_FILE = "$env:APPDATA\gcloud\application_default_credentials.json"
```

Check that the file exists (this must print `True`):

```powershell
Test-Path $env:GCLOUD_ADC_FILE
```

If you prefer, put the path in `.env` instead, as `GCLOUD_ADC_FILE` (see `.env.example`).
The file is mounted read-only into the container. It is never copied into the image
or the repository, and `GOOGLE_APPLICATION_CREDENTIALS` is not used.

**3. Build and start.**

```powershell
docker compose up -d --build
```

**4. Create the tables** (once; it is safe to run again):

```powershell
docker compose run --rm app npm run migrate
```

You should see three `migration_applied` lines.

**5. Check that the app reaches all 3 shards.**

```powershell
curl.exe http://localhost:3000/health
```

Expected: `{"status":"ok","shards":{"0":"up","1":"up","2":"up"}}`. Also run
`docker compose ps`: the `app` and `postgres` services should show `healthy`.

**6. Try an upload.**

```powershell
curl.exe -F "file=@sample-data/orders.csv" http://localhost:3000/upload-orders
```

**Useful commands**

```powershell
docker compose logs -f app
```

```powershell
docker compose down
```

`down` stops everything and keeps the database data. To delete the data too (for
example to start from an empty database):

```powershell
docker compose down -v
```

**Good to know**

- The database in Docker is separate from a native PostgreSQL. It starts empty and is
  published on port **5433** (native PostgreSQL uses 5432):
  `psql -h localhost -p 5433 -U postgres -d orders_shard_0`.
- The app listens on port 3000. Do not run `npm start` and the Docker app at the same
  time unless you change `PORT` in `.env`.
- The three databases are created only the first time the database volume is created.
  If they are missing, run `docker compose down -v` and start again.

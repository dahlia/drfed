@drfed/drfed
============

The main application package for [DrFed], a web-based platform for developing
and debugging ActivityPub apps.  It wires together the database layer,
ActivityPub federation, GraphQL server, and HTTP server, and exposes the
`drfed-server` CLI binary.

[DrFed]: https://drfed.org/


Usage
-----

~~~~ sh
drfed-server --root-origin https://drfed.example.com \
  --login-origin https://drfed.example.com --data-path .pgdata
drfed-server --root-origin https://drfed.example.com \
  --login-origin https://drfed.example.com \
  --database-url postgres://user@localhost/drfed
~~~~

The server listens on `localhost:8888` by default.  Pass `--listen HOST:PORT`
to override.  Automatic database migrations run on startup unless `--no-migrate`
is given.

CLI parsing validates settings before opening database or mail resources.
`--help`, `--version`, and `--generate-graphql-schema` can run without starting
the server; invalid options also exit before creating those resources.


Root origin
-----------

A root origin is required through `--root-origin`, `DRFED_ROOT_ORIGIN`, or
`server.root_origin` in the selected TOML file. Everything else follows from
it.  Each instance is served from its own subdomain of that origin, so with
`https://drfed.example.com` the instance `foo-bar` lives at
`https://foo-bar.drfed.example.com`.  A non-default port belongs in the value
and is carried into every instance, which is what makes a development
deployment work:

~~~~ sh
drfed-server --root-origin http://drfed.localhost:8888 \
  --login-origin http://localhost:3000 --data-path .pgdata
~~~~

Requests are routed by the authority they arrive on:

| Authority                             | Serves                                |
| ------------------------------------- | ------------------------------------- |
| `<slug>.<root domain>`                | ActivityPub only; GraphQL answers 404 |
| the root origin                       | GraphQL                               |
| the listening address, internal names | GraphQL                               |
| anything deeper under the root domain | 421 Misdirected Request               |
| an unusable `Host` header             | 400 Bad Request                       |

The authority has to match in full, port included.  A request for
`foo.drfed.example.com:8888` against a root origin of
`https://drfed.example.com` does not name an instance and is served the control
surface, not a 404, so do not read the table above as isolating GraphQL by host
name alone.  Ports 80 and 443 both count as no port at all, since which of them
is the default depends on a scheme that is deliberately not compared.

Not comparing the scheme is what lets a deployment sit behind a TLS-terminating
reverse proxy.  Such a proxy must pass two things through:

 -  `Host`, unchanged, because that is what names the instance.  A `Host`
    carrying the root zone's trailing dot is answered 400 rather than served,
    because the HTTP layer refuses it before DrFed sees it.
 -  `X-Forwarded-Proto: https`.  Without it the request looks like plain HTTP,
    and every actor URI DrFed mints names `http://`, which is not where the
    actor lives and not what the rest of the fediverse will accept.

Deploying this way needs a wildcard DNS record for `*.<root domain>` and, over
HTTPS, a wildcard TLS certificate to match.

Changing the root origin after instances exist does not move them.  Their host
names are already part of the actor URIs the rest of the fediverse has stored,
so the server only warns at startup about instances it can no longer reach.


Login origins
-------------

`--login-origin` specifies an HTTP or HTTPS origin allowed in email login
links.  At least one is required; repeat the option to allow multiple origins:

~~~~ sh
drfed-server --root-origin https://drfed.example.com --data-path .pgdata \
  --login-origin https://drfed.example.com \
  --login-origin http://localhost:3000
~~~~

For repository development, create the environment file loaded by
`mise run dev`:

~~~~ sh
cp packages/drfed/.env.example packages/drfed/.env
~~~~

`mise run dev` reads `DRFED_LOGIN_ORIGINS` as a JSON string array and passes
each value as a `--login-origin` option. If unset, it defaults to
`["http://localhost:3000"]`. The installed CLI reads the same variable.
Convert older comma-separated development values to JSON arrays.

That file also carries `DRFED_ROOT_ORIGIN`, which `mise run dev` passes as
`--root-origin`.  It defaults to `http://drfed.localhost:8888`; every subdomain
of `localhost` resolves to the loopback address without any DNS or */etc/hosts*
setup, which is what makes per-instance subdomains usable locally.


Options
-------

| Option                    | Short | Description                                                          |
| ------------------------- | ----- | -------------------------------------------------------------------- |
| `--print-config`          |       | Print effective settings and sources with secrets redacted; exit     |
| `--config FILE`           |       | Explicit TOML configuration file                                     |
| `--database-driver KIND`  |       | Select `pglite` or `postgres`                                        |
| `--migrate`               |       | Enable automatic migrations                                          |
| `--mail-transport KIND`   |       | Select `logtape` or `smtp`                                           |
| `--root-origin ORIGIN`    | `-r`  | Origin instances are subdomains of (required)                        |
| `--login-origin ORIGIN`   |       | Origin allowed in login links (required; may be repeated)            |
| `--listen HOST:PORT`      | `-l`  | Address to listen on (default: `localhost:8888`)                     |
| `--pglite-data-path PATH` | `-d`  | Directory for PGlite storage                                         |
| `--postgres-url URL`      | `-D`  | PostgreSQL connection URL                                            |
| `--no-migrate`            | `-M`  | Skip automatic migrations                                            |
| `--email-from ADDRESS`    | `-f`  | Sender of login mail (default: `noreply@` at the root origin's host) |
| `--smtp-url URL`          | `-s`  | SMTP server to deliver mail through                                  |
| `--help`                  |       | Show help                                                            |
| `--version`               |       | Show version                                                         |

`--pglite-data-path` and `--postgres-url` conflict at the winning input source.
Provide the path or URL for the selected database through CLI, environment or
TOML; the source selection rules are described below.

Without `--smtp-url`, mail is written to the log instead of being delivered,
which is why a development server can sign you in without a mail server.


Testing npm installation
------------------------

From the repository root, run `mise run test:packaging` to build and pack the
four backend packages, then install their tarballs with npm in temporary local
and global prefixes outside the checkout.  The check uses a separate npm cache
and empty npm configuration files, omits development dependencies, and disables
installation scripts.  It needs network access to the public npm registry for
external dependencies.

The check verifies packed entry points and migrations, npm's `drfed-server`
bin links, CLI help, a database-backed GraphQL request after initial migration,
and a restart with `--no-migrate` using the same PGlite directory.  It removes
the temporary installations and databases after stopping their servers.

All four backend tarballs are supplied to each install together so unpublished
workspace versions can be tested.  This baseline does not cover installing only
the facade from the registry, the frontend, or upgrading an older release.


Resource ownership
------------------

Server startup registers each resource as it is acquired.  Startup failures and
shutdown stop new work, drain active requests, GraphQL resolvers and the task
worker, then close
owned resources in reverse order.  Cleanup continues if one resource fails;
startup errors retain their original cause.  SIGTERM allows ten seconds for
shutdown and force-closes stalled HTTP connections after five seconds.

The `@drfed/drfed/resources` and `@drfed/drfed/operations` subpaths export
`ResourceOwner` and `OperationRegistry` for code that manages its own runtime.
Register borrowed resources with `owned: false`; the owner leaves them open.
Operations receive a shared abort signal and remain tracked until their
promises settle.  HTTP response streams in the CLI remain drained by srvx.

The CLI also tracks GraphQL context loading and field/type resolvers separately
from the HTTP handler.  [Yoga execution cancellation] stops further execution
when a client disconnects, but a resolver already waiting on a database or mail
operation can still be running.  Its resources remain open until it settles.

Use `run()` to admit new work and `track()` only for continuations of requests
already accepted.  Stop admitting requests and stop background producers before
calling `drain()`.  Draining also waits for continuations registered during
shutdown, so an accepted GraphQL response can finish during the grace period.

[Yoga execution cancellation]: https://the-guild.dev/graphql/yoga-server/docs/features/execution-cancellation


Shared configuration bindings
-----------------------------

`@drfed/drfed/configuration` supplies the common setting registry, strict TOML
structure, and isolated [Optique environment] and [configuration] contexts.
Bindings preserve `CLI > DRFED_* > TOML > default`, including `false` and
empty arrays. Array sources replace each other. Each result carries its source
and, for TOML values, the absolute configuration file path; provenance maps
contain no setting values.

Commands must check required values after resolution. An absent optional
setting has a default-sourced result whose `value` is `undefined`; wrapping
a binding in `optional()` can hide invalid environment values and should be
avoided. Bind only the settings a command consumes: the entire TOML file is
checked for unknown keys and wrong types, while unused environment values
remain unread. `configurationPath()` resolves CLI and environment paths
against the supplied working directory and TOML paths against the file's
directory. The loader reads only an explicitly selected file and fails if
that file is missing. It neither searches for configuration nor loads *.env*.

The server CLI uses these bindings. Set `DRFED_CONFIG` or pass `--config`
to select one TOML file; explicit CLI settings take priority over environment
variables and that file. Help and version requests do not read operational
configuration. Schema output does not read the TOML file.

~~~~ toml
[server]
root_origin = "https://drfed.example.com"
listen = "localhost:8888"
login_origins = ["https://drfed.example.com"]

[database]
driver = "pglite"
data_path = "data"
migrate = true

[mail]
transport = "logtape"

[telemetry]
log_level = "info"
~~~~

~~~~ sh
drfed-server --config /etc/drfed/drfed.toml
DRFED_CONFIG=/etc/drfed/drfed.toml drfed-server --no-migrate
DRFED_LOGIN_ORIGINS='["https://frontend.example.com"]' \
  drfed-server --config /etc/drfed/drfed.toml
~~~~

The example stores PGlite data at */etc/drfed/data*, relative to the file.
Environment and CLI paths are relative to the command's working directory.
When no database selector is given, PGlite uses a persistent OS data directory:
*~/Library/Application Support/DrFed/data* on macOS,
*$XDG\_DATA\_HOME/drfed/data* (or *~/.local/share/drfed/data*) on Linux, and
*%LOCALAPPDATA%/DrFed/data* (or *%USERPROFILE%/AppData/Local/DrFed/data*) on
Windows. Relative OS environment paths are ignored. Override the location
with `--data-path`; selecting PostgreSQL still requires its URL.

| Setting              | Environment variable           | TOML                       |
| -------------------- | ------------------------------ | -------------------------- |
| Root origin          | `DRFED_ROOT_ORIGIN`            | `server.root_origin`       |
| Listen address       | `DRFED_LISTEN`                 | `server.listen`            |
| Login origin array   | `DRFED_LOGIN_ORIGINS`          | `server.login_origins`     |
| Database driver      | `DRFED_DATABASE_DRIVER`        | `database.driver`          |
| PGlite path          | `DRFED_DATA_PATH`              | `database.data_path`       |
| PostgreSQL URL       | `DRFED_POSTGRES_URL`           | `database.url`             |
| Migration lock wait  | `DRFED_MIGRATION_LOCK_TIMEOUT` | `database.lock_timeout_ms` |
| Automatic migrations | `DRFED_MIGRATE`                | `database.migrate`         |
| Mail sender          | `DRFED_EMAIL_FROM`             | `mail.from`                |
| Mail transport       | `DRFED_MAIL_TRANSPORT`         | `mail.transport`           |
| SMTP URL             | `DRFED_SMTP_URL`               | `mail.smtp.url`            |
| Log level            | `DRFED_LOG_LEVEL`              | `telemetry.log_level`      |
| Log formatter        | `DRFED_LOG_FORMAT`             | `telemetry.log_format`     |
| Log output           | `DRFED_LOG_OUTPUT`             | `telemetry.log_output`     |

Database selectors at the highest source choose `pglite` or `postgres`;
selectors at that source must agree. A CLI PostgreSQL URL replaces a TOML
PGlite path, and a CLI PGlite path replaces a TOML PostgreSQL URL. An explicit
`--database-driver postgres` requires a PostgreSQL URL; it does not restore
a PGlite fallback. Same-kind values can be inherited from lower sources.
Foreign lower-source fields are removed before domain validation.

The mail transport follows the same rule: an SMTP URL selects `smtp`, and
a higher-source `--mail-transport logtape` disables a configured SMTP URL.
Only `smtp` and `logtape` are currently available. `--migrate` and
`--no-migrate` explicitly override the selected migration policy.

`@drfed/drfed/database-settings` exposes `resolveDatabaseSettings()` for the
same database selection contract, returning plain runtime settings and
source-only metadata for ignored fields.

[Optique environment]: https://optique.dev/integrations/env.md
[configuration]: https://optique.dev/integrations/config.md


Configuration diagnostics
-------------------------

`drfed-server --config drfed.toml --print-config` prints JSON containing the
selected settings and their sources without opening the database, mail
transport or log file. PostgreSQL and SMTP URLs are printed as `<redacted>`.
Database and mail selectors report the source that selected the effective kind;
ignored database fields and the unused web area are listed separately.
Invalid active settings still fail rather than falling back to another source.

Help, version and GraphQL schema output ignore operational environment values
and do not read the TOML file. Schema generation still accepts the historical
logging options, but ignores them and does not create a log file.


Database startup and updates
----------------------------

The server verifies bundled migration hashes and the database history before
starting workers or accepting HTTP requests. Automatic migration applies only
an exact known prefix, upgrades supported legacy metadata and requires ready
history afterward. Modified, diverged, newer or unsupported histories fail
without applying migration SQL. Restore or reconcile these histories after
reviewing your backup; changing hashes to silence the check is unsafe.

`--no-migrate` inspects history without applying SQL or upgrading metadata. It
starts only when history is exactly ready; fresh, pending and legacy databases
must first be prepared with automatic migration enabled. Opening a fresh
PGlite directory still initializes PGlite's own database files and catalog.

A persistent PGlite directory is exclusively owned for the lifetime of the
server. A second process fails immediately, including through a symlink alias.
The stable *.drfed.lock* file remains after shutdown and must not be deleted
to work around an ownership error. Process exit releases the native lock.

PostgreSQL migration uses a separate session, verifies history under its
advisory lock and closes that session before creating the runtime connection
pool. `--migration-lock-timeout 30000` sets the connection and lock acquisition
limit in milliseconds, through the same CLI/environment/TOML precedence. It
does not time out SQL already applying under the lock.
The timeout ranges from 1 to 2,147,483,647; the default is 30,000. It does not
change PGlite's immediate ownership conflict behavior.

PostgreSQL URLs must name one TCP host, a user and a database. Supported query
parameters are `sslmode`, `search_path` and `application_name`; duplicate or
unsupported parameters are rejected before connecting. The default TLS mode
is `disable`, intended for local connections or a separately secured network.
Use `sslmode=verify-full` for remote connections: both migration and runtime
connections verify the certificate chain and host name using Node.js's trust
store. Set Node.js's `NODE_EXTRA_CA_CERTS` before starting DrFed when a private
CA is required; see [Node.js's CA configuration]. Modes that allow plaintext
fallback or disable certificate verification, direct TLS negotiation and
multi-host URLs are not supported.

Both connections use the same `search_path` (default `public`) and
`application_name` (default `drfed`). The migration session passes `search_path`
through escaped PostgreSQL startup options, preserving quoted identifiers.

[Node.js's CA configuration]: https://nodejs.org/api/cli.html#node_extra_ca_certsfile


Database preparation command
----------------------------

Use `drfed-migrate` to prepare a database without starting the server, mail,
federation workers or web frontend. It uses the same `--config` TOML file,
`DRFED_CONFIG`, database options and environment variables as `drfed-server`;
server origins and mail settings are unnecessary for this command.

~~~~ sh
drfed-migrate --config /etc/drfed/drfed.toml --check
drfed-migrate --config /etc/drfed/drfed.toml
drfed-server --config /etc/drfed/drfed.toml --no-migrate
~~~~

The default invocation explicitly applies migrations even when the shared file
sets `database.migrate = false` or `DRFED_MIGRATE` disables server migration.
`--no-migrate` is a server option; use `--check` for database inspection.

`--check` inspects migration history without applying DrFed SQL or upgrading
legacy metadata. It exits 0 only when the database is ready, and exits 1 when
preparation is needed, history is incompatible or inspection fails. Both modes
print JSON with `status`, `format`, `applied` and `pending` on stdout;
operational errors go to stderr. `--print-config` prints redacted effective
settings and provenance without opening the database.

PGlite uses the same default persistent directory and native ownership lock as
the server. Stop a PGlite server before running either migration mode.
Inspecting a fresh directory creates PGlite's own database files and system
catalog, although it creates no DrFed tables or migration history. PostgreSQL
`--check` uses the current command's read privileges and needs no schema-change
grants.

Before updating, back up the database and stop running DrFed processes. Install
the new package, run `drfed-migrate` and verify `drfed-migrate --check`, then
start the server. Automatic migration at server startup is also available. Use
`--no-migrate` for later starts that should only inspect already prepared
history. Keep your backup until you have verified the update.


Initial account creation
------------------------

Create a local account before signing in; installed deployments do not need the
development seed. Use the same shared configuration or database options:

~~~~ sh
drfed-account create --config /etc/drfed/drfed.toml \
  --email operator@example.com --name Operator
~~~~

The command prepares a fresh database by default. `database.migrate = false`,
`DRFED_MIGRATE=false` or `--no-migrate` requires ready history instead; use
`--migrate` to override a lower-source disabled setting. PGlite ownership is
shared with the server, so stop a PGlite server before account creation.

Account creation grants no administrator privileges and creates no login
session. Repeat creation for the same normalized email to obtain the existing
account; its name and privileges are preserved. Email domain normalization
matches login. Display names are trimmed and accept 1 to 100 Unicode characters.
Invalid input is rejected before opening the database.

The command prints JSON with `status` (`created` or `exists`) and the stored
account identity. Both outcomes exit 0; configuration, preparation, ownership,
write and cleanup failures exit 1. Interruption also exits 1 after draining
admitted work; an in-flight write may complete, and retrying preserves an
account that was already created. `--print-config` shows redacted database
settings without acquiring resources. Server/mail settings are unused.

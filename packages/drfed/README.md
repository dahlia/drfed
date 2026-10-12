@drfed/drfed
============

The main application package for [DrFed], a web-based platform for developing
and debugging ActivityPub apps.  It wires together the database layer,
ActivityPub federation, GraphQL server, and HTTP server, and exposes the
`drfed-server`, `drfed-web`, `drfed-migrate`, and `drfed-account` commands.

[DrFed]: https://drfed.org/


Usage
-----

~~~~ sh
drfed-server --root-origin https://drfed.example.com \
  --data-path .pgdata
drfed-server --root-origin https://drfed.example.com \
  --database-url postgres://user@localhost/drfed
~~~~

The server listens on `localhost:8888` by default.  Pass `--listen HOST:PORT`
to override.  Automatic database migrations run on startup unless `--no-migrate`
is given. The frontend and exact `/graphql` endpoint share this listener. Open
the configured root origin for the frontend, or set `--public-origin` to a
different control authority. Instance and deeper subdomains cannot be selected
as its authority. Other control authorities still serve `/graphql`, but web
requests on them receive 421.

CLI parsing validates settings before opening database or mail resources.
`--help`, `--version`, and `--generate-graphql-schema` can run without starting
the server; invalid options also exit before creating those resources.


Standalone web frontend
-----------------------

Use `--no-web` for a backend that serves `/graphql` and federation; other
control paths return 404. Supply the frontend login origin explicitly.
`drfed-web` runs the installed frontend against that backend:

~~~~ sh
drfed-server --no-web --root-origin https://drfed.example.com \
  --login-origin https://drfed.example.com --listen localhost:8888
drfed-web --backend-url http://localhost:8888 \
  --public-origin https://drfed.example.com --listen localhost:3000
~~~~

Add the public frontend origin to the backend's `--login-origin` allowlist.
The command consumes the shared TOML file's `web` and `telemetry` sections,
without opening database or mail resources. Its listen setting is
`web.listen`/`DRFED_WEB_LISTEN`, independent of
`server.listen`/`DRFED_LISTEN`. See [the web package's README](../web/README.md)
for the complete runtime and request policy.


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
  --data-path .pgdata
~~~~

Requests are routed by the authority they arrive on:

| Authority                             | Serves                                |
| ------------------------------------- | ------------------------------------- |
| `<slug>.<root domain>`                | ActivityPub only; GraphQL answers 404 |
| the public web authority              | Frontend and exact `/graphql`         |
| other control authorities             | Exact `/graphql`; web paths are 421   |
| anything deeper under the root domain | 421 Misdirected Request               |
| an unusable `Host` header             | 400 Bad Request                       |

The authority has to match in full, port included.  A request for
`foo.drfed.example.com:8888` against a root origin of
`https://drfed.example.com` does not name an instance and is served the control
surface, not a 404, so do not read the table above as isolating GraphQL by host
name alone.  Ports 80 and 443 both count as no port at all, since which of them
is the default depends on a scheme that is deliberately not compared.

The first-release reverse proxy contract preserves the original `Host` header.
Set the root origin's external scheme for federation and the public web
origin's external scheme for the frontend. The server restores those schemes
before handing requests to Fedify or SolidStart; it ignores forwarded headers.
`X-Forwarded-Host` cannot select an instance or frontend. Proxies that replace
`Host` are unsupported. A trailing-dot Host may be refused by srvx before the
DrFed router runs.

Deploying this way needs a wildcard DNS record for `*.<root domain>` and, over
HTTPS, a wildcard TLS certificate to match.

Changing the root origin after instances exist does not move them.  Their host
names are already part of the actor URIs the rest of the fediverse has stored,
so the server only warns at startup about instances it can no longer reach.


Login origins
-------------

`--login-origin` specifies an HTTP or HTTPS origin allowed in email login
links. Combined mode defaults to the public web origin. An explicit list
replaces this default and must include that origin. With `--no-web`, at least
one origin must be explicit. Repeat the option to allow multiple origins:

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

| Option                            | Short | Description                                                                                                               |
| --------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| `--web` / `--no-web`              |       | Enable or disable the frontend (default: enabled)                                                                         |
| `--public-origin ORIGIN`          |       | Frontend origin (default: root origin; unused with `--no-web`)                                                            |
| `--print-config`                  |       | Print effective settings and sources with secrets redacted; exit                                                          |
| `--config FILE`                   |       | Explicit TOML configuration file                                                                                          |
| `--database-driver KIND`          |       | Select `pglite` or `postgres`                                                                                             |
| `--migrate`                       |       | Enable automatic migrations                                                                                               |
| `--mail-transport KIND`           |       | Select `logtape`, `smtp`, `jmap`, `lettermint`, `maileroo`, `mailtrap`, `mailgun`, `plunk`, `resend`, `sendgrid` or `ses` |
| `--root-origin ORIGIN`            | `-r`  | Origin instances are subdomains of (required)                                                                             |
| `--login-origin ORIGIN`           |       | Origin allowed in login links (required with `--no-web`; repeatable)                                                      |
| `--listen HOST:PORT`              | `-l`  | Address to listen on (default: `localhost:8888`)                                                                          |
| `--pglite-data-path PATH`         | `-d`  | Directory for PGlite storage                                                                                              |
| `--postgres-url URL`              | `-D`  | PostgreSQL connection URL                                                                                                 |
| `--no-migrate`                    | `-M`  | Skip automatic migrations                                                                                                 |
| `--email-from ADDRESS`            | `-f`  | Sender of login mail (default: `noreply@` at the root origin's host)                                                      |
| `--smtp-url URL`                  | `-s`  | SMTP server to deliver mail through                                                                                       |
| `--mail-log-content`              |       | Include subject/body and login codes in log-only output                                                                   |
| `--no-mail-log-content`           |       | Exclude mail subject/body (default)                                                                                       |
| `--smtp-host VALUE`               |       | SMTP server hostname                                                                                                      |
| `--smtp-port VALUE`               |       | SMTP server port                                                                                                          |
| `--smtp-tls VALUE`                |       | SMTP TLS mode: direct, starttls-required or opportunistic                                                                 |
| `--smtp-user VALUE`               |       | SMTP authentication username                                                                                              |
| `--smtp-password VALUE`           |       | SMTP authentication password                                                                                              |
| `--smtp-password-file VALUE`      |       | File containing the SMTP password                                                                                         |
| `--smtp-auth-method VALUE`        |       | SMTP authentication method                                                                                                |
| `--smtp-access-token VALUE`       |       | Static SMTP OAuth access token                                                                                            |
| `--smtp-access-token-file VALUE`  |       | File containing the SMTP OAuth access token                                                                               |
| `--smtp-connection-timeout VALUE` |       | SMTP connection timeout in milliseconds                                                                                   |
| `--smtp-socket-timeout VALUE`     |       | SMTP socket timeout in milliseconds                                                                                       |
| `--smtp-pool-size VALUE`          |       | Maximum owned SMTP connections                                                                                            |
| `--smtp-local-name VALUE`         |       | Local name for SMTP EHLO                                                                                                  |
| `--smtp-ca-file VALUE`            |       | File containing additional SMTP certificate authorities                                                                   |
| `--smtp-cert-file VALUE`          |       | File containing the SMTP client certificate                                                                               |
| `--smtp-key-file VALUE`           |       | File containing the SMTP client private key                                                                               |
| `--help`                          |       | Show help                                                                                                                 |
| `--version`                       |       | Show version                                                                                                              |

`--pglite-data-path` and `--postgres-url` conflict at the winning input source.
Provide the path or URL for the selected database through CLI, environment or
TOML; the source selection rules are described below.

Without a mail delivery transport, DrFed logs mail lifecycle events and warns
that delivery is disabled. Subject and body are excluded by default. For local
login links, explicitly pass `--mail-log-content`; `mise run dev` does this for
the development server.


Testing npm installation
------------------------

From the repository root, run `mise run test:packaging` to build and pack the
five packages, then install their tarballs with npm in temporary local
and global prefixes outside the checkout.  The check uses a separate npm cache
and empty npm configuration files, omits development dependencies, and disables
installation scripts.  It needs network access to the public npm registry for
external dependencies.

The check verifies packed entry points and migrations, npm's `drfed-server`
bin links, CLI help, a database-backed GraphQL request after initial migration,
and a restart with `--no-migrate` using the same PGlite directory.  It removes
the temporary installations and databases after stopping their servers.

All five tarballs are supplied to each install together so unpublished
workspace versions can be tested.  The check covers combined and standalone
frontend SSR, assets, login confirmation and session cookies. It does not cover
installing only the facade from the registry or upgrading an older release.


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

| Setting                                                   | Environment variable            | TOML                              |
| --------------------------------------------------------- | ------------------------------- | --------------------------------- |
| Root origin                                               | `DRFED_ROOT_ORIGIN`             | `server.root_origin`              |
| Listen address                                            | `DRFED_LISTEN`                  | `server.listen`                   |
| Login origin array                                        | `DRFED_LOGIN_ORIGINS`           | `server.login_origins`            |
| Database driver                                           | `DRFED_DATABASE_DRIVER`         | `database.driver`                 |
| PGlite path                                               | `DRFED_DATA_PATH`               | `database.data_path`              |
| PostgreSQL URL                                            | `DRFED_POSTGRES_URL`            | `database.url`                    |
| Migration lock wait                                       | `DRFED_MIGRATION_LOCK_TIMEOUT`  | `database.lock_timeout_ms`        |
| Automatic migrations                                      | `DRFED_MIGRATE`                 | `database.migrate`                |
| Mail sender                                               | `DRFED_EMAIL_FROM`              | `mail.from`                       |
| Mail transport                                            | `DRFED_MAIL_TRANSPORT`          | `mail.transport`                  |
| SMTP URL                                                  | `DRFED_SMTP_URL`                | `mail.smtp.url`                   |
| Mail content logging                                      | `DRFED_MAIL_LOG_CONTENT`        | `mail.log_content`                |
| SMTP server hostname                                      | `DRFED_SMTP_HOST`               | `mail.smtp.host`                  |
| SMTP server port                                          | `DRFED_SMTP_PORT`               | `mail.smtp.port`                  |
| SMTP TLS mode: direct, starttls-required or opportunistic | `DRFED_SMTP_TLS`                | `mail.smtp.tls`                   |
| SMTP authentication username                              | `DRFED_SMTP_USER`               | `mail.smtp.user`                  |
| SMTP authentication password                              | `DRFED_SMTP_PASSWORD`           | `mail.smtp.password`              |
| File containing the SMTP password                         | `DRFED_SMTP_PASSWORD_FILE`      | `mail.smtp.password_file`         |
| SMTP authentication method                                | `DRFED_SMTP_AUTH_METHOD`        | `mail.smtp.auth_method`           |
| Static SMTP OAuth access token                            | `DRFED_SMTP_ACCESS_TOKEN`       | `mail.smtp.access_token`          |
| File containing the SMTP OAuth access token               | `DRFED_SMTP_ACCESS_TOKEN_FILE`  | `mail.smtp.access_token_file`     |
| SMTP connection timeout in milliseconds                   | `DRFED_SMTP_CONNECTION_TIMEOUT` | `mail.smtp.connection_timeout_ms` |
| SMTP socket timeout in milliseconds                       | `DRFED_SMTP_SOCKET_TIMEOUT`     | `mail.smtp.socket_timeout_ms`     |
| Maximum owned SMTP connections                            | `DRFED_SMTP_POOL_SIZE`          | `mail.smtp.pool_size`             |
| Local name for SMTP EHLO                                  | `DRFED_SMTP_LOCAL_NAME`         | `mail.smtp.local_name`            |
| File containing additional SMTP certificate authorities   | `DRFED_SMTP_CA_FILE`            | `mail.smtp.ca_file`               |
| File containing the SMTP client certificate               | `DRFED_SMTP_CERT_FILE`          | `mail.smtp.cert_file`             |
| File containing the SMTP client private key               | `DRFED_SMTP_KEY_FILE`           | `mail.smtp.key_file`              |
| Log level                                                 | `DRFED_LOG_LEVEL`               | `telemetry.log_level`             |
| Log formatter                                             | `DRFED_LOG_FORMAT`              | `telemetry.log_format`            |
| Log output                                                | `DRFED_LOG_OUTPUT`              | `telemetry.log_output`            |

Database selectors at the highest source choose `pglite` or `postgres`;
selectors at that source must agree. A CLI PostgreSQL URL replaces a TOML
PGlite path, and a CLI PGlite path replaces a TOML PostgreSQL URL. An explicit
`--database-driver postgres` requires a PostgreSQL URL; it does not restore
a PGlite fallback. Same-kind values can be inherited from lower sources.
Foreign lower-source fields are removed before domain validation.

The mail transport follows the same precedence: an SMTP URL or `--smtp-host`
selects `smtp`, and a higher-source `--mail-transport logtape` disables
configured SMTP settings. SMTP URLs accept `smtp://` (port 587 by default) and
`smtps://` (implicit TLS, port 465 by default). URL credentials are
percent-decoded. A URL and separate host/port/TLS or credentials at the same
source cannot specify the same component twice. Higher-source fields replace
individual lower URL components; for example, a CLI password file replaces the
TOML URL password while keeping its host and port.

With separate SMTP fields, TLS defaults to `starttls-required`. `direct` uses
implicit TLS, and `opportunistic` upgrades only when supported. Authenticated
`smtp://` URLs require STARTTLS even when it is not advertised; explicitly
choosing opportunistic TLS with authentication is rejected. Certificates are
verified and TLS 1.2 or newer is required. Connection and socket timeouts
default to 30 seconds, with at most five owned SMTP connections.

Password authentication supports `plain` and `login`. Static OAuth
access tokens support `xoauth2` and `oauthbearer`; dynamic token callbacks are
library APIs rather than CLI settings. For password authentication, usernames
and passwords must currently be printable ASCII because Upyo 0.6.0 does not
encode Unicode password credentials as UTF-8. Non-root URL paths, query
parameters and fragments are rejected before runtime resources are created.

~~~~ toml
[mail]
transport = "smtp"
from = "noreply@drfed.example"

[mail.smtp]
host = "smtp.example"
port = 587
tls = "starttls-required"
user = "operator"
password_file = "secrets/smtp-password"
connection_timeout_ms = 30000
socket_timeout_ms = 30000
pool_size = 5
~~~~

Literal credentials and credential files are variants of one setting: a higher
source wins, while both at the same source are an error. Only files named by
the effective configuration are read, after configuration diagnostics and
before database preparation. Relative TOML paths use the configuration
directory; CLI/env paths use the working directory. Files must be regular UTF-8
files of at most 64 KiB; projected secret symlinks are supported. Exactly one
final LF or CRLF is removed, preserving spaces and any additional newline. File
paths and contents do not appear in credential read errors or `--print-config`
output.

`ca_file` adds certificate authorities to Node's default roots. For mutual TLS,
configure both `cert_file` and `key_file`; the files contain PEM certificates
and an unencrypted PEM private key. Certificate verification cannot be disabled.
See the [Upyo SMTP documentation] for the underlying transport.

`--migrate` and `--no-migrate` explicitly override the selected migration
policy.

`@drfed/drfed/database-settings` exposes `resolveDatabaseSettings()` for the
same database selection contract, returning plain runtime settings and
source-only metadata for ignored fields.

[Optique environment]: https://optique.dev/integrations/env.md
[configuration]: https://optique.dev/integrations/config.md
[Upyo SMTP documentation]: https://upyo.org/transports/smtp


JMAP mail
---------

Use [Upyo JMAP] with bearer authentication or basic authentication. A session
URL selects JMAP at that source; an explicit `--mail-transport jmap` also
selects it. Conflicting transport selectors at the same source are rejected.
Higher sources can switch transports without reading the previous transport's
credential files.

~~~~ toml
[mail]
transport = "jmap"

[mail.jmap]
session_url = "https://mail.example.com/.well-known/jmap"
bearer_token_file = "/run/secrets/jmap-token"
~~~~

Set `user` and `password_file` instead of `bearer_token_file` for basic
authentication. Basic credentials must be printable ASCII because the pinned
Upyo SDK does not encode non-ASCII credentials as UTF-8. The username cannot
contain a colon. Literal and file credentials use the same source precedence
and file rules as [SMTP](#shared-configuration-bindings); bearer and basic
credentials at the same source are rejected. Secret values and paths are
redacted from `--print-config`.

| CLI option                 | Environment variable           | TOML field                       |
| -------------------------- | ------------------------------ | -------------------------------- |
| `--jmap-session-url`       | `DRFED_JMAP_SESSION_URL`       | `mail.jmap.session_url`          |
| `--jmap-bearer-token`      | `DRFED_JMAP_BEARER_TOKEN`      | `mail.jmap.bearer_token`         |
| `--jmap-bearer-token-file` | `DRFED_JMAP_BEARER_TOKEN_FILE` | `mail.jmap.bearer_token_file`    |
| `--jmap-user`              | `DRFED_JMAP_USER`              | `mail.jmap.user`                 |
| `--jmap-password`          | `DRFED_JMAP_PASSWORD`          | `mail.jmap.password`             |
| `--jmap-password-file`     | `DRFED_JMAP_PASSWORD_FILE`     | `mail.jmap.password_file`        |
| `--jmap-account-id`        | `DRFED_JMAP_ACCOUNT_ID`        | `mail.jmap.account_id`           |
| `--jmap-identity-id`       | `DRFED_JMAP_IDENTITY_ID`       | `mail.jmap.identity_id`          |
| `--jmap-base-url`          | `DRFED_JMAP_BASE_URL`          | `mail.jmap.base_url`             |
| `--jmap-timeout`           | `DRFED_JMAP_TIMEOUT`           | `mail.jmap.timeout_ms`           |
| `--jmap-session-cache-ttl` | `DRFED_JMAP_SESSION_CACHE_TTL` | `mail.jmap.session_cache_ttl_ms` |

Session and base URLs require HTTPS, except HTTP on `localhost`, `127.0.0.1`,
or `[::1]` for local testing. URL credentials and fragments are rejected.
`base_url` is an origin used to rewrite endpoints discovered from the session,
useful when the mail server advertises internal host names. Without
`account_id` and `identity_id`, Upyo discovers a mail account and selects the
identity matching the sender address.

Duration options and their environment variables take milliseconds, matching
the TOML fields.

The whole delivery timeout defaults to 30 seconds, and session cache lifetime
to five minutes. Automatic JMAP retries are disabled because the pinned SDK
can replay a mail submission after an uncertain response. These settings apply
only when JMAP is selected. Cancelling a request aborts the in-flight JMAP
call. Delivery failures return the same opaque login response and produce the
same mail outcome log entries as SMTP.

[Upyo JMAP]: https://upyo.org/transports/jmap


Lettermint mail
---------------

Set `transport = "lettermint"` under `[mail]` and supply a sending API token:

~~~~ toml
[mail]
transport = "lettermint"

[mail.lettermint]
api_token_file = "/run/secrets/lettermint-token"
route = "transactional"
~~~~

The optional `route` selects a route configured in Lettermint; omit it to leave
route selection to the service. Delivery uses [Upyo Lettermint].

You can use the common API credential options instead of the Lettermint-specific
ones. For example, `--mail-api-key-file /run/secrets/lettermint-token` overrides
a Lettermint token from a lower-priority source. Of the four credential settings
(common or Lettermint, literal or file), only the highest-priority source is
used. Supplying more than one at that source is rejected. See the [shared
configuration](#shared-configuration-bindings) for the source order and secret
file rules. Only the selected file is read. Values and paths are redacted from
`--print-config`.

| CLI option                    | Environment variable              | TOML field                       |
| ----------------------------- | --------------------------------- | -------------------------------- |
| `--mail-api-key`              | `DRFED_MAIL_API_KEY`              | `mail.api_key`                   |
| `--mail-api-key-file`         | `DRFED_MAIL_API_KEY_FILE`         | `mail.api_key_file`              |
| `--lettermint-api-token`      | `DRFED_LETTERMINT_API_TOKEN`      | `mail.lettermint.api_token`      |
| `--lettermint-api-token-file` | `DRFED_LETTERMINT_API_TOKEN_FILE` | `mail.lettermint.api_token_file` |
| `--lettermint-base-url`       | `DRFED_LETTERMINT_BASE_URL`       | `mail.lettermint.base_url`       |
| `--lettermint-route`          | `DRFED_LETTERMINT_ROUTE`          | `mail.lettermint.route`          |
| `--lettermint-timeout`        | `DRFED_LETTERMINT_TIMEOUT`        | `mail.lettermint.timeout_ms`     |
| `--lettermint-retries`        | `DRFED_LETTERMINT_RETRIES`        | `mail.lettermint.retries`        |

The base URL defaults to `https://api.lettermint.co` and must be a bare origin:
HTTPS, or HTTP on loopback for local testing, with no credentials, path, query,
or fragment. All timeout forms take milliseconds. The whole delivery timeout
defaults to 30,000 milliseconds, including response bodies and retry delays.
When that deadline expires, DrFed reports a delivery failure and does not
automatically resend.

After the first attempt, up to three retries are made by default, with a
maximum of ten. Upyo generates one idempotency key per delivery and reuses it
across retries. A permanently rejected request is not retried. Cancelling a
delivery or shutting the transport down aborts in-flight requests.

[Upyo Lettermint]: https://upyo.org/transports/lettermint


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


Maileroo mail
-------------

Set the mail transport to `maileroo` and provide a sending key for a verified
Maileroo domain. Use the common `--mail-api-key`/`--mail-api-key-file` options
or the Maileroo-specific options below. CLI values take precedence over
environment variables, then TOML. At the highest source level that provides
a key, exactly one of `--mail-api-key`, `--mail-api-key-file`,
`--maileroo-api-key`, or `--maileroo-api-key-file` may be present. Lower sources
are ignored before validation or file access.

| CLI option                | Environment variable          | TOML setting                 |
| ------------------------- | ----------------------------- | ---------------------------- |
| `--maileroo-api-key`      | `DRFED_MAILEROO_API_KEY`      | `mail.maileroo.api_key`      |
| `--maileroo-api-key-file` | `DRFED_MAILEROO_API_KEY_FILE` | `mail.maileroo.api_key_file` |
| `--maileroo-base-url`     | `DRFED_MAILEROO_BASE_URL`     | `mail.maileroo.base_url`     |
| `--maileroo-timeout`      | `DRFED_MAILEROO_TIMEOUT`      | `mail.maileroo.timeout_ms`   |

~~~~ toml
[mail]
transport = "maileroo"

[mail.maileroo]
api_key_file = "/run/secrets/maileroo"
~~~~

The default API URL is `https://smtp.maileroo.com/api/v2`. An override replaces
this URL; Upyo appends `/emails` after removing trailing slashes. It must use
HTTPS or local loopback HTTP, without credentials, a query or a fragment.
The timeout covers the whole delivery, including the response body. Values
use milliseconds in all three sources and default to 30,000.
Timeouts must be positive and at most 2,147,483,647 milliseconds.

DrFed disables retries in Upyo's Maileroo transport. Maileroo's reference ID
is a tracking identifier;
it does not establish that resending an uncertain submission is safe. If the
response is lost or a request times out, DrFed cannot tell whether Maileroo
accepted the message. Login produces the same response as other mail failures,
and DrFed does not automatically resend the message. See the
[Upyo Maileroo documentation] and [Maileroo reference ID documentation].

[Upyo Maileroo documentation]: https://upyo.org/transports/maileroo
[Maileroo reference ID documentation]: https://maileroo.com/docs/smtp-relay/advanced-message-options


Mailtrap mail
-------------

Set `mail.transport = "mailtrap"` to use [Upyo Mailtrap]. Provide a sending
API token through the shared API key or key file options, or through the
Mailtrap-specific token or token file options. CLI values take precedence over
environment variables, which take precedence over TOML. At the highest source
level that supplies a credential, exactly one representation may be present.
Credential files from lower sources or other providers are not opened.

~~~~ toml
[mail]
transport = "mailtrap"

[mail.mailtrap]
api_token_file = "/run/secrets/mailtrap"
sandbox = true
inbox_id = "12345"
~~~~

Sandbox mode captures messages in a test inbox rather than delivering them
to recipients. It requires a positive decimal inbox ID no greater than
9,007,199,254,740,991. Production delivery is the default; an inbox ID alone
does not enable sandbox mode. Use `--mailtrap-sandbox` to enable it or
`--no-mailtrap-sandbox` to disable it when a lower source enabled it.

| CLI option                                     | Environment variable              | TOML setting                     |
| ---------------------------------------------- | --------------------------------- | -------------------------------- |
| `--mailtrap-api-token`                         | `DRFED_MAILTRAP_API_TOKEN`        | `mail.mailtrap.api_token`        |
| `--mailtrap-api-token-file`                    | `DRFED_MAILTRAP_API_TOKEN_FILE`   | `mail.mailtrap.api_token_file`   |
| `--mailtrap-sandbox` / `--no-mailtrap-sandbox` | `DRFED_MAILTRAP_SANDBOX`          | `mail.mailtrap.sandbox`          |
| `--mailtrap-inbox-id`                          | `DRFED_MAILTRAP_INBOX_ID`         | `mail.mailtrap.inbox_id`         |
| `--mailtrap-send-base-url`                     | `DRFED_MAILTRAP_SEND_BASE_URL`    | `mail.mailtrap.send_base_url`    |
| `--mailtrap-sandbox-base-url`                  | `DRFED_MAILTRAP_SANDBOX_BASE_URL` | `mail.mailtrap.sandbox_base_url` |
| `--mailtrap-timeout`                           | `DRFED_MAILTRAP_TIMEOUT`          | `mail.mailtrap.timeout_ms`       |

The production API defaults to `https://send.api.mailtrap.io`; the sandbox
API defaults to `https://sandbox.api.mailtrap.io`. Only the selected mode's
endpoint is validated and used. Overrides must use HTTPS or HTTP to a loopback
address and must not contain credentials, a query or a fragment. Upyo appends
`/api/send` for production or `/api/send/{inbox_id}` for the sandbox.
Certificate verification remains enabled.

The timeout covers the whole delivery, including reading the response body,
and defaults to 30,000 milliseconds. All input sources use milliseconds; values
must be positive and at most 2,147,483,647. DrFed disables Upyo's Mailtrap
retries because an uncertain API response can leave acceptance unknown, making
automatic resubmission risk duplicate mail. Cancellation and shutdown abort
active sends and wait for them to settle.

[Upyo Mailtrap]: https://upyo.org/transports/mailtrap


Mailgun mail
------------

Set the mail transport to `mailgun` and provide a verified sending domain and
API key. Use the shared `--mail-api-key`/`--mail-api-key-file` options
or the Mailgun-specific options below. CLI values take precedence over
environment variables, which take precedence over TOML. At the highest source
level that supplies a credential, set exactly one of these four key or key-file
options. Credential files from lower-priority sources or other providers are
not opened.

~~~~ toml
[mail]
transport = "mailgun"
from = "noreply@mg.example.com"

[mail.mailgun]
api_key_file = "/run/secrets/mailgun"
domain = "mg.example.com"
region = "eu"
~~~~

| CLI option               | Environment variable         | TOML setting                |
| ------------------------ | ---------------------------- | --------------------------- |
| `--mailgun-api-key`      | `DRFED_MAILGUN_API_KEY`      | `mail.mailgun.api_key`      |
| `--mailgun-api-key-file` | `DRFED_MAILGUN_API_KEY_FILE` | `mail.mailgun.api_key_file` |
| `--mailgun-domain`       | `DRFED_MAILGUN_DOMAIN`       | `mail.mailgun.domain`       |
| `--mailgun-region`       | `DRFED_MAILGUN_REGION`       | `mail.mailgun.region`       |
| `--mailgun-base-url`     | `DRFED_MAILGUN_BASE_URL`     | `mail.mailgun.base_url`     |
| `--mailgun-timeout`      | `DRFED_MAILGUN_TIMEOUT`      | `mail.mailgun.timeout_ms`   |

The domain, including an internationalized domain name, is normalized to
lowercase ASCII. It must be a DNS name without credentials, a port or a URL
path. The default `us` region uses `https://api.mailgun.net/v3`; `eu` uses
`https://api.eu.mailgun.net/v3`. A base URL override replaces that endpoint.
Overrides require HTTPS or local loopback HTTP, without credentials, a query or
a fragment. Upyo, DrFed's mail library, appends `/{domain}/messages` and sends
multipart form data.

DrFed disables per-message click and open tracking so login links go directly
to DrFed. These settings override the domain's tracking defaults. DrFed
disables Upyo's automatic retries. A submission that times out may already have
been accepted, so retrying it could send the message twice. The timeout covers
the whole delivery, including reading the response body, and defaults to 30,000
milliseconds. CLI options, environment variables and TOML all use milliseconds;
values must be positive and at most 2,147,483,647. Certificate verification
remains enabled.

See [Upyo Mailgun],
[Mailgun sending options]
and [click tracking].

[Upyo Mailgun]: https://upyo.org/transports/mailgun
[Mailgun sending options]: https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages
[click tracking]: https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/tracking-clicks


Plunk mail
----------

Set the mail transport to `plunk` and provide a sending API key through the
shared `--mail-api-key`/`--mail-api-key-file` options or the Plunk-specific
options below. CLI values take precedence over environment variables, which
take precedence over TOML. In the highest-precedence source that supplies a
credential, set exactly one of the key or key-file options. Credential files
from lower sources or other providers are not opened.

~~~~ toml
[mail]
transport = "plunk"

[mail.plunk]
api_key_file = "/run/secrets/plunk"
base_url = "https://mail.example.com/api"
~~~~

| CLI option             | Environment variable       | TOML setting              |
| ---------------------- | -------------------------- | ------------------------- |
| `--plunk-api-key`      | `DRFED_PLUNK_API_KEY`      | `mail.plunk.api_key`      |
| `--plunk-api-key-file` | `DRFED_PLUNK_API_KEY_FILE` | `mail.plunk.api_key_file` |
| `--plunk-base-url`     | `DRFED_PLUNK_BASE_URL`     | `mail.plunk.base_url`     |
| `--plunk-timeout`      | `DRFED_PLUNK_TIMEOUT`      | `mail.plunk.timeout_ms`   |

The base URL defaults to the hosted API at `https://next-api.useplunk.com`. For
a self-hosted server, override the base URL, including its API path if needed.
Upyo appends `/v1/send`, so the example above sends to
`https://mail.example.com/api/v1/send`. Overrides must use HTTPS, or HTTP only
for a loopback address, and must not contain credentials, a query or a
fragment. Certificate verification remains enabled.

DrFed disables Upyo's Plunk retries because an uncertain API response leaves
acceptance unknown, and automatic resubmission could send duplicate mail. The
timeout covers the whole delivery, including reading the response body, and
defaults to 30,000 milliseconds. CLI options, environment variables and TOML
all use milliseconds; values must be positive and at most 2,147,483,647.
Cancellation and shutdown abort active sends and wait for them to settle.

See [Upyo Plunk] for transport details, including self-hosted servers.

[Upyo Plunk]: https://upyo.org/transports/plunk


Resend mail
-----------

Set the mail transport to `resend` and provide a sending API key through the
shared `--mail-api-key`/`--mail-api-key-file` options or the Resend-specific
options below. CLI values take precedence over environment variables, which
take precedence over TOML. In the highest-precedence source that supplies a
credential, set exactly one key or key-file option. Credential files from
lower sources or other providers are not opened.

~~~~ toml
[mail]
transport = "resend"

[mail.resend]
api_key_file = "/run/secrets/resend"
retries = 1
~~~~

| CLI option              | Environment variable        | TOML setting               |
| ----------------------- | --------------------------- | -------------------------- |
| `--resend-api-key`      | `DRFED_RESEND_API_KEY`      | `mail.resend.api_key`      |
| `--resend-api-key-file` | `DRFED_RESEND_API_KEY_FILE` | `mail.resend.api_key_file` |
| `--resend-base-url`     | `DRFED_RESEND_BASE_URL`     | `mail.resend.base_url`     |
| `--resend-timeout`      | `DRFED_RESEND_TIMEOUT`      | `mail.resend.timeout_ms`   |
| `--resend-retries`      | `DRFED_RESEND_RETRIES`      | `mail.resend.retries`      |

The base URL defaults to `https://api.resend.com`. Upyo, the mail library DrFed
uses, appends `/emails`. Overrides must use HTTPS. HTTP is accepted only for
loopback addresses. Overrides must not contain credentials, a query or a
fragment. Certificate verification remains enabled.

DrFed generates one idempotency key per delivery and sends it with every
attempt. Resend uses this key to deduplicate submissions for 24 hours, allowing
bounded retries after an uncertain response. DrFed uses Upyo's Retry wrapper,
with cancellable delays, rather than the Resend SDK's internal retry loop.
Retries default to three additional attempts and may be set from zero through
ten. Only failures marked retryable are tried again. Each login email is its
own delivery and receives its own key.

The timeout covers the whole delivery, including retry delays and reading the
response body, and defaults to 30,000 milliseconds. CLI options, environment
variables and TOML all use milliseconds; values must be positive and at most
2,147,483,647. Cancellation and shutdown abort active sends and wait for them
to settle.

See [Upyo Resend] and [Resend idempotency keys].

[Upyo Resend]: https://upyo.org/transports/resend
[Resend idempotency keys]: https://resend.com/docs/dashboard/emails/idempotency-keys


SendGrid mail
-------------

Set the mail transport to `sendgrid` and provide a sending API key through the
shared `--mail-api-key`/`--mail-api-key-file` options or the SendGrid-specific
options below. CLI values take precedence over environment variables, which
take precedence over TOML. Credentials come from the highest-precedence source
that supplies any of the four shared or SendGrid-specific key or key-file
settings. That source must set exactly one; conflicting representations cause a
startup error. Credential files from lower-precedence sources or other
providers are not opened.

~~~~ toml
[mail]
transport = "sendgrid"

[mail.sendgrid]
api_key_file = "/run/secrets/sendgrid"
~~~~

| CLI option                | Environment variable          | TOML setting                 |
| ------------------------- | ----------------------------- | ---------------------------- |
| `--sendgrid-api-key`      | `DRFED_SENDGRID_API_KEY`      | `mail.sendgrid.api_key`      |
| `--sendgrid-api-key-file` | `DRFED_SENDGRID_API_KEY_FILE` | `mail.sendgrid.api_key_file` |
| `--sendgrid-base-url`     | `DRFED_SENDGRID_BASE_URL`     | `mail.sendgrid.base_url`     |
| `--sendgrid-timeout`      | `DRFED_SENDGRID_TIMEOUT`      | `mail.sendgrid.timeout_ms`   |

The base URL defaults to `https://api.sendgrid.com/v3`. Upyo, the mail library
DrFed uses, appends `/mail/send` to the base URL. Overrides must use HTTPS,
except that HTTP is accepted for loopback addresses. Overrides must not contain
credentials, a query or a fragment. Certificate verification remains enabled.

DrFed disables Upyo's automatic SendGrid retries because when a response is
lost or ambiguous, DrFed cannot tell whether SendGrid accepted the message, and
a retry could send duplicate mail. Click, open, subscription and Google
Analytics tracking are disabled in each message's tracking settings so login
links go directly to DrFed.

The timeout covers the whole delivery, including reading the
response body, and defaults to 30,000 milliseconds. CLI options, environment
variables and TOML all use milliseconds; values must be positive and at most
2,147,483,647. Cancellation and shutdown abort active sends and wait for them
to settle.

See [Upyo SendGrid] and [SendGrid sending options].

[Upyo SendGrid]: https://upyo.org/transports/sendgrid
[SendGrid sending options]: https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send


Amazon SES mail
---------------

Set the mail transport to `ses` and provide an AWS access key ID and secret
access key. DrFed uses Upyo's SES API transport; these are AWS credentials,
not SMTP credentials. Use the SES-specific settings below. The shared
`--mail-api-key` settings belong to the other API providers and are ignored
for SES. CLI values take precedence over environment variables, which take
precedence over TOML. At the highest source level that supplies a credential,
set its literal or file setting, not both. Credential files from lower sources
or other providers are not opened.

~~~~ toml
[mail]
transport = "ses"

[mail.ses]
auth = "session"
access_key_id_file = "/run/secrets/aws-access-key-id"
secret_access_key_file = "/run/secrets/aws-secret-access-key"
session_token_file = "/run/secrets/aws-session-token"
region = "eu-west-1"
~~~~

| CLI option                     | Environment variable               | TOML setting                      |
| ------------------------------ | ---------------------------------- | --------------------------------- |
| `--ses-auth`                   | `DRFED_SES_AUTH`                   | `mail.ses.auth`                   |
| `--ses-access-key-id`          | `DRFED_SES_ACCESS_KEY_ID`          | `mail.ses.access_key_id`          |
| `--ses-access-key-id-file`     | `DRFED_SES_ACCESS_KEY_ID_FILE`     | `mail.ses.access_key_id_file`     |
| `--ses-secret-access-key`      | `DRFED_SES_SECRET_ACCESS_KEY`      | `mail.ses.secret_access_key`      |
| `--ses-secret-access-key-file` | `DRFED_SES_SECRET_ACCESS_KEY_FILE` | `mail.ses.secret_access_key_file` |
| `--ses-session-token`          | `DRFED_SES_SESSION_TOKEN`          | `mail.ses.session_token`          |
| `--ses-session-token-file`     | `DRFED_SES_SESSION_TOKEN_FILE`     | `mail.ses.session_token_file`     |
| `--ses-region`                 | `DRFED_SES_REGION`                 | `mail.ses.region`                 |
| `--ses-timeout`                | `DRFED_SES_TIMEOUT`                | `mail.ses.timeout_ms`             |

Authentication defaults to `credentials`. A session token at a higher source
level selects `session`; an explicit authentication setting at the same or a
higher level wins. Session mode requires a token. Explicit `credentials` mode
leaves unused token files unopened. Access key IDs must contain ASCII letters
and digits; secret keys and session tokens must be nonempty printable ASCII
without whitespace. Selected files are read once at startup, with the final
LF or CRLF removed.

Upyo does not obtain IAM roles or refresh credentials. Obtain temporary
credentials outside DrFed and restart with fresh settings when they change.
DrFed reads the `DRFED_SES_*` variables above, not the AWS SDK's profile or
credential-provider chain.

The region defaults to `us-east-1`. Upyo constructs the HTTPS endpoint
`https://email.{region}.amazonaws.com/v2/email/outbound-emails` and signs
requests with AWS SigV4. Regions must use an ASCII AWS region name. China,
isolated and sovereign partitions that need another endpoint suffix are
unsupported by this SDK. There is no custom endpoint option. Certificate
verification remains enabled.

DrFed disables Upyo's SES retries because a lost response may leave message
acceptance unknown, and an automatic retry could send duplicate mail. The
timeout covers the whole delivery, including reading the response body, and
defaults to 30,000 milliseconds. CLI options, environment variables and TOML
all use milliseconds; values must be positive and at most 2,147,483,647.
Cancellation and shutdown abort active sends and wait for them to settle.

See [Upyo SES] and [AWS SES endpoints].

[Upyo SES]: https://upyo.org/transports/ses
[AWS SES endpoints]: https://docs.aws.amazon.com/general/latest/gr/ses.html

Self-hosting
============

Run DrFed on your own server to keep your debugging workspace on your own
infrastructure. See the [CLI reference] for backend configuration options.

[CLI reference]: /reference/cli


Create an account
-----------------

Use `drfed-account create` with the same database settings as your server.
Stop a running PGlite server first: only one process can own its data
directory at a time.

~~~~ sh
drfed-account create --data-path .pgdata \
  --email alice@example.com --name "Alice"
~~~~

Replace the email address and display name with your own. The command prepares
a fresh database automatically. An existing account with the same normalized
email is returned without changing its name or privileges. Newly created
accounts are not administrators.

For a configured deployment, use the same TOML file:

~~~~ sh
drfed-account create --config drfed.toml \
  --email alice@example.com --name "Alice"
~~~~

PostgreSQL deployments can instead pass
`--database-url postgres://drfed@localhost/drfed`. The command prints JSON with
a `created` or `exists` status; both outcomes exit successfully.

When running from the repository, build first and invoke the same command
through its binary:

~~~~ sh
mise exec -- node packages/drfed/bin/drfed-account.mjs create \
  --data-path .pgdata --email alice@example.com --name "Alice"
~~~~

Start the server, open its configured public origin, and sign in with that
email address. Follow the login link delivered by your mail transport.
For local testing with log-only mail, explicitly enable `--mail-log-content`
to print login links; their contents are excluded by default.

See [Configuration] for shared settings and mail setup.

[Configuration]: /manual/configuration


Prepare and check the database
------------------------------

`drfed-migrate` prepares the database without starting the server. Stop a
PGlite server before either of these commands:

~~~~ sh
drfed-migrate --config drfed.toml
drfed-migrate --config drfed.toml --check
~~~~

`--check` inspects migration history without applying DrFed migrations. It
exits successfully only when the database matches the installed migrations
with no pending changes. Back up your database before upgrading, apply the
new migrations, check them, then restart the server.

From the repository, invoke *packages/drfed/bin/drfed-migrate.mjs* through
`mise exec -- node` after building.

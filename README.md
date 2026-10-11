DrFed
=====

[![GitHub Actions][GitHub Actions badge]][GitHub Actions]
[![License: GPL-3.0-only][AGPLv3 badge]][AGPLv3]

DrFed is a web-based platform for developing and debugging [ActivityPub]
implementations, built by the team behind [Fedify]. It brings together the
tools you need to diagnose federation failures in one place: fetch and inspect
any ActivityPub object, monitor incoming activities in real time, step through
HTTP signature construction and verification, validate WebFinger and NodeInfo
responses, explore JSON-LD compaction and expansion, and send test activities
to any inbox. The goal is to make it straightforward to answer the question
“why doesn't my server federate with X?”—by showing you exactly which stage
broke, whether that's DNS, TLS, HTTP, signatures, or JSON-LD processing.

[GitHub Actions badge]: https://github.com/fedify-dev/drfed/actions/workflows/main.yaml/badge.svg
[GitHub Actions]: https://github.com/fedify-dev/drfed/actions/workflows/main.yaml
[AGPLv3 badge]: https://img.shields.io/github/license/fedify-dev/drfed
[AGPLv3]: https://www.gnu.org/licenses/agpl-3.0.html
[ActivityPub]: https://www.w3.org/TR/activitypub/
[Fedify]: https://fedify.dev/


Installation and server usage
-----------------------------

Install the CLI through npm:

~~~~ sh
npm install --global @drfed/drfed
drfed-server --root-origin http://drfed.localhost:8888 \
  --data-path .pgdata --mail-log-content
~~~~

Open `http://drfed.localhost:8888` for the frontend. The same listener serves
`/graphql`; instance subdomains serve ActivityPub only. The first startup
creates and migrates the database. Create an operator account before signing in:

~~~~ sh
drfed-account create --data-path .pgdata \
  --email operator@example.com --name Operator
~~~~

The default mail transport does not deliver messages. `--mail-log-content`
in the local example prints verification links so you can sign in during
development. Configure SMTP for delivery in service deployments; message
contents are excluded from logs by default. Repository development uses
`mise run dev` with separate backend and frontend processes and explicitly
enables login mail contents.

For a service deployment, select a TOML file with `--config` or `DRFED_CONFIG`.
CLI settings override `DRFED_*` environment variables, which override TOML
and defaults. No configuration files or *.env* files are searched automatically.

~~~~ toml
[server]
root_origin = "https://drfed.example.com"
listen = "localhost:8888"

[database]
data_path = "data"
~~~~

~~~~ sh
drfed-server --config drfed.toml
drfed-server --config drfed.toml --no-migrate
~~~~

Use `--no-migrate` to require an already migrated database.
TOML paths are relative to that file. See the [CLI package documentation]
for the environment variable names, PostgreSQL selection and mail settings.

[CLI package documentation]: ./packages/drfed/README.md

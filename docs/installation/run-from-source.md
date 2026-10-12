Run from source
===============

Build and run DrFed from its repository. This guide runs the backend and web
frontend together on your own machine, using PGlite for database storage.


Prerequisites
-------------

Install Git and [mise] 2026.6.10 or newer. Mise manages Node.js 26, pnpm 11,
and the other tools required by the project.

[mise]: https://mise.jdx.dev/


Get the source and build
------------------------

Clone the repository and run these commands from its root:

~~~~ sh
git clone https://github.com/fedify-dev/drfed.git
cd drfed
mise trust
mise install
mise run build
~~~~

The build compiles the backend packages, generates the GraphQL schema and
Relay artifacts, and builds the web frontend.


Create an account
-----------------

Create your account before starting the server:

~~~~ sh
mise exec -- node packages/drfed/bin/drfed-account.mjs create \
  --data-path .pgdata --email alice@example.com --name "Alice"
~~~~

Replace the email address and display name with your own. The command prepares
the database and stores the account in *.pgdata/*. See [Create an account] for
other database options.

[Create an account]: /manual/self-hosting#create-an-account


Start DrFed
-----------

~~~~ sh
mise run drfed-server \
  --root-origin http://drfed.localhost:8888 \
  --data-path .pgdata \
  --mail-log-content
~~~~

The server listens on `localhost:8888`, serves both the frontend and GraphQL,
and runs database migrations automatically. Keep this terminal open while
using DrFed.

The root origin gives each instance its own subdomain, such as
`http://example.drfed.localhost:8888`. Login links default to the same origin
as the frontend.


Sign in
-------

Open `http://drfed.localhost:8888` and sign in with the account you created.
Use this hostname rather than `localhost:8888`, because the frontend is served
only on its configured authority.

The example uses the log-only mail transport with `--mail-log-content`, which
prints login links in the server log. Follow the link to finish signing in.
Message contents are excluded from logs by default; configure mail delivery
for a service deployment.

To stop DrFed, press `Ctrl+C`. Your database remains in *.pgdata/* and is
reused when you restart the server.


Use your own domain
-------------------

For access from other machines or federation with remote servers, configure
publicly reachable origins, wildcard DNS for instance subdomains, and HTTPS.
Set `--root-origin` to your external HTTPS origin. A reverse proxy must
preserve the original `Host` header. DrFed restores the request scheme from
its configured origin and ignores forwarded headers.

See the [CLI reference] for database, origin, email, and logging options.

[CLI reference]: /reference/cli


Work on the code
----------------

For development with automatic rebuilds, run `mise run dev` after building.
It starts the backend and a separate Vite frontend, and seeds development
accounts by default. Use `mise run dev --no-seed` to skip that seed. The
frontend defaults to `http://localhost:3000`; follow the URL printed by Vite.

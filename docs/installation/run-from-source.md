Run from source
===============

Build and run DrFed from its repository. This guide starts the backend and web
frontend on your own machine, using PGlite for database storage.


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


Start the backend
-----------------

~~~~ sh
mise run drfed-server \
  --root-origin http://drfed.localhost:8888 \
  --login-origin http://localhost:3000 \
  --pglite-data-path .pgdata
~~~~

The backend listens on `localhost:8888`, stores data in *.pgdata/*, and runs
database migrations automatically. Keep this terminal open while using DrFed.

The root origin gives each instance its own subdomain, such as
`http://example.drfed.localhost:8888`. The login origin must match the origin
you use to open the frontend.


Create an account
-----------------

After the backend has started and completed its migrations, stop it with
`Ctrl+C`. Follow [Create an account] to add your email address and display name,
then restart the backend with the same command.

[Create an account]: /manual/self-hosting#create-an-account


Start the frontend
------------------

In another terminal, run this command from the repository root:

~~~~ sh
PORT=3000 mise exec -- pnpm --filter @drfed/web start \
  --backend-url http://127.0.0.1:8888
~~~~

Open `http://localhost:3000` and sign in with the account you created. Without
an SMTP server configured, login email is printed in the backend log. Follow
the link in that log to finish signing in.

To stop DrFed, press `Ctrl+C` in both terminals. Your database remains in
*.pgdata/* and is reused when you restart the backend.


Use your own domain
-------------------

For access from other machines or federation with remote servers, configure
publicly reachable origins, wildcard DNS for instance subdomains, and HTTPS.
Set `--login-origin` to the frontend's public origin, and point the frontend's
`--backend-url` at an address it can reach. A reverse proxy must preserve the
`Host` header and pass `X-Forwarded-Proto: https` when terminating TLS.

See the [CLI reference] for database, origin, email, and logging options.

[CLI reference]: /reference/cli

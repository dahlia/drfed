@drfed/web
==========

SolidStart frontend and embedded Node.js runtime for [DrFed].

[DrFed]: https://drfed.org/


Installed standalone frontend
-----------------------------

Install the application package to obtain the `drfed-web` command:

~~~~ sh
npm install --global @drfed/drfed
drfed-web --backend-url http://localhost:8888 \
  --public-origin https://drfed.example --listen localhost:3000
~~~~

The backend must already be running, and its `--login-origin` allowlist must
include the frontend's public origin. The backend value is normalized to an
origin; requests always use its `/graphql` endpoint. Frontend deployment
settings are resolved at startup and do not require rebuilding the frontend.

All DrFed commands read the same explicit TOML file through `--config FILE` or
`DRFED_CONFIG`, with CLI values overriding environment values and TOML.
`drfed-web` uses `web.public_origin`/`DRFED_PUBLIC_ORIGIN`,
`web.backend_url`/`DRFED_BACKEND_URL` and
`web.listen`/`DRFED_WEB_LISTEN`. Its default listen address is
`localhost:3000`; `server.listen`/`DRFED_LISTEN` belongs to the backend.
The common `telemetry` settings control logging. Database and mail sections are
unused by this command. `--print-config` explains effective settings and sources
without starting the runtime or opening log files.


Development and builds
----------------------

Run `mise run dev` from the repository root to start both development servers.
`mise run dev:web` starts only Vite; its GraphQL backend must already be
running. Development uses `DRFED_BACKEND_URL` (default
`http://drfed.localhost:8888`) and `DRFED_PUBLIC_ORIGIN` (default
`http://localhost:3000`). Add the public origin to the backend's login
allowlist when using a different origin.

Run `mise run build:web` to build the Node adapter, shared binding, SSR bundle
and static assets. `mise run build:web-runtime` builds just the adapter and
binding for Vite development.


Embedded runtime
----------------

Initialize the web runtime with a public origin and GraphQL handler:

~~~~ ts
import { createWebRuntime } from "@drfed/web";

const web = await createWebRuntime({
  publicOrigin: new URL("https://drfed.example"),
  graphqlFetch: (request) => yoga.fetch(request),
});

const response = await web.fetch(request);
await web.close();
~~~~

Importing the package and creating the runtime open no listening socket or
process signal/error handlers. `fetch()` serves SolidStart SSR, server functions
and bundled static assets. Deployment settings live in one external Node module
shared by the adapter and Nitro bundle, rather than argv or serialized runtime
configuration. Each server-side Relay request reads its own SolidStart request
context and forwards only a validated session token as Bearer authorization.
Other cookies and incoming authorization/proxy headers are not forwarded.

Nitro uses process-wide state, so initialize one runtime per process. A second
initialization is rejected, including after close. `close()` is idempotent,
cancels active GraphQL work and waits for its response bodies to finish before
running Nitro close hooks. An injected GraphQL handler remains caller-owned;
a handler that ignores cancellation can delay close until the caller's deadline.
Vite uses Nitro's in-process development runner so SSR shares the external
binding. Frontend HMR retains it; a Vite config or environment restart installs
a new development binding and drains the previous server's GraphQL work.

The [Nitro configuration] controls the listener-free Node entry and external
binding. [Solid's request context] supplies the request cancellation signal.

[Nitro configuration]: https://nitro.build/docs/configuration
[Solid's request context]: https://docs.solidjs.com/reference/server-utilities/get-request-event


Request and cookie policy
-------------------------

Serve the web app only through the configured public origin's authority.
Host-preserving reverse proxies may terminate TLS: DrFed restores the request
URL's scheme from the public origin and strips forwarded headers. It does not
trust forwarded host or protocol headers. A different authority receives 421;
malformed or inconsistent URL/Host values receive 400.

[Server functions] accept POST only, with an Origin matching the public origin.
When Origin is absent, a same-origin Referer is required. Missing, opaque,
malformed and cross-origin sources are rejected before body deserialization;
instance subdomains are also cross-origin. The same policy runs in embedded
and development servers, including encoded server-function path aliases.
Regular login-link GET pages still render, while confirmation uses POST.

Session cookies use HttpOnly, SameSite=Lax and path `/`, without Domain.
Secure follows the configured public origin's HTTPS scheme, including behind
TLS termination; forwarded headers cannot downgrade it.

[Server functions]: https://docs.solidjs.com/solid-start/v2/guides/security#csrf-cross-site-request-forgery


Verification
------------

`mise run test:web-runtime` checks SSR, static assets, binding identity,
controlled GraphQL headers, cancellation, idempotent draining close and the
absence of listeners or process-handler changes. `mise run test` includes this
test after building the frontend. `mise run test:packaging` also exercises the
runtime from local and global npm tarball installations.

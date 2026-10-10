@drfed/web
==========

Web frontend app for [DrFed], built with [SolidStart];

[DrFed]: https://drfed.org/
[SolidStart]: https://start.solidjs.com


Usage
-----

~~~~ bash
mise run dev:web

# or start the server and open the app in a new browser tab
mise run dev:web --open
~~~~


Building
--------

~~~~ bash
mise run build:web
~~~~


Running the build
-----------------

Pass the backend URL when starting the built server:

~~~~ bash
node .output/server/index.mjs --backend-url https://drfed.example
~~~~

Set `HOST` or `PORT` to change the listening address:

~~~~ bash
HOST=127.0.0.1 PORT=4000 node .output/server/index.mjs \
  --backend-url https://drfed.example
~~~~

This project was created with the [Solid CLI]

[Solid CLI]: https://github.com/solidjs-community/solid-cli


Embedded runtime probe
----------------------

From the repository root, run:

~~~~ sh
mise run probe:web-runtime
~~~~

The probe builds a temporary copy of this app with a custom Nitro Node entry
and verifies SSR, static assets, an external shared binding, and a close hook.
It rejects HTTP listener creation and changes to process error or signal
handlers.  GraphQL responses come from a local stub, without a backend server.
Temporary files are removed when the probe finishes.

This checks the build boundary for future embedding; it does not change the
published server or verify authentication, server-function security, HMR, or
the final runtime binding API.

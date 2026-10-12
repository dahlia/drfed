// DrFed: A web-based platform for developing and debugging ActivityPub apps
// Copyright (C) 2026 DrFed team
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import assert from "node:assert/strict";
import { it } from "node:test";

import { resolvePostgresConnection } from "@drfed/drfed/postgres-settings";

it("normalizes the same default connection without consulting driver environment", () => {
  const result = resolvePostgresConnection(
    new URL("postgres://user@localhost/drfed"),
  );
  assert.equal(result.host, "localhost");
  assert.equal(result.port, 5432);
  assert.equal(result.tls, false);
  const runtime = new URL(result.runtimeUrl);
  assert.equal(Number(runtime.port), result.port);
  assert.equal(runtime.searchParams.get("sslmode"), "disable");
  assert.equal(runtime.searchParams.get("search_path"), "public");
  assert.equal(result.options, "-csearch_path=public");
  assert.equal(result.applicationName, "drfed");
  assert.equal(runtime.searchParams.get("application_name"), "drfed");
});

it("preserves secure TLS, IPv6 and escaped quoted search paths", () => {
  const url = new URL("postgres://user@[::1]:5544/drfed");
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("search_path", '"DrFed Schema", public');
  url.searchParams.set("application_name", "DrFed test");
  const result = resolvePostgresConnection(url);
  assert.equal(result.host, "::1");
  assert.equal(result.port, 5544);
  assert.equal(result.tls, true);
  assert.equal(result.options, '-csearch_path="DrFed\\ Schema",\\ public');
  assert.equal(
    new URL(result.runtimeUrl).searchParams.get("search_path"),
    '"DrFed Schema", public',
  );
  assert.equal(result.applicationName, "DrFed test");
});

it("rejects unsupported or ambiguous URLs without disclosing credentials", () => {
  for (const suffix of [
    "sslmode=prefer",
    "sslmode=allow",
    "sslmode=require",
    "sslmode=no-verify",
    "sslmode=verify-ca",
    "sslnegotiation=direct",
    "host=other",
    "port=5544",
    "options=-csearch_path=other",
    "sslrootcert=/private/ca.pem",
    "unknown=1",
    "sslmode=disable&sslmode=verify-full",
    "search_path=",
    "application_name=",
    "search_path=%00",
    "application_name=%00",
  ]) {
    assert.throws(
      () =>
        resolvePostgresConnection(
          new URL(`postgres://user:PRIVATE_PASSWORD@localhost/drfed?${suffix}`),
        ),
      { message: "Invalid or unsupported PostgreSQL connection URL." },
    );
  }
  for (const value of [
    "postgres://user:PRIVATE_PASSWORD@host1,host2/drfed",
    "postgres://localhost/drfed",
    "postgres://user@localhost/",
    "postgres://user@localhost/drfed#fragment",
  ]) {
    assert.throws(() => resolvePostgresConnection(new URL(value)), {
      message: "Invalid or unsupported PostgreSQL connection URL.",
    });
  }
});

it("decodes reserved database characters and credentials once for both drivers", () => {
  const connection = resolvePostgresConnection(
    new URL("postgres://some%20user:p%40ss@localhost/drfed%2Ftest%23name"),
  );
  assert.equal(connection.database, "drfed/test#name");
  assert.equal(connection.user, "some user");
  assert.equal(connection.password, "p@ss");
});

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
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { verifyMigrationManifest } from "@drfed/models/migration-manifest";
import {
  MigrationPreparationError,
  migrationLockKey,
  preparePostgresDatabase,
} from "@drfed/models/migration-session";
import { Client } from "pg";

// This optional service is an isolated author-owned PostgreSQL test fixture.
// oxlint-disable-next-line node/no-process-env
const postgresUrl = process.env.DRFED_TEST_POSTGRES_URL;
const postgres = { skip: !postgresUrl, timeout: 15_000 };

function failure(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof MigrationPreparationError && error.code === code;
}

async function withSql(
  sql: string,
  run: (paths: {
    manifestPath: string;
    migrationsFolder: string;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "drfed-pg-sql-"));
  const migrationsFolder = join(directory, "drizzle");
  const name = "20260101000000_session_probe";
  const folder = join(migrationsFolder, name);
  const manifestPath = join(directory, "manifest.json");
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "migration.sql"), sql);
    await writeFile(
      manifestPath,
      JSON.stringify({
        formatVersion: 1,
        migrations: [
          { name, sha256: createHash("sha256").update(sql).digest("hex") },
        ],
      }),
    );
    await run({ manifestPath, migrationsFolder });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withDatabase(
  run: (url: string, observer: Client) => Promise<void>,
): Promise<void> {
  assert.ok(
    postgresUrl,
    "DRFED_TEST_POSTGRES_URL must point to an isolated cluster with CREATEDB permission",
  );
  const name = `drfed_test_${randomUUID().replaceAll("-", "")}`;
  const administrator = new Client({ connectionString: postgresUrl });
  await administrator.connect();
  let observer: Client | undefined;
  try {
    await administrator.query(`CREATE DATABASE "${name}"`);
    const connection = new URL(postgresUrl);
    connection.pathname = `/${name}`;
    observer = new Client({ connectionString: connection.href });
    await observer.connect();
    await run(connection.href, observer);
  } finally {
    await observer?.end();
    // Only this helper's unique test database is affected.
    await administrator.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",
      [name],
    );
    await administrator.query(`DROP DATABASE IF EXISTS "${name}"`);
    await administrator.end();
  }
}

it("uses stable distinct signed advisory keys for exact history-table identities", () => {
  assert.deepEqual(
    migrationLockKey(),
    migrationLockKey("drizzle", "__drizzle_migrations"),
  );
  assert.notDeepEqual(
    migrationLockKey("a:b", "c"),
    migrationLockKey("a", "b:c"),
  );
  assert.notDeepEqual(
    migrationLockKey("Drizzle", "x"),
    migrationLockKey("drizzle", "x"),
  );
  for (const value of migrationLockKey()) {
    assert.ok(
      Number.isInteger(value) &&
        value >= -2_147_483_648 &&
        value <= 2_147_483_647,
    );
  }
});

it("rejects invalid deadlines and pre-aborted operations before client creation", async () => {
  let called = 0;
  const credentials = {
    clientFactory: () => {
      called += 1;
      throw new Error("must not create client");
    },
  };
  await Promise.all(
    [0, -1, NaN, Infinity, 2_147_483_648].map((lockTimeoutMs) =>
      assert.rejects(
        preparePostgresDatabase({ credentials, lockTimeoutMs }),
        failure("invalid-options"),
      ),
    ),
  );
  await assert.rejects(
    preparePostgresDatabase({
      credentials,
      signal: AbortSignal.abort("PRIVATE_REASON"),
    }),
    failure("aborted"),
  );
  assert.equal(called, 0);
});

it("omits raw migration-file and factory failures from public diagnostics", async () => {
  const secret = "postgresql://user:PRIVATE_TOKEN@private.invalid/db";
  const credentials = {
    clientFactory: () => {
      throw new Error(secret);
    },
  };
  await assert.rejects(
    preparePostgresDatabase({ credentials }),
    (error: unknown) => {
      assert.ok(error instanceof MigrationPreparationError);
      assert.equal(error.code, "connection-failed");
      assert.doesNotMatch(error.stack ?? "", /PRIVATE_TOKEN/u);
      assert.equal("cause" in error, false);
      return true;
    },
  );
  const root = await mkdtemp(join(tmpdir(), "drfed-pg-invalid-"));
  try {
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, secret);
    await assert.rejects(
      preparePostgresDatabase({ credentials, manifestPath }),
      (error: unknown) => {
        assert.ok(error instanceof MigrationPreparationError);
        assert.equal(error.code, "invalid-migration-files");
        assert.doesNotMatch(error.stack ?? "", /PRIVATE_TOKEN/u);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it(
  "settles an unresponsive handshake at the overall lock deadline",
  { timeout: 5_000 },
  async () => {
    const sockets = new Set<Socket>();
    const peer = createServer((socket) => {
      sockets.add(socket);
      socket.on("data", () => {
        /* Discard startup bytes without answering the handshake. */
      });
      socket.on("close", () => sockets.delete(socket));
    });
    peer.listen(0, "127.0.0.1");
    await once(peer, "listening");
    try {
      const address = peer.address();
      assert.ok(address && typeof address === "object");
      await assert.rejects(
        preparePostgresDatabase({
          credentials: {
            clientFactory: () =>
              new Client({
                host: "127.0.0.1",
                port: address.port,
                connectionTimeoutMillis: 0,
              }),
          },
          lockTimeoutMs: 100,
        }),
        failure("lock-timeout"),
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        peer.close(() => resolve());
      });
    }
  },
);

it("handles an abort triggered by the factory before connect without unhandled stream errors", async () => {
  const controller = new AbortController();
  await assert.rejects(
    preparePostgresDatabase({
      signal: controller.signal,
      credentials: {
        clientFactory: () => {
          const client = new Client();
          controller.abort();
          return client;
        },
      },
    }),
    failure("aborted"),
  );
  await delay(1);
});

it(
  "serializes concurrent real PostgreSQL migration and applies SQL once",
  postgres,
  async () => {
    await withDatabase(async (url, observer) => {
      await withSql(
        "CREATE TABLE migration_probe (id integer PRIMARY KEY); INSERT INTO migration_probe VALUES (1); SELECT pg_sleep(0.15);",
        async (paths) => {
          const results = await Promise.all(
            [1, 2].map(() =>
              preparePostgresDatabase({ credentials: { url }, ...paths }),
            ),
          );
          assert.deepEqual(
            results.map((result) => result.status),
            ["ready", "ready"],
          );
          assert.equal(
            (
              await observer.query(
                "SELECT count(*)::integer AS count FROM migration_probe",
              )
            ).rows[0]?.count,
            1,
          );
          assert.equal(
            (
              await observer.query(
                "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
              )
            ).rows[0]?.count,
            1,
          );
          const key = migrationLockKey();
          assert.equal(
            (
              await observer.query(
                "SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired",
                [...key],
              )
            ).rows[0]?.acquired,
            true,
          );
          await observer.query(
            "SELECT pg_advisory_unlock($1::integer,$2::integer)",
            [...key],
          );
        },
      );
    });
  },
);

it(
  "times out behind another session's lock without creating metadata",
  postgres,
  async () => {
    await withDatabase(async (url, observer) => {
      const key = migrationLockKey();
      await observer.query("SELECT pg_advisory_lock($1::integer,$2::integer)", [
        ...key,
      ]);
      await assert.rejects(
        preparePostgresDatabase({ credentials: { url }, lockTimeoutMs: 100 }),
        failure("lock-timeout"),
      );
      assert.equal(
        (await observer.query("SELECT to_regnamespace('drizzle') AS namespace"))
          .rows[0]?.namespace,
        null,
      );
      await observer.query(
        "SELECT pg_advisory_unlock($1::integer,$2::integer)",
        [...key],
      );
    });
  },
);

it(
  "aborts lock waiting without creating metadata or reconnecting",
  postgres,
  async () => {
    await withDatabase(async (url, observer) => {
      const key = migrationLockKey();
      await observer.query("SELECT pg_advisory_lock($1::integer,$2::integer)", [
        ...key,
      ]);
      let created = 0;
      const credentials = {
        clientFactory: () => {
          created += 1;
          return new Client({ connectionString: url });
        },
      };
      await assert.rejects(
        preparePostgresDatabase({
          credentials,
          signal: AbortSignal.timeout(100),
        }),
        failure("aborted"),
      );
      assert.equal(created, 1);
      assert.equal(
        (await observer.query("SELECT to_regnamespace('drizzle') AS namespace"))
          .rows[0]?.namespace,
        null,
      );
      await observer.query(
        "SELECT pg_advisory_unlock($1::integer,$2::integer)",
        [...key],
      );
    });
  },
);

it(
  "rejects changed legacy history before metadata DDL and leaves raw errors private",
  postgres,
  async () => {
    await withDatabase(async (url, observer) => {
      await observer.query(
        "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
      );
      await observer.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1,$2)",
        ["d".repeat(64), Date.UTC(2026, 5, 22, 2, 17, 48)],
      );
      await assert.rejects(
        preparePostgresDatabase({ credentials: { url } }),
        (error: unknown) =>
          error instanceof MigrationPreparationError &&
          error.code === "incompatible-history" &&
          error.state?.status === "modified",
      );
      const columns = await observer.query(
        "SELECT attname FROM pg_attribute WHERE attrelid='drizzle.__drizzle_migrations'::regclass AND attnum>0 AND NOT attisdropped",
      );
      assert.equal(columns.rows.length, 3);
    });
  },
);

it(
  "terminates a backend during migration without retrying on a new connection",
  postgres,
  async () => {
    await withDatabase(async (url, observer) => {
      await withSql(
        "CREATE TABLE migration_probe (id integer); SELECT pg_sleep(2);",
        async (paths) => {
          let count = 0;
          const credentials = {
            clientFactory: () => {
              count += 1;
              return new Client({
                connectionString: url,
                application_name: "drfed_termination_probe",
              });
            },
          };
          const result = preparePostgresDatabase({ credentials, ...paths });
          const assertion = assert.rejects(
            result,
            failure("connection-failed"),
          );
          const waiting = async (): Promise<void> => {
            const active = await observer.query(
              "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='drfed_termination_probe' AND query LIKE '%pg_sleep%' AND state='active'",
            );
            if (active.rows.length) {
              await observer.query("SELECT pg_terminate_backend($1)", [
                active.rows[0]?.pid,
              ]);
              return;
            }
            await delay(20);
            return waiting();
          };
          await waiting();
          await assertion;
          assert.equal(count, 1);
          assert.equal(
            (
              await observer.query(
                "SELECT to_regclass('public.migration_probe') AS table_name",
              )
            ).rows[0]?.table_name,
            null,
          );
        },
      );
    });
  },
);

it(
  "applies all installed SQL and closes each fresh owned client after inspection",
  postgres,
  async () => {
    await withDatabase(async (url, observer) => {
      const clients: Client[] = [];
      const credentials = {
        clientFactory: () => {
          const client = new Client({ connectionString: url });
          clients.push(client);
          return client;
        },
      };
      assert.equal(
        (await preparePostgresDatabase({ credentials })).status,
        "ready",
      );
      assert.equal(
        (await preparePostgresDatabase({ credentials })).status,
        "ready",
      );
      assert.equal(clients.length, 2);
      assert.ok(clients.every((client) => client.connection.stream.destroyed));
      const installed = await verifyMigrationManifest();
      assert.equal(
        (
          await observer.query(
            "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
          )
        ).rows[0]?.count,
        installed.migrations.length,
      );
    });
  },
);

it(
  "upgrades verified legacy metadata on real PostgreSQL and rechecks exact history",
  postgres,
  async () => {
    await withDatabase(async (url, observer) => {
      const first = (await verifyMigrationManifest()).migrations[0]!;
      const sql = await readFile(
        new URL(`../drizzle/${first.name}/migration.sql`, import.meta.url),
        "utf8",
      );
      await observer.query(sql);
      await observer.query(
        "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
      );
      await observer.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1,$2)",
        [first.sha256, Date.UTC(2026, 5, 22, 2, 17, 48) + 321],
      );
      assert.equal(
        (await preparePostgresDatabase({ credentials: { url } })).status,
        "ready",
      );
      const upgraded = await observer.query(
        "SELECT created_at, name, applied_at FROM drizzle.__drizzle_migrations WHERE id=1",
      );
      assert.equal(upgraded.rows[0]?.name, first.name);
      assert.equal(upgraded.rows[0]?.applied_at, null);
    });
  },
);

it(
  "limits connection and lock waiting without timing out SQL after acquiring the lock",
  postgres,
  async () => {
    await withDatabase(async (url) => {
      await withSql("SELECT pg_sleep(0.6);", async (paths) => {
        assert.equal(
          (
            await preparePostgresDatabase({
              credentials: { url },
              lockTimeoutMs: 300,
              ...paths,
            })
          ).status,
          "ready",
        );
      });
    });
  },
);

it(
  "aborts an active SQL transaction, eventually releases its lock and never reconnects",
  postgres,
  async () => {
    await withDatabase(async (url, observer) => {
      await withSql(
        "CREATE TABLE migration_probe (id integer); SELECT pg_sleep(0.25);",
        async (paths) => {
          let created = 0;
          const controller = new AbortController();
          const credentials = {
            clientFactory: () => {
              created += 1;
              return new Client({
                connectionString: url,
                application_name: "drfed_abort_probe",
              });
            },
          };
          const running = preparePostgresDatabase({
            credentials,
            signal: controller.signal,
            ...paths,
          });
          const started = Date.now();
          const cancel = async (): Promise<void> => {
            const active = await observer.query(
              "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='drfed_abort_probe' AND query LIKE '%pg_sleep%' AND state='active'",
            );
            if (active.rows.length) {
              controller.abort();
              return;
            }
            assert.ok(
              Date.now() - started < 5_000,
              "Migration did not become active",
            );
            await delay(10);
            return cancel();
          };
          await Promise.all([
            cancel(),
            assert.rejects(running, failure("aborted")),
          ]);
          const key = migrationLockKey();
          const waitForRelease = async (): Promise<void> => {
            const lock = await observer.query(
              "SELECT pg_try_advisory_lock($1::integer,$2::integer) AS locked",
              [...key],
            );
            if (lock.rows[0]?.locked) {
              await observer.query(
                "SELECT pg_advisory_unlock($1::integer,$2::integer)",
                [...key],
              );
              return;
            }
            assert.ok(
              Date.now() - started < 5_000,
              "Interrupted transaction retained its lock",
            );
            await delay(20);
            return waitForRelease();
          };
          await waitForRelease();
          assert.equal(created, 1);
          assert.equal(
            (
              await observer.query(
                "SELECT to_regclass('public.migration_probe') AS table_name",
              )
            ).rows[0]?.table_name,
            null,
          );
          assert.equal(
            (
              await observer.query(
                "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
              )
            ).rows[0]?.count,
            0,
          );
        },
      );
    });
  },
);

it(
  "honors read-only history permissions and refuses hidden or inaccessible rows on PostgreSQL",
  postgres,
  async () => {
    const role = `drfed_reader_${randomUUID().replaceAll("-", "")}`;
    let created = false;
    try {
      await withDatabase(async (url, observer) => {
        assert.equal(
          (await preparePostgresDatabase({ credentials: { url } })).status,
          "ready",
        );
        await observer.query(
          `CREATE ROLE "${role}" NOLOGIN; GRANT USAGE ON SCHEMA drizzle TO "${role}"; GRANT SELECT ON drizzle.__drizzle_migrations TO "${role}"`,
        );
        created = true;
        const credentials = {
          clientFactory: () =>
            new Client({
              connectionString: url,
              options: `-c role=${role} -c default_transaction_read_only=on`,
            }),
        };
        assert.equal(
          (await preparePostgresDatabase({ credentials })).status,
          "ready",
        );
        await observer.query(
          `ALTER TABLE drizzle.__drizzle_migrations ENABLE ROW LEVEL SECURITY; CREATE POLICY visible_prefix ON drizzle.__drizzle_migrations FOR SELECT TO "${role}" USING (id <= 19)`,
        );
        await assert.rejects(
          preparePostgresDatabase({ credentials }),
          (error: unknown) =>
            error instanceof MigrationPreparationError &&
            error.code === "incompatible-history" &&
            error.state?.status === "unsupported-format",
        );
        await observer.query(
          `ALTER TABLE drizzle.__drizzle_migrations DISABLE ROW LEVEL SECURITY; REVOKE SELECT ON drizzle.__drizzle_migrations FROM "${role}"`,
        );
        await assert.rejects(
          preparePostgresDatabase({ credentials }),
          failure("inspection-failed"),
        );
        assert.equal(
          (
            await observer.query(
              "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
            )
          ).rows[0]?.count,
          (await verifyMigrationManifest()).migrations.length,
        );
      });
    } finally {
      if (created) {
        const administrator = new Client({ connectionString: postgresUrl });
        await administrator.connect();
        try {
          await administrator.query(`DROP ROLE "${role}"`);
        } finally {
          await administrator.end();
        }
      }
    }
  },
);

it(
  "aborts an actual unresponsive handshake after startup bytes arrive",
  { timeout: 5_000 },
  async () => {
    const controller = new AbortController();
    const sockets = new Set<Socket>();
    const peer = createServer((socket) => {
      sockets.add(socket);
      socket.on("data", () => controller.abort());
      socket.on("close", () => sockets.delete(socket));
    });
    peer.listen(0, "127.0.0.1");
    await once(peer, "listening");
    try {
      const address = peer.address();
      assert.ok(address && typeof address === "object");
      await assert.rejects(
        preparePostgresDatabase({
          signal: controller.signal,
          lockTimeoutMs: 2_000,
          credentials: {
            clientFactory: () =>
              new Client({
                host: "127.0.0.1",
                port: address.port,
                connectionTimeoutMillis: 0,
              }),
          },
        }),
        failure("aborted"),
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        peer.close(() => resolve());
      });
    }
  },
);

it(
  "rejects SQL changed after verification before any migration DDL",
  postgres,
  async () => {
    await withDatabase(async (url, observer) => {
      await withSql(
        "CREATE TABLE approved_probe (id integer);",
        async (paths) => {
          await assert.rejects(
            preparePostgresDatabase({
              ...paths,
              credentials: {
                clientFactory: () => {
                  // Deliberately change the file between initial verification and application.
                  // oxlint-disable-next-line node/no-sync
                  writeFileSync(
                    join(
                      paths.migrationsFolder,
                      "20260101000000_session_probe",
                      "migration.sql",
                    ),
                    "CREATE TABLE unverified_probe (id integer);",
                  );
                  return new Client({ connectionString: url });
                },
              },
            }),
            failure("invalid-migration-files"),
          );
          const result = await observer.query(
            "SELECT to_regnamespace('drizzle') AS history, to_regclass('approved_probe') AS approved, to_regclass('unverified_probe') AS unverified",
          );
          assert.deepEqual(result.rows[0], {
            history: null,
            approved: null,
            unverified: null,
          });
        },
      );
    });
  },
);

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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import {
  createAccountProgram,
  describeAccountConfiguration,
  resolveAccountOptions,
} from "@drfed/drfed/commands/account-program";
import { run } from "@optique/run";

async function parse(args: string[], env: Record<string, string>, cwd: string) {
  const invocation = createAccountProgram({ env: (name) => env[name], cwd });
  const raw = await run(invocation.program, {
    args: [
      "create",
      "--email=Operator@EXAMPLE.COM",
      "--name= Operator ",
      ...args,
    ],
    contexts: invocation.contexts,
    contextOptions: { load: invocation.load },
    colors: false,
    stderr: () => undefined,
    onExit(code): never {
      throw new Error(`CLI exit ${code}`);
    },
  });
  return resolveAccountOptions(raw, cwd);
}

it("shares TOML/env/CLI database precedence while ignoring server and mail domains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-account-parser-"));
  try {
    await writeFile(
      join(directory, "drfed.toml"),
      '[server]\nroot_origin="http://127.0.0.1"\n[database]\ndriver="pglite"\ndata_path="./data"\nlock_timeout_ms=123\nmigrate=false\n[mail.smtp]\nurl="not a URL"\n',
    );
    const env = {
      DRFED_ROOT_ORIGIN: "not an origin",
      DRFED_LOGIN_ORIGINS: "invalid JSON",
      DRFED_SMTP_URL: "invalid URL",
      DRFED_LOG_LEVEL: "invalid",
    };
    const configured = await parse(["--config", "drfed.toml"], env, directory);
    assert.equal(configured.database.migrate, false);
    assert.equal(configured.email, "Operator@example.com");
    assert.equal(configured.name, "Operator");
    assert.deepEqual(configured.database, {
      driver: "pglite",
      dataPath: join(directory, "data"),
      lockTimeoutMs: 123,
      migrate: false,
    });
    const overridden = await parse(
      ["--config", "drfed.toml", "--migration-lock-timeout=789", "--migrate"],
      { ...env, DRFED_MIGRATION_LOCK_TIMEOUT: "456" },
      directory,
    );
    assert.equal(overridden.database.lockTimeoutMs, 789);
    assert.equal(overridden.database.migrate, true);
    const diagnostic = describeAccountConfiguration(overridden);
    assert.equal(
      diagnostic.settings["database.lock_timeout_ms"]?.source,
      "cli",
    );
    assert.equal(
      diagnostic.settings["database.data_path"]?.configPath,
      join(directory, "drfed.toml"),
    );
    assert.equal(
      diagnostic.settings["database.data_path"]?.value,
      join(directory, "data"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("redacts a selected PostgreSQL URL and validates only the active database", async () => {
  const options = await parse(
    [
      "--postgres-url=postgres://user:PRIVATE_PASSWORD@localhost/drfed",
      "--print-config",
    ],
    { DRFED_DATA_PATH: "" },
    process.cwd(),
  );
  assert.equal(options.database.driver, "postgres");
  assert.equal(options.printConfig, true);
  assert.doesNotMatch(
    JSON.stringify(describeAccountConfiguration(options)),
    /PRIVATE_PASSWORD/u,
  );
  assert.equal(
    describeAccountConfiguration(options).settings["database.url"]?.value,
    "<redacted>",
  );
});

it("rejects invalid active settings and conflicting migration flags", async () => {
  await assert.rejects(
    parse([], { DRFED_MIGRATION_LOCK_TIMEOUT: "bad" }, process.cwd()),
    /CLI exit 1/u,
  );
  await assert.rejects(
    parse(["--migrate", "--no-migrate"], {}, process.cwd()),
    /CLI exit 1/u,
  );
});

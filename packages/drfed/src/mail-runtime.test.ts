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

import { createMailRuntime, prepareMail } from "@drfed/drfed/mail-runtime";
import { type LogRecord, configure, reset } from "@logtape/logtape";
import { createMessage } from "@upyo/core";

it("excludes mail contents by default and includes them only with explicit opt-in", async () => {
  const records: LogRecord[] = [];
  await configure({
    sinks: {
      record: (record) => {
        records.push(record);
      },
    },
    loggers: [{ category: [], sinks: ["record"], lowestLevel: "trace" }],
  });
  const message = createMessage({
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "PRIVATE_SUBJECT",
    content: { text: "PRIVATE_LOGIN_CODE" },
  });
  try {
    const hidden = createMailRuntime({
      transport: "logtape",
      logContent: false,
    });
    const receipt = await hidden.transport.send(message);
    assert.equal(receipt.successful, true);
    assert.doesNotMatch(
      JSON.stringify(records),
      /PRIVATE_SUBJECT|PRIVATE_LOGIN_CODE/u,
    );
    assert.ok(records.some((record) => record.level === "warning"));
    await hidden.close();
    records.length = 0;
    const explicit = createMailRuntime({
      transport: "logtape",
      logContent: true,
    });
    await explicit.transport.send(message);
    assert.match(JSON.stringify(records), /PRIVATE_SUBJECT/u);
    assert.match(JSON.stringify(records), /PRIVATE_LOGIN_CODE/u);
    await explicit.close();
  } finally {
    await reset();
  }
});

it("closes an owned transport once and sanitizes disposer errors", async () => {
  const runtime = createMailRuntime({
    transport: "logtape",
    logContent: false,
  });
  let disposals = 0;
  Object.defineProperty(runtime.transport, Symbol.asyncDispose, {
    value: () => {
      disposals += 1;
      return Promise.reject(new Error("PRIVATE_TOKEN"));
    },
  });
  const first = runtime.close();
  const second = runtime.close();
  assert.equal(first, second);
  await assert.rejects(first, { message: "Mail transport cleanup failed." });
  await assert.rejects(second, { message: "Mail transport cleanup failed." });
  assert.equal(disposals, 1);
});

it("validates credential files before constructing mail resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-mail-prepare-"));
  const path = join(directory, "PRIVATE_PASSWORD_FILE");
  const settings = {
    transport: "smtp" as const,
    connection: {
      host: "localhost",
      port: 587,
      secure: false,
      requireTls: true,
    },
    authentication: {
      type: "password" as const,
      user: "operator",
      method: "plain" as const,
      secret: { type: "file" as const, path },
    },
    files: { ca: undefined, key: undefined, cert: undefined },
  };
  try {
    await assert.rejects(prepareMail(settings), {
      message: "Unable to read secret for SMTP authentication.",
    });
    await writeFile(path, "PASSWORD\r\n");
    const prepared = await prepareMail(settings);
    assert.equal(prepared.transport, "smtp");
    if (prepared.transport !== "smtp") throw new Error();
    assert.deepEqual(prepared.connection.auth, {
      user: "operator",
      pass: "PASSWORD",
      method: "plain",
    });
    await writeFile(path, "한글\n");
    await assert.rejects(prepareMail(settings), {
      message: "Invalid SMTP password authentication settings.",
    });
    await writeFile(path, "PASSWORD\n\n");
    await assert.rejects(prepareMail(settings), {
      message: "Invalid SMTP password authentication settings.",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects malformed SMTP TLS files before transport construction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-mail-tls-"));
  const path = join(directory, "PRIVATE_CA_FILE");
  try {
    await writeFile(path, "PRIVATE_INVALID_PEM");
    await assert.rejects(
      prepareMail({
        transport: "smtp",
        connection: { host: "localhost", secure: true },
        authentication: undefined,
        files: { ca: { type: "file", path }, cert: undefined, key: undefined },
      }),
      { message: "Invalid SMTP TLS settings." },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects empty client certificate and private key files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-mail-empty-tls-"));
  const path = join(directory, "PRIVATE_EMPTY_PEM");
  try {
    await writeFile(path, "");
    await assert.rejects(
      prepareMail({
        transport: "smtp",
        connection: { host: "localhost", secure: true },
        authentication: undefined,
        files: {
          ca: undefined,
          cert: { type: "file", path },
          key: { type: "file", path },
        },
      }),
      { message: "Invalid SMTP TLS settings." },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

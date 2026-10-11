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
import { createServer } from "node:net";
import { it } from "node:test";

import { resolveSmtpConnection } from "@drfed/drfed/smtp-settings";
import { SmtpTransport } from "@upyo/smtp";

it("decodes SMTP credentials and requires TLS before authentication", () => {
  const settings = resolveSmtpConnection(
    new URL("smtp://user%40example.com:p%40ss@smtp.example.com"),
  );
  assert.deepEqual(settings.auth, { user: "user@example.com", pass: "p@ss" });
  assert.equal(settings.port, 587);
  assert.equal(settings.secure, false);
  assert.equal(settings.requireTls, true);
  assert.equal(settings.tls?.rejectUnauthorized, true);
  assert.equal(settings.tls?.minVersion, "TLSv1.2");
});

it("uses implicit TLS for smtps and normalizes IPv6 for the socket", () => {
  const settings = resolveSmtpConnection(new URL("smtps://[::1]"));
  assert.equal(settings.host, "::1");
  assert.equal(settings.port, 465);
  assert.equal(settings.secure, true);
  assert.equal(settings.requireTls, false);
  assert.equal(
    resolveSmtpConnection(new URL("smtp://localhost:2525")).port,
    2525,
  );
});

it("rejects unsupported SMTP URL components without leaking credentials", () => {
  for (const value of [
    "https://user:SECRET@smtp.example.com",
    "smtp://user:SECRET@smtp.example.com/path",
    "smtp://user:SECRET@smtp.example.com?tls=false",
    "smtp://user:SECRET@smtp.example.com#fragment",
    "smtp://user:SECRET@smtp.example.com:0",
    "smtp://user:SECRET%00@smtp.example.com",
    "smtp://user:caf%C3%A9@smtp.example.com",
    "smtp://user:%ED%95%9C%EA%B8%80@smtp.example.com",
    "smtp://%C3%A9:SECRET@smtp.example.com",
    "smtp://:SECRET@smtp.example.com",
    "smtp://user:SECRET%ZZ@smtp.example.com",
  ]) {
    assert.throws(() => resolveSmtpConnection(new URL(value)), {
      message: "Invalid SMTP connection URL.",
    });
  }
});

it(
  "never sends AUTH when an SMTP server refuses mandatory STARTTLS",
  { timeout: 10_000 },
  async () => {
    const commands: string[] = [];
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.write("220 localhost ESMTP\r\n");
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        for (let end; (end = input.indexOf("\r\n")) >= 0; ) {
          const command = input.slice(0, end);
          input = input.slice(end + 2);
          commands.push(command);
          if (command.startsWith("EHLO")) {
            socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
          } else if (command === "STARTTLS") {
            socket.write("454 TLS unavailable\r\n");
          } else if (command === "QUIT") socket.end("221 bye\r\n");
          else socket.write("535 refused\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const transport = new SmtpTransport({
      ...resolveSmtpConnection(
        new URL(`smtp://operator:SECRET@127.0.0.1:${address.port}`),
      ),
      connectionTimeout: 2_000,
      socketTimeout: 2_000,
    });
    try {
      await assert.rejects(transport.verify());
      assert.ok(commands.includes("STARTTLS"));
      assert.ok(commands.every((command) => !command.startsWith("AUTH")));
    } finally {
      await transport[Symbol.asyncDispose]();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  },
);

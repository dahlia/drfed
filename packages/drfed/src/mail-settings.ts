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

import { url } from "@optique/core/valueparser";
import type { SmtpConfig } from "@upyo/smtp";

import {
  type Sourced,
  configurationBoolean,
  configurationProvenance,
  configurationSettings,
} from "./configuration.ts";
import { type JmapSettings, resolveJmapSettings } from "./jmap-settings.ts";
import type { RawMailOptions } from "./mail-parser.ts";
import { type SecretSource, resolveSecretSource } from "./secret-source.ts";
import { resolveSmtpConnection } from "./smtp-settings.ts";

/** SMTP authentication selected before credential files are read. */
export type MailAuthentication =
  | {
      readonly type: "password";
      readonly user: string;
      readonly secret: SecretSource;
      readonly method: "plain" | "login";
    }
  | {
      readonly type: "oauth2";
      readonly user: string;
      readonly secret: SecretSource;
      readonly method: "xoauth2" | "oauthbearer";
    };

/** Listener-independent mail configuration; secret files remain unopened. */
export type MailSettings =
  | JmapSettings
  | { readonly transport: "logtape"; readonly logContent: boolean }
  | {
      readonly transport: "smtp";
      readonly connection: Omit<SmtpConfig, "auth" | "tls">;
      readonly authentication: MailAuthentication | undefined;
      readonly files: {
        readonly ca: SecretSource | undefined;
        readonly cert: SecretSource | undefined;
        readonly key: SecretSource | undefined;
      };
    };

type Input = Sourced<string | undefined> | undefined;
const priority = { default: 0, config: 1, env: 2, cli: 3 } as const;
const rank = (value: Sourced<unknown> | undefined) =>
  value?.value === undefined ? -1 : priority[value.source];

function selectTransport(raw: RawMailOptions) {
  const highest = Math.max(
    rank(raw.mailTransport),
    rank(raw.smtpUrl),
    rank(raw.smtpHost),
    rank(raw.jmapSessionUrl),
  );
  const explicit =
    rank(raw.mailTransport) === highest ? raw.mailTransport?.value : undefined;
  const smtp = rank(raw.smtpUrl) === highest || rank(raw.smtpHost) === highest;
  const jmap = rank(raw.jmapSessionUrl) === highest && highest >= 0;
  const transport =
    explicit ?? (jmap ? "jmap" : smtp && highest >= 0 ? "smtp" : "logtape");
  if (transport !== "smtp" && transport !== "logtape" && transport !== "jmap") {
    throw new Error(
      "Unsupported mail transport; expected logtape, smtp or jmap.",
    );
  }
  if (
    (smtp && highest >= 0 && transport !== "smtp") ||
    (jmap && transport !== "jmap")
  ) {
    throw new Error("Mail selectors at the same source disagree.");
  }
  const selector = [
    raw.mailTransport,
    raw.smtpUrl,
    raw.smtpHost,
    raw.jmapSessionUrl,
  ].find((value) => rank(value) === highest && value?.value !== undefined);
  return { transport, selector };
}

function component(explicit: Input, inherited: Input, field: string): Input {
  if (rank(explicit) === rank(inherited) && rank(explicit) >= 0) {
    throw new Error(`Duplicate SMTP setting for ${field} at the same source.`);
  }
  return rank(explicit) > rank(inherited) ? explicit : inherited;
}

function boundedNumber(
  value: Input,
  fallback: number,
  maximum: number,
  field: string,
) {
  if (value?.value === undefined) return fallback;
  const number = Number(value.value);
  if (
    !/^\d+$/u.test(value.value) ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > maximum
  ) {
    throw new Error(`Invalid SMTP setting for ${field}.`);
  }
  return number;
}

function extractUriPort(value: string) {
  // WHATWG URL parsing enforces the TCP port range too early for overrides.
  // Preserve an RFC URI decimal port and parse the remaining URL normally.
  const envelope =
    /^(?<scheme>smtps?:\/\/)(?<authority>[^/?#]*)(?<tail>.*)$/iu.exec(
      value,
    )?.groups;
  if (envelope === undefined) throw new Error("Invalid SMTP connection URL.");
  const { scheme = "", authority = "", tail = "" } = envelope;
  const portComponent = /:(?<port>\d*)$/u.exec(authority);
  const port = portComponent?.groups?.port;
  const withoutPort =
    portComponent === null
      ? authority
      : authority.slice(0, -portComponent[0].length);
  return { url: `${scheme}${withoutPort}${tail}`, port };
}

function urlComponents(raw: RawMailOptions): {
  host?: Input;
  port?: Input;
  tls?: Input;
  user?: Input;
  password?: Input;
} {
  const source = raw.smtpUrl;
  if (source?.value === undefined) return {};
  const extracted = extractUriPort(source.value);
  const rawPort = extracted.port;
  const parsed = url({ allowedProtocols: ["smtp:", "smtps:"] }).parse(
    extracted.url,
  );
  if (!parsed.success) throw new Error("Invalid SMTP connection URL.");
  const original = parsed.value;
  if (
    !/^smtps?:\/\//u.test(original.href) ||
    original.port !== "" ||
    (original.pathname !== "" && original.pathname !== "/") ||
    original.search !== "" ||
    original.hash !== ""
  ) {
    throw new Error("Invalid SMTP connection URL.");
  }
  const secure = original.protocol === "smtps:";
  const inherit = (value: string): Sourced<string> => ({ ...source, value });
  return {
    host: inherit(original.hostname),
    port: inherit(
      rawPort === undefined || rawPort === ""
        ? secure
          ? "465"
          : "587"
        : rawPort,
    ),
    tls: inherit(secure ? "direct" : "opportunistic"),
    ...(original.username === "" ? {} : { user: inherit(original.username) }),
    ...(original.password === ""
      ? {}
      : { password: inherit(original.password) }),
  };
}

function decodedComponent(
  explicit: Input,
  inherited: Input,
  field: string,
): Input {
  const selected = component(explicit, inherited, field);
  if (
    selected === undefined ||
    selected !== inherited ||
    selected.value === undefined
  ) {
    return selected;
  }
  try {
    return { ...selected, value: decodeURIComponent(selected.value) };
  } catch {
    throw new Error(`Invalid SMTP setting for ${field}.`);
  }
}

/** Validate the password API's currently supported encoding without secret errors. */
export function validateSmtpPassword(user: string, password: string) {
  if (
    user === "" ||
    /[^\x20-\x7e]/u.test(user) ||
    /[^\x20-\x7e]/u.test(password)
  ) {
    throw new Error("Invalid SMTP password authentication settings.");
  }
}

/** Validate static OAuth authentication without exposing tokens in errors. */
export function validateSmtpOAuth(user: string, token: string) {
  if (
    user === "" ||
    token === "" ||
    /[^\x21-\x7e]/u.test(token) ||
    /\p{Cc}/u.test(user)
  ) {
    throw new Error("Invalid SMTP OAuth authentication settings.");
  }
}

function authenticationMethod(
  input: Input,
  passwordSelected: boolean,
  selectedRank: number,
) {
  let method = input?.value;
  const methods = passwordSelected
    ? ["plain", "login"]
    : ["xoauth2", "oauthbearer"];
  if (
    method !== undefined &&
    !methods.includes(method) &&
    ["plain", "login", "xoauth2", "oauthbearer"].includes(method) &&
    rank(input) < selectedRank
  ) {
    method = undefined;
  }
  if (method !== undefined && !methods.includes(method)) {
    throw new Error("Invalid SMTP authentication method.");
  }
  return {
    value: method ?? (passwordSelected ? "plain" : "xoauth2"),
    source:
      method === undefined
        ? ("default" as const)
        : (input?.source ?? ("default" as const)),
    ...(method === undefined || input?.configPath === undefined
      ? {}
      : { configPath: input.configPath }),
  };
}

function authenticationSources(
  raw: RawMailOptions,
  user: Input,
  password: Input,
  passwordSelected: boolean,
) {
  const literalPassword =
    passwordSelected && rank(password) > rank(raw.smtpPasswordFile);
  const literalToken =
    !passwordSelected &&
    rank(raw.smtpAccessToken) > rank(raw.smtpAccessTokenFile);
  return {
    smtpUser: user,
    smtpPassword: literalPassword ? password : undefined,
    smtpPasswordFile:
      passwordSelected && !literalPassword ? raw.smtpPasswordFile : undefined,
    smtpAccessToken: literalToken ? raw.smtpAccessToken : undefined,
    smtpAccessTokenFile:
      !passwordSelected && !literalToken ? raw.smtpAccessTokenFile : undefined,
  };
}

function validateLiteralCredential(
  passwordSelected: boolean,
  user: string,
  secret: SecretSource,
) {
  if (secret.type !== "literal") return;
  if (passwordSelected) validateSmtpPassword(user, secret.value);
  else validateSmtpOAuth(user, secret.value);
}

function authentication(
  raw: RawMailOptions,
  inherited: ReturnType<typeof urlComponents>,
  cwd: string,
) {
  const user = decodedComponent(raw.smtpUser, inherited.user, "user");
  let password: Input;
  const passwordRank = Math.max(
    rank(raw.smtpPassword),
    rank(inherited.password),
    rank(raw.smtpPasswordFile),
  );
  const tokenRank = Math.max(
    rank(raw.smtpAccessToken),
    rank(raw.smtpAccessTokenFile),
  );
  if (passwordRank < 0 && tokenRank < 0) {
    if (user?.value !== undefined || raw.smtpAuthMethod?.value !== undefined) {
      throw new Error(
        "SMTP authentication requires a password or access token.",
      );
    }
    return { auth: undefined, sources: { smtpUser: user } };
  }
  if (passwordRank === tokenRank) {
    throw new Error(
      "SMTP authentication variants at the same source disagree.",
    );
  }
  if (user?.value === undefined || user.value === "") {
    throw new Error("SMTP authentication requires a username.");
  }
  const passwordSelected = passwordRank > tokenRank;
  if (
    passwordSelected &&
    rank(raw.smtpPasswordFile) <=
      Math.max(rank(raw.smtpPassword), rank(inherited.password))
  ) {
    password = component(raw.smtpPassword, inherited.password, "password");
  }
  if (passwordSelected && rank(password) >= rank(raw.smtpPasswordFile)) {
    password = decodedComponent(
      raw.smtpPassword,
      inherited.password,
      "password",
    );
  }
  const secret = passwordSelected
    ? resolveSecretSource(password, raw.smtpPasswordFile, "SMTP password", cwd)
    : resolveSecretSource(
        raw.smtpAccessToken,
        raw.smtpAccessTokenFile,
        "SMTP access token",
        cwd,
      );
  if (secret === undefined) throw new Error("Missing SMTP credential.");
  const method = authenticationMethod(
    raw.smtpAuthMethod,
    passwordSelected,
    Math.max(passwordRank, tokenRank),
  );
  validateLiteralCredential(passwordSelected, user.value, secret);
  const auth: MailAuthentication = passwordSelected
    ? {
        type: "password",
        user: user.value,
        secret,
        method: method.value as "plain" | "login",
      }
    : {
        type: "oauth2",
        user: user.value,
        secret,
        method: method.value as "xoauth2" | "oauthbearer",
      };
  return {
    auth,
    sources: {
      ...authenticationSources(raw, user, password, passwordSelected),
      smtpAuthMethod: method,
    },
  };
}

function tlsMode(
  tls: Input,
  explicit: Input,
  auth: MailAuthentication | undefined,
) {
  let mode = tls?.value ?? "starttls-required";
  if (!["direct", "starttls-required", "opportunistic"].includes(mode)) {
    throw new Error("Invalid SMTP TLS mode.");
  }
  if (auth !== undefined && mode === "opportunistic") {
    if (tls === explicit && explicit?.value !== undefined) {
      throw new Error(
        "SMTP authentication requires direct TLS or mandatory STARTTLS.",
      );
    }
    mode = "starttls-required";
  }
  return mode;
}

function smtpSettings(raw: RawMailOptions, cwd: string) {
  const inherited = urlComponents(raw);
  const host = component(raw.smtpHost, inherited.host, "host");
  const port = component(raw.smtpPort, inherited.port, "port");
  const tls = component(raw.smtpTls, inherited.tls, "tls");
  if (host?.value === undefined || host.value === "") {
    throw new Error("SMTP transport requires a host or SMTP URL.");
  }
  const selected = authentication(raw, inherited, cwd);
  const mode = tlsMode(tls, raw.smtpTls, selected.auth);
  let normalized: SmtpConfig;
  try {
    const authority =
      host.value.includes(":") && !host.value.startsWith("[")
        ? `[${host.value}]`
        : host.value;
    normalized = resolveSmtpConnection(
      new URL(
        `${mode === "direct" ? "smtps" : "smtp"}://${authority}:${boundedNumber(port, mode === "direct" ? 465 : 587, 65535, "port")}`,
      ),
    );
  } catch {
    throw new Error("Invalid SMTP host or port.");
  }
  if (
    raw.smtpLocalName?.value !== undefined &&
    !/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])$/u.test(raw.smtpLocalName.value)
  ) {
    throw new Error("Invalid SMTP local name.");
  }
  const cert = resolveSecretSource(
    undefined,
    raw.smtpCertFile,
    "SMTP client certificate",
    cwd,
  );
  const key = resolveSecretSource(
    undefined,
    raw.smtpKeyFile,
    "SMTP client key",
    cwd,
  );
  if ((cert === undefined) !== (key === undefined)) {
    throw new Error(
      "SMTP client certificate and key must be configured together.",
    );
  }
  const mail: MailSettings = {
    transport: "smtp",
    connection: {
      host: normalized.host,
      port: normalized.port ?? (mode === "direct" ? 465 : 587),
      secure: mode === "direct",
      requireTls: mode === "starttls-required",
      connectionTimeout: boundedNumber(
        raw.smtpConnectionTimeout,
        30_000,
        2_147_483_647,
        "connection timeout",
      ),
      socketTimeout: boundedNumber(
        raw.smtpSocketTimeout,
        30_000,
        2_147_483_647,
        "socket timeout",
      ),
      poolSize: boundedNumber(raw.smtpPoolSize, 5, 2_147_483_647, "pool size"),
      ...(raw.smtpLocalName?.value === undefined
        ? {}
        : { localName: raw.smtpLocalName.value }),
    },
    authentication: selected.auth,
    files: {
      ca: resolveSecretSource(
        undefined,
        raw.smtpCaFile,
        "SMTP certificate authorities",
        cwd,
      ),
      cert,
      key,
    },
  };
  return {
    mail,
    mode,
    sources: {
      ...raw,
      smtpHost: host,
      smtpPort: port,
      smtpTls: tls,
      ...selected.sources,
    },
  };
}

function logContent(raw: RawMailOptions) {
  const parsed = configurationBoolean().parse(
    raw.mailLogContent?.value ?? "false",
  );
  if (!parsed.success) throw new Error("Invalid mail.log_content setting.");
  return parsed.value;
}

function diagnosticValues(
  mail: MailSettings,
  smtp: ReturnType<typeof smtpSettings> | undefined,
  jmap: ReturnType<typeof resolveJmapSettings> | undefined,
) {
  const values: Record<string, unknown> = { mailTransport: mail.transport };
  if (mail.transport === "logtape") values.mailLogContent = mail.logContent;
  else if (mail.transport === "jmap") Object.assign(values, jmap?.values);
  else {
    Object.assign(values, {
      smtpHost: mail.connection.host,
      smtpPort: mail.connection.port,
      smtpTls: smtp?.mode,
      smtpConnectionTimeout: mail.connection.connectionTimeout,
      smtpSocketTimeout: mail.connection.socketTimeout,
      smtpPoolSize: mail.connection.poolSize,
      smtpLocalName: mail.connection.localName,
      smtpAuthMethod: mail.authentication?.method,
    });
  }
  if (mail.transport !== "logtape") {
    for (const [key, value] of Object.entries(
      mail.transport === "smtp" ? (smtp?.sources ?? {}) : (jmap?.sources ?? {}),
    )) {
      if (
        key.startsWith(mail.transport) &&
        value?.value !== undefined &&
        configurationSettings[key as keyof typeof configurationSettings].secret
      ) {
        values[key] = "<redacted>";
      }
    }
  }
  return values;
}

function ignoredMailField(
  key: string,
  provider: MailSettings["transport"],
  sources: Record<string, Input>,
) {
  if (key === "mailLogContent") return provider !== "logtape";
  const branch = key.startsWith("smtp")
    ? "smtp"
    : key.startsWith("jmap")
      ? "jmap"
      : undefined;
  if (branch === undefined) return false;
  if (branch !== provider) return true;
  if (key === "smtpAuthMethod" && sources[key]?.source === "default") {
    return true;
  }
  return key in sources && sources[key]?.value === undefined;
}

/** Resolve provider selection and safe diagnostics without reading credentials.
 * @returns Runtime settings, redacted diagnostics and ignored branch metadata.
 */
export function resolveMailSettings(raw: RawMailOptions, cwd = process.cwd()) {
  const selection = selectTransport(raw);
  const smtp =
    selection.transport === "smtp" ? smtpSettings(raw, cwd) : undefined;
  const jmap =
    selection.transport === "jmap" ? resolveJmapSettings(raw, cwd) : undefined;
  const mail: MailSettings = jmap?.mail ??
    smtp?.mail ?? {
      transport: "logtape",
      logContent: logContent(raw),
    };
  const provenance = configurationProvenance({
    ...raw,
    ...smtp?.sources,
    ...jmap?.sources,
    mailTransport: selection.selector,
  });
  const values = diagnosticValues(mail, smtp, jmap);
  const activeSources: Record<string, Input> =
    mail.transport === "smtp" ? (smtp?.sources ?? {}) : (jmap?.sources ?? {});
  const ignored = Object.entries(raw)
    .filter(
      ([key, value]) =>
        value?.value !== undefined &&
        value.source !== "default" &&
        ignoredMailField(key, mail.transport, activeSources),
    )
    .map(([key, value]) => ({
      field:
        configurationSettings[key as keyof typeof configurationSettings].toml,
      source: value?.source ?? "default",
    }));
  const diagnostic = Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        configurationSettings[key as keyof typeof configurationSettings].toml,
        { value, ...(provenance[key] ?? { source: "default" as const }) },
      ]),
  );
  return { mail, diagnostic, ignored, provenance };
}

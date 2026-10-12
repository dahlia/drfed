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
// oxlint-disable no-console no-await-in-loop no-magic-numbers node/no-top-level-await
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packageOrder = ["models", "federation", "graphql", "web", "drfed"];
const repository = "fedify-dev/drfed";
const workflow = ".github/workflows/main.yaml";
const cliArgs = process.argv.slice(2);
const command = cliArgs.shift();
function option(name: string, fallback: string): string {
  const index = cliArgs.indexOf(name);
  if (index < 0) return fallback;
  const value = cliArgs[index + 1];
  assert.ok(value && !value.startsWith("--"), `Missing ${name}`);
  return value;
}
const root = resolve(
  option("--root", fileURLToPath(new URL("../", import.meta.url))),
);
const artifacts = resolve(
  option("--artifacts", join(root, "release-artifacts")),
);
const fixture = cliArgs.includes("--fixture");
const githubApi = option("--github-api", "https://api.github.com/");
if (fixture) {
  const endpoint = new URL(githubApi);
  assert.ok(
    githubApi === "https://api.github.com/" ||
      (endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1"),
  );
} else assert.equal(githubApi, "https://api.github.com/");
const registry = option("--registry", "https://registry.npmjs.org/");
if (fixture) {
  const url = new URL(registry);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
} else assert.equal(registry, "https://registry.npmjs.org/");

interface Version {
  enabled: boolean;
  version: string;
  fullVersion: string;
  baseVersion: string;
  channel: string;
  sha: string;
  runNumber: string;
  runId: string;
  ref: string;
  workflow: string;
}
interface PackageManifest {
  name: string;
  version: string;
  repository?: { type: string; url: string; directory: string };
  publishConfig?: { access: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  main?: string;
  types?: string;
  exports?: unknown;
  bin?: Record<string, string>;
  drfedBuild?: Version;
}
interface Artifact {
  name: string;
  filename: string;
  integrity: string;
}
interface Bundle {
  build: Version;
  packages: Artifact[];
  notesIntegrity?: string;
  completions?: Artifact[];
}
interface RegistryVersion extends PackageManifest {
  dist: { integrity: string };
}
const semver =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
function parseVersion(value: string): RegExpExecArray {
  const match = semver.exec(value);
  assert.ok(match, `Unsupported version: ${value}`);
  assert.ok(value.length <= 256, "Version exceeds npm SemVer length");
  for (const component of match.slice(1, 4)) {
    assert.ok(
      BigInt(component!) <= BigInt(Number.MAX_SAFE_INTEGER),
      "Version component exceeds npm SemVer range",
    );
  }
  return match;
}
function compare(left: string, right: string): number {
  const lhs = parseVersion(left);
  const rhs = parseVersion(right);
  for (let index = 1; index <= 3; index += 1) {
    const difference = BigInt(lhs[index]!) - BigInt(rhs[index]!);
    if (difference) return difference > 0 ? 1 : -1;
  }
  if (!lhs[4] || !rhs[4]) return lhs[4] ? -1 : rhs[4] ? 1 : 0;
  const identifiers = lhs[4].split(".");
  const others = rhs[4].split(".");
  for (
    let index = 0;
    index < Math.max(identifiers.length, others.length);
    index += 1
  ) {
    const item = identifiers[index];
    const other = others[index];
    if (item === other) continue;
    if (item == null) return -1;
    if (other == null) return 1;
    const numeric = /^\d+$/u.test(item);
    const otherNumeric = /^\d+$/u.test(other);
    if (numeric && otherNumeric) return BigInt(item) > BigInt(other) ? 1 : -1;
    if (numeric !== otherNumeric) return numeric ? -1 : 1;
    return item > other ? 1 : -1;
  }
  return 0;
}
async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
async function run(binary: string, args: string[], cwd = root) {
  return await execute(binary, args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}
function digest(bytes: Uint8Array, algorithm = "sha512"): string {
  return `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
}
async function calculate(): Promise<Version> {
  const manifests = await Promise.all(
    packageOrder.map((name) =>
      json<PackageManifest>(join(root, "packages", name, "package.json")),
    ),
  );
  const baseVersion = manifests[0]!.version;
  parseVersion(baseVersion);
  for (const [index, manifest] of manifests.entries()) {
    assert.equal(manifest.name, `@drfed/${packageOrder[index]}`);
    assert.equal(
      manifest.version,
      baseVersion,
      "Mismatched checked-in package versions",
    );
  }
  const event = process.env.GITHUB_EVENT_PATH
    ? await json<{ deleted?: boolean }>(process.env.GITHUB_EVENT_PATH)
    : {};
  const ref = process.env.GITHUB_REF ?? "";
  const enabled =
    process.env.GITHUB_EVENT_NAME === "push" &&
    process.env.GITHUB_REPOSITORY === repository &&
    !event.deleted &&
    (ref === "refs/heads/main" || ref.startsWith("refs/tags/"));
  const sha = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  assert.match(sha, /^[a-f0-9]{40}$/u);
  if (enabled) {
    assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/u);
    assert.equal(
      (
        await run("git", ["rev-parse", `${process.env.GITHUB_SHA}^{commit}`])
      ).stdout.trim(),
      sha,
    );
  }
  const runNumber = process.env.GITHUB_RUN_NUMBER ?? "0";
  const runId = process.env.GITHUB_RUN_ID ?? "0";
  let version = baseVersion;
  let fullVersion = version;
  let channel = "";
  if (enabled) {
    assert.match(runNumber, /^[1-9]\d*$/u);
    assert.match(runId, /^[1-9]\d*$/u);
    if (ref === "refs/heads/main") {
      assert.ok(
        !parseVersion(baseVersion)[4],
        "Main development base must be stable SemVer",
      );
      version = `${baseVersion}-dev.${runNumber}`;
      fullVersion = `${version}+${sha.slice(0, 8)}`;
      channel = "dev";
    } else {
      version = ref.slice("refs/tags/".length);
      parseVersion(version);
      assert.equal(
        version,
        baseVersion,
        "Tag must match every checked-in package version",
      );
      fullVersion = version;
      channel = parseVersion(version)[4] ? "next" : "latest";
    }
  }
  return {
    enabled,
    version,
    fullVersion,
    baseVersion,
    channel,
    sha,
    runNumber,
    runId,
    ref,
    workflow,
  };
}
function buildFromEnvironment(): Version {
  const build = JSON.parse(
    process.env.DRFED_RELEASE_BUILD ?? "null",
  ) as Version | null;
  assert.ok(build?.enabled, "Missing authorized version job output");
  parseVersion(build.version);
  assert.match(build.sha, /^[a-f0-9]{40}$/u);
  assert.equal(build.ref, process.env.GITHUB_REF);
  assert.equal(build.workflow, workflow);
  assert.equal(process.env.GITHUB_EVENT_NAME, "push");
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(build.runNumber, process.env.GITHUB_RUN_NUMBER);
  assert.equal(build.runId, process.env.GITHUB_RUN_ID);
  return build;
}
async function apply(): Promise<void> {
  const build = buildFromEnvironment();
  assert.deepEqual(build, await calculate());
  for (const name of packageOrder) {
    const path = join(root, "packages", name, "package.json");
    const manifest = await json<PackageManifest>(path);
    manifest.version = build.version;
    manifest.drfedBuild = build;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
function checkManifest(
  manifest: PackageManifest,
  name: string,
  build: Version,
  files: Set<string>,
): void {
  assert.equal(manifest.name, `@drfed/${name}`);
  assert.equal(manifest.version, build.version);
  assert.deepEqual(manifest.drfedBuild, build);
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "https://github.com/fedify-dev/drfed.git",
    directory: `packages/${name}`,
  });
  assert.equal(manifest.publishConfig?.access, "public");
  for (const dependencies of [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ]) {
    for (const [dependency, version] of Object.entries(dependencies ?? {})) {
      assert.ok(
        !/^(?:workspace:|catalog:|file:|link:|\.|\/)/u.test(version),
        `${dependency}: ${version}`,
      );
      if (dependency.startsWith("@drfed/")) {
        assert.equal(version, build.version);
      }
    }
  }
  function target(value: unknown): void {
    if (typeof value === "string") {
      assert.ok(
        files.has(`package/${value.replace(/^\.\//u, "")}`),
        `Missing entry point ${value}`,
      );
    } else if (value != null && typeof value === "object") {
      Object.values(value).forEach(target);
    }
  }
  target(manifest.main);
  target(manifest.types);
  target(manifest.exports);
  target(manifest.bin);
  if (name === "models") {
    assert.ok(files.has("package/dist/migrations-manifest.json"));
    assert.ok([...files].some((path) => path.endsWith("/migration.sql")));
  }
  if (name === "web") assert.ok(files.has("package/.output/server/index.mjs"));
  if (name === "drfed") {
    for (const commandName of ["server", "web", "migrate", "account"]) {
      assert.ok(files.has(`package/bin/drfed-${commandName}.mjs`));
    }
  }
}
function completionFiles(): { path: string; filename: string }[] {
  return ["server", "web", "migrate", "account"].flatMap((commandName) => {
    const binary = `drfed-${commandName}`;
    return ["bash", "zsh", "fish", "pwsh", "nu"].map((shell) => {
      const name =
        shell === "zsh"
          ? `_${binary}`
          : shell === "fish"
            ? `${binary}.fish`
            : shell === "pwsh"
              ? `${binary}.ps1`
              : shell === "nu"
                ? `${binary}.nu`
                : binary;
      return {
        path: `package/completions/${shell}/${name}`,
        filename: `${binary}.${shell}`,
      };
    });
  });
}
async function completionBytes(archive: string, path: string): Promise<Buffer> {
  // Completion scripts are UTF-8 text; extracting from the verified package
  // makes release assets independent of mutable build output on disk.
  const bytes = Buffer.from((await run("tar", ["-xOf", archive, path])).stdout);
  assert.ok(bytes.length > 0, `Empty completion script: ${path}`);
  return bytes;
}
async function inspect(
  archive: string,
  name: string,
  build: Version,
): Promise<void> {
  const manifest = JSON.parse(
    (await run("tar", ["-xOf", archive, "package/package.json"])).stdout,
  ) as PackageManifest;
  const files = new Set(
    (await run("tar", ["-tzf", archive])).stdout.trim().split("\n"),
  );
  checkManifest(manifest, name, build, files);
}
async function pack(): Promise<void> {
  const build = buildFromEnvironment();
  await mkdir(artifacts, { recursive: true });
  const entries: Artifact[] = [];
  for (const name of packageOrder) {
    const result = JSON.parse(
      (
        await run(
          "pnpm",
          ["pack", "--json", "--pack-destination", artifacts],
          join(root, "packages", name),
        )
      ).stdout,
    ) as { filename: string };
    const filename = basename(result.filename);
    const archive = join(artifacts, filename);
    await inspect(archive, name, build);
    entries.push({
      name: `@drfed/${name}`,
      filename,
      integrity: digest(await readFile(archive)),
    });
  }
  const bundle: Bundle = { build, packages: entries };
  if (build.channel !== "dev") {
    const notes = join(artifacts, "release-notes.md");
    await run("sacho", [
      "show",
      build.version,
      "--skip-heading",
      "--no-word-wrap",
      "--output-file",
      notes,
    ]);
    assert.ok(
      (await readFile(notes, "utf8")).trim(),
      "Missing frozen release notes",
    );
    bundle.notesIntegrity = digest(await readFile(notes));
    bundle.completions = [];
    const archive = join(artifacts, entries.at(-1)!.filename);
    for (const { path, filename } of completionFiles()) {
      const bytes = await completionBytes(archive, path);
      await writeFile(join(artifacts, filename), bytes);
      bundle.completions.push({
        name: filename,
        filename,
        integrity: digest(bytes),
      });
    }
  }
  await writeFile(
    join(artifacts, "manifest.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
}
async function verify(): Promise<Bundle> {
  const bundle = await json<Bundle>(join(artifacts, "manifest.json"));
  const expected = buildFromEnvironment();
  assert.deepEqual(bundle.build, expected);
  assert.equal(
    (await run("git", ["rev-parse", "HEAD"])).stdout.trim(),
    expected.sha,
  );
  assert.equal(bundle.packages.length, packageOrder.length);
  for (const [index, entry] of bundle.packages.entries()) {
    const name = packageOrder[index]!;
    assert.equal(entry.name, `@drfed/${name}`);
    assert.equal(entry.filename, `drfed-${name}-${expected.version}.tgz`);
    assert.equal(
      entry.integrity,
      digest(await readFile(join(artifacts, entry.filename))),
    );
    await inspect(join(artifacts, entry.filename), name, expected);
  }
  if (expected.channel !== "dev") {
    assert.equal(
      bundle.notesIntegrity,
      digest(await readFile(join(artifacts, "release-notes.md"))),
    );
    assert.equal(bundle.completions?.length, completionFiles().length);
    const archive = join(artifacts, bundle.packages.at(-1)!.filename);
    for (const [index, { path, filename }] of completionFiles().entries()) {
      const entry: Artifact = bundle.completions![index]!;
      assert.equal(entry.name, filename);
      assert.equal(entry.filename, filename);
      const bytes = await readFile(join(artifacts, filename));
      assert.equal(entry.integrity, digest(bytes));
      assert.deepEqual(bytes, await completionBytes(archive, path));
    }
    const frozen = (
      await run("sacho", [
        "show",
        expected.version,
        "--skip-heading",
        "--no-word-wrap",
      ])
    ).stdout;
    assert.equal(
      await readFile(join(artifacts, "release-notes.md"), "utf8"),
      frozen,
    );
  } else {
    assert.equal(bundle.notesIntegrity, undefined);
    assert.equal(bundle.completions, undefined);
  }
  return bundle;
}
async function get<T>(url: string, github = false): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: github
          ? {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`,
            }
          : {},
      });
    } catch (error) {
      if (attempt === 2) throw error;
      await delay(fixture ? 1 : 1000 * (attempt + 1));
      continue;
    }
    if (response.status === 404) return null;
    if (response.ok) return (await response.json()) as T;
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      await delay(fixture ? 1 : 1000 * (attempt + 1));
      continue;
    }
    throw new Error(`GET ${url}: HTTP ${response.status}`);
  }
  throw new Error("Unreachable request state");
}
async function ensureUnpublished(): Promise<void> {
  const build = buildFromEnvironment();
  assert.deepEqual(build, await calculate());
  for (const name of packageOrder) {
    const existing = await get<RegistryVersion>(
      new URL(
        `${encodeURIComponent(`@drfed/${name}`)}/${build.version}`,
        registry,
      ).href,
    );
    assert.equal(
      existing,
      null,
      "Original artifact missing for a published version; do not rebuild it",
    );
  }
}
async function published(entry: Artifact, build: Version): Promise<boolean> {
  const document = await get<RegistryVersion>(
    new URL(`${encodeURIComponent(entry.name)}/${build.version}`, registry)
      .href,
  );
  if (!document) return false;
  assert.equal(document.name, entry.name);
  assert.equal(document.version, build.version);
  assert.equal(
    document.dist.integrity,
    entry.integrity,
    `Immutable version conflict for ${entry.name}`,
  );
  assert.deepEqual(
    document.drfedBuild,
    build,
    `Build provenance conflict for ${entry.name}`,
  );
  return true;
}
async function tagTarget(build: Version): Promise<void> {
  if (build.channel === "dev") return;
  const tag = build.ref.slice("refs/tags/".length);
  assert.equal(tag, build.version);
  const remote = fixture
    ? option("--remote", "")
    : `https://github.com/${repository}.git`;
  assert.ok(remote);
  const result = (
    await run("git", [
      "ls-remote",
      "--tags",
      remote,
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ])
  ).stdout
    .trim()
    .split("\n");
  const peeled =
    result.find((line) => line.endsWith(`refs/tags/${tag}^{}`)) ??
    result.find((line) => line.endsWith(`refs/tags/${tag}`));
  assert.equal(
    peeled?.split(/\s+/u)[0],
    build.sha,
    "Remote tag was deleted or retargeted",
  );
}
async function waitForPublication(
  entry: Artifact,
  build: Version,
): Promise<void> {
  // Registry reads can lag a successful upload. Keep this budget separate
  // from upload retries so an acknowledged version is never uploaded again.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await published(entry, build)) return;
    if (attempt < 29) await delay(fixture ? 1 : 5000);
  }
  throw new Error(
    `npm accepted ${entry.name}@${build.version}, but registry metadata did not become visible; rerun with the original verified artifacts`,
  );
}
async function publishOne(
  entry: Artifact,
  build: Version,
  staging: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await published(entry, build)) return;
    await tagTarget(build);
    try {
      await run("npm", [
        "publish",
        join(artifacts, entry.filename),
        "--registry",
        registry,
        "--access",
        "public",
        "--tag",
        staging,
        "--ignore-scripts",
        ...(fixture ? [] : ["--provenance"]),
      ]);
    } catch (error) {
      if (await published(entry, build)) return;
      const message = String(error);
      if (
        attempt === 2 ||
        !/(?:E429|E5\d\d|ETIMEDOUT|ECONNRESET|EAI_AGAIN)/u.test(message)
      ) {
        throw error;
      }
      await delay(fixture ? 1 : 2000);
      continue;
    }
    console.log(
      `npm accepted ${entry.name}@${build.version}; verifying registry visibility`,
    );
    await waitForPublication(entry, build);
    return;
  }
  throw new Error(`Incomplete publication: ${entry.name}`);
}
async function newerChannelVersion(
  entry: Artifact,
  currentVersion: string,
  build: Version,
): Promise<boolean> {
  if (build.channel !== "dev") {
    return compare(build.version, currentVersion) < 0;
  }
  const current = await get<RegistryVersion>(
    new URL(`${encodeURIComponent(entry.name)}/${currentVersion}`, registry)
      .href,
  );
  assert.ok(current, `Missing current dev metadata for ${entry.name}`);
  assert.equal(current.name, entry.name);
  assert.equal(current.version, currentVersion);
  // A manually seeded dev.0 has no CI run identity. Only accept this exact
  // same-base bootstrap; every CI dev run has a positive run number.
  if (
    current.drfedBuild === undefined &&
    currentVersion === `${build.baseVersion}-dev.0`
  ) {
    return false;
  }
  assert.equal(
    current.drfedBuild?.workflow,
    workflow,
    "Cannot order a foreign dev build",
  );
  const runNumber = current.drfedBuild?.runNumber;
  assert.equal(typeof runNumber, "string");
  assert.match(runNumber!, /^[1-9]\d*$/u);
  return BigInt(runNumber!) > BigInt(build.runNumber);
}
async function waitForChannel(entry: Artifact, build: Version): Promise<void> {
  const url = new URL(
    `-/package/${encodeURIComponent(entry.name)}/dist-tags`,
    registry,
  ).href;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await get<Record<string, string>>(url);
    if (current?.[build.channel] === build.version) return;
    if (attempt < 29) await delay(fixture ? 1 : 5000);
  }
  throw new Error(
    `Registry did not confirm ${entry.name} ${build.channel} tag at ${build.version}; rerun with the original verified artifacts`,
  );
}
async function publish(): Promise<void> {
  const bundle = await verify();
  const { build } = bundle;
  if (!fixture) {
    assert.deepEqual(build, await calculate());
    assert.equal((await run("npm", ["--version"])).stdout.trim(), "12.2.0");
  }
  const staging = build.channel === "dev" ? "dev-staging" : "release-staging";
  await tagTarget(build);
  // Preflight the complete set so an existing conflict cannot cause new uploads.
  for (const entry of bundle.packages) await published(entry, build);
  for (const entry of bundle.packages) {
    await publishOne(entry, build, staging);
  }
  // All members exist before any shared tag is advanced. The workflow serializes
  // this entire operation; comparison also protects against late older builds.
  const tags: Record<string, string>[] = [];
  let newerExists = false;
  for (const entry of bundle.packages) {
    const current = await get<Record<string, string>>(
      new URL(`-/package/${encodeURIComponent(entry.name)}/dist-tags`, registry)
        .href,
    );
    assert.ok(current, `Missing tags for ${entry.name}`);
    tags.push(current);
    if (
      current[build.channel] &&
      (await newerChannelVersion(entry, current[build.channel]!, build))
    ) {
      newerExists = true;
    }
  }
  if (!newerExists) {
    for (const [index, entry] of bundle.packages.entries()) {
      if (tags[index]![build.channel] !== build.version) {
        await tagTarget(build);
        await run("npm", [
          "dist-tag",
          "add",
          `${entry.name}@${build.version}`,
          build.channel,
          "--registry",
          registry,
        ]);
      }
      await waitForChannel(entry, build);
    }
  } else {
    console.log(
      "Newer channel version already exists; preserving shared dist-tags.",
    );
  }
  for (const [index, entry] of bundle.packages.entries()) {
    if (tags[index]![staging]) {
      await run("npm", [
        "dist-tag",
        "rm",
        entry.name,
        staging,
        "--registry",
        registry,
      ]);
    }
  }
  console.log(
    `Confirmed complete package set: ${build.fullVersion} (${build.sha})`,
  );
}
interface Release {
  tag_name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; digest?: string; size: number; state: string }[];
}
async function uploadAsset(
  entry: Artifact,
  existing: Release,
  build: Version,
): Promise<void> {
  const bytes = await readFile(join(artifacts, entry.filename));
  const expectedDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const asset: Release["assets"][number] | undefined = existing.assets.find(
    (item) => item.name === entry.filename,
  );
  if (asset?.state === "uploaded") {
    assert.equal(
      asset.digest,
      expectedDigest,
      `Release asset conflict: ${asset.name}`,
    );
    assert.equal(asset.size, bytes.length);
  } else {
    if (asset) {
      // GitHub documents empty starter assets left by failed uploads as safe
      // to delete. Never clobber completed, active, or unknown-state assets.
      assert.equal(asset.state, "starter", "Unknown or active asset state");
      assert.equal(asset.size, 0);
      assert.equal(asset.digest ?? null, null);
    }
    await tagTarget(build);
    await run("gh", [
      "release",
      "upload",
      build.version,
      join(artifacts, entry.filename),
      ...(asset ? ["--clobber"] : []),
      "--repo",
      repository,
    ]);
  }
}
async function release(): Promise<void> {
  const bundle = await verify();
  const { build } = bundle;
  assert.ok(build.channel === "latest" || build.channel === "next");
  assert.deepEqual(build, await calculate());
  for (const entry of bundle.packages) assert.ok(await published(entry, build));
  await tagTarget(build);
  const notes = await readFile(join(artifacts, "release-notes.md"), "utf8");
  const url = new URL(
    `repos/${repository}/releases/tags/${build.version}`,
    githubApi,
  ).href;
  let existing = await get<Release>(url, true);
  if (!existing) {
    const currentTags = await get<Record<string, string>>(
      new URL(
        `-/package/${encodeURIComponent("@drfed/drfed")}/dist-tags`,
        registry,
      ).href,
    );
    assert.ok(currentTags);
    const latest =
      build.channel === "latest" && currentTags.latest === build.version;
    try {
      await run("gh", [
        "release",
        "create",
        build.version,
        "--repo",
        repository,
        "--verify-tag",
        `--latest=${latest}`,
        "--target",
        build.sha,
        "--title",
        build.version,
        "--notes-file",
        join(artifacts, "release-notes.md"),
        ...(build.channel === "next" ? ["--prerelease"] : []),
      ]);
    } catch (error) {
      existing = await get<Release>(url, true);
      if (!existing) throw error;
    }
    existing ??= await get<Release>(url, true);
  }
  assert.ok(existing);
  assert.equal(existing.tag_name, build.version);
  assert.equal(existing.body.trim(), notes.trim());
  assert.equal(existing.draft, false);
  assert.equal(existing.prerelease, build.channel === "next");
  for (const entry of [...bundle.packages, ...bundle.completions!]) {
    await uploadAsset(entry, existing, build);
  }
}
if (command === "version") {
  const build = await calculate();
  console.log(JSON.stringify(build));
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `enabled=${build.enabled}\nbuild=${JSON.stringify(build)}\n`,
    );
  }
} else if (command === "apply") await apply();
else if (command === "ensure-unpublished") await ensureUnpublished();
else if (command === "tag-target") await tagTarget(buildFromEnvironment());
else if (command === "pack") await pack();
else if (command === "verify") {
  await verify();
  console.log("Verified release artifact identities and contents");
} else if (command === "publish") await publish();
else if (command === "github-release") await release();
else if (command === "compare") {
  console.log(compare(cliArgs[0]!, cliArgs[1]!));
} else {
  throw new Error(
    "Expected version, apply, pack, verify, publish, github-release or compare",
  );
}

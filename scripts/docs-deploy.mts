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
// oxlint-disable no-console node/no-top-level-await

// Verifies a built documentation directory and deploys it to Cloudflare
// Pages with the wrangler that the docs:deploy mise task provides.  The
// deployment target comes from the environment and is validated here, and
// wrangler is spawned without a shell, so no value is ever interpolated into
// a command line.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { previewUrl } from "./docs-preview.mts";

/**
 * The directory wrangler runs in.  `wrangler pages deploy` uploads the
 * *functions/* directory of its working directory as code, so this is also
 * where {@link verifyDist} looks for one.
 */
export const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/** Entries of a Pages output directory that Cloudflare would run as code. */
export const codeEntries = ["_worker.js", "_routes.json", "functions"] as const;

/** The URLs that `wrangler pages deploy` reported for one deployment. */
export interface PagesDeployment {
  /** The URL of this deployment alone. */
  readonly deploymentUrl: string;
  /** The `*.pages.dev` alias of the branch, if Cloudflare reported one. */
  readonly aliasUrl: string | null;
}

async function exists(path: string): Promise<boolean> {
  try {
    // A dangling symbolic link still counts as present, hence lstat().
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Refuses a documentation build that is not plain static files: anything
 * that Cloudflare Pages would execute, a *functions/* directory where wrangler
 * runs, or a build without an *index.html*.
 * @param dir The built documentation directory.
 * @param wranglerCwd The directory wrangler will run in.
 */
export async function verifyDist(
  dir: string,
  wranglerCwd: string = repositoryRoot,
): Promise<void> {
  const stats = await lstat(dir).catch(() => null);
  assert.ok(stats?.isDirectory(), `${dir} is not a directory`);
  const present = await Promise.all(
    codeEntries.map((name) => exists(join(dir, name))),
  );
  codeEntries.forEach((name, index) =>
    assert.ok(
      !present[index],
      `${name} must not be in the documentation build`,
    ),
  );
  assert.ok(
    !(await exists(join(wranglerCwd, "functions"))),
    `functions/ must not exist where wrangler runs (${wranglerCwd})`,
  );
  const index = await lstat(join(dir, "index.html")).catch(() => null);
  assert.ok(
    index?.isFile(),
    "index.html is missing from the documentation build",
  );
}

/**
 * Accepts only the branches this repository deploys: `main` for the canary
 * site and `pr-<number>` for pull request previews.
 * @returns The branch, unchanged.
 */
export function deployBranch(value: string | undefined): string {
  assert.ok(
    value != null && /^(?:main|pr-[1-9]\d*)$/u.test(value),
    "DOCS_BRANCH must be main or pr-<number>",
  );
  return value;
}

/**
 * Accepts only a full lowercase commit SHA.
 * @returns The SHA, unchanged.
 */
export function deployCommit(value: string | undefined): string {
  assert.ok(
    value != null && /^[0-9a-f]{40}$/u.test(value),
    "DOCS_COMMIT must be a full commit SHA",
  );
  return value;
}

/**
 * Accepts only a valid Cloudflare Pages project name.
 * @returns The name, unchanged.
 */
export function projectName(value: string | undefined): string {
  assert.ok(
    value != null && /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/u.test(value),
    "CLOUDFLARE_PROJECT_NAME must be a Cloudflare Pages project name",
  );
  return value;
}

/**
 * Builds the wrangler arguments.  The commit message is left out on purpose:
 * for a pull request preview it is chosen by the pull request author.
 * @returns The arguments that follow the `wrangler` command.
 */
export function wranglerArguments(
  dir: string,
  project: string,
  branch: string,
  commit: string,
): readonly string[] {
  return [
    "pages",
    "deploy",
    dir,
    `--project-name=${project}`,
    `--branch=${branch}`,
    `--commit-hash=${commit}`,
  ];
}

/**
 * Reads the deployment URLs from the ND-JSON file that wrangler writes to
 * `WRANGLER_OUTPUT_FILE_PATH`, as `cloudflare/wrangler-action` does: the
 * first `pages-deploy-detailed` entry of version 1 wins, and lines that are
 * not JSON or describe something else are skipped.  Only `https:` URLs are
 * accepted.
 * @returns The deployment and alias URLs.
 * @throws {Error} When no entry reports an `https:` deployment URL.
 */
export function parseDeployOutput(text: string): PagesDeployment {
  for (const line of text.split(/\r?\n/u)) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry == null) continue;
    const { type, version, url, alias } = entry as Record<string, unknown>;
    if (type !== "pages-deploy-detailed" || version !== 1) continue;
    const deploymentUrl = previewUrl(typeof url === "string" ? url : "");
    assert.ok(
      deploymentUrl != null,
      "wrangler reported no https: deployment URL",
    );
    return {
      deploymentUrl,
      aliasUrl: previewUrl(typeof alias === "string" ? alias : ""),
    };
  }
  throw new Error("wrangler wrote no pages-deploy-detailed entry");
}

function environment(name: string): string {
  const value = process.env[name];
  assert.ok(value != null && value !== "", `${name} is required`);
  return value;
}

async function output(name: string, value: string): Promise<void> {
  console.log(`${name}=${value}`);
  const file = process.env.GITHUB_OUTPUT;
  if (file) await appendFile(file, `${name}=${value}\n`);
}

async function verify(): Promise<void> {
  await verifyDist(resolve(environment("usage_dir")));
}

async function deploy(): Promise<void> {
  const dir = resolve(environment("usage_dir"));
  const project = projectName(process.env.CLOUDFLARE_PROJECT_NAME);
  const branch = deployBranch(process.env.DOCS_BRANCH);
  const commit = deployCommit(process.env.DOCS_COMMIT);
  environment("CLOUDFLARE_API_TOKEN");
  environment("CLOUDFLARE_ACCOUNT_ID");
  await verifyDist(dir);
  const outputDir = await mkdtemp(join(tmpdir(), "drfed-docs-deploy-"));
  try {
    const outputFile = join(outputDir, "wrangler-output.json");
    // GitHub tokens are never handed to wrangler, and a directory inherited
    // from the environment cannot redirect where its output is read from.
    const {
      GH_TOKEN: _ghToken,
      GITHUB_TOKEN: _githubToken,
      WRANGLER_OUTPUT_FILE_DIRECTORY: _outputDirectory,
      ...inherited
    } = process.env;
    const child = spawn(
      "wrangler",
      wranglerArguments(dir, project, branch, commit),
      {
        cwd: repositoryRoot,
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          ...inherited,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_OUTPUT_FILE_PATH: outputFile,
        },
      },
    );
    const [code, signal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    assert.ok(
      code === 0,
      `wrangler pages deploy failed (${signal ?? `exit code ${code}`})`,
    );
    const { deploymentUrl, aliasUrl } = parseDeployOutput(
      await readFile(outputFile, "utf8"),
    );
    await output("deployment-url", deploymentUrl);
    await output("alias-url", aliasUrl ?? "");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

const commands: Readonly<Record<string, () => Promise<void>>> = {
  verify,
  deploy,
};

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  const handler = command == null ? undefined : commands[command];
  if (handler == null) {
    throw new Error(`Expected one of: ${Object.keys(commands).join(", ")}`);
  }
  try {
    await handler();
  } catch (error) {
    // A refusal is reported as one line rather than as a stack trace.
    if (!(error instanceof assert.AssertionError)) throw error;
    console.error(`docs-deploy: ${error.message}`);
    process.exitCode = 1;
  }
}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Build identification shown in Settings: the app version and the short Git
 * commit of the code being built. Only these two values are ever embedded —
 * no other environment variables, paths, names or credentials.
 *
 * - Version: the root package.json (the single source of truth).
 * - Commit: the CI-provided SHA (GitHub Actions `GITHUB_SHA`, Cloudflare
 *   Workers Builds `WORKERS_CI_COMMIT_SHA`, Cloudflare Pages
 *   `CF_PAGES_COMMIT_SHA`), otherwise `git rev-parse HEAD` in a checkout.
 *   Anything that is not a hex SHA is ignored; without one, only the version
 *   is shown.
 */
export interface BuildInfo {
  version: string;
  commit: string;
}

const ROOT = path.resolve(__dirname, '..', '..');
const COMMIT_VARS = ['GITHUB_SHA', 'WORKERS_CI_COMMIT_SHA', 'CF_PAGES_COMMIT_SHA'] as const;

export function shortCommit(value: string | undefined | null): string {
  const v = (value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(v) ? v.slice(0, 7) : '';
}

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString();
  } catch {
    return '';
  }
}

export function readBuildInfo(env: Record<string, string | undefined> = process.env, git: () => string = gitCommit): BuildInfo {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: unknown };
  const version = typeof pkg.version === 'string' && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(pkg.version) ? pkg.version : '0.0.0';
  let commit = '';
  for (const name of COMMIT_VARS) {
    commit = shortCommit(env[name]);
    if (commit) break;
  }
  if (!commit) commit = shortCommit(git());
  return { version, commit };
}

/** Compile-time constants for Vite / Vitest `define`. */
export function buildDefines(info: BuildInfo = readBuildInfo()): Record<string, string> {
  return { __APP_VERSION__: JSON.stringify(info.version), __APP_COMMIT__: JSON.stringify(info.commit) };
}

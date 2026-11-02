// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { buildDefines, readBuildInfo, shortCommit } from '../build-info';

const root = join(__dirname, '..', '..', '..');
const rootVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
const SHA = '0123456789abcdef0123456789abcdef01234567';

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('build information (injected at build time)', () => {
  it('takes the version from the root package.json', () => {
    expect(rootVersion).toBe('0.1.0');
    expect(readBuildInfo({}, () => '').version).toBe(rootVersion);
  });

  it('uses the CI commit: GitHub Actions, Cloudflare Workers Builds or Pages, then git', () => {
    expect(readBuildInfo({ GITHUB_SHA: SHA }, () => 'ffffffffff').commit).toBe('0123456');
    expect(readBuildInfo({ WORKERS_CI_COMMIT_SHA: 'ABCDEF1234567' }, () => '').commit).toBe('abcdef1');
    expect(readBuildInfo({ CF_PAGES_COMMIT_SHA: 'abcdef1234' }, () => '').commit).toBe('abcdef1');
    expect(readBuildInfo({}, () => `${SHA}\n`).commit).toBe('0123456');
  });

  it('shows the version alone when Git metadata is missing or not a commit hash', () => {
    expect(readBuildInfo({}, () => '').commit).toBe('');
    expect(readBuildInfo({ GITHUB_SHA: 'main' }, () => 'fatal: not a git repository').commit).toBe('');
    expect(shortCommit('$(whoami)')).toBe('');
    expect(shortCommit('abc')).toBe('');
  });

  it('embeds only the version and commit values', () => {
    const defines = buildDefines({ version: '0.1.0', commit: 'abcdef1' });
    expect(defines).toEqual({ __APP_VERSION__: '"0.1.0"', __APP_COMMIT__: '"abcdef1"' });
  });
});

async function renderSettings() {
  // Fresh module graph so the stubbed build constants are read again (provider and dialog from the same graph).
  const { SettingsDialog } = await import('../src/components/Dialogs');
  const { I18nProvider } = await import('../src/lib/i18n');
  render(
    <I18nProvider>
      <SettingsDialog onClose={() => {}} />
    </I18nProvider>,
  );
  return screen.getByTestId('build-info');
}

describe('Settings shows the deployed build', () => {
  it('version and short commit', async () => {
    vi.stubGlobal('__APP_VERSION__', '0.1.0');
    vi.stubGlobal('__APP_COMMIT__', 'abcdef1');
    const line = await renderSettings();
    expect(line.textContent).toBe('FeltCircle v0.1.0 · Build abcdef1');
  });

  it('version alone without Git metadata', async () => {
    vi.stubGlobal('__APP_VERSION__', '0.1.0');
    vi.stubGlobal('__APP_COMMIT__', '');
    const line = await renderSettings();
    expect(line.textContent).toBe('FeltCircle v0.1.0');
  });
});

describe('versions stay in sync with the root package.json', () => {
  it('workspaces, internal dependencies and the lockfile', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    expect(lock.version).toBe(rootVersion);
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key !== '' && !/^(apps|packages)\/[^/]+$/.test(key)) continue; // workspaces only, not their node_modules
      const pkg = JSON.parse(readFileSync(join(root, key, 'package.json'), 'utf8')) as { version: string; dependencies?: Record<string, string> };
      expect(pkg.version, key).toBe(rootVersion);
      expect(entry.version, key).toBe(rootVersion);
      for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) if (dep.startsWith('@feltcircle/')) expect(range, `${key} → ${dep}`).toBe(rootVersion);
    }
  });
});

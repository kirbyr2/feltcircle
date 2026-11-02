import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildDefines } from './build-info';

/**
 * Emits `sw.js` with a precache list of every built file, so Local Mode works
 * fully offline after the first visit. No external PWA tooling required.
 */
function serviceWorker(): Plugin {
  return {
    name: 'feltcircle-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const publicDir = path.resolve(__dirname, 'public');
      const publicFiles: string[] = [];
      const walk = (dir: string, prefix = '') => {
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          if (fs.statSync(full).isDirectory()) walk(full, `${prefix}${f}/`);
          else publicFiles.push(`${prefix}${f}`);
        }
      };
      if (fs.existsSync(publicDir)) walk(publicDir);
      const files = [...Object.keys(bundle), ...publicFiles.filter((f) => f !== 'config.json' && f !== '.nojekyll')]
        .filter((f) => !f.endsWith('.map'))
        .sort();
      const hash = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      const template = fs.readFileSync(path.resolve(__dirname, 'src/sw-template.js'), 'utf8');
      const source = template.replace('__PRECACHE__', JSON.stringify(['./', ...files])).replace('__VERSION__', hash);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

/**
 * Copies index.html to 404.html. Static hosts such as GitHub Pages serve it for
 * unknown paths, so invitation links (`/join/CODE`) work without rewrite rules.
 */
function notFoundPage(): Plugin {
  let outDir = 'dist';
  return {
    name: 'feltcircle-404',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const index = path.join(outDir, 'index.html');
      if (fs.existsSync(index)) fs.copyFileSync(index, path.join(outDir, '404.html'));
    },
  };
}

export default defineConfig({
  // Relative base: the same build works at a domain root or under a sub-path (GitHub Pages).
  base: './',
  plugins: [react(), serviceWorker(), notFoundPage()],
  // App version (root package.json) and the commit being built, shown in Settings.
  define: buildDefines(),
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  server: {
    host: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', ws: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});

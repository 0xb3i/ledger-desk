import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

// Keep the installed application independent of this checkout and node_modules.
await build({
  configFile: false,
  root: projectRoot,
  publicDir: false,
  ssr: { target: 'node', noExternal: true },
  build: {
    ssr: resolve(projectRoot, 'src/local/server.ts'),
    outDir: resolve(projectRoot, 'dist-local'),
    emptyOutDir: true,
    target: 'node24',
    sourcemap: false,
    minify: false,
    rollupOptions: {
      external: [...new Set([...builtinModules, ...builtinModules.map(name => name.startsWith('node:') ? name : `node:${name}`)])],
      output: { entryFileNames: 'server.mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
    },
  },
});

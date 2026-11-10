import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * T16 D4: KTX2Loader fetches basis_transcoder.js/.wasm from a directory at runtime. Serve that directory
 * at /three-basis/ straight from the installed three (dev) and emit the same two files into the build,
 * so the transcoder always matches the three version that decodes with it.
 */
function threeBasis(): Plugin {
  const dir = path.join(path.dirname(createRequire(import.meta.url).resolve('three')), '../examples/jsm/libs/basis');
  const files = { 'basis_transcoder.js': 'text/javascript', 'basis_transcoder.wasm': 'application/wasm' } as const;
  return {
    name: 'three-basis',
    configureServer(server) {
      server.middlewares.use('/three-basis', (req, res, next) => {
        const name = (req.url ?? '').replace(/^\/+|\?.*$/g, '') as keyof typeof files;
        if (!Object.hasOwn(files, name)) return next();
        res.setHeader('Content-Type', files[name]);
        res.end(readFileSync(path.join(dir, name)));
      });
    },
    generateBundle() {
      for (const name of Object.keys(files)) this.emitFile({ type: 'asset', fileName: `three-basis/${name}`, source: readFileSync(path.join(dir, name)) });
    },
  };
}

export default defineConfig({
  plugins: [threeBasis()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
  },
});

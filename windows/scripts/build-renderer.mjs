// Bundles the app window into dist/ (one script, the stylesheet, the page and the icon).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/renderer/main.js')],
  bundle: true,
  format: 'iife',
  target: 'chrome130',
  outfile: path.join(dist, 'renderer.js'),
  sourcemap: 'linked',
  logLevel: 'warning',
  loader: { '.bin': 'binary', '.jpg': 'dataurl', '.png': 'dataurl' },
});

for (const f of ['index.html', 'styles.css']) fs.copyFileSync(path.join(root, 'src/renderer', f), path.join(dist, f));
fs.copyFileSync(path.join(root, 'build/icon.png'), path.join(dist, 'icon.png'));
console.log('Built dist/');

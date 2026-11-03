import { build } from 'esbuild';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const hash = createHash('sha256');
for (const name of (await fs.readdir('plugins/copilot-provider/src')).sort()) {
  if (name.endsWith('.mjs')) hash.update(name).update((await fs.readFile(`plugins/copilot-provider/src/${name}`, 'utf8')).replace(/\r\n/g, '\n'));
}
hash.update((await fs.readFile('package-lock.json', 'utf8')).replace(/\r\n/g, '\n'));
const buildId = hash.digest('hex').slice(0, 20);
await fs.mkdir('plugins/copilot-provider/dist', { recursive: true });
await build({ entryPoints: ['plugins/copilot-provider/src/cli.mjs'], outfile: 'plugins/copilot-provider/dist/cli.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'eof', define: { __COPILOT_BUILD_ID__: JSON.stringify(buildId) } });

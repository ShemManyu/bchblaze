import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const output = resolve('data/swapcircle-azure.zip');
mkdirSync(resolve('data'), { recursive: true });
const directory = mkdtempSync(resolve('data/azure-package-'));
try {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  delete manifest.devDependencies;
  manifest.scripts = {
    start: 'NODE_ENV=production node dist/server/server/index.js',
  };
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  delete lock.packages[''].devDependencies;
  writeFileSync(
    resolve(directory, 'package.json'),
    JSON.stringify(manifest, null, 2),
  );
  writeFileSync(
    resolve(directory, 'package-lock.json'),
    JSON.stringify(lock, null, 2),
  );
  cpSync(resolve('dist'), resolve(directory, 'dist'), { recursive: true });
  rmSync(output, { force: true });
  const result = spawnSync(
    'zip',
    ['-qr', output, 'package.json', 'package-lock.json', 'dist'],
    {
      cwd: directory,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0)
    throw new Error(
      result.error?.message ?? result.stderr ?? 'Azure packaging failed.',
    );
  console.info(`Azure runtime package: ${output}`);
  console.info(
    'Contains the built app and production dependency manifests only. No seeds, environment files, test wallets, or demo controls.',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

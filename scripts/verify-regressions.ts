import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const mutations = [
  {
    name: 'missing SIGHASH_UTXOS enforcement',
    file: 'src/shared/transactions.ts',
    pattern: /script\[signatureLength\] === 0x61/,
    testFile: 'tests/transactions.test.ts',
    testName: 'rejects otherwise-valid signatures without SIGHASH_UTXOS',
  },
  {
    name: 'fabricated received NFT category',
    file: 'src/shared/transactions.ts',
    pattern:
      /participant\.receiveAsset\.category\s*===\s*participants\[\(index \+ 1\) % 3\]!\.sendAsset\.category/,
    testFile: 'tests/transactions.test.ts',
    testName:
      'does not let fabricated receive metadata disguise a different NFT',
  },
  {
    name: 'same wallet occupying two participant roles',
    file: 'src/shared/cycles.ts',
    pattern: /a\.receiveAddress === c\.receiveAddress/,
    replacement: 'false',
    testFile: 'tests/cycles.test.ts',
    testName: 'does not match the same receiving wallet as two participants',
  },
];

function run(testFile: string, testName: string) {
  return spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', testFile, '-t', testName],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

for (const mutation of mutations) {
  const path = resolve(mutation.file);
  const original = readFileSync(path, 'utf8');
  const matches = original.match(new RegExp(mutation.pattern.source, 'g'));
  if (matches?.length !== 1) {
    throw new Error(`Expected one exact mutation anchor: ${mutation.name}`);
  }
  const baseline = run(mutation.testFile, mutation.testName);
  if (baseline.status !== 0 || !/Tests\s+1 passed/.test(baseline.stdout)) {
    throw new Error(`Baseline test did not run and pass: ${mutation.name}`);
  }
  try {
    writeFileSync(
      path,
      original.replace(mutation.pattern, mutation.replacement ?? 'true'),
    );
    const result = run(mutation.testFile, mutation.testName);
    if (result.status === 0 || !/Tests\s+1 failed/.test(result.stdout)) {
      console.error(result.stdout, result.stderr);
      throw new Error(`Regression test missed the bug: ${mutation.name}`);
    }
    console.info(`CAUGHT: ${mutation.name}`);
  } finally {
    writeFileSync(path, original);
  }
}

console.info('All 3 mutations were caught; source files restored.');

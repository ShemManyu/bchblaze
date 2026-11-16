import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

interface Mutation {
  name: string;
  file: string;
  pattern: RegExp;
  testFile: string;
  testName: string;
  replacement?: string;
  anchorCount?: number;
  testCount?: number;
}

const mutations: Mutation[] = [
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
  {
    name: 'unverified source transaction identity',
    file: 'src/server/chain.ts',
    pattern: /transactionId\(hex\) !== txid/,
    replacement: 'false',
    testFile: 'tests/chain.test.ts',
    testName:
      'rejects a node returning a different raw transaction under the requested ID',
  },
  {
    name: 'invented source output values',
    file: 'src/server/chain.ts',
    pattern: /!sameOutput\(source,\s*utxoOutput\((?:actual|expected)\)\)/,
    replacement: 'false',
    anchorCount: 2,
    testFile: 'tests/chain.test.ts',
    testName:
      'rejects invented UTXO values even if an indexer reports them as unspent',
  },
  {
    name: 'resurrecting cancelled preparation',
    file: 'src/server/store.ts',
    pattern:
      /circle\.status !== 'preparing'\s*\|\|\s*circle\.expiresAt <= this\.now\(\)/,
    replacement: 'false',
    testFile: 'tests/coordinator.test.ts',
    testName:
      'cannot resurrect a room cancelled during asynchronous preparation',
  },
  {
    name: 'recording an expired approval',
    file: 'src/server/store.ts',
    pattern:
      /circle\.status !== 'awaiting_signatures'\s*\|\|\s*circle\.expiresAt <= this\.now\(\)/,
    replacement: 'false',
    testFile: 'tests/coordinator.test.ts',
    testName:
      'does not record an approval arriving after the coordination window',
  },
  {
    name: 'untyped external wallet rejection',
    file: 'src/web/wallet.ts',
    pattern:
      /catch \{\s*signal\?\.throwIfAborted\(\);\s*throw new DomainError\(\s*'WALLET_REJECTED',[\s\S]*?\n {2}\}/,
    replacement: 'catch (error) { throw error; }',
    testFile: 'tests/wizardconnect.test.ts',
    testName: 'signs distinct HD inputs in three external wallet managers',
  },
  {
    name: 'stale broadcast results replacing newer confirmations',
    file: 'src/server/store.ts',
    pattern:
      /expectedVersion !== undefined\s*&&\s*circle\.version !== expectedVersion/,
    replacement: 'false',
    anchorCount: 2,
    testCount: 2,
    testFile: 'tests/coordinator.test.ts',
    testName: 'does not let a late broadcast result erase a newer confirmation',
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
  if (matches?.length !== (mutation.anchorCount ?? 1)) {
    throw new Error(`Expected exact mutation anchors: ${mutation.name}`);
  }
  const baseline = run(mutation.testFile, mutation.testName);
  const count = mutation.testCount ?? 1;
  if (
    baseline.status !== 0 ||
    !new RegExp(`Tests\\s+${count} passed`).test(baseline.stdout)
  ) {
    throw new Error(`Baseline test did not run and pass: ${mutation.name}`);
  }
  try {
    writeFileSync(
      path,
      original.replace(
        new RegExp(mutation.pattern.source, 'g'),
        mutation.replacement ?? 'true',
      ),
    );
    const result = run(mutation.testFile, mutation.testName);
    if (
      result.status === 0 ||
      !new RegExp(`Tests\\s+${count} failed`).test(result.stdout)
    ) {
      console.error(result.stdout, result.stderr);
      throw new Error(`Regression test missed the bug: ${mutation.name}`);
    }
    console.info(`CAUGHT: ${mutation.name}`);
  } finally {
    writeFileSync(path, original);
  }
}

console.info(
  `All ${mutations.length} mutations were caught; source files restored.`,
);

import { readFile } from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type {
  Circle,
  NftAsset,
  WalletUtxo,
  WantedAsset,
} from '../src/shared/types.js';
import { decodeTransaction, transactionId } from '../src/shared/bitcoin.js';

interface DemoState {
  actors: {
    label: string;
    receiveAddress: string;
    asset: NftAsset;
    wanted: WantedAsset;
  }[];
  utxos: WalletUtxo[];
  broadcasts: string[];
  requests: { inputPaths: [number, string, number][]; broadcast: boolean }[][];
  encryptedEvents: number;
}

async function state(page: Page) {
  return (await (await page.request.get('/__demo/state')).json()) as DemoState;
}
async function refreshMarket(page: Page) {
  const response = page.waitForResponse(
    (response) =>
      response.url().includes('/api/market?') && response.status() === 200,
  );
  await page
    .getByRole('button', { name: 'Refresh market', exact: true })
    .click();
  await response;
}
async function pair(page: Page, index: number) {
  await page
    .getByRole('button', { name: 'Connect wallet', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Your keys stay with you.' });
  const uri = dialog.getByLabel('Wallet pairing URI');
  await expect(uri).not.toHaveValue('');
  const response = await page.request.post('/__demo/pair', {
    data: { actor: index, uri: await uri.inputValue() },
  });
  expect(response.status()).toBe(202);
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText('Scanning...', { exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Make an offer', exact: true }),
  ).toBeEnabled();
}
async function publish(page: Page, index: number, actors: DemoState['actors']) {
  await page
    .getByRole('button', { name: 'Make an offer', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Start with what you have.',
  });
  await dialog.getByLabel('Collector name').fill(actors[index]!.label);
  await expect(
    dialog.getByRole('button', {
      name: `Offer NFT ${actors[index]!.asset.category}`,
      exact: true,
    }),
  ).toHaveAttribute('aria-pressed', 'true');
  await dialog
    .getByLabel('Wanted category', { exact: true })
    .fill(actors[index]!.wanted.category);
  await dialog.getByLabel('Commitment (hex)').fill('01');
  await dialog.getByRole('button', { name: 'Publish offer' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('tab', { name: 'My offers 1' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
}
async function openRoom(page: Page, id: string) {
  await page.goto(`/?circle=${id}&network=chipnet`);
  const dialog = page.getByRole('dialog', {
    name: 'Your circle is taking shape.',
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('presents the product accessibly on mobile and requires explicit Mainnet consent', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Good trades come full circle.' }),
  ).toBeVisible();
  await expect(
    page.getByText('LOCAL DEMO LEDGER', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Every circle begins with one wish.', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('link', { name: 'The pitch' }).click();
  const pitch = page.getByRole('dialog', { name: 'The SwapCircle pitch' });
  await expect(
    pitch.getByRole('heading', { name: 'Some trades need a third person.' }),
  ).toBeVisible();
  for (let index = 0; index < 4; index += 1)
    await pitch.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(
    pitch.getByRole('heading', {
      name: 'Start with a community. Measure circles closed.',
    }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pitch).not.toBeVisible();
  await page
    .getByRole('combobox', { name: 'BCH network' })
    .selectOption('mainnet');
  const consent = page.getByRole('dialog', {
    name: 'This is real-value territory.',
  });
  await expect(
    consent.getByRole('button', { name: 'Use Mainnet' }),
  ).toBeDisabled();
  await consent.getByRole('checkbox').check();
  await consent.getByRole('button', { name: 'Use Mainnet' }).click();
  await expect(page.getByRole('combobox', { name: 'BCH network' })).toHaveValue(
    'mainnet',
  );
  await expect(
    page.getByText('Mainnet uses real BCH and CashTokens.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'BCH network' })
    .selectOption('chipnet');
  await expect(page.getByRole('combobox', { name: 'BCH network' })).toHaveValue(
    'chipnet',
  );
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('does not save an original offer when the coordinator changes the requested trade', async ({
  page,
}) => {
  await page.goto('/');
  await pair(page, 0);
  const actors = (await state(page)).actors;
  let createdId = '';
  await page.route('**/api/offers', async (route) => {
    const response = await route.fetch();
    const offer = await response.json();
    createdId = offer.id;
    await route.fulfill({
      response,
      json: {
        ...offer,
        wanted: { ...offer.wanted, category: 'ff'.repeat(32) },
      },
    });
  });
  try {
    await page
      .getByRole('button', { name: 'Make an offer', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Start with what you have.',
    });
    await dialog.getByLabel('Collector name').fill('Alice');
    await dialog
      .getByLabel('Wanted category', { exact: true })
      .fill(actors[0]!.wanted.category);
    await dialog.getByLabel('Commitment (hex)').fill('01');
    await dialog.getByRole('button', { name: 'Publish offer' }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      'The coordinator returned an altered offer.',
    );
    expect(
      await page.evaluate(() =>
        localStorage.getItem('swapcircle-original-offers-v1'),
      ),
    ).toBeNull();
    expect((await state(page)).requests.flat()).toHaveLength(0);
  } finally {
    await page.unroute('**/api/offers');
    if (createdId)
      expect(
        (
          await page.request.delete(`/api/offers/${createdId}`, { data: {} })
        ).status(),
      ).toBe(204);
  }
});

test('three independent browsers review, sign, recover, and settle a real VM-verified atomic exchange', async ({
  browser,
  baseURL,
}) => {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  const errors: string[] = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const context = await browser.newContext({
        baseURL,
        viewport: { width: 1440, height: 1000 },
      });
      contexts.push(context);
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      pages.push(page);
      await page.goto('/');
      await pair(page, index);
    }
    const alice = pages[0]!;
    const actors = (await state(alice)).actors;
    for (let index = 0; index < 3; index += 1)
      await publish(pages[index]!, index, actors);
    await refreshMarket(alice);
    await expect(
      alice.getByRole('heading', { name: '1 circle found.' }),
    ).toBeVisible();
    await alice.getByRole('button', { name: 'Build this circle' }).click();
    let room = alice.getByRole('dialog', {
      name: 'Your circle is taking shape.',
    });
    await expect(room).toBeVisible();
    const firstId = new URL(alice.url()).searchParams.get('circle')!;
    await room.getByRole('button', { name: 'Cancel this circle' }).click();
    await room.getByRole('button', { name: 'Yes, cancel circle' }).click();
    await expect(room.getByText('Cancelled', { exact: true })).toBeVisible();
    await room.getByRole('button', { name: 'Close dialog' }).click();
    await expect(
      alice.getByRole('heading', { name: '1 circle found.' }),
    ).toBeVisible();
    await alice.getByRole('button', { name: 'Build this circle' }).click();
    room = alice.getByRole('dialog', { name: 'Your circle is taking shape.' });
    await expect(room).toBeVisible();
    const id = new URL(alice.url()).searchParams.get('circle')!;
    expect(id).not.toBe(firstId);
    const originalCache = await alice.evaluate(() => {
      const key = 'swapcircle-original-offers-v1';
      const raw = localStorage.getItem(key)!;
      const offers = JSON.parse(raw);
      Object.values(offers).forEach((offer) => {
        (offer as { wanted: WantedAsset }).wanted.category = 'ff'.repeat(32);
      });
      localStorage.setItem(key, JSON.stringify(offers));
      return raw;
    });
    await alice.reload();
    room = alice.getByRole('dialog', { name: 'Your circle is taking shape.' });
    await expect(
      room.getByText(
        'The current proposal could not be independently matched to the published offers. Do not sign it.',
        { exact: true },
      ),
    ).toBeVisible();
    await room.getByRole('checkbox').check();
    await expect(
      room.getByRole('button', { name: 'Approve in wallet', exact: true }),
    ).toBeDisabled();
    expect((await state(alice)).requests.flat()).toHaveLength(0);
    await alice.evaluate(
      (raw) => localStorage.setItem('swapcircle-original-offers-v1', raw),
      originalCache,
    );
    await alice.reload();
    room = alice.getByRole('dialog', { name: 'Your circle is taking shape.' });
    await expect(room).toBeVisible();
    await alice.screenshot({ path: 'test-results/review.png', fullPage: true });

    const spectator = await browser.newContext({ baseURL });
    contexts.push(spectator);
    const publicResponse = await spectator.request.get(`/api/circles/${id}`);
    expect(((await publicResponse.json()) as Circle).proposal).toBeUndefined();
    expect(
      (await spectator.request.get(`/api/circles/${id}/transaction`)).status(),
    ).toBe(403);

    await alice.request.post('/__demo/reject-next', { data: { actor: 0 } });
    await room.getByRole('checkbox').check();
    await room
      .getByRole('button', { name: 'Approve in wallet', exact: true })
      .click();
    await expect(room.getByRole('alert')).toContainText(
      'No new approval was submitted',
    );
    let circle = (await (
      await alice.request.get(`/api/circles/${id}`)
    ).json()) as Circle;
    expect(
      circle.participants.filter((participant) => participant.signed),
    ).toHaveLength(0);
    expect((await state(alice)).broadcasts).toHaveLength(0);

    await room
      .getByRole('button', { name: 'Approve in wallet', exact: true })
      .click();
    await expect(
      room.getByText('Your approval is recorded.', { exact: true }),
    ).toBeVisible();
    for (let index = 1; index < 3; index += 1) {
      const ownRoom = await openRoom(pages[index]!, id);
      await expect(
        ownRoom.getByRole('heading', {
          name: `${actors[index]!.label}'s exact trade`,
        }),
      ).toBeVisible();
      await ownRoom.getByRole('checkbox').check();
      await expect(
        ownRoom.getByRole('button', { name: 'Approve in wallet', exact: true }),
      ).toBeEnabled();
      await ownRoom
        .getByRole('button', { name: 'Approve in wallet', exact: true })
        .click();
      if (index === 1) {
        await expect(
          ownRoom.getByText('Your approval is recorded.', { exact: true }),
        ).toBeVisible();
        await expect(
          ownRoom.getByRole('button', { name: 'Settle the circle' }),
        ).not.toBeVisible();
        expect((await state(alice)).broadcasts).toHaveLength(0);
      } else {
        await expect(
          ownRoom.getByRole('button', { name: 'Settle the circle' }),
        ).toBeVisible();
      }
    }

    await alice.reload();
    room = alice.getByRole('dialog', { name: 'Your circle is taking shape.' });
    await expect(
      room.getByRole('button', { name: 'Settle the circle' }),
    ).toBeVisible();
    await expect(
      room.getByRole('button', { name: 'Cancel this circle' }),
    ).not.toBeVisible();
    const downloadEvent = alice.waitForEvent('download');
    await room
      .getByRole('button', { name: 'Export signed transaction' })
      .click();
    const download = await downloadEvent;
    const exported = JSON.parse(
      await readFile((await download.path())!, 'utf8'),
    ) as { signedTransaction: string; txid: string };
    expect(transactionId(exported.signedTransaction)).toBe(exported.txid);

    await alice.request.post('/__demo/broadcast-mode', {
      data: { mode: 'timeout_before_acceptance' },
    });
    await room.getByRole('button', { name: 'Settle the circle' }).click();
    await expect(
      room.getByText('Outcome uncertain', { exact: true }),
    ).toBeVisible();
    expect((await state(alice)).broadcasts).toEqual([
      exported.signedTransaction,
    ]);
    await alice.request.post('/__demo/broadcast-mode', {
      data: { mode: 'ok' },
    });
    await room
      .getByRole('button', { name: 'Check and retry same transaction' })
      .click();
    await expect(
      alice
        .getByRole('dialog', { name: 'A good trade, full circle.' })
        .getByText('In mempool', { exact: true }),
    ).toBeVisible();
    room = alice.getByRole('dialog', { name: 'A good trade, full circle.' });
    await expect(
      room.getByText(
        'Accepted into the mempool. Not yet confirmed or irreversible.',
        { exact: true },
      ),
    ).toBeVisible();
    const final = await state(alice);
    expect(final.broadcasts).toEqual([
      exported.signedTransaction,
      exported.signedTransaction,
    ]);
    expect(final.encryptedEvents).toBeGreaterThanOrEqual(10);
    expect(final.requests.map((requests) => requests.length)).toEqual([
      2, 1, 1,
    ]);
    expect(
      final.requests.flat().every((request) => request.broadcast === false),
    ).toBe(true);
    expect(
      final.requests
        .flat()
        .every(
          (request) =>
            request.inputPaths.some(
              ([, path, index]) => path === 'receive' && index === 3,
            ) &&
            request.inputPaths.some(
              ([, path, index]) => path === 'change' && index === 2,
            ),
        ),
    ).toBe(true);
    circle = (await (
      await alice.request.get(`/api/circles/${id}`)
    ).json()) as Circle;
    for (const participant of circle.proposal!.participants) {
      const matching = final.utxos.filter(
        (utxo) => utxo.token?.category === participant.receiveAsset.category,
      );
      expect(matching).toHaveLength(1);
      const inventory = (await (
        await alice.request.post('/api/wallet/inventory', {
          data: {
            network: 'chipnet',
            addressPaths: [
              {
                address: participant.receiveAddress,
                path: 'receive',
                index: 0,
              },
            ],
          },
        })
      ).json()) as { utxos: WalletUtxo[] };
      expect(
        inventory.utxos.some(
          (utxo) =>
            utxo.token?.category === participant.receiveAsset.category &&
            utxo.satoshis === '1000',
        ),
      ).toBe(true);
      expect(inventory.utxos.find((utxo) => !utxo.token)!.satoshis).toBe(
        participant.changeSatoshis,
      );
    }
    expect(
      decodeTransaction(exported.signedTransaction).inputs.every(
        (input) => input.unlockingBytecode.length > 0,
      ),
    ).toBe(true);
    await alice.request.post('/__demo/confirm', {
      data: { txid: exported.txid, confirmations: 2 },
    });
    await room.getByRole('button', { name: 'Refresh chain status' }).click();
    await expect(
      room.getByText('Confirmed on-chain.', { exact: true }),
    ).toBeVisible();
    await expect(
      room.getByText(
        '2 confirmations. Confirmation counts can change during a reorg.',
        { exact: true },
      ),
    ).toBeVisible();
    await alice.screenshot({
      path: 'test-results/settled.png',
      fullPage: true,
    });
    await room.getByRole('button', { name: 'Close dialog' }).click();
    await alice.getByRole('tab', { name: 'All wishes 0' }).click();
    await alice.screenshot({
      path: 'test-results/desktop.png',
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

const document = globalThis.document;
const state = await (await globalThis.fetch('/__demo/state')).json();
for (const actor of state.actors) {
  const card = document.createElement('article');
  const title = document.createElement('h2');
  title.textContent = actor.label;
  card.append(title);
  for (const [label, category] of [
    ['Offers category', actor.asset.category],
    ['Wants category', actor.wanted.category],
  ]) {
    const heading = document.createElement('p');
    heading.textContent = label;
    const value = document.createElement('code');
    value.textContent = category;
    card.append(heading, value);
  }
  document.querySelector('#actors').append(card);
}
document.querySelector('#pair').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const status = document.querySelector('#status');
  button.disabled = true;
  status.textContent = 'Pairing over the encrypted local relay...';
  try {
    const response = await globalThis.fetch('/__demo/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: Number(document.querySelector('[name=actor]').value),
        uri: document.querySelector('[name=uri]').value.trim(),
      }),
    });
    if (!response.ok) throw new Error('Pairing failed.');
    document.querySelector('[name=uri]').value = '';
    status.textContent = 'Pairing started. Return to SwapCircle to continue.';
  } catch {
    status.textContent =
      'Pairing failed. Check the URI and try a fresh pairing link.';
  } finally {
    button.disabled = false;
  }
});

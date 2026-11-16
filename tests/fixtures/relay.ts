import { WebSocketServer, type WebSocket } from 'ws';
import {
  matchFilters,
  verifyEvent,
  type Event,
  type Filter,
} from 'nostr-tools';
import { useWebSocketImplementation } from 'nostr-tools/pool';

export async function fixtureRelay() {
  useWebSocketImplementation(globalThis.WebSocket);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Relay did not listen.');
  const subscriptions = new Map<WebSocket, Map<string, Filter[]>>();
  const events: Event[] = [];
  server.on('connection', (socket) => {
    subscriptions.set(socket, new Map());
    socket.on('close', () => subscriptions.delete(socket));
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString()) as unknown[];
        if (message[0] === 'REQ' && typeof message[1] === 'string') {
          const filters = message.slice(2) as Filter[];
          subscriptions.get(socket)!.set(message[1], filters);
          for (const event of events) {
            if (matchFilters(filters, event))
              socket.send(JSON.stringify(['EVENT', message[1], event]));
          }
          socket.send(JSON.stringify(['EOSE', message[1]]));
        } else if (message[0] === 'EVENT') {
          const event = message[1] as Event;
          if (!verifyEvent(event)) {
            socket.send(
              JSON.stringify([
                'OK',
                event.id,
                false,
                'Invalid event signature.',
              ]),
            );
            return;
          }
          if (!events.some((existing) => existing.id === event.id)) {
            events.push(event);
            for (const [client, entries] of subscriptions) {
              for (const [id, filters] of entries) {
                if (matchFilters(filters, event))
                  client.send(JSON.stringify(['EVENT', id, event]));
              }
            }
          }
          socket.send(JSON.stringify(['OK', event.id, true, '']));
        } else if (message[0] === 'CLOSE' && typeof message[1] === 'string') {
          subscriptions.get(socket)?.delete(message[1]);
        }
      } catch {
        socket.send(JSON.stringify(['NOTICE', 'Invalid test relay message.']));
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${address.port}`,
    events,
    waitForClients: (maximum: number) =>
      new Promise<void>((resolve, reject) => {
        if (server.clients.size <= maximum) return resolve();
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Relay clients did not finish their teardown.'));
        }, 10_000);
        const check = () => {
          if (server.clients.size > maximum) return;
          clearTimeout(timer);
          cleanup();
          resolve();
        };
        const watch = (socket: WebSocket) => socket.once('close', check);
        const cleanup = () => {
          server.off('connection', watch);
          for (const socket of server.clients) socket.off('close', check);
        };
        for (const socket of server.clients) watch(socket);
        server.on('connection', watch);
      }),
    close: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

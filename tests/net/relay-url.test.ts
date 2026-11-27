import { describe, expect, it } from 'vitest';
import { relayUrlFor } from '../../src/net/types';

describe('relayUrlFor', () => {
  it.each([
    ['https://x.cloudfront.net/code/ports/5176/', 'wss://x.cloudfront.net/code/ports/5176/lan'],
    ['https://x.cloudfront.net/code/ports/5176', 'wss://x.cloudfront.net/code/ports/5176/lan'],
    ['https://x.cloudfront.net/code/ports/5176/?autostart=skirmish#a', 'wss://x.cloudfront.net/code/ports/5176/lan'],
    ['http://192.168.1.20:8080/', 'ws://192.168.1.20:8080/lan'],
    ['http://192.168.1.20:8080/index.html', 'ws://192.168.1.20:8080/lan'],
    ['http://localhost:5173/sandbox/ui.html?mp=1', 'ws://localhost:5173/sandbox/lan'],
  ])('%s → %s', (page, relay) => expect(relayUrlFor(page)).toBe(relay));
});

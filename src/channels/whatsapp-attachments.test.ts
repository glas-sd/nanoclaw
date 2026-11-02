/** Exercise the real inbound handler and session staging; no WhatsApp connection. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChannelRegistration, InboundMessage } from './adapter.js';

const mocks = vi.hoisted(() => ({
  registration: undefined as ChannelRegistration | undefined,
  handlers: new Map<string, (...args: any[]) => any>(),
  download: vi.fn(),
  insert: vi.fn(),
  reupload: vi.fn(),
  dataDir: '',
}));
vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: (_name: string, registration: ChannelRegistration) => {
    mocks.registration = registration;
  },
}));
vi.mock('../env.js', () => ({ readEnvFile: () => ({ WHATSAPP_ENABLED: 'true' }) }));
vi.mock('../config.js', async (original) => ({
  ...(await original<typeof import('../config.js')>()),
  get DATA_DIR() {
    return mocks.dataDir;
  },
}));
// Capture the mailbox boundary, but keep real writeSessionMessage + AnchoredDir I/O.
vi.mock('../mailbox/index.js', async (original) => ({
  ...(await original<typeof import('../mailbox/index.js')>()),
  getAgentMailbox: () => ({
    prepare: vi.fn(),
    session: async (_key: unknown, action: any) => action({ insertMessage: mocks.insert }),
  }),
}));
vi.mock('../db/sessions.js', () => ({ updateSession: vi.fn() }));
vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: () => ({
    ev: {
      on: (event: string, handler: (...args: any[]) => any) => {
        mocks.handlers.set(event, handler);
        if (event === 'connection.update') queueMicrotask(() => handler({ connection: 'open' }));
      },
    },
    updateMediaMessage: mocks.reupload,
    sendPresenceUpdate: async () => {},
    groupFetchAllParticipating: async () => ({}),
    end: vi.fn(),
  }),
  Browsers: { macOS: () => [] },
  DisconnectReason: {},
  useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: vi.fn() }),
  makeCacheableSignalKeyStore: () => ({}),
  normalizeMessageContent: (message: unknown) => message,
  downloadMediaMessage: mocks.download,
}));

import './whatsapp.js';
import { isSafeAttachmentName } from '../attachment-safety.js';
import { sessionDir, writeSessionMessage } from '../session-manager.js';

beforeEach(() => {
  mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-attachments-'));
  mocks.handlers.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '2.3000.123456' }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fs.rmSync(mocks.dataDir, { recursive: true, force: true });
});

async function receive(media: Record<string, unknown>, bytes: Buffer) {
  mocks.download.mockResolvedValue(bytes);
  const onInbound = vi.fn();
  const adapter = (await mocks.registration!.factory())!;
  await adapter.setup({ onInbound, onMetadata: vi.fn(), onAction: vi.fn(), onInboundEvent: vi.fn() });
  await mocks.handlers.get('messages.upsert')!({
    messages: [
      {
        key: { id: 'wa-image', remoteJid: '15550001111@s.whatsapp.net' },
        messageTimestamp: 1700000000,
        message: media,
      },
    ],
  });
  await adapter.teardown();
  expect(onInbound).toHaveBeenCalledOnce();
  expect(mocks.download).toHaveBeenCalledWith(
    expect.anything(),
    'buffer',
    {},
    expect.objectContaining({ reuploadRequest: mocks.reupload }),
  );
  return onInbound.mock.calls[0][2] as InboundMessage;
}

it('stages image bytes independently per session and removes inline data from mailbox metadata', async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0x00, 0x80, 0xff, 0xd9]);
  const inbound = await receive({ imageMessage: { caption: 'photo' } }, bytes);
  const content = JSON.stringify(inbound.content);
  const attachment = JSON.parse(content).attachments[0];
  expect(attachment).toMatchObject({ type: 'image', data: bytes.toString('base64') });
  expect(attachment).not.toHaveProperty('localPath');
  expect(fs.existsSync(path.join(mocks.dataDir, 'attachments'))).toBe(false);

  let name = '';
  for (const session of ['session-a', 'session-b']) {
    await writeSessionMessage('agent', session, { ...inbound, content });
    const stored = JSON.parse(mocks.insert.mock.calls.at(-1)![0].content).attachments[0];
    name = stored.name;
    expect(name).toMatch(/\.jpg$/);
    expect(stored).toMatchObject({ type: 'image', localPath: `inbox/wa-image/${name}` });
    expect(stored).not.toHaveProperty('data');
    expect(fs.readFileSync(path.join(sessionDir('agent', session), stored.localPath))).toEqual(bytes);
  }
  expect(JSON.parse(content).attachments[0].data).toBe(bytes.toString('base64'));
  fs.unlinkSync(path.join(sessionDir('agent', 'session-a'), 'inbox/wa-image', name));
  expect(fs.readFileSync(path.join(sessionDir('agent', 'session-b'), 'inbox/wa-image', name))).toEqual(bytes);
});

it.each(['../escape.pdf', 'nested/file.pdf', 'nested\\file.pdf', '\0bad', ''])(
  'replaces unsafe document filename %j at the staging boundary',
  async (fileName) => {
    const bytes = Buffer.from('document bytes');
    const inbound = await receive({ documentMessage: { fileName } }, bytes);
    await writeSessionMessage('agent', 'session-a', { ...inbound, content: JSON.stringify(inbound.content) });
    const stored = JSON.parse(mocks.insert.mock.calls.at(-1)![0].content).attachments[0];
    expect(isSafeAttachmentName(stored.name)).toBe(true);
    expect(stored.localPath).toBe(`inbox/wa-image/${stored.name}`);
    expect(stored).not.toHaveProperty('data');
    expect(fs.readFileSync(path.join(sessionDir('agent', 'session-a'), stored.localPath))).toEqual(bytes);
  },
);

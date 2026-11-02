/**
 * Regression coverage for inbound WhatsApp media reaching the container.
 *
 * The adapter used to write media to `<DATA_DIR>/attachments/` and report
 * `localPath: "attachments/<file>"`, but the container mounts the session dir
 * at /workspace and the agent-runner renders attachments as
 * `/workspace/${localPath}` — so the agent was handed a path that resolved to
 * `<sessionDir>/attachments/`, which never exists. Media downloaded fine and
 * was unreadable anyway.
 *
 * These drive `buildAttachmentEntry` through the real host staging path
 * (`writeSessionMessage` → `extractAttachmentFiles`) and assert the resulting
 * `localPath` resolves to a file under the session dir. Asserting it merely
 * starts with `inbox/` would stay green if nothing were written.
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-wa-media' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../db/index.js';
import { createSession } from '../db/sessions.js';
import { initSessionFolder, withMailboxSession, sessionDir, writeSessionMessage } from '../session-manager.js';
import type { Session } from '../types.js';
import { buildAttachmentEntry } from './whatsapp.js';

const TEST_DIR = '/tmp/nanoclaw-test-wa-media';
const AG = 'ag-wa-media';
const SESS = 'sess-wa-media';

function now(): string {
  return new Date().toISOString();
}

/** Run an adapter-built attachment through the host's inbound staging path. */
async function stage(messageId: string, attachment: unknown): Promise<Array<Record<string, unknown>>> {
  await writeSessionMessage(AG, SESS, {
    id: messageId,
    kind: 'chat',
    timestamp: now(),
    platformId: 'whatsapp:120363@g.us',
    channelType: 'whatsapp',
    threadId: null,
    content: JSON.stringify({ text: '', sender: '972500000000@s.whatsapp.net', attachments: [attachment] }),
  });

  const rows = await withMailboxSession(AG, SESS, (mailbox) => mailbox.getInboundHistory(1));
  if (rows.length !== 1) throw new Error('missing inbound message');
  const attachments = JSON.parse(rows[0].content).attachments as Array<Record<string, unknown>>;
  for (const attachment of attachments) {
    expect(attachment).not.toHaveProperty('data');
    expect(attachment.localPath).toMatch(/^inbox\//);
  }
  return attachments;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: AG, name: 'WaMedia', folder: 'wamedia', agent_provider: null, created_at: now() });
  const sess: Session = {
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
  await createSession(sess);
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('buildAttachmentEntry', () => {
  it('carries bytes as base64 and invents no path of its own', () => {
    const entry = buildAttachmentEntry('audio', { mimetype: 'audio/ogg' }, Buffer.from('ogg'));

    expect(entry).not.toHaveProperty('localPath');
    expect(entry.data).toBe(Buffer.from('ogg').toString('base64'));
    expect(entry.size).toBe(3);
  });
});

describe('inbound media staging', () => {
  it('stages an uncaptioned image where /workspace/<localPath> resolves', async () => {
    const bytes = Buffer.from('jpeg-bytes');
    // WhatsApp sends images with a mimetype and no fileName. Deriving the
    // extension from it is the host's job, so it isn't asserted here.
    const entry = buildAttachmentEntry('image', { mimetype: 'image/jpeg' }, bytes);

    const [staged] = await stage('WA-IMG-1', entry);

    const onDisk = path.join(sessionDir(AG, SESS), staged.localPath as string);
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk)).toEqual(bytes);
  });

  it('keeps a traversal fileName inside the session inbox', async () => {
    // documentMessage.fileName rides through WhatsApp's E2E channel, so Meta
    // can't sanitize it server-side and the host guard is the only one.
    const entry = buildAttachmentEntry(
      'document',
      { fileName: '../../../../etc/pwned.txt', mimetype: 'text/plain' },
      Buffer.from('attacker-bytes'),
    );

    const [staged] = await stage('WA-DOC-1', entry);

    const onDisk = path.join(sessionDir(AG, SESS), staged.localPath as string);
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.realpathSync(onDisk).startsWith(fs.realpathSync(sessionDir(AG, SESS)))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DIR, 'etc', 'pwned.txt'))).toBe(false);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionSummary, StoredMessage } from '@maka/core';
import {
  createAppShellRevisionActions,
  type TurnRevisionDraft,
} from '../../renderer/app-shell-revision-actions.js';

function session(id: string): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: false,
    model: 'test',
    permissionMode: 'ask',
  };
}

function userMessage(
  overrides: Partial<Extract<StoredMessage, { type: 'user' }>> = {},
): Extract<StoredMessage, { type: 'user' }> {
  return {
    type: 'user',
    id: 'message-1',
    turnId: 'turn-1',
    ts: 1,
    text: 'Human-facing prompt',
    ...overrides,
  };
}

function installWindow(
  branchBeforeTurn: (
    sessionId: string,
    input: { sourceTurnId: string },
  ) => Promise<SessionSummary>,
): () => void {
  const target = globalThis as unknown as { window?: unknown };
  const hadWindow = Object.prototype.hasOwnProperty.call(target, 'window');
  const previousWindow = target.window;
  Object.defineProperty(target, 'window', {
    configurable: true,
    value: {
      maka: { sessions: { branchBeforeTurn } },
      requestAnimationFrame(callback: FrameRequestCallback) {
        callback(0);
        return 1;
      },
    },
    writable: true,
  });
  return () => {
    if (hadWindow) {
      Object.defineProperty(target, 'window', {
        configurable: true,
        value: previousWindow,
        writable: true,
      });
    } else {
      delete target.window;
    }
  };
}

function createHarness(options: {
  branchBeforeTurn: (
    sessionId: string,
    input: { sourceTurnId: string },
  ) => Promise<SessionSummary>;
  messages?: StoredMessage[];
  pendingAttachments?: boolean;
  previousComposerText?: string;
}) {
  const activeIdRef: { current: string | undefined } = { current: 'source' };
  const revisionDraftRef: { current: TurnRevisionDraft | null } = { current: null };
  const composerCalls: string[] = [];
  const opened: string[] = [];
  const branchCalls: Array<[string, { sourceTurnId: string }]> = [];
  const infoToasts: Array<[string, string | undefined]> = [];
  const restoreWindow = installWindow(async (sessionId, input) => {
    branchCalls.push([sessionId, input]);
    return options.branchBeforeTurn(sessionId, input);
  });
  const actions = createAppShellRevisionActions({
    uiLocale: 'en',
    activeIdRef,
    composerRef: {
      current: {
        setText: (text: string) => { composerCalls.push(text); },
        appendText: () => undefined,
        getText: () => options.previousComposerText ?? 'Previous draft',
        clearDraft: (key: string) => { composerCalls.push(`<clear:${key}>`); },
        focus: () => { composerCalls.push('<focus>'); },
      },
    },
    messages: options.messages ?? [userMessage()],
    hasPendingAttachments: () => options.pendingAttachments === true,
    openSessionInChat: (sessionId) => {
      opened.push(sessionId);
      activeIdRef.current = sessionId;
    },
    refreshMessages: async () => true,
    refreshSessions: async () => [],
    setMessages: () => undefined,
    commitRevisionDraft: (draft) => { revisionDraftRef.current = draft; },
    revisionDraftRef,
    toastApi: {
      info: (title, description) => { infoToasts.push([title, description]); },
      error: () => undefined,
    },
    upsertSessionSummary: () => undefined,
  });
  return {
    actions,
    activeIdRef,
    branchCalls,
    composerCalls,
    infoToasts,
    opened,
    restoreWindow,
    revisionDraftRef,
  };
}

describe('app shell revision actions', () => {
  it('starts a local draft and branches only when the edited text is sent', async () => {
    const harness = createHarness({ branchBeforeTurn: async () => session('branch') });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      assert.deepEqual(harness.branchCalls, []);
      assert.equal(harness.revisionDraftRef.current?.draftSessionId, 'source');
      assert.deepEqual(harness.composerCalls, ['Human-facing prompt', '<focus>']);

      assert.equal(await harness.actions.prepareRevisionSend('Edited prompt'), true);
      assert.deepEqual(harness.branchCalls, [['source', { sourceTurnId: 'turn-1' }]]);
      assert.deepEqual(harness.opened, ['branch']);
      assert.equal(harness.revisionDraftRef.current?.draftSessionId, 'branch');
      assert.deepEqual(
        harness.composerCalls,
        ['Human-facing prompt', '<focus>', 'Edited prompt', '<focus>'],
      );
    } finally {
      harness.restoreWindow();
    }
  });

  it('refuses source and retained attachment history before creating a lossy branch', () => {
    const attachment = {
      kind: 'image' as const,
      name: 'source.png',
      mimeType: 'image/png',
      bytes: 4,
      ref: { kind: 'session_file' as const, sessionId: 'source', relativePath: 'attachment-1' },
    };
    const harness = createHarness({
      messages: [
        userMessage({ turnId: 'turn-0', attachments: [attachment] }),
        userMessage({ id: 'message-2', turnId: 'turn-1', ts: 2 }),
      ],
      branchBeforeTurn: async () => session('branch'),
    });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      assert.equal(harness.revisionDraftRef.current, null);
      assert.deepEqual(harness.branchCalls, []);
      assert.equal(harness.infoToasts[0]?.[0], 'This message cannot be edited yet');
    } finally {
      harness.restoreWindow();
    }
  });

  it('refuses transformed prompts and a composer that already owns attachments', () => {
    const transformed = createHarness({
      messages: [userMessage({ text: '<invoked-skill>hidden</invoked-skill>', displayText: '/skill prompt' })],
      branchBeforeTurn: async () => session('branch'),
    });
    try {
      transformed.actions.beginEditUserMessage('turn-1');
      assert.equal(transformed.revisionDraftRef.current, null);
    } finally {
      transformed.restoreWindow();
    }

    const pending = createHarness({
      pendingAttachments: true,
      branchBeforeTurn: async () => session('branch'),
    });
    try {
      pending.actions.beginEditUserMessage('turn-1');
      assert.equal(pending.revisionDraftRef.current, null);
    } finally {
      pending.restoreWindow();
    }
  });

  it('does not steal focus when navigation wins a pending branch creation', async () => {
    let resolveBranch: ((value: SessionSummary) => void) | undefined;
    const branchPromise = new Promise<SessionSummary>((resolve) => { resolveBranch = resolve; });
    const harness = createHarness({ branchBeforeTurn: async () => branchPromise });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      const pending = harness.actions.prepareRevisionSend('Edited prompt');
      await Promise.resolve();
      harness.activeIdRef.current = 'another-session';
      resolveBranch?.(session('branch'));
      assert.equal(await pending, false);
      assert.deepEqual(harness.opened, []);
    } finally {
      harness.restoreWindow();
    }
  });

  it('cancels back to the source and restores its previous draft', async () => {
    const harness = createHarness({ branchBeforeTurn: async () => session('branch') });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      await harness.actions.prepareRevisionSend('Edited prompt');
      await harness.actions.cancelRevisionDraft();
      assert.equal(harness.revisionDraftRef.current, null);
      assert.deepEqual(harness.opened, ['branch', 'source']);
      assert.ok(harness.composerCalls.includes('<clear:branch>'));
      assert.deepEqual(harness.composerCalls.slice(-2), ['Previous draft', '<focus>']);
    } finally {
      harness.restoreWindow();
    }
  });
});

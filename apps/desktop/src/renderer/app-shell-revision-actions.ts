import type { SessionSummary, StoredMessage, UiLocale } from '@maka/core';
import { userFacingText } from '@maka/core';
import type { ComposerHandle } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import {
  isSessionWorkspaceUnavailableError,
  showSessionWorkspaceUnavailableToast,
} from './session-workspace-errors.js';

type RefBox<T> = { current: T };
type MessageListUpdater = (
  next: StoredMessage[] | ((current: StoredMessage[]) => StoredMessage[]),
) => void;

type ToastApi = {
  info(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

/** Active edit-and-resend draft owned by the desktop shell. */
export type TurnRevisionDraft = {
  sourceSessionId: string;
  sourceTurnId: string;
  /** Active owner of the draft. Changes to the branch child after prepare. */
  draftSessionId: string;
  originalText: string;
  /** Composer text that was present before edit began; restored on cancel. */
  previousComposerText: string;
};

export interface AppShellRevisionActions {
  beginEditUserMessage(turnId: string): void;
  /** Lazily create the before-turn branch immediately before normal send. */
  prepareRevisionSend(text: string): Promise<boolean>;
  cancelRevisionDraft(): Promise<void>;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

/**
 * Desktop edit-and-resend follows the CLI rewind boundary without creating an
 * empty branch at click time:
 *
 *   edit click -> local composer draft only
 *   send       -> branchBeforeTurn -> switch child -> normal send
 *
 * If normal send fails after the branch was prepared, the child remains active
 * with the edited text and a second send retries there instead of branching
 * again. Attachment-bearing source or retained context is rejected until the
 * branch artifact copier can preserve those references without data loss.
 */
export function createAppShellRevisionActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  composerRef: RefBox<ComposerHandle | null>;
  messages: readonly StoredMessage[];
  hasPendingAttachments: () => boolean;
  openSessionInChat: (sessionId: string, turnId?: string) => void;
  refreshMessages: (sessionId: string) => Promise<boolean>;
  refreshSessions: () => Promise<SessionSummary[]>;
  setMessages: MessageListUpdater;
  commitRevisionDraft: (draft: TurnRevisionDraft | null) => void;
  revisionDraftRef: RefBox<TurnRevisionDraft | null>;
  toastApi: ToastApi;
  upsertSessionSummary: (session: SessionSummary) => void;
}): AppShellRevisionActions {
  const {
    uiLocale,
    activeIdRef,
    composerRef,
    messages,
    hasPendingAttachments,
    openSessionInChat,
    refreshMessages,
    refreshSessions,
    setMessages,
    commitRevisionDraft,
    revisionDraftRef,
    toastApi,
    upsertSessionSummary,
  } = deps;
  const copy = getDesktopConversationCopy(uiLocale).actions;

  function beginEditUserMessage(turnId: string): void {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const existing = revisionDraftRef.current;
    if (existing) {
      if (existing.draftSessionId === sessionId && existing.sourceTurnId === turnId) {
        composerRef.current?.focus();
      } else {
        toastApi.info(copy.revisionUnavailableTitle, copy.revisionAlreadyActive);
      }
      return;
    }
    if (hasPendingAttachments()) {
      toastApi.info(copy.revisionUnavailableTitle, copy.revisionDraftAttachmentConflict);
      return;
    }
    const userMessage = messages.find(
      (message): message is Extract<StoredMessage, { type: 'user' }> =>
        message.type === 'user' && message.turnId === turnId,
    );
    if (!userMessage) {
      toastApi.error(copy.operationFailedTitle, copy.operationFailedFallback);
      return;
    }

    const turnOrder: string[] = [];
    const seenTurns = new Set<string>();
    const turnHasAttachments = new Set<string>();
    for (const message of messages) {
      const messageTurnId = (message as { turnId?: string }).turnId;
      if (messageTurnId && !seenTurns.has(messageTurnId)) {
        seenTurns.add(messageTurnId);
        turnOrder.push(messageTurnId);
      }
      if (message.type === 'user' && message.attachments && message.attachments.length > 0) {
        turnHasAttachments.add(message.turnId);
      }
    }
    const sourceIndex = turnOrder.indexOf(turnId);
    const retainedAttachmentTurn = turnOrder
      .slice(0, Math.max(0, sourceIndex))
      .find((candidate) => turnHasAttachments.has(candidate));
    if (
      (userMessage.attachments && userMessage.attachments.length > 0) ||
      retainedAttachmentTurn
    ) {
      toastApi.info(copy.revisionUnavailableTitle, copy.revisionAttachmentsUnsupported);
      return;
    }
    if (userMessage.displayText !== undefined && userMessage.displayText !== userMessage.text) {
      toastApi.info(copy.revisionUnavailableTitle, copy.revisionTransformedTextUnsupported);
      return;
    }

    const prompt = userFacingText(userMessage);
    commitRevisionDraft({
      sourceSessionId: sessionId,
      sourceTurnId: turnId,
      draftSessionId: sessionId,
      originalText: prompt,
      previousComposerText: composerRef.current?.getText() ?? '',
    });
    composerRef.current?.setText(prompt);
    composerRef.current?.focus();
    toastApi.info(copy.revisionStartedTitle, copy.revisionStartedDescription);
  }

  async function prepareRevisionSend(text: string): Promise<boolean> {
    const draft = revisionDraftRef.current;
    if (!draft || activeIdRef.current !== draft.draftSessionId) return false;
    // A previous attempt already prepared the child; retry normal send there.
    if (draft.draftSessionId !== draft.sourceSessionId) return true;

    const sourceSessionId = draft.sourceSessionId;
    try {
      const newSession = await window.maka.sessions.branchBeforeTurn(sourceSessionId, {
        sourceTurnId: draft.sourceTurnId,
      });
      upsertSessionSummary(newSession);
      if (activeIdRef.current !== sourceSessionId || revisionDraftRef.current !== draft) {
        await refreshSessions();
        return false;
      }

      const prepared = { ...draft, draftSessionId: newSession.id };
      commitRevisionDraft(prepared);
      openSessionInChat(newSession.id);
      setMessages([]);
      await refreshMessages(newSession.id);
      // Let Composer swap its draftKey before writing into the child draft.
      await nextAnimationFrame();
      if (activeIdRef.current !== newSession.id || revisionDraftRef.current !== prepared) {
        return false;
      }
      composerRef.current?.setText(text);
      composerRef.current?.focus();
      toastApi.info(copy.revisionReadyTitle, copy.revisionReadyDescription);
      await refreshSessions();
      return true;
    } catch (error) {
      if (activeIdRef.current !== sourceSessionId) return false;
      if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
      } else {
        toastApi.error(
          copy.operationFailedTitle,
          localizedShellErrorMessage(error, copy.operationFailedFallback, uiLocale),
        );
      }
      return false;
    }
  }

  async function cancelRevisionDraft(): Promise<void> {
    const draft = revisionDraftRef.current;
    if (!draft) return;
    commitRevisionDraft(null);
    if (draft.draftSessionId !== draft.sourceSessionId) {
      composerRef.current?.clearDraft(draft.draftSessionId);
    }
    if (activeIdRef.current === draft.sourceSessionId) {
      composerRef.current?.setText(draft.previousComposerText);
      return;
    }
    openSessionInChat(draft.sourceSessionId);
    setMessages([]);
    await refreshMessages(draft.sourceSessionId);
    await nextAnimationFrame();
    if (activeIdRef.current === draft.sourceSessionId) {
      composerRef.current?.setText(draft.previousComposerText);
      composerRef.current?.focus();
    }
  }

  return { beginEditUserMessage, prepareRevisionSend, cancelRevisionDraft };
}

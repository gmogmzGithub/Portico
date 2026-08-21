const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createChatRuntimeRegistry } = require('./chat-runtime-registry');

const stateFor = (registry, chatId) =>
  registry.getSnapshot().chats.find((state) => state.chatId === chatId) || null;

test('navigating one view from active chat A to chat B preserves A activity', () => {
  const registry = createChatRuntimeRegistry();
  registry.setViewState('main:1', { chatId: 'chat-a', visible: true });
  registry.reportActivity({ chatId: 'chat-a', busy: true, phase: 'generating' });

  registry.setViewState('main:1', { chatId: 'chat-b', visible: true });
  registry.reportActivity({ chatId: 'chat-b', busy: false, phase: 'idle' });

  assert.deepEqual(stateFor(registry, 'chat-a'), {
    chatId: 'chat-a',
    busy: true,
    phase: 'generating',
    unread: false,
    attentionRequired: false,
  });
  assert.equal(stateFor(registry, 'chat-b'), null);
});

test('removing an originating view does not erase a backend task that can outlive it', () => {
  const registry = createChatRuntimeRegistry();
  registry.setViewState('detached:9', { chatId: 'chat-a', visible: false });
  registry.reportActivity({ chatId: 'chat-a', busy: true, phase: 'tasks' });

  registry.removeView('detached:9');

  assert.equal(stateFor(registry, 'chat-a')?.busy, true);
  assert.equal(stateFor(registry, 'chat-a')?.phase, 'tasks');
});

test('terminal reconciliation marks an unseen chat unread but not a viewed chat', () => {
  const backgroundRegistry = createChatRuntimeRegistry();
  backgroundRegistry.setViewState('main:1', { chatId: 'chat-b', visible: true });
  backgroundRegistry.reportActivity({ chatId: 'chat-a', busy: true, phase: 'tasks' });
  backgroundRegistry.reportActivity({ chatId: 'chat-a', busy: false, phase: 'idle' });
  assert.equal(stateFor(backgroundRegistry, 'chat-a')?.unread, true);

  const foregroundRegistry = createChatRuntimeRegistry();
  foregroundRegistry.setViewState('main:1', { chatId: 'chat-a', visible: true });
  foregroundRegistry.reportActivity({ chatId: 'chat-a', busy: true, phase: 'generating' });
  foregroundRegistry.reportActivity({ chatId: 'chat-a', busy: false, phase: 'idle' });
  assert.equal(stateFor(foregroundRegistry, 'chat-a'), null);
});

test('opening completed chat history never creates a runtime completion transition', () => {
  const registry = createChatRuntimeRegistry();
  registry.setViewState('main:1', { chatId: 'chat-complete', visible: true });

  assert.equal(
    registry.reportActivity({ chatId: 'chat-complete', busy: false, phase: 'idle' }),
    false,
  );
  assert.equal(
    registry.reportActivity({ chatId: 'chat-complete', busy: false, phase: 'idle' }),
    false,
  );
  assert.equal(stateFor(registry, 'chat-complete'), null);
});

test('a background turn completes once and a follow-up starts a fresh lifecycle', () => {
  const registry = createChatRuntimeRegistry();
  let completionTransitions = 0;
  const report = (payload) => {
    const previousState = registry.getChatState(payload.chatId);
    const changed = registry.reportActivity(payload);
    const nextState = registry.getChatState(payload.chatId);
    if (changed && previousState?.busy === true && nextState?.busy !== true) {
      completionTransitions += 1;
    }
    return changed;
  };

  registry.setViewState('main:1', { chatId: 'chat-active', visible: true });
  report({ chatId: 'chat-active', busy: true, phase: 'generating' });

  registry.setViewState('main:1', { chatId: 'chat-complete', visible: true });
  report({ chatId: 'chat-complete', busy: false, phase: 'idle' });
  assert.equal(stateFor(registry, 'chat-active')?.busy, true);
  assert.equal(completionTransitions, 0);

  report({ chatId: 'chat-active', busy: false, phase: 'idle' });
  report({ chatId: 'chat-active', busy: false, phase: 'idle' });
  assert.equal(completionTransitions, 1);

  report({ chatId: 'chat-active', busy: true, phase: 'generating' });
  report({ chatId: 'chat-active', busy: false, phase: 'idle' });
  assert.equal(completionTransitions, 2);
});

test('opening an unread chat acknowledges blue state without clearing orange attention', () => {
  const registry = createChatRuntimeRegistry();
  registry.reportActivity({ chatId: 'chat-a', busy: true, phase: 'tasks' });
  registry.reportActivity({ chatId: 'chat-a', busy: false, phase: 'idle' });
  registry.patchChatState({ chatId: 'chat-a', attentionRequired: true });

  registry.setViewState('main:1', { chatId: 'chat-a', visible: true });

  assert.deepEqual(stateFor(registry, 'chat-a'), {
    chatId: 'chat-a',
    busy: false,
    phase: 'idle',
    unread: false,
    attentionRequired: true,
  });
});

test('settling chat A cannot mutate concurrently active chat B', () => {
  const registry = createChatRuntimeRegistry();
  registry.reportActivity({ chatId: 'chat-a', busy: true, phase: 'tasks' });
  registry.reportActivity({ chatId: 'chat-b', busy: true, phase: 'generating' });

  registry.reportActivity({ chatId: 'chat-a', busy: false, phase: 'idle' });

  assert.equal(stateFor(registry, 'chat-a')?.unread, true);
  assert.equal(stateFor(registry, 'chat-b')?.busy, true);
  assert.equal(stateFor(registry, 'chat-b')?.phase, 'generating');
});

test('malformed activity reports are ignored and explicit state patches stay bounded', () => {
  const registry = createChatRuntimeRegistry();
  assert.equal(registry.reportActivity({ chatId: '', busy: true }), false);
  assert.equal(registry.reportActivity({ chatId: 'chat-a', busy: 'yes' }), false);
  assert.deepEqual(registry.getSnapshot().chats, []);

  registry.patchChatState({
    chatId: `  ${'a'.repeat(300)}  `,
    attentionRequired: true,
  });
  assert.equal(registry.getSnapshot().chats[0].chatId.length, 256);
});

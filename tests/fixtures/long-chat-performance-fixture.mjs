export const LONG_CHAT_TOOL_CALL_COUNT = 66;

const clone = (value) => JSON.parse(JSON.stringify(value));

export const buildLongChatPerformanceFixture = () => {
	const toolCalls = Array.from({ length: LONG_CHAT_TOOL_CALL_COUNT }, (_, index) => {
		const toolCallId = `tool-call-${String(index + 1).padStart(2, '0')}`;
		const hiddenOutput = `${toolCallId}:`.padEnd(7_700, String(index % 10));
		return {
			toolCallId,
			detail: `<details type="tool_calls" id="${toolCallId}" name="web.search" done="true"><summary>Search ${index + 1}</summary><div>${hiddenOutput}</div></details>`,
			contentBlock: {
				type: 'tool_calls',
				content: [
					{
						id: toolCallId,
						function: {
							name: 'web.search',
							arguments: JSON.stringify({ query: `deterministic query ${index + 1}` })
						}
					}
				],
				results: [
					{
						tool_call_id: toolCallId,
						content: JSON.stringify({
							results: `${toolCallId}:`.padEnd(16_600, String((index + 3) % 10))
						})
					}
				]
			}
		};
	});

	const user = {
		id: 'user-message',
		role: 'user',
		content: 'Prepare the biweekly project status.'
	};
	const assistant = {
		id: 'assistant-message',
		parentId: user.id,
		role: 'assistant',
		done: true,
		content: `${toolCalls.map(({ detail }) => detail).join('\n')}\n\n## Final project status\n\nThe final narrative is visible and complete.`,
		contentBlocks: toolCalls.map(({ contentBlock }) => contentBlock)
	};
	const history = {
		currentId: assistant.id,
		messages: {
			[user.id]: user,
			[assistant.id]: assistant
		}
	};

	return {
		id: 'long-chat-performance-fixture',
		user_id: 'fixture-user',
		chat: {
			title: 'Search and Groups Biweekly Project Status',
			history,
			// This intentionally reproduces the legacy duplicate that hydration removes.
			messages: clone([user, assistant])
		}
	};
};

export const compactLongChatPerformanceFixture = (fixture) => {
	const compact = clone(fixture);
	if (compact.chat?.history?.messages) {
		delete compact.chat.messages;
	}
	return compact;
};

export const buildPersistedSubagentReopenFixture = () => {
	const parentChatId = 'persisted-parent-chat';
	const childChatId = 'persisted-child-chat';
	const toolCallId = 'call-persisted-timeout';
	const timeoutResult = {
		is_error: true,
		message: 'Chat did not complete within 1500s',
		content: 'Chat did not complete within 1500s'
	};
	const detail = `<details type="tool_calls" done="true" id="${toolCallId}" name="subagents_run_subagent" result="${JSON.stringify(timeoutResult).replaceAll('"', '&quot;')}"><summary>Tool Executed</summary></details>`;
	return {
		parent: {
			id: parentChatId,
			chat: {
				title: 'Persisted Subagent Parent',
				history: {
					currentId: 'assistant-message',
					messages: {
						'assistant-message': {
							id: 'assistant-message',
							role: 'assistant',
							done: true,
							content: `${detail}\n\nFinal parent narrative.`,
							contentBlocks: [
								{
									type: 'tool_calls',
									content: [
										{
											id: toolCallId,
											function: { name: 'subagents_run_subagent', arguments: '{}' }
										}
									],
									results: [
										{
											tool_call_id: toolCallId,
											server_id: 'subagents',
											content: JSON.stringify(timeoutResult)
										}
									]
								}
							]
						}
					}
				}
			}
		},
		child: {
			id: childChatId,
			user_id: 'portico-service',
			chat: {
				meta: {
					subagent: {
						parent_chat_id: parentChatId,
						parent_tool_call_id: toolCallId
					}
				},
				history: {
					currentId: 'child-assistant',
					messages: {
						'child-assistant': {
							id: 'child-assistant',
							role: 'assistant',
							done: true,
							usage: { total_tokens: 179483 },
							contentBlocks: Array.from({ length: 12 }, (_, index) => ({
								type: 'tool_calls',
								content: [
									{
										id: `child-tool-${index + 1}`,
										function: { name: 'example_tool', arguments: '{}' }
									}
								]
							}))
						}
					}
				}
			}
		},
		descendants: {
			chat_ids: [childChatId],
			truncated: false,
			tool_calls: {
				[toolCallId]: {
					chat_id: childChatId,
					tool_call_count: 12,
					display_tokens: 179483
				}
			}
		},
		toolCallId,
		parentChatId,
		childChatId
	};
};

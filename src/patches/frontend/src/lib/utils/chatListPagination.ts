import { get } from 'svelte/store';

import { getChatList } from '$lib/apis/chats';
import { chats, currentChatPage } from '$lib/stores';
import {
	createChatListPaginationController,
	type ChatListRow
} from '$lib/utils/chatListPaginationCore';

const controller = createChatListPaginationController<ChatListRow>({
	fetchPage: (token, page) => getChatList(token, page),
	readRows: () => get(chats) ?? [],
	replaceRows: (rows) => chats.set(rows),
	setCommittedPage: (page) => currentChatPage.set(page)
});

export const chatListPaginationState = {
	subscribe: controller.subscribe
};

export const refreshChatListPageOne = (token: string) => controller.refreshPageOne(token);

export const appendNextChatListPage = (token: string) => controller.appendNextPage(token);

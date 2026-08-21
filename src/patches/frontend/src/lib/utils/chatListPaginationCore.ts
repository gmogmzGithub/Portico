export type ChatListRow = {
	id?: string | null;
	[key: string]: unknown;
};

export type ChatListPaginationState = {
	generation: number;
	committedPage: number;
	loadingInitial: boolean;
	loadingMore: boolean;
	exhausted: boolean;
};

export type ChatListRequestResult<Row extends ChatListRow> = {
	status: 'applied' | 'stale' | 'not-ready';
	page: number;
	rows: Row[];
	exhausted: boolean;
};

type ChatListPaginationDependencies<Row extends ChatListRow> = {
	fetchPage: (token: string, page: number) => Promise<unknown>;
	readRows: () => Row[] | null | undefined;
	replaceRows: (rows: Row[]) => void;
	setCommittedPage: (page: number) => void;
};

const mergeRowsById = <Row extends ChatListRow>(existingRows: Row[], newRows: Row[]): Row[] => {
	const merged = [...existingRows];
	const seenIds = new Set(
		existingRows
			.map((row) => row?.id)
			.filter((id): id is string => typeof id === 'string' && id.length > 0)
	);

	for (const row of newRows) {
		const id = row?.id;
		if (typeof id === 'string' && id.length > 0) {
			if (seenIds.has(id)) continue;
			seenIds.add(id);
		}
		merged.push(row);
	}

	return merged;
};

const requireRows = <Row extends ChatListRow>(value: unknown): Row[] => {
	if (!Array.isArray(value)) {
		throw new Error('Chat list response was unavailable');
	}
	return value as Row[];
};

export const createChatListPaginationController = <Row extends ChatListRow>(
	dependencies: ChatListPaginationDependencies<Row>
) => {
	let state: ChatListPaginationState = {
		generation: 0,
		committedPage: 0,
		loadingInitial: false,
		loadingMore: false,
		exhausted: false
	};
	const subscribers = new Set<(value: ChatListPaginationState) => void>();
	let appendInFlight:
		| {
				generation: number;
				promise: Promise<ChatListRequestResult<Row>>;
		  }
		| null = null;

	const publish = (patch: Partial<ChatListPaginationState>) => {
		state = { ...state, ...patch };
		for (const subscriber of subscribers) subscriber(state);
	};

	const subscribe = (subscriber: (value: ChatListPaginationState) => void) => {
		subscribers.add(subscriber);
		subscriber(state);
		return () => subscribers.delete(subscriber);
	};

	const refreshPageOne = async (token: string): Promise<ChatListRequestResult<Row>> => {
		const requestGeneration = state.generation + 1;
		publish({
			generation: requestGeneration,
			loadingInitial: true,
			loadingMore: false,
			exhausted: false
		});

		try {
			const rows = requireRows<Row>(await dependencies.fetchPage(token, 1));
			if (state.generation !== requestGeneration) {
				return { status: 'stale', page: 1, rows: [], exhausted: state.exhausted };
			}

			dependencies.replaceRows(rows);
			dependencies.setCommittedPage(1);
			publish({ committedPage: 1, loadingInitial: false, exhausted: false });
			return { status: 'applied', page: 1, rows, exhausted: false };
		} catch (error) {
			if (state.generation === requestGeneration) {
				publish({ loadingInitial: false });
			}
			throw error;
		}
	};

	const appendNextPage = (token: string): Promise<ChatListRequestResult<Row>> => {
		if (appendInFlight?.generation === state.generation) {
			return appendInFlight.promise;
		}

		if (state.loadingInitial || state.committedPage < 1 || state.exhausted) {
			return Promise.resolve({
				status: 'not-ready',
				page: state.committedPage,
				rows: [],
				exhausted: state.exhausted
			});
		}

		const requestGeneration = state.generation;
		const requestedPage = state.committedPage + 1;
		publish({ loadingMore: true });

		const inFlightRequest: {
			generation: number;
			promise: Promise<ChatListRequestResult<Row>> | null;
		} = { generation: requestGeneration, promise: null };
		const promise = (async (): Promise<ChatListRequestResult<Row>> => {
			try {
				const rows = requireRows<Row>(await dependencies.fetchPage(token, requestedPage));
				if (state.generation !== requestGeneration) {
					return {
						status: 'stale',
						page: requestedPage,
						rows: [],
						exhausted: state.exhausted
					};
				}

				const existingRows = dependencies.readRows();
				dependencies.replaceRows(
					mergeRowsById(Array.isArray(existingRows) ? existingRows : [], rows)
				);
				dependencies.setCommittedPage(requestedPage);
				const exhausted = rows.length === 0;
				publish({
					committedPage: requestedPage,
					loadingMore: false,
					exhausted
				});
				return { status: 'applied', page: requestedPage, rows, exhausted };
			} catch (error) {
				if (state.generation === requestGeneration) {
					publish({ loadingMore: false });
				}
				throw error;
			} finally {
				if (appendInFlight === inFlightRequest) appendInFlight = null;
			}
		})();

		inFlightRequest.promise = promise;
		appendInFlight = inFlightRequest as {
			generation: number;
			promise: Promise<ChatListRequestResult<Row>>;
		};
		return promise;
	};

	return {
		subscribe,
		getState: () => state,
		refreshPageOne,
		appendNextPage
	};
};

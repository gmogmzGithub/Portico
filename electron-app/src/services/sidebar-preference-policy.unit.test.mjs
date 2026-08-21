import test from 'node:test';
import assert from 'node:assert/strict';

import {
	normalizeStoredSidebarPreference,
	resolveInitialSidebarOpen,
	shouldPersistSidebarPreference
} from '../../../src/patches/frontend/src/lib/utils/sidebar-preference.mjs';

test('normal desktop windows prefer the durable sidebar preference when available', () => {
	assert.equal(
		resolveInitialSidebarOpen({
			isMobile: false,
			delegatedSubagentView: false,
			storedLocalValue: 'false',
			persistedPreference: true
		}),
		true
	);
	assert.equal(
		resolveInitialSidebarOpen({
			isMobile: false,
			delegatedSubagentView: false,
			storedLocalValue: 'true',
			persistedPreference: false
		}),
		false
	);
});

test('sidebar preference falls back to local storage when durable state is absent', () => {
	assert.equal(
		resolveInitialSidebarOpen({
			isMobile: false,
			delegatedSubagentView: false,
			storedLocalValue: 'true',
			persistedPreference: null
		}),
		true
	);
	assert.equal(
		resolveInitialSidebarOpen({
			isMobile: false,
			delegatedSubagentView: false,
			storedLocalValue: '',
			persistedPreference: null
		}),
		false
	);
});

test('delegated subagent views always force the sidebar closed', () => {
	assert.equal(
		resolveInitialSidebarOpen({
			isMobile: false,
			delegatedSubagentView: true,
			storedLocalValue: 'true',
			persistedPreference: true
		}),
		false
	);
	assert.equal(
		shouldPersistSidebarPreference({
			isMobile: false,
			delegatedSubagentView: true
		}),
		false
	);
});

test('mobile layout never persists sidebar preference', () => {
	assert.equal(
		resolveInitialSidebarOpen({
			isMobile: true,
			delegatedSubagentView: false,
			storedLocalValue: 'true',
			persistedPreference: true
		}),
		false
	);
	assert.equal(
		shouldPersistSidebarPreference({
			isMobile: true,
			delegatedSubagentView: false
		}),
		false
	);
	assert.equal(
		shouldPersistSidebarPreference({
			isMobile: false,
			delegatedSubagentView: false
		}),
		true
	);
});

test('sidebar preference normalization only accepts booleans', () => {
	assert.equal(normalizeStoredSidebarPreference(true), true);
	assert.equal(normalizeStoredSidebarPreference(false), false);
	assert.equal(normalizeStoredSidebarPreference('true'), null);
	assert.equal(normalizeStoredSidebarPreference(null), null);
});

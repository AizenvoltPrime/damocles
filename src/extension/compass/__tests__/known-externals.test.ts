import { describe, it, expect } from 'vitest';
import { isKnownExternal } from '../known-externals';

describe('isKnownExternal — stdlib sub-paths and Rust prefixes', () => {
	it('classifies Rust stdlib paths as external', () => {
		expect(isKnownExternal('std::collections::HashMap')).toBe(true);
		expect(isKnownExternal('core::mem::swap')).toBe(true);
		expect(isKnownExternal('alloc::vec::Vec')).toBe(true);
		expect(isKnownExternal('std::io')).toBe(true);
	});

	it('classifies Ruby stdlib sub-paths as external', () => {
		expect(isKnownExternal('net/http')).toBe(true);
		expect(isKnownExternal('net/https')).toBe(true);
		expect(isKnownExternal('active_record/base')).toBe(true);
	});

	it('classifies npm package sub-paths as external', () => {
		expect(isKnownExternal('vitest/config')).toBe(true);
		expect(isKnownExternal('lodash/debounce')).toBe(true);
		expect(isKnownExternal('date-fns/format')).toBe(true);
	});

	it('still classifies bare npm packages as external', () => {
		expect(isKnownExternal('react')).toBe(true);
		expect(isKnownExternal('vue')).toBe(true);
		expect(isKnownExternal('@vue/runtime-core')).toBe(true);
		expect(isKnownExternal('@anthropic-ai/claude-agent-sdk')).toBe(true);
	});

	it('does not classify PHP PascalCase namespaces as external', () => {
		expect(isKnownExternal('App\\Auth\\Authenticator')).toBe(false);
		expect(isKnownExternal('App\\Cache\\CacheManager')).toBe(false);
	});

	it('still classifies known PHP vendor namespaces as external', () => {
		expect(isKnownExternal('Illuminate\\Support\\Facades\\Auth')).toBe(true);
		expect(isKnownExternal('Symfony\\Component\\HttpFoundation\\Request')).toBe(true);
	});

	it('does not classify relative code imports as external', () => {
		expect(isKnownExternal('./models')).toBe(false);
		expect(isKnownExternal('../types')).toBe(false);
		expect(isKnownExternal('./UserList.vue')).toBe(false);
		expect(isKnownExternal('../service')).toBe(false);
	});

	it('classifies bundler-resolved asset imports as external', () => {
		expect(isKnownExternal('./style.css')).toBe(true);
		expect(isKnownExternal('./locales/en.json')).toBe(true);
		expect(isKnownExternal('../assets/loading-spinner.json')).toBe(true);
		expect(isKnownExternal('./icon.svg')).toBe(true);
		expect(isKnownExternal('./theme.scss')).toBe(true);
		expect(isKnownExternal('./font.woff2')).toBe(true);
		expect(isKnownExternal('./model.glb')).toBe(true);
	});

	it('handles asset imports with query strings (Vite ?url, ?raw)', () => {
		expect(isKnownExternal('./logo.svg?raw')).toBe(true);
		expect(isKnownExternal('./image.png?url')).toBe(true);
	});

	it('classifies Node builtins as external', () => {
		expect(isKnownExternal('fs')).toBe(true);
		expect(isKnownExternal('fs/promises')).toBe(true);
		expect(isKnownExternal('path')).toBe(true);
		expect(isKnownExternal('node:crypto')).toBe(true);
	});
});

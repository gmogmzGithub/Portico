import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
	plugins: [
		sveltekit(),
		viteStaticCopy({
			targets: [
				{
					src: 'node_modules/onnxruntime-web/dist/*.jsep.*',

					dest: 'wasm'
				}
			]
		})
	],
	define: {
		APP_VERSION: JSON.stringify(process.env.npm_package_version),
		APP_BUILD_HASH: JSON.stringify(process.env.APP_BUILD_HASH || 'dev-build')
	},
	build: {
		sourcemap: true
	},
	worker: {
		format: 'es'
	},
	esbuild: {
		pure: process.env.ENV === 'dev' ? [] : ['console.log', 'console.debug', 'console.error']
	},
	server: {
		// Allow access from Docker network hostnames
		allowedHosts: ['open-webui', 'portico-open-webui-dev', 'localhost'],
		// Enable polling for file watching in Docker (fixes macOS bind mount issues)
		watch: {
			usePolling: true,
			interval: 500
		},
		// Proxy API calls to the backend server
		proxy: {
			'/api': {
				target: 'http://localhost:8081',
				changeOrigin: true
			},
			'/ws': {
				target: 'ws://localhost:8081',
				ws: true
			},
			'/ollama': {
				target: 'http://localhost:8081',
				changeOrigin: true
			},
			'/openai': {
				target: 'http://localhost:8081',
				changeOrigin: true
			},
			'/audio': {
				target: 'http://localhost:8081',
				changeOrigin: true
			},
			'/images': {
				target: 'http://localhost:8081',
				changeOrigin: true
			},
			'/retrieval': {
				target: 'http://localhost:8081',
				changeOrigin: true
			},
			'/health': {
				target: 'http://localhost:8081',
				changeOrigin: true
			},
			'/static': {
				target: 'http://localhost:8081',
				changeOrigin: true
			}
		}
	}
});

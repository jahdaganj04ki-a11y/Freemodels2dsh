/**
 * Test-only ESM loader registration. The plugin's production modules import
 * Harness peer packages (@deepseek-ai/*); under the plain `node --test`
 * runner those specifiers resolve to the minimal stubs in test/stubs so the
 * suite stays hermetic and needs no node_modules install.
 */
import { register } from 'node:module'

register(new URL('./loader.mjs', import.meta.url))

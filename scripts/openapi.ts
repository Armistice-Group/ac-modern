/**
 * Writes the API's OpenAPI document for the Mintlify docs:
 *   pnpm docs:openapi
 * The server URL in it is ACM_DOCS_SERVER (default: a placeholder your users replace).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openapi } from '../src/lib/server/openapi.ts';

const out = join(import.meta.dirname, '../docs/api-reference/openapi.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(openapi(process.env.ACM_DOCS_SERVER || 'https://access.example.com'), null, '\t')}\n`);
console.log(`Wrote ${out}`);

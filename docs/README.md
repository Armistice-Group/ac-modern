# ac·modern docs

The documentation site, built with [Mintlify](https://mintlify.com).

## Preview

```sh
cd docs
npx mint dev
```

Then open http://localhost:3000.

## API reference

The endpoint pages under **API reference → Endpoints** are generated from `api-reference/openapi.json`, which is produced from the app's own spec (`src/lib/server/openapi.ts`):

```sh
pnpm docs:openapi
```

Run it whenever the API changes. Don't edit `openapi.json` by hand.

## Layout

- `docs.json`: site config (theme, colours, navigation)
- `*.mdx`: pages, grouped in folders that match the navigation
- `screenshots/`: images used by the pages and the main README (regenerate with `pnpm screenshots`)
- `logo/`, `favicon.svg`: branding

Check links before publishing:

```sh
npx mint broken-links
```

Published at https://ac-modern.mintlify.app (Mintlify builds it from `docs/` on every push to `main`).

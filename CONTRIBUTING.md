# Contributing

Thanks for helping. A few things to know first.

## Security issues

Don't open an issue or pull request for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Development

Node 24+ (26 recommended, see `.nvmrc`) and pnpm 12 (`npm install -g pnpm@12`).

```sh
pnpm install
ACM_DATA_DIR=./demo-data pnpm seed     # demo organisation: avery@northwind.example / demo-password
ACM_DATA_DIR=./demo-data pnpm dev
pnpm check && pnpm test                # typecheck and tests (SQLite)
TEST_DATABASE_URL=postgres://… pnpm test
```

## Pull requests

- Keep them focused, and add a test for behaviour you change: the workflow, evidence, directory and integration tests in `tests/` show the style.
- Anything that touches who can approve, see or change access needs a test for the case that must be refused, not only the one that works.
- Every query on tenant data filters by `org_id`.
- New UI follows the existing components and tokens in `src/app.css`; check light and dark.
- If it changes behaviour people rely on, update the docs in `docs/` (a Mintlify site, published at ac-modern.mintlify.app).

## License of contributions

ac·modern is licensed under the [Functional Source License 1.1, Apache 2.0 future license](LICENSE.md). By opening a pull request, you agree that your contribution is licensed under the same terms, including its conversion to Apache 2.0 two years after release, and you confirm you have the right to contribute it.

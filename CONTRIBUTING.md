# Contributing

Start with the [MVP plan](docs/zh-CN/mvp.md) and the [API contract](spec/api.md). When changing an SDK behavior, update the shared [behavior specification](spec/behavior.md) and the Node.js and Python conformance cases together. Run `npm test` for the simulated Google service and Node.js, and `npm run test:python` for Python.

## SDK packages

Run `bash scripts/package-sdks.sh` after installing workspace dependencies. It builds the npm tarball, Python wheel, and Python source distribution, installs them in isolated directories, and runs the shared SDK conformance suites against the installed packages.

### Local release command

Start from a clean `main` that matches `origin/main`. Run the command without `--only` to release both SDKs. Each SDK defaults to its own next patch version. Use `--version X.Y.Z` to choose an exact stable version for the selected SDKs.

```bash
npm run release -- --dry-run
npm run release -- --only node
npm run release -- --only python --version 0.2.0
```

The local dry run previews the version and tag plan. On confirmation, the command updates the selected version files and lockfiles, commits them, and pushes `main` and the selected tags in one Git transaction. GitHub Actions verifies the packages before publishing. If the push fails, the commit and tags remain local for inspection and retry.

### GitHub Actions

Manually run the [npm workflow](.github/workflows/publish-npm.yml) to rehearse the release with `npm publish --dry-run`. To release, push a `node-v<version>` tag on a commit from `main`. The tag must match `sdks/node/package.json`. GitHub Actions uploads the verified tarball to npm using Trusted Publishing. The `gabriel-calendar` npm package must trust `Easy-Ez/gabriel-calendar`, workflow `publish-npm.yml`, environment `npm`, with direct publishing allowed. npm expires a new binding if it does not complete a successful publish within two days.

Manually run the [PyPI workflow](.github/workflows/publish-pypi.yml) to build, install, and validate the Python distributions without uploading them. To release, push a `python-v<version>` tag on a commit from `main`. The tag must match `sdks/python/pyproject.toml`. GitHub Actions publishes the verified wheel and source distribution through the existing PyPI Trusted Publisher for `publish-pypi.yml` in the `pypi` environment.

## Public repository boundary

| Suitable for this repository | Keep outside the repository |
| --- | --- |
| Product scope, onboarding, architecture, public APIs, SDK and service source approved for release | Deployment configuration and inventories, private runbooks, internal URLs and operational records |
| Synthetic fixtures, placeholder values, public provider documentation | OAuth credentials, tokens, webhook verification values, local configuration, and private keys |
| Reproducible tests with fake providers | Live calendar records, actual attendee details, customer identifiers, screenshots, logs and captured requests |

Use reserved example domains such as `example.invalid` and synthetic identifiers. Store runtime credentials in the deployment's secret manager and inject them at runtime. Keep internal material in a separate private workspace or repository. Ignore patterns are a backstop for local files.

Before publishing, review the exact staged diff and tracked paths. Scan staged content for secrets and private data without printing matches. Check that examples contain synthetic data and the docs accurately describe the release state. Run live Google checks only with authorized test accounts and calendars. Use fake providers and synthetic fixtures for automated tests.

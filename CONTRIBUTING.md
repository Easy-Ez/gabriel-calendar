# Contributing

Start with the [MVP plan](docs/zh-CN/mvp.md) and the [API contract](spec/api.md). When changing an SDK behavior, update the shared [behavior specification](spec/behavior.md) and the Node.js and Python conformance cases together. Run `npm test` for the simulated Google service and Node.js, and `npm run test:python` for Python.

## SDK packages

Run `bash scripts/package-sdks.sh` after installing workspace dependencies. It builds the npm tarball, Python wheel, and Python source distribution, installs them in isolated directories, and runs the shared SDK conformance suites against the installed packages. Publish the exact verified npm tarball. The manually dispatched [PyPI workflow](.github/workflows/publish-pypi.yml) runs the package checks before publishing its verified Python artifacts with Trusted Publishing.

## Public repository boundary

| Suitable for this repository | Keep outside the repository |
| --- | --- |
| Product scope, onboarding, architecture, public APIs, SDK and service source approved for release | Deployment configuration and inventories, private runbooks, internal URLs and operational records |
| Synthetic fixtures, placeholder values, public provider documentation | OAuth credentials, tokens, webhook verification values, local configuration, and private keys |
| Reproducible tests with fake providers | Live calendar records, actual attendee details, customer identifiers, screenshots, logs and captured requests |

Use reserved example domains such as `example.invalid` and synthetic identifiers. Store runtime credentials in the deployment's secret manager and inject them at runtime. Keep internal material in a separate private workspace or repository. Ignore patterns are a backstop for local files.

Before publishing, review the exact staged diff and tracked paths. Scan staged content for secrets and private data without printing matches. Check that examples contain synthetic data and the docs accurately describe the release state. Run live Google checks only with authorized test accounts and calendars. Use fake providers and synthetic fixtures for automated tests.

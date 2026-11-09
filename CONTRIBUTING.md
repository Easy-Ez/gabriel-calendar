# Contributing

Start with the [MVP plan](docs/zh-CN/mvp.md) and the [API draft](spec/api.md). When changing an SDK behavior, update the shared [behavior specification](spec/behavior.md) and the Node.js and Python conformance cases together once the implementations exist.

## Public repository boundary

| Suitable for this repository | Keep outside the repository |
| --- | --- |
| Product scope, onboarding, architecture, public APIs, SDK and service source approved for release | Deployment configuration and inventories, private runbooks, internal URLs and operational records |
| Synthetic fixtures, placeholder values, public provider documentation | OAuth credentials, tokens, webhook verification values, local configuration, and private keys |
| Reproducible tests with fake providers | Live calendar records, actual attendee details, customer identifiers, screenshots, logs and captured requests |

Use reserved example domains such as `example.invalid` and synthetic identifiers. Store runtime credentials in the deployment's secret manager and inject them at runtime. Keep internal material in a separate private workspace or repository. Ignore patterns are a backstop for local files.

Before publishing, review the exact staged diff and tracked paths. Scan staged content for secrets and private data without printing matches. Check that examples contain synthetic data and the docs accurately describe the release state. Run live Google checks only with authorized test accounts and calendars. Use fake providers and synthetic fixtures for automated tests.

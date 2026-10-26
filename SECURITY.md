# Security Policy

## Supported versions

Security fixes target the latest code on the `main` branch until a stable release policy is documented. The project is currently pre-1.0.0; users should assume breaking changes may occur.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository when it is enabled. If private reporting is not available, open a minimal public issue asking the maintainers for a private disclosure channel; do not publish exploit details, credentials, or proof-of-concept payloads in a public issue.

## Security boundaries

- `forge_install` and `forge_activate` must remain gated on successful static validation and sandbox testing.
- Sandbox tests must fail closed if bubblewrap or required namespace isolation is unavailable.
- Generated plugin code is untrusted. Passing the static validator and sandbox smoke test is not a security certification; activation executes code in the host process.
- Do not commit credentials, API keys, private repository contents, personal data, or local absolute paths.
- The validator rejects traversal paths, duplicate paths, secret-shaped paths, oversized files, and unsupported package entrypoint layouts.

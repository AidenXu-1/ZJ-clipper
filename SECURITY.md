# Security Policy

## Supported version

Security fixes are applied to the latest release of Nomo Clipper. Older releases remain available for reproducibility, but users should upgrade to the latest version.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository instead of opening a public issue. Do not include API keys, tokens, private documents, or other sensitive data in public issues or pull requests.

If a credential may have been exposed, revoke or rotate it immediately before reporting the technical details.

## Development toolchain

Production dependencies are required to pass `npm audit --omit=dev --audit-level=high`. Critical development dependency findings are also blocked in CI.

The remaining esbuild advisory is inherited through the WXT build toolchain and is not included in the published browser extension. Forcing the patched esbuild major version breaks the WXT 0.19 build, while WXT 0.20 currently breaks this project's required ASCII content-script output. Keep the alert open and reassess when the upstream toolchain supports a compatible patched release.

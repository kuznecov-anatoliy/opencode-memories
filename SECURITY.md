# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in opencode-memories, please report it by opening a GitHub Security Advisory at:

https://github.com/kuznecov-anatoliy/opencode-memories/security/advisories

Do **not** report security vulnerabilities via public issues.

Alternatively, you can report vulnerabilities directly via email: **kuznecov.anatoly@gmail.com** (PGP fingerprint available on request).

You can expect an acknowledgement within 72 hours and a detailed response within 5 business days.

## Scope

This plugin stores session data from AI agents. While it does not handle authentication tokens or credentials by design, users should be aware that:

- MEMORY files and the SQLite database may contain sensitive information discussed during AI sessions
- The plugin validates file paths but does not encrypt stored data
- Access to the database file implies access to all stored session history

## Recommendations

1. Add `MEMORIES/` and `*.db` to your project's `.gitignore` (already included by default)
2. Do not commit `.db` files or `MEMORIES/` directories to version control
3. Review stored content before sharing database dumps or MEMORY files

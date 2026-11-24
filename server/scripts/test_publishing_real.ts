/**
 * Deprecated safety stub.
 *
 * This filename used to create content and publish it as a hard-coded user.
 * That behaviour is intentionally removed. Use `pnpm canary:provider` for a
 * tenant/account-bound, read-only release check with explicit interlocks.
 */
console.error('Refusing legacy real publishing test. Use `pnpm canary:provider -- --user-id <id> --platform <provider> ...` instead.');
process.exitCode = 1;

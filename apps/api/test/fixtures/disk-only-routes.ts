/**
 * RFC-029 D3. The published GETs that read a FILE and never open a database
 * connection.
 *
 * RFC-023 D1's rule is "a published route declares what its SQL may cost".
 * These two have no SQL to cost anything: the daily job leaves a small JSON in
 * a directory the API bind-mounts `:ro`, and the handler reads it. Giving them
 * a `statement_timeout` entry would be a promise about statements they never
 * run — a number in the config file that nothing enforces and that the next
 * reader has to disprove.
 *
 * So they are named here instead, once, and the two budget suites both use
 * this list: `route-budgets.test.ts` excuses them from declaring a budget, and
 * `route-budgets.runtime.test.ts` holds them to the reason they were excused by
 * asserting they run NO statement at all. Adding a query to one of them fails
 * the second test, which is a louder and more useful failure than a budget
 * quietly not applying.
 */
export const DISK_ONLY_ROUTES: readonly string[] = [
  "/polymarket/shadow-replay/latest",
  "/polymarket/shadow-replay/runs",
];

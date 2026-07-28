import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';

/**
 * Turns a skipped test into a failed run when `CI` is set.
 *
 * Every spec in `playwright/` opens with a `test.skip(condition, reason)`
 * precondition (no seeded clusters, auth already enforced, …). Playwright exits
 * **0** when those fire, so a suite that skipped all 39 tests is
 * indistinguishable from one that passed all 39 — which is precisely how a
 * green-looking run can verify nothing. That trap cost a full false-green
 * verification pass locally, and it is the main way the #334 promotion gate
 * could report success while testing nothing.
 *
 * @ai-warning Do NOT "fix" a CI failure from this reporter by relaxing the
 * offending `test.skip` condition. The skip firing in CI means the *environment*
 * is wrong (unseeded database, leftover `auth_config.mode = 'local'` from a
 * hard-killed run) — the assertion that something is missing is correct and the
 * environment is what needs repairing.
 *
 * Locally it only reports: the skip list is printed either way, but the run
 * status is left alone so a developer probing a subset on an empty database
 * still gets Playwright's normal exit code.
 */
export default class ForbidSkippedReporter implements Reporter {
  private readonly skipped: string[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'skipped') {
      this.skipped.push(`${test.location.file}:${test.location.line} › ${test.title}`);
    }
  }

  // Playwright types `onEnd` as returning a Promise of the status override, so
  // this has to be async even though nothing is awaited.
  async onEnd(result: FullResult): Promise<{ status: FullResult['status'] } | undefined> {
    if (this.skipped.length === 0) return undefined;

    const enforcing = Boolean(process.env.CI);
    console.log(
      `\n${enforcing ? '✘' : '!'} ${this.skipped.length} test(s) were SKIPPED — a skipped golden-path test verifies nothing:`,
    );
    for (const entry of this.skipped) console.log(`    - ${entry}`);
    console.log(
      enforcing
        ? '  Failing the run: this suite gates promotion to main, so it must actually execute.\n'
        : '  Not failing the run (CI is unset). Seed the dev database to execute these.\n',
    );

    // Only escalate; never downgrade a genuine failure to a pass.
    return enforcing && result.status === 'passed' ? { status: 'failed' } : undefined;
  }
}

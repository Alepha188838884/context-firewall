/**
 * Per-server tool allow/deny policy (GitHub issue #1). `allowTools`/`denyTools` on a downstream
 * config entry restrict which of that server's tools `invoke_tool` will dispatch to. Deny wins
 * over allow; both support exact names and `*` globs.
 */

/**
 * Deliberately NOT regex-based. Compiling the pattern to `^${literal}.*${literal}.*...$` has two
 * real failure modes:
 *   (a) adjacent `*`s (e.g. `a**b`) compile to consecutive `.*.*`, and on a long tool name that
 *       triggers catastrophic backtracking in the regex engine - the gateway can hang on a single
 *       policy check (measured: 4+ stars against a ~1000-char name took multiple seconds).
 *   (b) `.` in a regex doesn't match `\n` by default, so `delete_*` fails to catch a (adversarial
 *       or just weird) tool name containing a newline, e.g. "delete_evil\ninject" - a silent
 *       fail-open in a security-relevant check.
 * Instead this is the standard two-pointer greedy wildcard matcher (star-only, no `?`): O(n*m)
 * worst case, no backtracking blowup, and compares characters directly so `*` matches literally
 * any character including `\n`.
 */
export function matchesToolPattern(toolName: string, pattern: string): boolean {
  let s = 0;
  let p = 0;
  let starIdx = -1;
  let matchFrom = 0;

  while (s < toolName.length) {
    if (p < pattern.length && pattern[p] === toolName[s]) {
      s++;
      p++;
    } else if (p < pattern.length && pattern[p] === '*') {
      starIdx = p;
      matchFrom = s;
      p++;
    } else if (starIdx !== -1) {
      // Backtrack to the most recent '*' and let it swallow one more character.
      p = starIdx + 1;
      matchFrom++;
      s = matchFrom;
    } else {
      return false;
    }
  }

  while (p < pattern.length && pattern[p] === '*') {
    p++;
  }
  return p === pattern.length;
}

export type ToolPolicyResult = { allowed: true } | { allowed: false; rule: string };

export function checkToolPolicy(
  downstream: { allowTools?: string[]; denyTools?: string[] } | undefined,
  tool: string
): ToolPolicyResult {
  if (!downstream) {
    return { allowed: true };
  }

  for (const pattern of downstream.denyTools ?? []) {
    if (matchesToolPattern(tool, pattern)) {
      return { allowed: false, rule: `denyTools: "${pattern}"` };
    }
  }

  if (downstream.allowTools && downstream.allowTools.length > 0) {
    const matched = downstream.allowTools.some((pattern) => matchesToolPattern(tool, pattern));
    if (!matched) {
      return { allowed: false, rule: 'not matched by allowTools' };
    }
  }

  return { allowed: true };
}

/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';

export interface HarnessEmit {
  /** What the generated file proves, in one clause — used in the revert message. */
  label: string;
  /** Where the generated file lives. */
  target: string;
  /** Renders and writes it, returning the SQL that was written. */
  write: (target?: string) => string;
  /**
   * Every module whose builders feed the file, so the revert message names the
   * one that actually changed. A harness rendered from two modules and blaming
   * only one sends the reader to the wrong file.
   */
  sources: string[];
}

/** Repo root, so the docker command below can be pasted from there. */
const REPO_ROOT = path.resolve(__dirname, '../..');

function repoRelative(file: string): string {
  // Forward slashes: the command is pasted into a shell that may be bash inside
  // the container's host, and a backslash path is read as escapes.
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/**
 * Writes a generated Postgres harness and says what to do about it.
 *
 * The two harnesses differ in which builders they render and in nothing else,
 * including the part that matters most: the file is not a copy to be read, it is
 * a thing that has to be re-run against a real database before it is committed.
 * Keeping that instruction in one place means it cannot go stale in one script
 * and stay correct in the other.
 */
export function emitHarness(config: HarnessEmit): void {
  const before = fs.existsSync(config.target)
    ? fs.readFileSync(config.target, 'utf8')
    : null;

  const sql = config.write(config.target);

  const assertions = (sql.match(/^DO \$\$/gm) ?? []).length;
  console.log(`Wrote ${assertions} assertion(s) to ${config.target}`);

  if (before === sql) {
    console.log('No change — the committed harness already matches the builders.');
    return;
  }

  if (before === null) {
    console.log('This is a new file; commit it with the builder change that produced it.');
    return;
  }

  const relative = repoRelative(config.target);
  const inContainer = `/tmp/${path.basename(config.target)}`;
  const revert = config.sources.length === 1 ? config.sources[0] : config.sources.join(' or ');
  console.log(
    '\nThe harness changed. Re-run it against Postgres before committing:\n' +
      `  docker cp ${relative} cpep-mig:${inContainer}\n` +
      `  docker exec cpep-mig psql -v ON_ERROR_STOP=1 -U postgres -d pharmacy -f ${inContainer}\n` +
      `\nIf you did not intend to change what ${config.label}, revert ${revert}.`
  );
}

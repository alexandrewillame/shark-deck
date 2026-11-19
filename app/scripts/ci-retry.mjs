#!/usr/bin/env node
/**
 * Re-runs a GitHub Actions run whose jobs GitHub never started (no machine
 * handed out: the job is cancelled with no step run, as the hosted macOS ones
 * sometimes are), until it passes. Meant to be left running, overnight if need be:
 *
 *   npm run ci:retry                      the latest Build run on main
 *   npm run ci:retry -- 44561042114       that run
 *   npm run ci:retry -- --ref v0.3.2      the latest Build run of a tag or branch
 *   npm run ci:retry -- --check           say what it would watch, and stop
 *
 *   --every 20      minutes between re-runs (default 20)
 *   --tries 40      re-runs before giving up (default 40: about 13 hours)
 *   --workflow build.yml
 *
 * It stops at the first real failure, a job that ran and failed: that is for
 * a person to look at, not to re-run. It needs a GitHub token allowed to
 * re-run workflows: $GITHUB_TOKEN, or else the one Git already uses to push to
 * GitHub (`git credential fill`). The token is never printed.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const check = args.includes('--check');
const runArg = args.find((a, i) => /^\d+$/.test(a) && !/^--/.test(args[i - 1] ?? ''));
const workflow = flag('workflow', 'build.yml');
const ref = flag('ref', 'main');
const everyMin = Number(flag('every', '20'));
const tries = Number(flag('tries', '40'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(new Date().toLocaleTimeString(), ...m);

function repoName() {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const m = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?\s*$/.exec(r.stdout ?? '');
  return m ? m[1] : 'alexandrewillame/shark-deck';
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    // Never a sign-in window in the middle of the night: no stored token, no run.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  return /^password=(.+)$/m.exec(r.stdout ?? '')?.[1]?.trim() ?? null;
}

const REPO = repoName();
const TOKEN = token();
if (!TOKEN) {
  console.error('No GitHub token: set GITHUB_TOKEN, or push once with Git so it stores one.');
  process.exit(1);
}

async function api(path, method = 'GET') {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'shark-deck-ci-retry',
        },
      });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        throw Object.assign(new Error(`GitHub answered ${res.status} to ${method} ${path}`), {
          fatal: true,
        });
      }
      if (!res.ok) throw new Error(`GitHub answered ${res.status} to ${method} ${path}`);
      return res.status === 204 || res.status === 201 ? null : await res.json();
    } catch (e) {
      // A network blip or a GitHub hiccup overnight: try again a little later.
      if (e.fatal || attempt >= 10) throw e;
      log(String(e.message ?? e), '- trying again in a minute');
      await sleep(60_000);
    }
  }
}

async function findRun() {
  if (runArg) return api(`/actions/runs/${runArg}`);
  const list = await api(
    `/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(ref)}&per_page=1`,
  );
  const run = list.workflow_runs[0];
  if (!run) throw new Error(`No ${workflow} run for ${ref}.`);
  return run;
}

async function waitDone(id) {
  for (;;) {
    const run = await api(`/actions/runs/${id}`);
    if (run.status === 'completed') return run;
    await sleep(60_000);
  }
}

/** A job that never got a machine: no runner, no step. GitHub's doing, not ours. */
const unstarted = (j) => !j.runner_name && !(j.steps ?? []).length;
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure']);

let run = await findRun();
log(
  `${REPO}: ${run.name} on ${run.head_branch} (${run.head_sha.slice(0, 7)}), attempt ${run.run_attempt}: ${run.status}${run.conclusion ? ', ' + run.conclusion : ''}`,
);
log(run.html_url);
if (check) process.exit(0);

for (let n = 0; ;) {
  run = await waitDone(run.id);
  if (run.conclusion === 'success') {
    log('Passed.');
    process.exit(0);
  }
  const jobs = (await api(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs;
  const failed = jobs.filter((j) => FAILED.has(j.conclusion));
  const real = failed.filter((j) => !unstarted(j));
  if (real.length) {
    log('A job ran and failed: not re-running it. Look at:');
    for (const j of real) log(`  ${j.name}: ${j.conclusion} - ${j.html_url}`);
    process.exit(1);
  }
  if (n >= tries) {
    log(`Still no machine after ${tries} re-runs: giving up.`);
    process.exit(1);
  }
  n++;
  log(
    `No machine for ${failed.map((j) => j.name).join(', ') || 'a job'}. Re-run ${n} of ${tries} in ${everyMin} min.`,
  );
  await sleep(everyMin * 60_000);
  await api(`/actions/runs/${run.id}/rerun-failed-jobs`, 'POST');
  log('Re-run started.');
  await sleep(15_000);
}

import { readFile } from 'node:fs/promises';
import { planAutonomousBuildCycle } from '../algo/autonomous-build-cycle.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const statePath = argument('--state', 'validation/autonomous-build-state.json');
const repository = {
  fullName: argument('--repository', 'vhanukaev1981/crypto-market-monitor'),
  branch: argument('--branch', 'agent/algo-v2-hardening-v1'),
  headSha: argument('--head-sha', 'UNVERIFIED_LOCAL_HEAD'),
};
const qualification = {
  status: argument('--qualification-status', 'MISSING'),
  runId: argument('--qualification-run-id', null),
};

try {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const plan = planAutonomousBuildCycle({ state, repository, qualification });
  process.stdout.write(`${JSON.stringify(plan)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message ?? 'AUTONOMOUS_BUILD_CYCLE_FAILED'}\n`);
  process.exitCode = 1;
}

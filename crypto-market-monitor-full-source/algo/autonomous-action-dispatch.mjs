import { authorizeBuildAction } from './autonomous-permission-boundary.mjs';

const ACTION_CLASS_MAP = Object.freeze({
  PAPER_INFRA: Object.freeze({
    permissionAction: 'RUN_PAPER_INFRA',
    executor: 'paper-readiness-integration',
  }),
});

export function mapAutonomousAction(actionClass) {
  const mapped = ACTION_CLASS_MAP[actionClass];
  if (!mapped) {
    throw new Error(`AUTONOMOUS_ACTION_NOT_ALLOWED:${String(actionClass)}`);
  }

  const authorization = authorizeBuildAction({ action: mapped.permissionAction });
  if (authorization.allowed !== true) {
    throw new Error(`AUTONOMOUS_ACTION_NOT_ALLOWED:${String(actionClass)}`);
  }

  return { ...mapped };
}

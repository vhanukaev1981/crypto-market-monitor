function bucket() {
  return { evaluatedSignals:0, approvedSignals:0, blockedSignals:0, decisions:{}, reasons:{}, approvedNotional:0 };
}

function addCount(obj,key) {
  const k=String(key ?? 'UNKNOWN');
  obj[k]=(obj[k]??0)+1;
}

function validate(event) {
  const ms=Date.parse(event?.time ?? '');
  if (!Number.isFinite(ms) || typeof event?.decision!=='string' || !event.decision || typeof event?.reasonCode!=='string' || !event.reasonCode || !Number.isFinite(event?.approvedNotional)) throw new Error('INVALID_RISK_DECISION_EVENT');
  return ms;
}

function apply(target,event) {
  target.evaluatedSignals++;
  const approved=['APPROVED','REDUCED_SIZE'].includes(event.decision) && event.approvedNotional>0;
  if (approved) target.approvedSignals++;
  else target.blockedSignals++;
  addCount(target.decisions,event.decision);
  addCount(target.reasons,event.reasonCode);
  target.approvedNotional+=event.approvedNotional;
}

export function summarizeRiskDecisions(events) {
  if (!Array.isArray(events)) throw new Error('INVALID_RISK_DECISION_EVENTS');
  const total=bucket();
  const byYear={};
  for (const event of events) {
    const ms=validate(event);
    const year=String(new Date(ms).getUTCFullYear());
    if (!byYear[year]) byYear[year]=bucket();
    apply(total,event);
    apply(byYear[year],event);
  }
  return { total, byYear };
}

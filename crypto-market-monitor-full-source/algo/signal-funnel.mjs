function bucket() {
  return { evaluatedBars:0, buyCandidates:0, blockedBars:0, reasons:{}, regimes:{}, structural1d:{}, confirmation4h:{}, averageScore:null };
}

function addCount(obj,key) {
  const k=String(key ?? 'UNKNOWN');
  obj[k]=(obj[k]??0)+1;
}

function validate(event) {
  const ms=Date.parse(event?.time ?? '');
  if (!Number.isFinite(ms) || typeof event?.action!=='string' || !event.action || typeof event?.reason!=='string' || !event.reason) throw new Error('INVALID_SIGNAL_FUNNEL_EVENT');
  if (event.score!=null && !Number.isFinite(event.score)) throw new Error('INVALID_SIGNAL_FUNNEL_EVENT');
  return ms;
}

function apply(target,event,scoreState) {
  target.evaluatedBars++;
  if (event.action==='BUY_CANDIDATE') target.buyCandidates++;
  else target.blockedBars++;
  addCount(target.reasons,event.reason);
  addCount(target.regimes,event.regime);
  addCount(target.structural1d,event.structural1d);
  addCount(target.confirmation4h,event.confirmation4h);
  if (Number.isFinite(event.score)) {
    scoreState.sum+=event.score;
    scoreState.count++;
    target.averageScore=scoreState.sum/scoreState.count;
  }
}

export function summarizeSignalFunnel(events) {
  if (!Array.isArray(events)) throw new Error('INVALID_SIGNAL_FUNNEL_EVENTS');
  const total=bucket();
  const byYear={};
  const totalScore={sum:0,count:0};
  const yearScores={};
  for (const event of events) {
    const ms=validate(event);
    const year=String(new Date(ms).getUTCFullYear());
    if (!byYear[year]) { byYear[year]=bucket(); yearScores[year]={sum:0,count:0}; }
    apply(total,event,totalScore);
    apply(byYear[year],event,yearScores[year]);
  }
  return { total, byYear };
}

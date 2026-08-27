function monthIndex(key){
  const m=String(key).match(/^(\d{4})-(\d{2})$/);
  if(!m) throw new Error('INVALID_MONTH_KEY');
  const y=Number(m[1]), mo=Number(m[2]);
  if(mo<1||mo>12) throw new Error('INVALID_MONTH_KEY');
  return y*12+(mo-1);
}

export function assertSpotResearchWindow({startMonth,endMonth}={}){
  const start=monthIndex(startMonth);
  const end=monthIndex(endMonth);
  if(end<start) throw new Error('INVALID_MONTH_RANGE');
  if(start<monthIndex('2022-11')) throw new Error('SPOT_ARCHIVE_START_EXCEEDED');
  if(end>=monthIndex('2025-01')) throw new Error('OOS_WINDOW_LOCKED');
  return {startMonth,endMonth,oosLocked:true};
}

export function spotResearchTimeRange({startMonth,endMonth}={}){
  assertSpotResearchWindow({startMonth,endMonth});
  const [startYear,startMo]=startMonth.split('-').map(Number);
  const [endYear,endMo]=endMonth.split('-').map(Number);
  const startMs=Date.UTC(startYear,startMo-1,1,0,0,0,0);
  const nextMonthMs=Date.UTC(endYear,endMo,1,0,0,0,0);
  const endRequestMs=nextMonthMs-1;
  const expectedLastMs=nextMonthMs-3600000;
  return {
    startMs,
    endRequestMs,
    expectedFirst:new Date(startMs).toISOString(),
    expectedLast:new Date(expectedLastMs).toISOString(),
    expectedCandleCount:(expectedLastMs-startMs)/3600000+1,
  };
}

export function spotArchiveCoverageTimeRange({startMonth,endMonth}={}){
  const requested=spotResearchTimeRange({startMonth,endMonth});
  const archiveStartMs=startMonth==='2022-11' ? Date.UTC(2022,10,10,0,0,0,0) : requested.startMs;
  const expectedLastMs=Date.parse(requested.expectedLast);
  return {
    startMs:archiveStartMs,
    endRequestMs:requested.endRequestMs,
    expectedFirst:new Date(archiveStartMs).toISOString(),
    expectedLast:requested.expectedLast,
    expectedCandleCount:(expectedLastMs-archiveStartMs)/3600000+1,
    requestedExpectedFirst:requested.expectedFirst,
    requestedExpectedCandleCount:requested.expectedCandleCount,
    preArchiveMissingHours:(archiveStartMs-requested.startMs)/3600000,
  };
}

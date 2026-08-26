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

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { monthKeys, spotArchiveUrl } from './bybit-spot-archive.mjs';
import { assertFrozenAlgoV2CandidateFreezeRecord, FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD, FROZEN_ALGO_V2_PARAMETERS } from './algo-v2-candidate-freeze.mjs';

export const BLIND_OOS_START_MONTH='2025-01';
export const BLIND_OOS_RECORD_URL=new URL('../validation/algo-v2-btcusdt-blind-oos.json',import.meta.url);
export const BLIND_OOS_DIGEST_URL=new URL('../validation/algo-v2-btcusdt-blind-oos.sha256',import.meta.url);

function monthIndex(key){
  const m=String(key).match(/^(\d{4})-(\d{2})$/);
  if(!m) throw new Error('INVALID_MONTH_KEY');
  const y=Number(m[1]), mo=Number(m[2]);
  if(mo<1||mo>12) throw new Error('INVALID_MONTH_KEY');
  return y*12+(mo-1);
}

function monthKeyFromIndex(index){
  const y=Math.floor(index/12);
  const mo=(index%12)+1;
  return `${y}-${String(mo).padStart(2,'0')}`;
}

function lastHourOfMonth(month){
  const [year,mo]=month.split('-').map(Number);
  return new Date(Date.UTC(year,mo,1)-3600000).toISOString();
}

function firstHourOfMonth(month){
  const [year,mo]=month.split('-').map(Number);
  return new Date(Date.UTC(year,mo-1,1,0,0,0,0)).toISOString();
}

function stableStringify(value){
  if(Array.isArray(value)) return `[${value.map(item=>stableStringify(item)).join(',')}]`;
  if(value && typeof value==='object'){
    return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(input){
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

export function latestFullyClosedMonthUtc(now=new Date()){
  const date=now instanceof Date ? now : new Date(now);
  const y=date.getUTCFullYear();
  const mo=date.getUTCMonth();
  const lastClosedIndex=y*12+mo-1;
  return monthKeyFromIndex(lastClosedIndex);
}

export function assertBlindOosCanOpen({freezeRecord=FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD,blindOosEvidenceExists=false}={}){
  assertFrozenAlgoV2CandidateFreezeRecord(freezeRecord);
  if(blindOosEvidenceExists) throw new Error('BLIND_OOS_ALREADY_EXECUTED');
  if(freezeRecord.freeze?.blindOosOpened!==false) throw new Error('BLIND_OOS_ALREADY_OPENED');
  if(freezeRecord.freeze?.oosLocked!==true) throw new Error('OOS_LOCK_STATE_DRIFT');
  if(freezeRecord.freeze?.thresholdPct!==25) throw new Error('FROZEN_CANDIDATE_THRESHOLD_DRIFT');
  return freezeRecord;
}

export async function resolveLatestAvailableClosedSpotArchiveMonth({symbol='BTCUSDT',now=new Date(),fetchImpl=fetch}={}){
  const start=monthIndex(BLIND_OOS_START_MONTH);
  for(let probe=monthIndex(latestFullyClosedMonthUtc(now));probe>=start;probe--){
    const month=monthKeyFromIndex(probe);
    const head=await fetchImpl(spotArchiveUrl({symbol,month}),{method:'HEAD',redirect:'follow'});
    if(head.ok) return month;
    if(head.status===404) continue;
    throw new Error(`SPOT_ARCHIVE_HEAD_FAILED:${month}:${head.status}`);
  }
  throw new Error('NO_CLOSED_BLIND_OOS_MONTH_AVAILABLE');
}

export function assertFrozenBlindOosRecord(record,{digest}={}){
  if(!record || typeof record!=='object') throw new Error('INVALID_BLIND_OOS_RECORD');
  if(record.schemaVersion!==1) throw new Error('INVALID_BLIND_OOS_SCHEMA');
  if(record.freezeEvidence?.head!==FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD.evidence.researchHead) throw new Error('BLIND_OOS_FREEZE_EVIDENCE_DRIFT');
  if(record.freezeEvidence?.candidateThresholdPct!==25) throw new Error('BLIND_OOS_THRESHOLD_DRIFT');
  if(record.oos?.state!=='OPENED_ONCE') throw new Error('BLIND_OOS_STATE_DRIFT');
  if(record.oos?.openCount!==1) throw new Error('BLIND_OOS_OPEN_COUNT_DRIFT');
  if(record.oos?.blindOosOpened!==true) throw new Error('BLIND_OOS_FLAG_MISSING');
  if(record.oos?.selectionReuseAllowed!==false) throw new Error('BLIND_OOS_SELECTION_REUSE_FORBIDDEN');
  if(record.oos?.tuningAfterFreeze!==false) throw new Error('BLIND_OOS_TUNING_DRIFT');
  if(record.provenance?.market!=='BYBIT_SPOT' || record.provenance?.source!=='BYBIT_PUBLIC_SPOT_TRADE_ARCHIVES') throw new Error('BLIND_OOS_PROVENANCE_DRIFT');
  for(const [key,value] of Object.entries(FROZEN_ALGO_V2_PARAMETERS)) if(record.parameters?.[key]!==value) throw new Error(`BLIND_OOS_PARAMETER_DRIFT:${key}`);
  const expectedPassCriteria=FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD.blindOosPassCriteria;
  if(stableStringify(record.passCriteria)!==stableStringify(expectedPassCriteria)) throw new Error('BLIND_OOS_PASS_CRITERIA_DRIFT');
  const expectedSyntheticRepairCheck=record.provenance?.syntheticRepair===false;
  if(record.evaluation?.checks?.syntheticRepair!==expectedSyntheticRepairCheck) throw new Error('BLIND_OOS_SYNTHETIC_REPAIR_CHECK_DRIFT');
  const expectedDataQualityCheck=(record.provenance?.gapCount===0 && record.provenance?.syntheticCandles===0);
  if(record.evaluation?.checks?.dataQualityViolations!==expectedDataQualityCheck) throw new Error('BLIND_OOS_DATA_QUALITY_CHECK_DRIFT');
  const serialized=`${JSON.stringify(record,null,2)}\n`;
  if(digest!=null && sha256Hex(serialized)!==digest) throw new Error('BLIND_OOS_DIGEST_MISMATCH');
  return record;
}

export async function readFrozenBlindOosRecord({
  recordUrl=BLIND_OOS_RECORD_URL,
  digestUrl=BLIND_OOS_DIGEST_URL,
}={}){
  const raw=await readFile(recordUrl,'utf8');
  const digestText=await readFile(digestUrl,'utf8');
  const digest=digestText.trim().split(/\s+/)[0];
  const record=JSON.parse(raw);
  assertFrozenBlindOosRecord(record,{digest});
  return {record,digest};
}

export function expectedBlindOosContextMonths(endMonth){
  if(monthIndex(endMonth)<monthIndex(BLIND_OOS_START_MONTH)) throw new Error('INVALID_BLIND_OOS_END_MONTH');
  return monthKeys('2022-11',endMonth);
}

export function blindOosCoverageRange(endMonth){
  if(monthIndex(endMonth)<monthIndex(BLIND_OOS_START_MONTH)) throw new Error('INVALID_BLIND_OOS_END_MONTH');
  const first='2022-11-10T00:00:00.000Z';
  const last=lastHourOfMonth(endMonth);
  return {
    expectedFirst:first,
    expectedLast:last,
    expectedCandleCount:(Date.parse(last)-Date.parse(first))/3600000+1,
    oosTradingStartTime:firstHourOfMonth(BLIND_OOS_START_MONTH),
  };
}

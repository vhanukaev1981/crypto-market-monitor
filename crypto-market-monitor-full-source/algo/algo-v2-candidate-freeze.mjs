import { readFile } from 'node:fs/promises';

function freezeDeep(value){
  if(!value || typeof value!=='object') return value;
  for(const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

export const FROZEN_ALGO_V2_PARAMETERS=freezeDeep({
  startingEquity:100000,
  riskPct:0.0035,
  maxPositionPct:0.25,
  hardExposurePct:0.30,
  atrStopMult:1.5,
  trailAtrMult:2.0,
  spreadBps:2,
  slippageBps:2,
  feeBps:10,
  maxSpreadBps:10,
  maxSlippageBps:10,
});

export const FROZEN_ALGO_V2_RESEARCH_CANDIDATE=freezeDeep({
  name:'DAILY_EMA200_OVEREXTENSION',
  status:'FROZEN_FOR_FUTURE_BLIND_OOS',
  thresholdPct:25,
  evaluatedThresholdsPct:[20,25,30],
  sensitivityOnlyThresholdsPct:[20,30],
  rationale:'Avoid long entries after the completed 1D trend is materially overextended above EMA200.',
  usesCompletedHigherTimeframeOnly:true,
  tuningAfterFreeze:false,
  oosLocked:true,
  blindOosOpened:false,
  noStrategyBehaviorChange:true,
});

export const FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD=freezeDeep({
  schemaVersion:1,
  evidence:{
    researchHead:'03211a2a7d1bb55b20fc9d9b91b39cfd1c1ac3f9',
    workflowName:'ALGO V2 Bybit Spot Research',
    workflowRunId:33065509531,
    artifact:{
      name:'algo-v2-btc-bybit-spot-research',
      id:9643733715,
      digest:'sha256:757f23fe259f81bfa275a9a2ed2324274de13bcc00fe9b3bb900f98e181d0021',
    },
  },
  provenance:{
    market:'BYBIT_SPOT',
    source:'BYBIT_PUBLIC_SPOT_TRADE_ARCHIVES',
    aggregation:'TRADE_STREAM_TO_OHLCV_1H',
    interval:'1h',
    researchWindowStartMonth:'2022-11',
    researchWindowEndMonth:'2024-12',
    blindOosWindow:'2025-01 onward',
    archiveCoverageStart:'2022-11-10T00:00:00.000Z',
    archiveCoverageEnd:'2024-12-31T23:00:00.000Z',
    candleCount:18792,
    gapCount:0,
    syntheticCandles:0,
    syntheticRepair:false,
    preArchiveMissingHours:216,
  },
  freeze:{
    candidateName:FROZEN_ALGO_V2_RESEARCH_CANDIDATE.name,
    candidateState:FROZEN_ALGO_V2_RESEARCH_CANDIDATE.status,
    thresholdPct:FROZEN_ALGO_V2_RESEARCH_CANDIDATE.thresholdPct,
    evaluatedThresholdsPct:FROZEN_ALGO_V2_RESEARCH_CANDIDATE.evaluatedThresholdsPct,
    sensitivityOnlyThresholdsPct:FROZEN_ALGO_V2_RESEARCH_CANDIDATE.sensitivityOnlyThresholdsPct,
    rationale:FROZEN_ALGO_V2_RESEARCH_CANDIDATE.rationale,
    usesCompletedHigherTimeframeOnly:FROZEN_ALGO_V2_RESEARCH_CANDIDATE.usesCompletedHigherTimeframeOnly,
    tuningAfterFreeze:FROZEN_ALGO_V2_RESEARCH_CANDIDATE.tuningAfterFreeze,
    oosLocked:FROZEN_ALGO_V2_RESEARCH_CANDIDATE.oosLocked,
    blindOosOpened:FROZEN_ALGO_V2_RESEARCH_CANDIDATE.blindOosOpened,
    noStrategyBehaviorChange:FROZEN_ALGO_V2_RESEARCH_CANDIDATE.noStrategyBehaviorChange,
  },
  parameters:FROZEN_ALGO_V2_PARAMETERS,
  metrics:{
    research2023:{
      netReturnPct:5.802356,
      maxDrawdownPct:1.93061,
      profitFactor:4.525931,
      expectancy:362.647258,
      completedTrades:16,
    },
    validation2024:{
      netReturnPct:0.484937,
      maxDrawdownPct:3.125476,
      profitFactor:1.07045,
      expectancy:12.123436,
      completedTrades:40,
    },
  },
  blindOosPassCriteria:{
    netReturnPct:'>0',
    profitFactor:'>1.0',
    expectancy:'>0',
    maxDrawdownPct:'<=5.0',
    maxExposurePct:'<=30.0',
    syntheticRepair:false,
    dataQualityViolations:0,
    tuningAfterFreeze:false,
  },
});

const RISK_PARAMETER_KEYS=new Set(['startingEquity','riskPct','maxPositionPct','hardExposurePct','atrStopMult','trailAtrMult']);
const EXECUTION_PARAMETER_KEYS=new Set(['spreadBps','slippageBps','feeBps','maxSpreadBps','maxSlippageBps']);
const FREEZE_RECORD_URL=new URL('../validation/algo-v2-candidate-freeze.json',import.meta.url);

function assertExactSubset(actual, expected, errorPrefix){
  for(const [key,value] of Object.entries(expected)){
    if(Array.isArray(value)){
      if(!Array.isArray(actual?.[key]) || JSON.stringify(actual[key])!==JSON.stringify(value)) throw new Error(`${errorPrefix}:${key}`);
      continue;
    }
    if(value && typeof value==='object'){
      assertExactSubset(actual?.[key],value,`${errorPrefix}:${key}`);
      continue;
    }
    if(actual?.[key]!==value) throw new Error(`${errorPrefix}:${key}`);
  }
}

function assertExactShape(actual, expected, errorPrefix){
  if(Array.isArray(expected)){
    if(!Array.isArray(actual) || actual.length!==expected.length) throw new Error(errorPrefix);
    for(let i=0;i<expected.length;i++) assertExactShape(actual[i],expected[i],`${errorPrefix}:${i}`);
    return;
  }
  if(expected && typeof expected==='object'){
    if(!actual || typeof actual!=='object' || Array.isArray(actual)) throw new Error(errorPrefix);
    const actualKeys=Object.keys(actual).sort();
    const expectedKeys=Object.keys(expected).sort();
    if(JSON.stringify(actualKeys)!==JSON.stringify(expectedKeys)) throw new Error(errorPrefix);
    for(const key of expectedKeys) assertExactShape(actual[key],expected[key],`${errorPrefix}:${key}`);
    return;
  }
  if(actual!==expected) throw new Error(errorPrefix);
}

export function assertFrozenAlgoV2CandidateFreezeRecord(record){
  if(!record || typeof record!=='object') throw new Error('INVALID_FROZEN_CANDIDATE_RECORD');
  if(record.freeze?.thresholdPct!==FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD.freeze.thresholdPct) throw new Error('FROZEN_CANDIDATE_THRESHOLD_DRIFT');
  if(record.freeze?.oosLocked!==true) throw new Error('OOS_LOCK_STATE_DRIFT');
  if(record.freeze?.blindOosOpened!==false) throw new Error('BLIND_OOS_ALREADY_OPENED');
  if(record.freeze?.candidateState!==FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD.freeze.candidateState) throw new Error('FROZEN_CANDIDATE_STATE_DRIFT');
  if(JSON.stringify(record.freeze?.sensitivityOnlyThresholdsPct)!==JSON.stringify(FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD.freeze.sensitivityOnlyThresholdsPct)) {
    throw new Error('FROZEN_CANDIDATE_SENSITIVITY_DRIFT');
  }
  if(JSON.stringify(record.freeze?.evaluatedThresholdsPct)!==JSON.stringify(FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD.freeze.evaluatedThresholdsPct)) {
    throw new Error('FROZEN_CANDIDATE_EVALUATION_SET_DRIFT');
  }
  if(record.freeze?.tuningAfterFreeze!==false) throw new Error('FROZEN_TUNING_STATE_DRIFT');
  for(const [key,value] of Object.entries(FROZEN_ALGO_V2_PARAMETERS)){
    if(record.parameters?.[key]===value) continue;
    if(RISK_PARAMETER_KEYS.has(key)) throw new Error(`FROZEN_RISK_PARAMETER_DRIFT:${key}`);
    if(EXECUTION_PARAMETER_KEYS.has(key)) throw new Error(`FROZEN_EXECUTION_PARAMETER_DRIFT:${key}`);
    throw new Error(`FROZEN_PARAMETER_DRIFT:${key}`);
  }
  assertExactSubset(record.provenance,FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD.provenance,'FROZEN_PROVENANCE_DRIFT');
  assertExactSubset(record.evidence,FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD.evidence,'FROZEN_EVIDENCE_DRIFT');
  assertExactSubset(record.metrics,FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD.metrics,'FROZEN_METRICS_DRIFT');
  assertExactSubset(record.blindOosPassCriteria,FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD.blindOosPassCriteria,'FROZEN_BLIND_OOS_PASS_CRITERIA_DRIFT');
  return record;
}

export async function readFrozenAlgoV2CandidateFreezeRecord(){
  const raw=await readFile(FREEZE_RECORD_URL,'utf8');
  const record=JSON.parse(raw);
  assertFrozenAlgoV2CandidateFreezeRecord(record);
  assertExactShape(record,FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD,'FROZEN_RECORD_JSON_MISMATCH');
  return record;
}

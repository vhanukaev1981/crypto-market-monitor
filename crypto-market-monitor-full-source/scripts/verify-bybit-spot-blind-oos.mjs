import { readFrozenBlindOosRecord } from '../algo/algo-v2-blind-oos.mjs';

try{
  const {record,digest}=await readFrozenBlindOosRecord();
  console.log(JSON.stringify({
    recordPath:'validation/algo-v2-btcusdt-blind-oos.json',
    digestPath:'validation/algo-v2-btcusdt-blind-oos.sha256',
    digest,
    promotionState:record.oos.promotionState,
    passed:record.evaluation.passed,
  },null,2));
}catch(error){
  if(error?.code==='ENOENT'){
    console.log(JSON.stringify({
      recordPath:'validation/algo-v2-btcusdt-blind-oos.json',
      digestPath:'validation/algo-v2-btcusdt-blind-oos.sha256',
      status:'NO_COMMITTED_BLIND_OOS_EVIDENCE',
    },null,2));
    process.exit(0);
  }
  throw error;
}

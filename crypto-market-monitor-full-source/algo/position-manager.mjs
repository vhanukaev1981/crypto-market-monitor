// P0 Task 7: DB-authoritative projection of authenticated exchange fills.
// Never create a fill from order acknowledgement, orderStatus, or RAM state.
// The upstream caller is responsible for proving execution IDs and fee conversion.
export function createPositionManager({pool,executionStore,executorFence}={}){
 if(!pool||typeof pool.query!=='function'||!executionStore||!executorFence||
   typeof executorFence.assertCurrent!=='function')throw Error('position-manager requires PostgreSQL, executionStore and executorFence');
 const token=x=>{
   if(!Number.isSafeInteger(x)||x<=0)throw Error('positive executor fenceToken required');
   return x;
 };
 const name=(label,x)=>{
   if(typeof x!=='string'||!x.trim())throw Error(label+' required');
   return x;
 };
 const amount=(label,x,zero=false)=>{
   if(!['number','string'].includes(typeof x)||!/^[0-9]+(?:\.[0-9]{1,12})?$/.test(String(x))||
     (zero?Number(x)<0:Number(x)<=0)||!Number.isFinite(Number(x)))throw Error(label+' invalid decimal');
   return x;
 };
 async function one(sql,args,label){
   const r=await pool.query(sql,args);
   if(!r||!Array.isArray(r.rows)||!r.rows[0])throw Error('position-manager '+label+' returned no row');
   return r.rows[0];
 }
 async function checked(fenceToken){
   token(fenceToken);
   await executorFence.assertCurrent({fenceToken});
 }
 function singleFill(fills){
   if(!Array.isArray(fills)||fills.length!==1||!fills[0])throw Error('exactly one authenticated fill required per apply');
   const f=fills[0];
   if(f.feeCurrency!=='USDT')throw Error('UNSUPPORTED_FEE_CURRENCY: cannot treat non-USDT fees as USDT');
   return {
     execId:name('execId',f.execId),
     qty:amount('execQty',f.execQty),
     price:amount('execPrice',f.execPrice),
     fee:amount('execFee',f.execFee??0,true)
   };
 }
 return Object.freeze({
  async applyBuyFill({execution,fills,fenceToken}={}){
   const f=singleFill(fills);await checked(fenceToken);
   return one('select * from public.algobot_apply_position_buy_fill($1,$2,$3,$4,$5,$6)',
     [name('buy orderLinkId',execution?.orderLinkId),f.execId,f.qty,f.price,f.fee,fenceToken],
     'applyBuyFill');
  },
  async requestExit({positionId,reason,orderLinkId,fenceToken}={}){
   await checked(fenceToken);
   return one('select * from public.algobot_request_position_exit($1,$2,$3,$4)',
     [name('positionId',positionId),name('reason',reason),name('orderLinkId',orderLinkId),fenceToken],
     'requestExit');
  },
  async applySellFill({positionId,execution,fills,fenceToken}={}){
   const f=singleFill(fills);await checked(fenceToken);
   return one('select * from public.algobot_apply_position_sell_fill($1,$2,$3,$4,$5,$6,$7)',
     [name('positionId',positionId),name('sell orderLinkId',execution?.orderLinkId),
       f.execId,f.qty,f.price,f.fee,fenceToken],'applySellFill');
  },
  async listManagedPositions(){
   const result=await pool.query('select * from public.algobot_list_managed_positions()',[]);
   if(!result||!Array.isArray(result.rows))throw Error('position-manager unable to inspect positions');
   return result.rows;
  }
 });
}

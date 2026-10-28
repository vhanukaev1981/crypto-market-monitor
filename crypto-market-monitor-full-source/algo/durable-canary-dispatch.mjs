// P0 crash-safe CANARY execution orchestration.
// This is NOT a trading authorization: startup recovery must provide an
// independently verified isTradingEnabled gate and database executor token.
// Exchange evidence must come from the authenticated Bybit transport.
const SCALE=10n**12n;
function units(v,label){
  const s=String(v ?? '');
  if(!/^[0-9]+(?:\.[0-9]{1,12})?$/.test(s))throw Error('INVALID_EXCHANGE_DECIMAL: '+label);
  const [whole,frac='']=s.split('.');
  return BigInt(whole)*SCALE+BigInt((frac+'0'.repeat(12)).slice(0,12));
}
function decimal(v){return (v/SCALE).toString()+'.'+(v%SCALE).toString().padStart(12,'0');}
function requireDeps({executionStore,canaryBudgetStore,executorFence,recoveryGate,transport,fenceToken}){
  const methods=[
    [executionStore,['getByOrderLinkId','createExecution','markInFlight','markUnknown',
      'applyExchangeEvidence','lockTrading']],
    [canaryBudgetStore,['reserve','commit']],
    [executorFence,['assertCurrent']],
    [recoveryGate,['isTradingEnabled']],
    [transport,['placeOrder','reconcileOrder','listExecutions']]
  ];
  if(!Number.isSafeInteger(fenceToken)||fenceToken<=0 ||
     methods.some(([v,names])=>!v||names.some(n=>typeof v[n]!=='function'))){
    throw Error('DURABLE_EXECUTION_REQUIRED: persistent stores, fencing, recovery and verified transport are mandatory');
  }
}
export function createDurableCanaryDispatcher(config={}){
  requireDeps(config);
  const {executionStore,canaryBudgetStore,executorFence,recoveryGate,transport,fenceToken}=config;
  let healthy=true;
  const healthyNow=()=>healthy;
  async function guarded(){
    if(!healthy || await recoveryGate.isTradingEnabled()!==true){
      throw Error('RECOVERY_LOCKED: verified startup recovery and healthy execution are required');
    }
    await executorFence.assertCurrent({fenceToken});
  }
  async function submit({symbol,side,orderLinkId,notionalUsdt}={}){
    if(symbol!=='BTCUSDT'||!['BUY','SELL'].includes(side) ||
      typeof orderLinkId!=='string'||!/^[A-Za-z0-9_-]{1,36}$/.test(orderLinkId) ||
      !Number.isFinite(notionalUsdt)||notionalUsdt<=0||notionalUsdt>10){
      throw Error('DURABLE_REQUEST_INVALID: strict BTCUSDT Spot CANARY constraints required');
    }
    await guarded();
    const existing=await executionStore.getByOrderLinkId({orderLinkId});
    if(existing){
      if(existing.symbol!==symbol||existing.side!==side||
        units(existing.requested_notional_usdt,'existing-notional')!==units(notionalUsdt,'requested-notional')){
        throw Error('IDEMPOTENCY_CONFLICT: persisted order differs from new request');
      }
      return Object.freeze({success:false,duplicate:true,orderLinkId,
        status:existing.status,orderId:existing.exchange_order_id??null});
    }
    await executionStore.createExecution({
      orderLinkId,symbol,side,requestedQty:0,requestedNotional:notionalUsdt,fenceToken
    });
    const reservation=await canaryBudgetStore.reserve({
      orderLinkId,requestedNotionalUsdt:notionalUsdt,executorFenceToken:fenceToken
    });
    if(!reservation?.reservationId){
      throw Error('DURABLE_RESERVATION_MISSING: no committed reservation evidence');
    }
    await executionStore.markInFlight({orderLinkId,fenceToken});
    // A crash after IN_FLIGHT and before exchange dispatch remains unresolved.
    // Only cold-start reconciliation may prove a safe next action.
    let attempted=false;
    try{
      await guarded();
      const orderPayload={category:'spot',symbol,
        side:side==='BUY'?'Buy':'Sell',orderType:'Market',
        qty:String(notionalUsdt),marketUnit:'quoteCoin',orderLinkId};
      attempted=true;  // a timeout after this point is not proof of rejection
      const placed=await transport.placeOrder(orderPayload);
      const exchangeOrderId=placed?.result?.orderId;
      if(placed?.retCode!==0||typeof exchangeOrderId!=='string'||!exchangeOrderId||
        placed.result.orderLinkId!==orderLinkId){
        throw Error('EXCHANGE_ACK_UNVERIFIED');
      }
      const reconciliation=await transport.reconcileOrder({orderLinkId,
        orderId:exchangeOrderId,symbol});
      const rec=reconciliation?.result;
      if(reconciliation?.retCode!==0||rec?.category!=='spot'||
        rec?.symbol!==symbol||rec?.side!==orderPayload.side||
        rec?.orderType!=='Market'||rec?.orderStatus!=='Filled'||
        rec?.orderId!==exchangeOrderId||rec?.orderLinkId!==orderLinkId){
        throw Error('RECONCILIATION_INCOMPLETE');
      }
      const fills=await transport.listExecutions({orderLinkId,
        orderId:exchangeOrderId,symbol});
      const page=fills?.result;
      if(fills?.retCode!==0||page?.category!=='spot'||
        page.hasMore!==false||!Array.isArray(page.list)||page.list.length===0){
        throw Error('EXCHANGE_FILLS_INCOMPLETE');
      }
      let q=0n,v=0n,fee=0n;
      const seen=new Set();
      for(const f of page.list){
        if(f?.orderId!==exchangeOrderId||f?.orderLinkId!==orderLinkId||
          f?.symbol!==symbol||f?.side!==orderPayload.side||
          f?.orderType!=='Market'||f?.execType!=='Trade'||
          typeof f.execId!=='string'||!f.execId||seen.has(f.execId)){
          throw Error('EXCHANGE_FILL_IDENTITY_MISMATCH');
        }
        seen.add(f.execId);
        if(f.feeCurrency!=='USDT'){
          // Fees paid in BTC require a dedicated valued-fee accounting model.
          // Never mislabel BTC fees as USDT.
          throw Error('FEE_CURRENCY_ACCOUNTING_UNSUPPORTED');
        }
        const eq=units(f.execQty,'qty'),ev=units(f.execValue,'value'),ef=units(f.execFee,'fee');
        if(eq<=0n||ev<=0n||ef<0n||units(f.execPrice,'price')<=0n){
          throw Error('EXCHANGE_FILL_AMOUNT_INVALID');
        }
        q+=eq;v+=ev;fee+=ef;
      }
      if(q!==units(rec.cumExecQty,'cumExecQty') ||
         v!==units(rec.cumExecValue,'cumExecValue') ||
         v>units(notionalUsdt,'authorized notional')){
        throw Error('EXCHANGE_FILL_TOTAL_MISMATCH');
      }
      const avg=decimal(v*SCALE/q);
      await executionStore.applyExchangeEvidence({
        orderLinkId,status:'FILLED',exchangeOrderId,filledQty:decimal(q),
        filledNotional:decimal(v),avgFillPrice:avg,fees:decimal(fee),fenceToken
      });
      await canaryBudgetStore.commit({reservationId:reservation.reservationId,
        filledNotionalUsdt:Number(decimal(v)),executorFenceToken:fenceToken});
      return Object.freeze({
        success:true,duplicate:false,status:'FILLED',orderLinkId,orderId:exchangeOrderId,
        filledQty:decimal(q),filledNotionalUsdt:decimal(v),avgPrice:avg,
        feesUsdt:decimal(fee),cumulativeExposureUsdt:reservation.totalAuthorizedUsdt
      });
    }catch(err){
      healthy=false;
      // Independently persist a trading lock, even if fill was recorded but
      // the budget commit or a subsequent step failed.
      const lockErrors=[];
      try{await executionStore.lockTrading({fenceToken,reason:'CANARY_EXECUTION_UNCERTAIN'});}
      catch(e){lockErrors.push(e);}
      if(attempted){
        try{await executionStore.markUnknown({orderLinkId,reason:'EXCHANGE_RECONCILIATION_UNCERTAIN',fenceToken});}
        catch(e){lockErrors.push(e);}
      }
      throw Error('CANARY_UNKNOWN_LOCKED: exchange or ledger outcome unconfirmed'+
        (lockErrors.length?' (persistent lock/reconciliation needs recovery)':''),{cause:err});
    }
  }
  return Object.freeze({submit,isHealthy:healthyNow});
}

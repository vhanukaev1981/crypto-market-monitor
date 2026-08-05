import { NextResponse } from "next/server";

type Intelligence = {
  updatedAt: number;
  global: null | { marketCap:number; volume:number; btcDominance:number; ethDominance:number; markets:number };
  stablecoins: { symbol:string; name:string; price:number; marketCap:number; circulatingSupply:number; change24h:number; deviation:number; depeg:boolean }[];
  bitcoin: null | { fastestFee:number; halfHourFee:number; hourFee:number; minimumFee:number; mempoolCount:number; mempoolVsize:number; blockHeight:number; averageBlockMinutes:number };
  tertiary: Record<string, number> | null;
  sources: { name:string; status:"ok"|"unavailable"; updatedAt:number }[];
};

async function json(url:string) {
  const response=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(8000),next:{revalidate:60}});
  if(!response.ok) throw new Error(String(response.status));
  return response.json();
}

export async function GET() {
  const now=Date.now();
  const out:Intelligence={updatedAt:now,global:null,stablecoins:[],bitcoin:null,tertiary:null,sources:[]};
  await Promise.allSettled([
    Promise.all([
      json("https://api.coingecko.com/api/v3/global"),
      json("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=tether,usd-coin,dai,first-digital-usd&price_change_percentage=24h"),
    ]).then(([globalResult,stableResult])=>{
      const data=globalResult.data;
      out.global={marketCap:Number(data.total_market_cap?.usd),volume:Number(data.total_volume?.usd),btcDominance:Number(data.market_cap_percentage?.btc),ethDominance:Number(data.market_cap_percentage?.eth),markets:Number(data.markets)};
      out.stablecoins=(stableResult as Array<Record<string,unknown>>).map(item=>{
        const price=Number(item.current_price);
        return {symbol:String(item.symbol).toUpperCase(),name:String(item.name),price,marketCap:Number(item.market_cap),circulatingSupply:Number(item.circulating_supply),change24h:Number(item.price_change_percentage_24h),deviation:(price-1)*100,depeg:Math.abs(price-1)>=.01};
      });
      out.sources.push({name:"CoinGecko Global",status:"ok",updatedAt:now});
    }).catch(()=>out.sources.push({name:"CoinGecko Global",status:"unavailable",updatedAt:now})),
    Promise.all([
      json("https://mempool.space/api/v1/fees/recommended"),
      json("https://mempool.space/api/mempool"),
      json("https://mempool.space/api/blocks/tip/height"),
      json("https://mempool.space/api/v1/blocks"),
    ]).then(([fees,pool,height,blocks])=>{
      const recent=(blocks as Array<{timestamp:number}>).slice(0,6);
      const intervals=recent.slice(1).map((b,i)=>(recent[i].timestamp-b.timestamp)/60);
      out.bitcoin={fastestFee:Number(fees.fastestFee),halfHourFee:Number(fees.halfHourFee),hourFee:Number(fees.hourFee),minimumFee:Number(fees.minimumFee),mempoolCount:Number(pool.count),mempoolVsize:Number(pool.vsize),blockHeight:Number(height),averageBlockMinutes:intervals.reduce((a,b)=>a+b,0)/Math.max(1,intervals.length)};
      out.sources.push({name:"mempool.space",status:"ok",updatedAt:now});
    }).catch(()=>out.sources.push({name:"mempool.space",status:"unavailable",updatedAt:now})),
    json("https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD").then(result=>{
      const rows=result.result||{};
      const btc=Object.entries(rows).find(([key])=>key.includes("XBT"))?.[1] as {c?:string[]}|undefined;
      const eth=Object.entries(rows).find(([key])=>key.includes("ETH"))?.[1] as {c?:string[]}|undefined;
      out.tertiary={BTC:Number(btc?.c?.[0]),ETH:Number(eth?.c?.[0])};
      out.sources.push({name:"Kraken Public API",status:"ok",updatedAt:now});
    }).catch(()=>out.sources.push({name:"Kraken Public API",status:"unavailable",updatedAt:now})),
  ]);
  return NextResponse.json(out,{headers:{"Cache-Control":"public, max-age=60, stale-while-revalidate=180"}});
}

import { NextResponse } from "next/server";

const API_BASE = "https://api.bybit.com";
const SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT", "XRPUSDT",
  "DOGEUSDT", "BNBUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
] as const;

type BybitTicker = {
  symbol: string;
  lastPrice: string;
  price24hPcnt: string;
  highPrice24h: string;
  lowPrice24h: string;
  turnover24h: string;
  volume24h: string;
};
type LinearTicker = BybitTicker & {
  indexPrice: string; markPrice: string; openInterest: string; openInterestValue: string;
  fundingRate: string; nextFundingTime: string; bid1Price: string; ask1Price: string;
};

const intervalMap: Record<string, { interval: string; limit: number }> = {
  "24h": { interval: "60", limit: 24 },
  "7d": { interval: "240", limit: 42 },
  "30d": { interval: "D", limit: 30 },
  "90d": { interval: "D", limit: 90 },
};

async function bybit(path: string) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });

  if (!response.ok) throw new Error(`Bybit returned ${response.status}`);
  const payload = await response.json();
  if (payload.retCode !== 0) throw new Error(payload.retMsg || "Bybit request failed");
  return payload.result;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const range = params.get("range") || "7d";
    const requestedSymbol = (params.get("symbol") || "BTC").toUpperCase();
    const marketSymbol = `${requestedSymbol}USDT`;
    const symbol = SYMBOLS.includes(marketSymbol as (typeof SYMBOLS)[number]) ? marketSymbol : "BTCUSDT";
    const chart = intervalMap[range] ?? intervalMap["7d"];

    const comparisonSymbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT"];
    const [tickerResult, klineResult, orderbookResult] = await Promise.all([
      bybit("/v5/market/tickers?category=spot"),
      bybit(`/v5/market/kline?category=spot&symbol=${symbol}&interval=${chart.interval}&limit=${chart.limit}`),
      bybit(`/v5/market/orderbook?category=spot&symbol=${symbol}&limit=25`),
    ]);

    // Optional research panels must never take the core market feed down with them.
    const [linearResult, comparisonResults] = await Promise.all([
      bybit(`/v5/market/tickers?category=linear&symbol=${symbol}`).catch(() => null),
      Promise.allSettled(comparisonSymbols.map((item) => bybit(`/v5/market/kline?category=spot&symbol=${item}&interval=D&limit=30`))),
    ]);

    const allTickers = tickerResult.list as BybitTicker[];
    const tickers = SYMBOLS.map((symbol) => allTickers.find((item) => item.symbol === symbol))
      .filter((item): item is BybitTicker => Boolean(item))
      .map((item) => ({
        symbol: item.symbol.replace("USDT", ""),
        lastPrice: Number(item.lastPrice),
        change24h: Number(item.price24hPcnt) * 100,
        high24h: Number(item.highPrice24h),
        low24h: Number(item.lowPrice24h),
        turnover24h: Number(item.turnover24h),
        volume24h: Number(item.volume24h),
      }))
      .filter((item) => [item.lastPrice, item.change24h, item.high24h, item.low24h, item.turnover24h, item.volume24h].every(Number.isFinite));

    const candles = (klineResult.list as string[][])
      .map((row) => ({
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        turnover: Number(row[6]),
      }))
      .filter((row) => Object.values(row).every(Number.isFinite))
      .reverse();
    if (!tickers.length || !candles.length) throw new Error("Bybit returned an incomplete core payload");
    const bids = (orderbookResult.b as string[][]).map(([price, size]) => ({ price: Number(price), size: Number(size) })).filter(row => Number.isFinite(row.price) && Number.isFinite(row.size));
    const asks = (orderbookResult.a as string[][]).map(([price, size]) => ({ price: Number(price), size: Number(size) })).filter(row => Number.isFinite(row.price) && Number.isFinite(row.size));
    const bidDepth = bids.reduce((sum, row) => sum + row.price * row.size, 0);
    const askDepth = asks.reduce((sum, row) => sum + row.price * row.size, 0);
    const bestBid = bids[0]?.price;
    const bestAsk = asks[0]?.price;
    const derivativesRaw = (linearResult?.list?.[0] ?? {}) as Partial<LinearTicker>;
    const markPrice = finite(derivativesRaw.markPrice);
    const indexPrice = finite(derivativesRaw.indexPrice);
    const derivatives = markPrice !== null && indexPrice !== null ? {
      markPrice, indexPrice,
      openInterest: finite(derivativesRaw.openInterest),
      openInterestValue: finite(derivativesRaw.openInterestValue),
      fundingRate: finite(derivativesRaw.fundingRate) === null ? null : Number(derivativesRaw.fundingRate) * 100,
      nextFundingTime: finite(derivativesRaw.nextFundingTime),
      basisPercent: indexPrice ? ((markPrice / indexPrice) - 1) * 100 : null,
    } : null;
    const comparison = comparisonResults.flatMap((entry, index) => {
      if (entry.status !== "fulfilled") return [];
      const values = (entry.value.list as string[][])
        .map((row) => ({ time: Number(row[0]), close: Number(row[4]) }))
        .filter(row => Number.isFinite(row.time) && Number.isFinite(row.close))
        .reverse();
      return values.length > 2 ? [{ symbol: comparisonSymbols[index].replace("USDT", ""), values }] : [];
    });

    return NextResponse.json(
      {
        source: "Bybit Public Market API", updatedAt: Date.now(), chartSymbol: symbol.replace("USDT", ""), tickers, candles,
        orderbook: {
          bids: bids.slice(0, 10), asks: asks.slice(0, 10), bestBid, bestAsk,
          spreadPercent: bestBid && bestAsk ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 100 : 0,
          bidDepth, askDepth, imbalance: bidDepth + askDepth ? ((bidDepth - askDepth) / (bidDepth + askDepth)) * 100 : 0,
        },
        derivatives,
        comparison,
        availability: { core: "ok", orderbook: bids.length && asks.length ? "ok" : "unavailable", derivatives: derivatives ? "ok" : "unavailable", comparison: comparison.length === comparisonSymbols.length ? "ok" : comparison.length ? "partial" : "unavailable" },
      },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
    );
  } catch {
    return NextResponse.json(
      { error: "MARKET_DATA_UNAVAILABLE", message: "נתוני השוק אינם זמינים כרגע" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

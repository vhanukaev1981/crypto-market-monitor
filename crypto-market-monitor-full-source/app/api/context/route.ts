import { NextResponse } from "next/server";

const ids: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", ADA: "cardano", XRP: "ripple",
  DOGE: "dogecoin", BNB: "binancecoin", AVAX: "avalanche-2", LINK: "chainlink", DOT: "polkadot",
};

function clean(value: string) {
  return value.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
}

export async function GET() {
  const result: {
    secondary: Record<string, number> | null;
    news: { title: string; link: string; publishedAt: string; source: string }[];
    liquidation: null;
  } = { secondary: null, news: [], liquidation: null };

  await Promise.allSettled([
    fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(ids).join(",")}&vs_currencies=usd`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(7000), next: { revalidate: 60 },
    }).then(async response => {
      if (!response.ok) throw new Error("secondary unavailable");
      const data = await response.json() as Record<string, { usd?: number }>;
      result.secondary = Object.fromEntries(Object.entries(ids).map(([symbol, id]) => [symbol, Number(data[id]?.usd)]));
    }),
    fetch("https://www.coindesk.com/arc/outboundfeeds/rss/", {
      headers: { Accept: "application/rss+xml, application/xml" }, signal: AbortSignal.timeout(7000), next: { revalidate: 300 },
    }).then(async response => {
      if (!response.ok) throw new Error("news unavailable");
      const xml = await response.text();
      result.news = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map(match => {
        const item = match[1];
        const field = (name: string) => clean(item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`))?.[1] || "");
        return { title: field("title"), link: field("link"), publishedAt: field("pubDate"), source: "CoinDesk RSS" };
      }).filter(item => item.title && item.link.startsWith("https://"));
    }),
  ]);

  return NextResponse.json(
    { ...result, updatedAt: Date.now() },
    { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } },
  );
}

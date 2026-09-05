import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url || typeof url !== "string") {
      return NextResponse.json({ ok: false, error: "Missing URL parameter" }, { status: 400 });
    }

    const trimmed = url.trim();

    // If it already has access_token in the string
    if (trimmed.includes("access_token=")) {
      const match = trimmed.match(/access_token=([^&]+)/);
      const refreshMatch = trimmed.match(/refresh_token=([^&]+)/);
      if (match) {
        return NextResponse.json({
          ok: true,
          access_token: decodeURIComponent(match[1]),
          refresh_token: refreshMatch ? decodeURIComponent(refreshMatch[1]) : "",
        });
      }
    }

    // If it is a verify link from the email button
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      try {
        const res = await fetch(trimmed, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        });

        // Supabase /auth/v1/verify typically responds with 302/303 Redirect to site URL with #access_token=...
        const location = res.headers.get("location");
        if (location && location.includes("access_token=")) {
          const match = location.match(/access_token=([^&]+)/);
          const refreshMatch = location.match(/refresh_token=([^&]+)/);
          if (match) {
            return NextResponse.json({
              ok: true,
              access_token: decodeURIComponent(match[1]),
              refresh_token: refreshMatch ? decodeURIComponent(refreshMatch[1]) : "",
            });
          }
        }

        // If it returned body text containing access_token
        const text = await res.text();
        if (text.includes("access_token=")) {
          const match = text.match(/access_token=([^&"']+)/);
          const refreshMatch = text.match(/refresh_token=([^&"']+)/);
          if (match) {
            return NextResponse.json({
              ok: true,
              access_token: decodeURIComponent(match[1]),
              refresh_token: refreshMatch ? decodeURIComponent(refreshMatch[1]) : "",
            });
          }
        }
      } catch (fetchErr: unknown) {
        console.error("Resolve fetch error:", fetchErr);
      }
    }

    return NextResponse.json({ ok: false, error: "Could not extract session from URL" }, { status: 400 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

import { type NextRequest, NextResponse } from "next/server";
import {
  cleanErrorDetail,
  hermesBaseUrl,
  hermesErrorMessage,
  hermesHeaders,
  hermesLatestUrl,
  isPriceId,
} from "~~/utils/hermes";

export const dynamic = "force-dynamic";

/**
 * Server-side proxy for Pyth Hermes. The browser calls this route; the route adds the API key
 * (HERMES_API_KEY, server only) so the key never reaches the browser or the repo.
 */
export async function GET(request: NextRequest) {
  const priceId = request.nextUrl.searchParams.get("id") ?? "";
  if (!isPriceId(priceId)) {
    return NextResponse.json({ error: "Query parameter id must be a 32-byte hex price feed id." }, { status: 400 });
  }

  const apiKey = process.env.HERMES_API_KEY;
  try {
    const upstream = await fetch(hermesLatestUrl(hermesBaseUrl(), priceId), {
      headers: hermesHeaders(apiKey),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!upstream.ok) {
      const detail = cleanErrorDetail(await upstream.text().catch(() => ""), apiKey);
      return NextResponse.json(
        { error: hermesErrorMessage(upstream.status, Boolean(apiKey?.trim()), detail) },
        { status: 502 },
      );
    }
    return NextResponse.json(await upstream.json());
  } catch (error) {
    // Network failures surface as "fetch failed" with the useful code (ENOTFOUND, ETIMEDOUT, ...) in `cause`.
    const reason =
      error instanceof Error ? ((error as { cause?: { code?: string } }).cause?.code ?? error.message) : "";
    return NextResponse.json(
      { error: `Could not reach Hermes${reason ? ` (${reason})` : ""}. Check your connection and HERMES_URL.` },
      { status: 502 },
    );
  }
}

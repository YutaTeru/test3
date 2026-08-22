import { launch } from "@cloudflare/playwright";

interface Env {
  BROWSER: Fetcher;
}

type SiteKey = "kakuyomu" | "nola";

const SITES: Record<SiteKey, string> = {
  kakuyomu: "https://kakuyomu.jp/",
  nola: "https://story.nola-novel.com/",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function getSite(url: URL): SiteKey | null {
  const site = url.searchParams.get("site");
  return site === "kakuyomu" || site === "nola" ? site : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "novel-auto-publisher",
        browserRun: "configured",
        phase: "phase-1-browser-check",
        next: [
          "verify Kakuyomu/Nola pages open in Browser Run",
          "add KV storageState for authenticated sessions",
          "implement draft-only adapters",
          "enable publish only after draft flow is stable",
        ],
      });
    }

    if (url.pathname === "/browser-check" || url.pathname === "/screenshot") {
      const site = getSite(url);
      if (!site) {
        return json(
          { ok: false, error: "Use ?site=kakuyomu or ?site=nola" },
          { status: 400 },
        );
      }

      let browser;
      try {
        browser = await launch(env.BROWSER);
        const page = await browser.newPage();
        await page.goto(SITES[site], {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await page.waitForTimeout(1500);

        if (url.pathname === "/screenshot") {
          const image = await page.screenshot({ fullPage: false });
          return new Response(image, {
            headers: {
              "content-type": "image/png",
              "cache-control": "no-store",
            },
          });
        }

        return json({
          ok: true,
          site,
          requestedUrl: SITES[site],
          finalUrl: page.url(),
          title: await page.title(),
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        return json(
          {
            ok: false,
            site,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 502 },
        );
      } finally {
        await browser?.close();
      }
    }

    if (url.pathname.startsWith("/draft") || url.pathname.startsWith("/publish")) {
      return json(
        {
          ok: false,
          status: "not-enabled-yet",
          reason:
            "Authenticated storageState and site-specific selectors must be verified before draft/publish automation is enabled.",
        },
        { status: 501 },
      );
    }

    return json({ ok: false, error: "Not found" }, { status: 404 });
  },
};

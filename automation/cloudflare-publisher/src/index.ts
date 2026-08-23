import { launch } from "@cloudflare/playwright";

interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

interface Env {
  BROWSER: Fetcher;
  SESSION_KV: KVLike;
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
      "cache-control": "no-store",
      ...init.headers,
    },
  });
}

function getSite(url: URL): SiteKey | null {
  const site = url.searchParams.get("site");
  return site === "kakuyomu" || site === "nola" ? site : null;
}

function sessionKey(site: SiteKey) {
  return `session:${site}`;
}

async function loadStorageState(env: Env, site: SiteKey): Promise<unknown | undefined> {
  const raw = await env.SESSION_KV.get(sessionKey(site));
  if (!raw) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function inspectSite(
  browser: any,
  env: Env,
  site: SiteKey,
  includeScreenshot = false,
) {
  const storedState = await loadStorageState(env, site);
  let context: any;

  try {
    context = await browser.newContext(
      storedState ? { storageState: storedState as any } : {},
    );
    const page = await context.newPage();
    await page.goto(SITES[site], {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(1500);

    const result: Record<string, unknown> = {
      ok: true,
      site,
      requestedUrl: SITES[site],
      finalUrl: page.url(),
      title: await page.title(),
      hasStoredSession: Boolean(storedState),
      checkedAt: new Date().toISOString(),
    };

    if (includeScreenshot) {
      const image = await page.screenshot({
        fullPage: false,
        type: "jpeg",
        quality: 55,
      });
      result.screenshotMime = "image/jpeg";
      result.screenshotBase64 = bytesToBase64(image);
    }

    return result;
  } catch (error) {
    return {
      ok: false,
      site,
      requestedUrl: SITES[site],
      hasStoredSession: Boolean(storedState),
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await context?.close();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "novel-auto-publisher",
        browserRun: "configured",
        sessionStore: "SESSION_KV",
        phase: "phase-2-session-ready",
        next: [
          "verify Kakuyomu/Nola pages in one Browser Run session",
          "capture both site screenshots",
          "bootstrap authenticated sessions with Human in the Loop",
          "implement draft-only adapters",
          "enable publish only after draft flow is stable",
        ],
      });
    }

    if (url.pathname === "/session-status") {
      const site = getSite(url);
      if (site) {
        const raw = await env.SESSION_KV.get(sessionKey(site));
        return json({ ok: true, site, hasStoredSession: Boolean(raw) });
      }

      const [kakuyomu, nola] = await Promise.all([
        env.SESSION_KV.get(sessionKey("kakuyomu")),
        env.SESSION_KV.get(sessionKey("nola")),
      ]);
      return json({
        ok: true,
        sessions: {
          kakuyomu: Boolean(kakuyomu),
          nola: Boolean(nola),
        },
      });
    }

    if (url.pathname === "/verify-sites") {
      let browser;
      try {
        // One browser acquisition only. This avoids Free-plan acquisition limits
        // while still keeping Kakuyomu and Nola isolated in separate contexts.
        browser = await launch(env.BROWSER);
        const kakuyomu = await inspectSite(browser, env, "kakuyomu", true);
        const nola = await inspectSite(browser, env, "nola", true);

        return json({
          ok: Boolean((kakuyomu as any).ok && (nola as any).ok),
          browserLaunches: 1,
          kakuyomu,
          nola,
        });
      } catch (error) {
        return json(
          {
            ok: false,
            browserLaunches: 1,
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 502 },
        );
      } finally {
        await browser?.close();
      }
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

        if (url.pathname === "/browser-check") {
          const result = await inspectSite(browser, env, site, false);
          return json(result, { status: (result as any).ok ? 200 : 502 });
        }

        const storedState = await loadStorageState(env, site);
        const context = await browser.newContext(
          storedState ? { storageState: storedState as any } : {},
        );
        try {
          const page = await context.newPage();
          await page.goto(SITES[site], {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          await page.waitForTimeout(1500);
          const image = await page.screenshot({ fullPage: false });
          return new Response(image, {
            headers: {
              "content-type": "image/png",
              "cache-control": "no-store",
            },
          });
        } finally {
          await context.close();
        }
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

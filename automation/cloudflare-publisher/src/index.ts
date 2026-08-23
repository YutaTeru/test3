import { launch } from "@cloudflare/playwright";

interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

interface Env {
  BROWSER: Fetcher;
  SESSION_KV: KVLike;
  LOGIN_RUN_TOKEN?: string;
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

function sessionMetaKey(site: SiteKey) {
  return `session-meta:${site}`;
}

function hasValidRunToken(request: Request, env: Env) {
  const providedToken = request.headers.get("x-login-run-token");
  return Boolean(env.LOGIN_RUN_TOKEN && providedToken === env.LOGIN_RUN_TOKEN);
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

async function loadSessionMeta(env: Env, site: SiteKey): Promise<unknown | null> {
  const raw = await env.SESSION_KV.get(sessionMetaKey(site));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
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

async function inspectAnonymousSite(browser: any, site: SiteKey, includeScreenshot = false) {
  let context: any;

  try {
    context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    const response = await page.goto(SITES[site], {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(1500);

    const httpStatus = response?.status() ?? null;
    const title = await page.title();
    const targetBlocked =
      httpStatus === 403 ||
      /ERROR:\s*The request could not be satisfied/i.test(title);
    const httpOk = httpStatus === null || (httpStatus >= 200 && httpStatus < 400);

    const result: Record<string, unknown> = {
      ok: httpOk && !targetBlocked,
      site,
      requestedUrl: SITES[site],
      finalUrl: page.url(),
      httpStatus,
      title,
      targetBlocked,
      checkedAt: new Date().toISOString(),
    };

    if (includeScreenshot) {
      const image = await page.screenshot({
        fullPage: false,
        type: "jpeg",
        quality: 35,
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
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await context?.close();
  }
}

async function inspectAuthenticatedNola(browser: any, env: Env) {
  const storedState = await loadStorageState(env, "nola");
  if (!storedState) {
    return { ok: false, error: "Nola session is not stored" };
  }

  let context: any;
  try {
    context = await browser.newContext({
      storageState: storedState as any,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const response = await page.goto(SITES.nola, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(2500);

    const httpStatus = response?.status() ?? null;
    const pageData = await page.evaluate(() => {
      const clean = (value: string | null | undefined) =>
        (value || "").replace(/\s+/g, " ").trim();

      const links = Array.from(document.querySelectorAll("a"))
        .map((el) => ({
          text: clean(el.textContent),
          href: (el as HTMLAnchorElement).href || "",
          title: clean(el.getAttribute("title")),
          ariaLabel: clean(el.getAttribute("aria-label")),
        }))
        .filter((item) => item.text || item.title || item.ariaLabel)
        .slice(0, 150);

      const buttons = Array.from(document.querySelectorAll("button"))
        .map((el) => ({
          text: clean(el.textContent),
          title: clean(el.getAttribute("title")),
          ariaLabel: clean(el.getAttribute("aria-label")),
          disabled: (el as HTMLButtonElement).disabled,
        }))
        .filter((item) => item.text || item.title || item.ariaLabel)
        .slice(0, 100);

      const inputs = Array.from(document.querySelectorAll("input, textarea"))
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: (el as HTMLInputElement).type || "",
          name: clean(el.getAttribute("name")),
          placeholder: clean(el.getAttribute("placeholder")),
          ariaLabel: clean(el.getAttribute("aria-label")),
        }))
        .slice(0, 100);

      const contentEditables = Array.from(
        document.querySelectorAll('[contenteditable="true"]'),
      ).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: clean(el.textContent).slice(0, 200),
        ariaLabel: clean(el.getAttribute("aria-label")),
      }));

      return {
        bodyText: clean(document.body?.innerText).slice(0, 12000),
        links,
        buttons,
        inputs,
        contentEditables,
      };
    });

    const image = await page.screenshot({
      fullPage: false,
      type: "jpeg",
      quality: 45,
    });

    return {
      ok: httpStatus === null || (httpStatus >= 200 && httpStatus < 400),
      site: "nola",
      finalUrl: page.url(),
      title: await page.title(),
      httpStatus,
      inspectedAt: new Date().toISOString(),
      ...pageData,
      screenshotMime: "image/jpeg",
      screenshotBase64: bytesToBase64(image),
    };
  } catch (error) {
    return {
      ok: false,
      site: "nola",
      error: error instanceof Error ? error.message : String(error),
      inspectedAt: new Date().toISOString(),
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
        phase: "phase-3-nola-first",
        next: [
          "inspect authenticated Nola UI",
          "identify the real draft-creation path and selectors",
          "implement Nola draft-only adapter",
          "verify the draft in Nola before enabling any publish action",
        ],
      });
    }

    if (url.pathname === "/session-status") {
      const site = getSite(url);
      if (site) {
        const [raw, meta] = await Promise.all([
          env.SESSION_KV.get(sessionKey(site)),
          loadSessionMeta(env, site),
        ]);
        return json({
          ok: true,
          site,
          hasStoredSession: Boolean(raw),
          meta,
        });
      }

      const [kakuyomu, nola, kakuyomuMeta, nolaMeta] = await Promise.all([
        env.SESSION_KV.get(sessionKey("kakuyomu")),
        env.SESSION_KV.get(sessionKey("nola")),
        loadSessionMeta(env, "kakuyomu"),
        loadSessionMeta(env, "nola"),
      ]);
      return json({
        ok: true,
        sessions: {
          kakuyomu: { stored: Boolean(kakuyomu), meta: kakuyomuMeta },
          nola: { stored: Boolean(nola), meta: nolaMeta },
        },
      });
    }

    if (url.pathname === "/login-handoff") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "POST required" }, { status: 405 });
      }

      const site = getSite(url);
      if (!site) {
        return json(
          { ok: false, error: "Use ?site=kakuyomu or ?site=nola" },
          { status: 400 },
        );
      }

      if (!hasValidRunToken(request, env)) {
        return json({ ok: false, error: "Unauthorized" }, { status: 401 });
      }

      let browser: any;
      let context: any;
      try {
        browser = await launch(env.BROWSER, { keep_alive: 600000 });
        context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        await page.goto(SITES[site], {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await page.waitForTimeout(1000);

        const cdp = await context.newCDPSession(page);
        await (cdp.send as any)("Cloudflare.getLiveView", {
          mode: "tab",
          expiresInMs: 600000,
        });

        const handoffComplete = new Promise<any>((resolve) => {
          (cdp.once as any)("Cloudflare.handoffComplete", resolve);
        });

        const handoff = await (cdp.send as any)("Cloudflare.handoff", {
          instructions:
            site === "kakuyomu"
              ? "カクヨムにログインしてください。ログイン完了後、Live ViewのDoneを押してください。"
              : "Nolaにログインしてください。ログイン完了後、Live ViewのDoneを押してください。",
          timeout: 600000,
        });

        const completion = await handoffComplete;
        if (!completion?.success) {
          return json(
            {
              ok: false,
              site,
              handoffId: handoff?.handoffId ?? null,
              reason: completion?.reason ?? "Human handoff was not completed",
            },
            { status: 408 },
          );
        }

        const storageState = await context.storageState({ indexedDB: true });
        const meta = {
          savedAt: new Date().toISOString(),
          finalUrl: page.url(),
          title: await page.title(),
        };

        await Promise.all([
          env.SESSION_KV.put(sessionKey(site), JSON.stringify(storageState)),
          env.SESSION_KV.put(sessionMetaKey(site), JSON.stringify(meta)),
        ]);

        return json({
          ok: true,
          site,
          saved: true,
          handoffId: handoff?.handoffId ?? null,
          meta,
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
        await context?.close();
        await browser?.close();
      }
    }

    if (url.pathname === "/nola-inspect") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "POST required" }, { status: 405 });
      }
      if (!hasValidRunToken(request, env)) {
        return json({ ok: false, error: "Unauthorized" }, { status: 401 });
      }

      let browser: any;
      try {
        browser = await launch(env.BROWSER);
        const result = await inspectAuthenticatedNola(browser, env);
        return json(result, { status: (result as any).ok ? 200 : 502 });
      } catch (error) {
        return json(
          {
            ok: false,
            site: "nola",
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 502 },
        );
      } finally {
        await browser?.close();
      }
    }

    if (url.pathname === "/verify-sites") {
      let browser;
      try {
        browser = await launch(env.BROWSER);
        const kakuyomu = await inspectAnonymousSite(browser, "kakuyomu", true);
        const nola = await inspectAnonymousSite(browser, "nola", true);

        return json({
          ok: Boolean((kakuyomu as any).ok && (nola as any).ok),
          browserLaunches: 1,
          authenticatedSessionUsed: false,
          kakuyomu,
          nola,
        });
      } catch (error) {
        return json(
          {
            ok: false,
            browserLaunches: 1,
            authenticatedSessionUsed: false,
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
        const result = await inspectAnonymousSite(
          browser,
          site,
          url.pathname === "/screenshot",
        );

        if (url.pathname === "/browser-check") {
          return json(result, { status: (result as any).ok ? 200 : 502 });
        }

        if (!(result as any).screenshotBase64) {
          return json(result, { status: 502 });
        }

        const binary = atob((result as any).screenshotBase64);
        const image = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) image[i] = binary.charCodeAt(i);
        return new Response(image, {
          headers: {
            "content-type": "image/jpeg",
            "cache-control": "no-store",
          },
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
            "The authenticated Nola UI is being inspected first. Draft creation will be enabled only after real selectors are verified.",
        },
        { status: 501 },
      );
    }

    return json({ ok: false, error: "Not found" }, { status: 404 });
  },
};

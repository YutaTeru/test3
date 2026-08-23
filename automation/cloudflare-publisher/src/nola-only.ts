import { launch } from "@cloudflare/playwright";

interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface Env {
  BROWSER: Fetcher;
  SESSION_KV: KVLike;
  LOGIN_RUN_TOKEN?: string;
}

const NOLA_STORY_URL = "https://story.nola-novel.com/";
const NOLA_EDITOR_URL = "https://nola-novel.com/";
const NOLA_CREATE_URL = "https://nola-novel.com/novels/create";
const SESSION_KEY = "session:nola";
const SESSION_META_KEY = "session-meta:nola";

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

function hasValidRunToken(request: Request, env: Env) {
  const provided = request.headers.get("x-login-run-token");
  return Boolean(env.LOGIN_RUN_TOKEN && provided === env.LOGIN_RUN_TOKEN);
}

async function loadStorageState(env: Env): Promise<unknown | undefined> {
  const raw = await env.SESSION_KV.get(SESSION_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function loadSessionMeta(env: Env): Promise<unknown | null> {
  const raw = await env.SESSION_KV.get(SESSION_META_KEY);
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

async function collectFrame(frame: any) {
  const url = frame.url();
  try {
    const data = await frame.evaluate(() => {
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
        .slice(0, 200);

      const buttons = Array.from(document.querySelectorAll("button"))
        .map((el) => ({
          text: clean(el.textContent),
          title: clean(el.getAttribute("title")),
          ariaLabel: clean(el.getAttribute("aria-label")),
          disabled: (el as HTMLButtonElement).disabled,
        }))
        .filter((item) => item.text || item.title || item.ariaLabel)
        .slice(0, 150);

      const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: (el as HTMLInputElement).type || "",
          name: clean(el.getAttribute("name")),
          placeholder: clean(el.getAttribute("placeholder")),
          ariaLabel: clean(el.getAttribute("aria-label")),
        }))
        .slice(0, 150);

      const contentEditables = Array.from(
        document.querySelectorAll('[contenteditable="true"]'),
      ).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: clean(el.textContent).slice(0, 200),
        ariaLabel: clean(el.getAttribute("aria-label")),
      }));

      return {
        readyState: document.readyState,
        htmlLength: document.documentElement?.outerHTML?.length || 0,
        bodyText: clean(document.body?.innerText).slice(0, 12000),
        links,
        buttons,
        inputs,
        contentEditables,
      };
    });

    return { url, ...data };
  } catch (error) {
    return {
      url,
      readyState: null,
      htmlLength: 0,
      bodyText: "",
      links: [],
      buttons: [],
      inputs: [],
      contentEditables: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function inspectNolaEditor(browser: any, env: Env) {
  const storedState = await loadStorageState(env);
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
    const response = await page.goto(NOLA_CREATE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });

    await page.waitForTimeout(7000);

    const frameData = [];
    for (const frame of page.frames()) {
      frameData.push(await collectFrame(frame));
    }

    const links = frameData.flatMap((item: any) => item.links || []);
    const buttons = frameData.flatMap((item: any) => item.buttons || []);
    const inputs = frameData.flatMap((item: any) => item.inputs || []);
    const contentEditables = frameData.flatMap(
      (item: any) => item.contentEditables || [],
    );
    const bodyText = frameData
      .map((item: any) => item.bodyText || "")
      .filter(Boolean)
      .join(" | ")
      .slice(0, 20000);

    const finalUrl = page.url();
    const title = await page.title();
    const httpStatus = response?.status() ?? null;
    const loginLike =
      /\/auth|\/signin|\/login/i.test(finalUrl) ||
      /ログイン|メールアドレス.*パスワード/.test(bodyText);
    const createLike =
      /作品|新規|タイトル|小説|原稿/.test(bodyText) ||
      inputs.some((item: any) =>
        /タイトル|作品|小説|原稿/.test(
          `${item.name || ""} ${item.placeholder || ""} ${item.ariaLabel || ""}`,
        ),
      );

    const image = await page.screenshot({
      fullPage: false,
      type: "jpeg",
      quality: 45,
    });

    return {
      ok: httpStatus === null || (httpStatus >= 200 && httpStatus < 400),
      site: "nola-editor",
      requestedUrl: NOLA_CREATE_URL,
      finalUrl,
      title,
      httpStatus,
      sessionAcceptedOnEditor: !loginLike,
      createScreenDetected: createLike,
      inspectedAt: new Date().toISOString(),
      frameCount: frameData.length,
      frames: frameData.map((item: any) => ({
        url: item.url,
        readyState: item.readyState,
        htmlLength: item.htmlLength,
        links: item.links?.length || 0,
        buttons: item.buttons?.length || 0,
        inputs: item.inputs?.length || 0,
        contentEditables: item.contentEditables?.length || 0,
        error: item.error || null,
      })),
      bodyText,
      links,
      buttons,
      inputs,
      contentEditables,
      screenshotMime: "image/jpeg",
      screenshotBase64: bytesToBase64(image),
    };
  } catch (error) {
    return {
      ok: false,
      site: "nola-editor",
      requestedUrl: NOLA_CREATE_URL,
      error: error instanceof Error ? error.message : String(error),
      inspectedAt: new Date().toISOString(),
    };
  } finally {
    await context?.close();
  }
}

async function runHumanLogin(request: Request, env: Env) {
  if (!hasValidRunToken(request, env)) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let browser: any;
  let context: any;
  try {
    const storedState = await loadStorageState(env);
    browser = await launch(env.BROWSER, { keep_alive: 600000 });
    context = await browser.newContext({
      ...(storedState ? { storageState: storedState as any } : {}),
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto(NOLA_EDITOR_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(1500);

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
        "Nolaの執筆ツールにログインしてください。ログイン完了後、Live ViewのDoneを押してください。",
      timeout: 600000,
    });

    const completion = await handoffComplete;
    if (!completion?.success) {
      return json(
        {
          ok: false,
          site: "nola",
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
      source: "nola-editor",
    };

    await Promise.all([
      env.SESSION_KV.put(SESSION_KEY, JSON.stringify(storageState)),
      env.SESSION_KV.put(SESSION_META_KEY, JSON.stringify(meta)),
    ]);

    return json({
      ok: true,
      site: "nola",
      saved: true,
      handoffId: handoff?.handoffId ?? null,
      meta,
    });
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
    await context?.close();
    await browser?.close();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "novel-auto-publisher",
        mode: "nola-only",
        sessionStore: "SESSION_KV",
        storyUrl: NOLA_STORY_URL,
        editorUrl: NOLA_EDITOR_URL,
        phase: "inspect-nola-editor",
      });
    }

    if (url.pathname === "/session-status") {
      const [raw, meta] = await Promise.all([
        env.SESSION_KV.get(SESSION_KEY),
        loadSessionMeta(env),
      ]);
      return json({
        ok: true,
        site: "nola",
        hasStoredSession: Boolean(raw),
        meta,
      });
    }

    if (url.pathname === "/login-handoff") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "POST required" }, { status: 405 });
      }
      return runHumanLogin(request, env);
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
        const result = await inspectNolaEditor(browser, env);
        return json(result, { status: (result as any).ok ? 200 : 502 });
      } catch (error) {
        return json(
          {
            ok: false,
            site: "nola-editor",
            error: error instanceof Error ? error.message : String(error),
          },
          { status: 502 },
        );
      } finally {
        await browser?.close();
      }
    }

    if (url.pathname.startsWith("/draft")) {
      return json(
        {
          ok: false,
          status: "not-enabled-yet",
          reason: "Nola editor selectors must be verified before draft creation is enabled.",
        },
        { status: 501 },
      );
    }

    if (url.pathname.startsWith("/publish")) {
      return json(
        {
          ok: false,
          status: "disabled",
          reason: "Public posting is intentionally disabled during Nola-only draft testing.",
        },
        { status: 501 },
      );
    }

    return json({ ok: false, error: "Not found" }, { status: 404 });
  },
};

import "dotenv/config";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import reports from "../reports.json" with { type: "json" };
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";

type ReportConfig = { institution: string; aliases: string[] };
type Result = {
  institution: string;
  status: "OK" | "FAILED";
  matchedReport?: string;
  file?: string;
  error?: string;
};

const BASE_URL = process.env.GPS_BASE_URL ?? "https://gpstracker.elektrosek.com";
const DOWNLOAD_ROOT = process.env.GPS_DOWNLOAD_ROOT ?? "downloads";
const TIMEOUT = Number(process.env.GPS_TIMEOUT_MS ?? 45_000);
const REPORT_TIMEOUT = Number(process.env.GPS_REPORT_TIMEOUT_MS ?? 300_000);
const HEADLESS = /^true$/i.test(process.env.GPS_HEADLESS ?? "false");
const INSPECT = process.argv.includes("--inspect");
const DISCOVER_API = process.argv.includes("--discover-api");

type ApiTrace = {
  time: string;
  method: string;
  resourceType: string;
  url: string;
  postData: string | null;
  status?: number;
  contentType?: string;
  responseBody?: unknown;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
};

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => {
    if (/^authorization$/i.test(name)) {
      const scheme = value.match(/^\s*([A-Za-z]+)\s+/)?.[1];
      return [name, scheme ? `${scheme} [REDACTED]` : "[REDACTED]"];
    }
    if (/token|secret|api[-_]?key/i.test(name)) return [name, "[REDACTED]"];
    if (/^cookie$/i.test(name)) {
      const names = value.split(";").map((part) => part.split("=")[0]?.trim()).filter(Boolean);
      return [name, names.map((item) => `${item}=[REDACTED]`).join("; ")];
    }
    if (/^set-cookie$/i.test(name)) return [name, "[COOKIE VALUES REDACTED]"];
    return [name, value];
  }));
}

function responseShape(value: unknown, keyName = ""): unknown {
  if (/password|token|auth|secret|cookie|session|key/i.test(keyName)) return "[REDACTED]";
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => responseShape(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, responseShape(item, key)]));
  }
  if (typeof value === "string") return `[string:${value.length}]`;
  return value;
}

function redactTechnicalData(value: string): string {
  let result = value;
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (/token|auth|password|secret|session|apiKey/i.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    result = url.toString();
  } catch {
    // Nuk është URL; vazhdojmë me redaktimin e tekstit/JSON-it.
  }
  return result
    .replace(/(name="password"\r?\n\r?\n)([^\r\n]+)/gi, "$1[REDACTED]")
    .replace(/("?(?:token|authorization|password|secret|sessionId|accessToken)"?\s*[:=]\s*")([^"]+)(")/gi, "$1[REDACTED]$3")
    .replace(/((?:token|authorization|password|secret|sessionId|accessToken)=)([^&\s]+)/gi, "$1[REDACTED]");
}

function startApiTrace(page: Page): { traces: ApiTrace[] } {
  const traces: ApiTrace[] = [];
  page.on("request", (request) => {
    const resourceType = request.resourceType();
    if (!["xhr", "fetch", "document", "other"].includes(resourceType)) return;
    // Login-i përjashtohet plotësisht: nuk na duhet për zbulimin e raporteve
    // dhe trupi multipart përmban kredenciale.
    if (/\/Login\/UserLogin(?:\?|$)/i.test(request.url())) return;
    traces.push({
      time: new Date().toISOString(),
      method: request.method(),
      resourceType,
      url: redactTechnicalData(request.url()),
      postData: request.postData() ? redactTechnicalData(request.postData()!) : null,
      requestHeaders: sanitizeHeaders(request.headers()),
    });
  });
  page.on("response", async (response) => {
    const request = response.request();
    const url = redactTechnicalData(request.url());
    if (/\/Login\/UserLogin(?:\?|$)/i.test(request.url())) {
      const loginTrace: ApiTrace = {
        time: new Date().toISOString(), method: request.method(), resourceType: request.resourceType(),
        url: `${new URL(request.url()).origin}/Login/UserLogin`, postData: "[LOGIN REQUEST EXCLUDED]",
        status: response.status(), contentType: (await response.headerValue("content-type")) ?? undefined,
        requestHeaders: sanitizeHeaders(request.headers()), responseHeaders: sanitizeHeaders(await response.allHeaders()),
      };
      try {
        const text = await response.text();
        loginTrace.responseBody = text.trim() ? responseShape(JSON.parse(text)) : "[EMPTY BODY]";
      } catch {
        loginTrace.responseBody = "[UNAVAILABLE OR NON-JSON BODY]";
      }
      traces.push(loginTrace);
      return;
    }
    const item = [...traces].reverse().find((trace) => trace.url === url && trace.method === request.method() && trace.status === undefined);
    if (!item) return;
    item.status = response.status();
    item.contentType = (await response.headerValue("content-type")) ?? undefined;
    item.responseHeaders = sanitizeHeaders(await response.allHeaders());
    if (/\/(?:ReportCustom\/(?:GetList|GetModel)|Report\/Base\/Trip)(?:\?|$)/i.test(request.url())) {
      try {
        const bodyText = await response.text();
        if (bodyText.length <= 5_000_000) {
          try {
            item.responseBody = JSON.parse(bodyText);
          } catch {
            item.responseBody = redactTechnicalData(bodyText);
          }
        } else {
          item.responseBody = `[RESPONSE TOO LARGE: ${bodyText.length} characters]`;
        }
      } catch {
        item.responseBody = "[RESPONSE BODY UNAVAILABLE]";
      }
    }
  });
  return { traces };
}

function cleanName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function safeFileName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function monthBounds(month: string): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("Muaji duhet të jetë në formatin YYYY-MM, p.sh. 2026-07.");
  }
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return {
    start: `${month}-01 00:00:00`,
    end: `${month}-${String(lastDay).padStart(2, "0")} 23:59:59`,
  };
}

async function askMonth(): Promise<string> {
  const arg = process.argv.find((item) => /^\d{4}-\d{2}$/.test(item));
  if (arg) return arg;

  const now = new Date();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const suggested = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}`;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Muaji i raportit [${suggested}]: `)).trim();
  rl.close();
  return answer || suggested;
}

async function firstVisible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    if ((await locator.count()) > 0 && (await locator.first().isVisible())) return locator.first();
  }
  return null;
}

async function clickOne(locators: Locator[], description: string): Promise<void> {
  const target = await firstVisible(locators);
  if (!target) throw new Error(`Nuk u gjet elementi: ${description}`);
  await target.click({ timeout: TIMEOUT });
}

async function loginIfNeeded(page: Page): Promise<void> {
  if (!/loginPage/i.test(page.url())) return;

  const account = process.env.GPS_ACCOUNT;
  const password = process.env.GPS_PASSWORD;
  if (!account || !password) {
    throw new Error("Plotëso GPS_ACCOUNT dhe GPS_PASSWORD në skedarin .env.");
  }

  // Kjo faqe është SPA dhe në lidhje të ngadalta formulari mund të shfaqet
  // mbi 30 sekonda pas DOMContentLoaded. Presim formularin real, jo vetëm HTML-në bazë.
  const accountInput = page.locator('form.login-form input[type="text"]').first();
  const passwordInput = page.locator('form.login-form input[type="password"]').first();
  await accountInput.waitFor({ state: "visible", timeout: 90_000 });
  await passwordInput.waitFor({ state: "visible", timeout: 90_000 });
  // Animacioni i login-it mund t'i mbajë fushat vizualisht të bllokuara edhe
  // pasi janë shfaqur. `force` plotëson input-et reale të Vue/Vuetify.
  await accountInput.fill(account, { force: true });
  await passwordInput.fill(password, { force: true });
  await clickOne(
    [page.locator("button.login-button"), page.getByRole("button", { name: /log\s*in/i })],
    "Log in",
  );
  // Harta mban kërkesa aktive dhe ngjarja e plotë `load` mund të mos mbarojë.
  // Mjafton që navigimi të ketë nisur dhe loginPage të jetë mbyllur.
  await page.waitForURL((url) => !/loginPage/i.test(url.toString()), {
    timeout: TIMEOUT,
    waitUntil: "commit",
  });
}

async function openReports(page: Page): Promise<void> {
  if (/statisticalReport/i.test(page.url())) return;
  // Pas autentikimit hapim direkt route-in. Në DOM ka disa elemente me tekstin
  // "Reports" (desktop, mobile dhe shortcut), prandaj klikimi është i paqartë.
  await page.goto(`${BASE_URL}/statisticalReport`, { waitUntil: "commit", timeout: TIMEOUT });
  await page.waitForURL(/statisticalReport/i, { timeout: TIMEOUT, waitUntil: "commit" });
}

async function selectReport(page: Page, report: ReportConfig): Promise<string> {
  const reportNodes = page.locator(".v-treeview-node__label p").filter({ hasText: /\(Travel Report\)/i });
  await reportNodes.first().waitFor({ state: "visible", timeout: REPORT_TIMEOUT });
  const reportTexts = await reportNodes.allTextContents();

  for (const alias of report.aliases) {
    const normalizedAlias = cleanName(alias);
    const index = reportTexts.findIndex((text) => {
      const reportName = cleanName(text.replace(/\(\s*Travel Report\s*\)/i, ""));
      return reportName.startsWith(normalizedAlias);
    });
    if (index < 0) continue;

    await reportNodes.nth(index).click({ timeout: REPORT_TIMEOUT });
    // Gjenerimi fillestar i raportit mund të zgjasë 1–3 minuta.
    await waitForReportDateInputs(page);
    return reportTexts[index].trim();
  }

  throw new Error(`Raporti nuk u gjet me aliaset: ${report.aliases.join(", ")}`);
}

async function findReportDateInputs(page: Page): Promise<Locator[]> {
  const dateInputs = page.locator("input");
  const matches: Locator[] = [];
  const count = await dateInputs.count();

  for (let i = 0; i < count; i++) {
    const input = dateInputs.nth(i);
    if (!(await input.isVisible())) continue;
    const value = (await input.inputValue().catch(() => "")) ?? "";
    const placeholder = (await input.getAttribute("placeholder")) ?? "";
    if (/\d{4}-\d{2}-\d{2}/.test(value) || /date|time|yyyy/i.test(placeholder)) matches.push(input);
  }

  return matches;
}

async function waitForReportDateInputs(page: Page): Promise<Locator[]> {
  const deadline = Date.now() + REPORT_TIMEOUT;
  while (Date.now() < deadline) {
    const matches = await findReportDateInputs(page);
    if (matches.length >= 2) return matches;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`Raporti nuk u gjenerua brenda ${Math.round(REPORT_TIMEOUT / 60_000)} minutash.`);
}

async function setDateRange(page: Page, start: string, end: string): Promise<void> {
  const matches = await waitForReportDateInputs(page);

  await matches[0].fill(start);
  await matches[0].press("Tab");
  await matches[1].fill(end);
  await matches[1].press("Tab");
}

async function runSearch(page: Page): Promise<void> {
  await clickOne(
    [page.getByRole("button", { name: /^search$/i }), page.getByText("Search", { exact: true })],
    "Search i raportit",
  );
  await page.waitForTimeout(1_000);
  await page.getByText(/Summary/i).first().waitFor({ state: "visible", timeout: REPORT_TIMEOUT });
}

async function exportExcel(page: Page, targetFile: string): Promise<void> {
  const directExcel = await firstVisible([
    page.getByText("Export Excel", { exact: true }),
    page.getByText(/Export Excel/i),
  ]);

  if (directExcel) {
    const downloadPromise = page.waitForEvent("download", { timeout: REPORT_TIMEOUT });
    await directExcel.click();
    const download = await downloadPromise;
    await download.saveAs(targetFile);
    return;
  } else {
    await clickOne(
      [
        page.locator(".mdi-export-variant"),
        page.locator('[title*="Export" i]'),
        page.locator('[aria-label*="Export" i]'),
        page.locator(".fa-upload, .icon-export, .el-icon-upload2").first(),
      ],
      "ikona Export",
    );
    await page.getByText(/Export Excel/i).first().waitFor({ state: "visible", timeout: TIMEOUT });
    const downloadPromise = page.waitForEvent("download", { timeout: REPORT_TIMEOUT });
    await page.getByText(/Export Excel/i).first().click();
    const download = await downloadPromise;
    await download.saveAs(targetFile);
  }
}

async function saveDebug(page: Page, label: string): Promise<void> {
  const debugDir = path.resolve("debug");
  await fs.mkdir(debugDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await page.screenshot({ path: path.join(debugDir, `${stamp}_${safeFileName(label)}.png`), fullPage: true });
  await fs.writeFile(path.join(debugDir, `${stamp}_${safeFileName(label)}.html`), await page.content(), "utf8");
}

async function closeContext(context: BrowserContext): Promise<void> {
  await context.close().catch(() => undefined);
}

async function main(): Promise<void> {
  const month = await askMonth();
  const { start, end } = monthBounds(month);
  const outputDir = path.resolve(DOWNLOAD_ROOT, month);
  await fs.mkdir(outputDir, { recursive: true });

  const context = await chromium.launchPersistentContext(path.resolve("playwright-profile"), {
    headless: HEADLESS,
    acceptDownloads: true,
    viewport: { width: 1600, height: 1000 },
  });
  context.setDefaultTimeout(TIMEOUT);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(`${BASE_URL}/loginPage`, { waitUntil: "domcontentloaded" });
    await loginIfNeeded(page);
    const apiTrace = DISCOVER_API ? startApiTrace(page) : null;
    await openReports(page);

    if (INSPECT) {
      await saveDebug(page, "reports-page");
      console.log("U ruajtën skedarët diagnostikues në dosjen debug.");
      return;
    }

    const results: Result[] = [];
    const reportsToRun = DISCOVER_API
      ? (reports as ReportConfig[]).filter((report) => report.aliases.some((alias) => cleanName(alias) === "shkoder"))
      : (reports as ReportConfig[]);
    console.log(`\nPeriudha: ${start} - ${end}`);
    console.log(`Raporte për t'u shkarkuar: ${reportsToRun.length}\n`);

    for (const [index, report] of reportsToRun.entries()) {
      const prefix = `[${index + 1}/${reportsToRun.length}] ${report.institution}`;
      try {
        console.log(`${prefix} - duke kërkuar...`);
        const matchedReport = await selectReport(page, report);
        await setDateRange(page, start, end);
        await runSearch(page);
        const targetFile = path.join(outputDir, `${String(index + 1).padStart(2, "0")}_${safeFileName(report.institution)}_${month}.xlsx`);
        await exportExcel(page, targetFile);
        results.push({ institution: report.institution, status: "OK", matchedReport, file: targetFile });
        console.log(`${prefix} - OK`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ institution: report.institution, status: "FAILED", error: message });
        console.error(`${prefix} - DËSHTOI: ${message}`);
        await saveDebug(page, report.institution).catch(() => undefined);
        await page.goto(`${BASE_URL}/statisticalReport`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      }
    }

    const summaryPath = path.join(outputDir, `rezultati_${month}.json`);
    await fs.writeFile(summaryPath, JSON.stringify({ month, start, end, results }, null, 2), "utf8");
    if (apiTrace) {
      const apiPath = path.resolve("debug", `api-requests_${month}.json`);
      await fs.mkdir(path.dirname(apiPath), { recursive: true });
      await fs.writeFile(apiPath, JSON.stringify(apiTrace.traces, null, 2), "utf8");
      console.log(`Gjurmët e API-së: ${apiPath}`);
    }
    const ok = results.filter((result) => result.status === "OK").length;
    const failed = results.length - ok;
    console.log(`\nPërfundoi: ${ok} me sukses, ${failed} me gabim.`);
    console.log(`Dosja: ${outputDir}`);
    console.log(`Përmbledhja: ${summaryPath}`);
    if (failed > 0) process.exitCode = 2;
  } catch (error) {
    await saveDebug(page, "fatal-error").catch(() => undefined);
    throw error;
  } finally {
    await closeContext(context);
  }
}

main().catch((error) => {
  console.error("\nGabim fatal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import "dotenv/config";
import { request } from "playwright";
import * as XLSX from "xlsx";
import reports from "../reports.json" with { type: "json" };
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";

type ReportConfig = { institution: string; aliases: string[] };
type CustomReport = { custom_id: number; name: string; report_type: number };
type Tracker = { tracker_name: string; sn_imei_id: string };
type ApiEnvelope<T> = { state: boolean; message?: string; errorMessage?: string | null; value: T };
type LoginValue = { userToken: string; sssid: string };
type ReportSection = {
  type: string;
  columns?: Array<{ field: string; text: string }>;
  rows?: Array<Record<string, unknown>>;
  device?: Array<{ monitor_object?: string; total?: number; rows?: Array<Record<string, unknown>> }>;
};
type RunResult = { institution: string; report?: string; status: "OK" | "FAILED"; file?: string; error?: string };

const BASE_URL = process.env.GPS_BASE_URL ?? "https://gpstracker.elektrosek.com";
const API_URL = process.env.GPS_API_URL ?? `${BASE_URL}:18889`;
const DOWNLOAD_ROOT = process.env.GPS_DOWNLOAD_ROOT ?? "downloads";
const API_TIMEOUT = Number(process.env.GPS_API_TIMEOUT_MS ?? 600_000);
const PAGE_SIZE = Number(process.env.GPS_API_PAGE_SIZE ?? 100);

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, " ").trim().toLowerCase();
}

function safeFileName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[<>:"/\\|?*]+/g, "").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function monthBounds(month: string): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Muaji duhet të jetë YYYY-MM, p.sh. 2026-07.");
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return { start: `${month}-01 00:00:00`, end: `${month}-${String(lastDay).padStart(2, "0")} 23:59:59` };
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

async function findAccountCode(): Promise<string> {
  if (process.env.GPS_API_ACCOUNT_CODE) return process.env.GPS_API_ACCOUNT_CODE;
  const debugDir = path.resolve("debug");
  const files = (await fs.readdir(debugDir).catch(() => []))
    .filter((name) => /^api-requests.*\.json$/i.test(name))
    .sort()
    .reverse();

  for (const file of files) {
    try {
      const trace = JSON.parse(await fs.readFile(path.join(debugDir, file), "utf8")) as Array<{ url?: string }>;
      for (const item of trace) {
        if (!item.url?.includes("/ReportCustom/GetList")) continue;
        const code = new URL(item.url).searchParams.get("sAccount");
        if (code) return code;
      }
    } catch {
      // Provo skedarin tjetër.
    }
  }
  throw new Error("Nuk u gjet kodi i llogarisë. Mbaj në dosjen debug skedarin api-requests_*.json ose vendos GPS_API_ACCOUNT_CODE në .env.");
}

function assertEnvelope<T>(body: ApiEnvelope<T>, endpoint: string): T {
  if (!body || body.state !== true) throw new Error(`${endpoint}: ${body?.errorMessage || body?.message || "përgjigje e pasuksesshme"}`);
  return body.value;
}

function findCustomReport(items: CustomReport[], config: ReportConfig): CustomReport | undefined {
  for (const alias of config.aliases) {
    const wanted = normalize(alias);
    const match = items.find((item) => item.report_type === 3 && normalize(item.name).startsWith(wanted));
    if (match) return match;
  }
  return undefined;
}

function section(sections: ReportSection[], type: string): ReportSection | undefined {
  return sections.find((item) => item.type.toLowerCase() === type.toLowerCase());
}

function mergeSections(target: ReportSection[], incoming: ReportSection[]): ReportSection[] {
  if (target.length === 0) return structuredClone(incoming);
  for (const part of incoming) {
    const existing = section(target, part.type);
    if (!existing) {
      target.push(structuredClone(part));
      continue;
    }
    if (/\.Sum$/i.test(part.type)) continue;
    if (part.rows?.length) existing.rows = [...(existing.rows ?? []), ...part.rows];
    if (part.device?.length) existing.device = [...(existing.device ?? []), ...part.device];
  }
  return target;
}

function translatedRows(part: ReportSection, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const columns = part.columns ?? [];
  return rows.map((row) => Object.fromEntries(columns.map((column) => [column.text, row[column.field] ?? ""])));
}

function setWidths(sheet: XLSX.WorkSheet, rows: Array<Record<string, unknown>>): void {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  sheet["!cols"] = headers.map((header) => ({ wch: Math.min(45, Math.max(12, header.length + 2)) }));
}

function addSheet(workbook: XLSX.WorkBook, name: string, rows: Array<Record<string, unknown>>): void {
  const safeRows = rows.length ? rows : [{ Informacion: "Nuk ka të dhëna për këtë seksion." }];
  const sheet = XLSX.utils.json_to_sheet(safeRows);
  setWidths(sheet, safeRows);
  XLSX.utils.book_append_sheet(workbook, sheet, name.slice(0, 31));
}

function writeWorkbook(file: string, institution: string, reportName: string, start: string, end: string, sections: ReportSection[]): void {
  const workbook = XLSX.utils.book_new();
  addSheet(workbook, "Informacion", [{ Institucioni: institution, Raporti: reportName, "Data e fillimit": start, "Data e përfundimit": end }]);

  const sum = section(sections, "Trip.Sum");
  if (sum) addSheet(workbook, "Summary", translatedRows(sum, sum.rows ?? []));

  const sumDetail = section(sections, "Trip.SumDetail");
  if (sumDetail) addSheet(workbook, "Device Summary", translatedRows(sumDetail, sumDetail.rows ?? []));

  const detail = section(sections, "Trip.Detail");
  if (detail) {
    const details = (detail.device ?? []).flatMap((device) => device.rows ?? []);
    addSheet(workbook, "Trip Details", translatedRows(detail, details));
  }

  XLSX.writeFile(workbook, file, { compression: true });
}

async function main(): Promise<void> {
  const account = process.env.GPS_ACCOUNT;
  const password = process.env.GPS_PASSWORD;
  if (!account || !password) throw new Error("Plotëso GPS_ACCOUNT dhe GPS_PASSWORD në .env.");

  const month = await askMonth();
  const { start, end } = monthBounds(month);
  const outputDir = path.resolve(DOWNLOAD_ROOT, month);
  await fs.mkdir(outputDir, { recursive: true });

  const api = await request.newContext({
    baseURL: API_URL,
    ignoreHTTPSErrors: true,
    timeout: API_TIMEOUT,
    extraHTTPHeaders: {
      language: "en-us",
      Accept: "application/json, text/plain, */*",
      Referer: `${BASE_URL}/`,
    },
  });
  const results: RunResult[] = [];

  try {
    console.log("Po kryhet autentikimi direkt me API...");
    const loginResponse = await api.post("/Login/UserLogin", {
      headers: { language: "en-us" },
      multipart: { language: "en-us", timezone: "120", useraccount: account, password },
    });
    if (!loginResponse.ok()) throw new Error(`Login API dështoi me HTTP ${loginResponse.status()}.`);
    const loginText = await loginResponse.text();
    if (!loginText.trim()) throw new Error("Login API ktheu përgjigje bosh edhe pasi u dërgua header-i language.");
    let loginBody: ApiEnvelope<LoginValue>;
    try {
      loginBody = JSON.parse(loginText) as ApiEnvelope<LoginValue>;
    } catch {
      throw new Error("Login API ktheu përgjigje që nuk është JSON.");
    }
    const loginValue = assertEnvelope(loginBody, "Login API");
    if (!loginValue.userToken) throw new Error("Login API nuk ktheu userToken.");
    const accountCode = process.env.GPS_API_ACCOUNT_CODE || loginValue.sssid || await findAccountCode();
    const authHeaders = {
      Authorization: `Bearer ${loginValue.userToken}`,
      language: "en-us",
      "accept-language": "en-us",
    };

    const listResponse = await api.get("/ReportCustom/GetList", { headers: authHeaders, params: { sAccount: accountCode } });
    if (!listResponse.ok()) throw new Error(`GetList dështoi me HTTP ${listResponse.status()}; sesioni API nuk u pranua.`);
    const listText = await listResponse.text();
    if (!listText.trim()) throw new Error("GetList ktheu përgjigje bosh; sesioni API nuk u pranua.");
    const customReports = assertEnvelope(JSON.parse(listText) as ApiEnvelope<CustomReport[]>, "GetList");
    console.log(`U gjetën ${customReports.length} raporte në GPS.\n`);

    for (const [index, config] of (reports as ReportConfig[]).entries()) {
      const prefix = `[${index + 1}/${reports.length}] ${config.institution}`;
      try {
        const customReport = findCustomReport(customReports, config);
        if (!customReport) throw new Error("Nuk u gjet raporti përkatës në GetList.");
        console.log(`${prefix} - ${customReport.name}, duke marrë pajisjet...`);

        const modelResponse = await api.get("/ReportCustom/GetModel", {
          headers: authHeaders,
          params: { sAccount: accountCode, sKey: customReport.custom_id },
        });
        const model = assertEnvelope((await modelResponse.json()) as ApiEnvelope<{ trackers: Tracker[] }>, "GetModel");
        const trackers = model.trackers ?? [];
        if (!trackers.length) throw new Error("Raporti nuk ka pajisje.");
        const imeis = trackers.map((tracker) => tracker.sn_imei_id).filter(Boolean);

        let offset = 0;
        let merged: ReportSection[] = [];
        while (offset < imeis.length) {
          console.log(`${prefix} - të dhënat ${offset + 1}-${Math.min(offset + PAGE_SIZE, imeis.length)} nga ${imeis.length}...`);
          const tripResponse = await api.get("/Report/Base/Trip", {
            headers: authHeaders,
            timeout: API_TIMEOUT,
            params: {
              imeis: imeis.join(","), startTime: start, endTime: end,
              offset, limit: PAGE_SIZE, total: true, oil100km: 15,
            },
          });
          if (!tripResponse.ok()) throw new Error(`Trip API dështoi me HTTP ${tripResponse.status()}.`);
          const parts = assertEnvelope((await tripResponse.json()) as ApiEnvelope<ReportSection[]>, "Trip");
          merged = mergeSections(merged, parts);
          const pageRows = section(parts, "Trip.SumDetail")?.rows?.length ?? 0;
          if (pageRows === 0) break;
          offset += pageRows;
          if (offset >= imeis.length) break;
        }

        const file = path.join(outputDir, `${String(index + 1).padStart(2, "0")}_${safeFileName(config.institution)}_${month}.xlsx`);
        writeWorkbook(file, config.institution, customReport.name, start, end, merged);
        results.push({ institution: config.institution, report: customReport.name, status: "OK", file });
        console.log(`${prefix} - OK\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ institution: config.institution, status: "FAILED", error: message });
        console.error(`${prefix} - DËSHTOI: ${message}\n`);
      }
    }
  } finally {
    await api.dispose();
  }

  const summaryFile = path.join(outputDir, `rezultati_api_${month}.json`);
  await fs.writeFile(summaryFile, JSON.stringify({ month, start, end, results }, null, 2), "utf8");
  const ok = results.filter((item) => item.status === "OK").length;
  console.log(`Përfundoi: ${ok} me sukses, ${results.length - ok} me gabim.`);
  console.log(`Dosja: ${outputDir}`);
  if (ok !== results.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error("\nGabim fatal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

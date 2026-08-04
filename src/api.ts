import "dotenv/config";
import { request } from "playwright";
import XLSX from "xlsx-js-style";
import reports from "../reports.json" with { type: "json" };
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";

type ReportConfig = { institution: string; aliases: string[] };
type CustomReport = { custom_id: number; name: string; report_type: number };
type Tracker = { tracker_name: string; sn_imei_id: string };
type ApiEnvelope<T> = {
  state: boolean;
  message?: string;
  errorMessage?: string | null;
  value: T;
};
type LoginValue = { userToken: string; sssid: string };
type ReportSection = {
  type: string;
  columns?: Array<{ field: string; text: string }>;
  rows?: Array<Record<string, unknown>>;
  device?: Array<{
    monitor_object?: string;
    total?: number;
    rows?: Array<Record<string, unknown>>;
  }>;
};
type RunResult = {
  institution: string;
  report?: string;
  status: "OK" | "SKIPPED" | "FAILED";
  file?: string;
  error?: string;
};

const BASE_URL =
  process.env.GPS_BASE_URL ?? "https://gpstracker.elektrosek.com";
const API_URL = process.env.GPS_API_URL ?? `${BASE_URL}:18889`;
const DOWNLOAD_ROOT = process.env.GPS_DOWNLOAD_ROOT ?? "downloads";
const API_TIMEOUT = Number(process.env.GPS_API_TIMEOUT_MS ?? 600_000);
// Një ambulancë për kërkesë: shmang 502 te raportet e rënda si Trauma.
const PAGE_SIZE = 1;
const TRIP_RESULT_LIMIT = Number(process.env.GPS_TRIP_RESULT_LIMIT ?? 1_000);
const TRIP_API_ATTEMPTS = Number(process.env.GPS_TRIP_API_ATTEMPTS ?? 4);
const TRIP_API_RETRY_DELAY = Number(
  process.env.GPS_TRIP_API_RETRY_DELAY_MS ?? 30_000,
);

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalize(value: string): string {
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

function optionValue(name: string): string | undefined {
  const inline = process.argv.find((argument) =>
    argument.startsWith(`${name}=`),
  );
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Pas ${name} duhet të vendosësh një vlerë.`);
  return value.trim();
}

function monthBounds(month: string): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new Error("Muaji duhet të jetë YYYY-MM, p.sh. 2026-07.");
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
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = (
    await rl.question(`Muaji i raportit [${suggested}]: `)
  ).trim();
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
      const trace = JSON.parse(
        await fs.readFile(path.join(debugDir, file), "utf8"),
      ) as Array<{ url?: string }>;
      for (const item of trace) {
        if (!item.url?.includes("/ReportCustom/GetList")) continue;
        const code = new URL(item.url).searchParams.get("sAccount");
        if (code) return code;
      }
    } catch {
      // Provo skedarin tjetër.
    }
  }
  throw new Error(
    "Nuk u gjet kodi i llogarisë. Mbaj në dosjen debug skedarin api-requests_*.json ose vendos GPS_API_ACCOUNT_CODE në .env.",
  );
}

function assertEnvelope<T>(body: ApiEnvelope<T>, endpoint: string): T {
  if (!body || body.state !== true)
    throw new Error(
      `${endpoint}: ${body?.errorMessage || body?.message || "përgjigje e pasuksesshme"}`,
    );
  return body.value;
}

function findCustomReport(
  items: CustomReport[],
  config: ReportConfig,
): CustomReport | undefined {
  for (const alias of config.aliases) {
    const wanted = normalize(alias);
    const match = items.find(
      (item) =>
        item.report_type === 3 && normalize(item.name).startsWith(wanted),
    );
    if (match) return match;
  }
  return undefined;
}

function section(
  sections: ReportSection[],
  type: string,
): ReportSection | undefined {
  return sections.find(
    (item) => item.type.toLowerCase() === type.toLowerCase(),
  );
}

function durationToSeconds(value: unknown): number {
  const parts = String(value ?? "0:00:00")
    .split(":")
    .map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part)))
    return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function secondsToDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function mergeTripSummary(
  existing: ReportSection,
  incoming: ReportSection,
): void {
  const target = existing.rows?.[0];
  const source = incoming.rows?.[0];
  if (!target || !source) return;

  const oldDeviceCount = Number(target.device_num ?? 0);
  const newDeviceCount = Number(source.device_num ?? 0);
  const totalDeviceCount = oldDeviceCount + newDeviceCount;
  const oldAverage = Number(target.ave_speed ?? 0);
  const newAverage = Number(source.ave_speed ?? 0);

  target.device_num = totalDeviceCount;
  target.trip_num = Number(target.trip_num ?? 0) + Number(source.trip_num ?? 0);
  target.trip_mileage_sum =
    Number(target.trip_mileage_sum ?? 0) + Number(source.trip_mileage_sum ?? 0);
  target.trip_time = secondsToDuration(
    durationToSeconds(target.trip_time) + durationToSeconds(source.trip_time),
  );
  target.ave_speed =
    totalDeviceCount > 0
      ? Math.round(
          ((oldAverage * oldDeviceCount + newAverage * newDeviceCount) /
            totalDeviceCount) *
            100,
        ) / 100
      : 0;
  target.max_speed = Math.max(
    Number(target.max_speed ?? 0),
    Number(source.max_speed ?? 0),
  );
  for (const field of [
    "oil_consumption",
    "trip_cost",
    "oil_consumption_sensor",
    "trip_cost_sensor",
  ]) {
    target[field] =
      Math.round(
        (Number(target[field] ?? 0) + Number(source[field] ?? 0)) * 100,
      ) / 100;
  }
}

function mergeSections(
  target: ReportSection[],
  incoming: ReportSection[],
): ReportSection[] {
  if (target.length === 0) return structuredClone(incoming);
  for (const part of incoming) {
    const existing = section(target, part.type);
    if (!existing) {
      target.push(structuredClone(part));
      continue;
    }
    if (/\.Sum$/i.test(part.type)) {
      mergeTripSummary(existing, part);
      continue;
    }
    if (part.rows?.length)
      existing.rows = [...(existing.rows ?? []), ...part.rows];
    if (part.device?.length)
      existing.device = [...(existing.device ?? []), ...part.device];
  }
  return target;
}

function incompleteTripDevices(
  sections: ReportSection[],
): Array<{ name: string; rows: number; total: number }> {
  const detail = section(sections, "Trip.Detail");
  return (detail?.device ?? []).flatMap((device) => {
    const rows = device.rows?.length ?? 0;
    const total = Number(device.total ?? rows);
    if (!Number.isFinite(total) || rows >= total) return [];
    return [
      { name: device.monitor_object?.trim() || "Ambulanca", rows, total },
    ];
  });
}

const thinBorder = {
  top: { style: "thin", color: { rgb: "000000" } },
  bottom: { style: "thin", color: { rgb: "000000" } },
  left: { style: "thin", color: { rgb: "000000" } },
  right: { style: "thin", color: { rgb: "000000" } },
};

const titleStyle = {
  font: { name: "Calibri", sz: 20, bold: true, color: { rgb: "FFFFFF" } },
  fill: { patternType: "solid", fgColor: { rgb: "002060" } },
  alignment: { horizontal: "center" },
};
const headerStyle = {
  font: { name: "Calibri", sz: 10, bold: true, color: { rgb: "FFFFFF" } },
  fill: { patternType: "solid", fgColor: { rgb: "002060" } },
  alignment: { horizontal: "center" },
  border: thinBorder,
};
const textStyle = {
  font: { name: "Calibri", sz: 11 },
  alignment: { horizontal: "left", vertical: "center", wrapText: true },
  border: thinBorder,
};

const integerStyle = {
  font: { name: "Calibri", sz: 11 },
  numFmt: "0",
  border: thinBorder,
};

const decimalStyle = {
  font: { name: "Calibri", sz: 11 },
  numFmt: "0.00",
  border: thinBorder,
};

function sectionHeaders(part: ReportSection | undefined): string[] {
  return (part?.columns ?? []).map((column) => column.text);
}

function sectionRows(
  part: ReportSection | undefined,
  rows: Array<Record<string, unknown>>,
): unknown[][] {
  const columns = part?.columns ?? [];
  return rows.map((row) => columns.map((column) => row[column.field] ?? ""));
}

function sevenSignificantDigits(value: unknown): unknown {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0)
    return value;
  const floatValue = Math.fround(value);
  const scale = 10 ** (6 - Math.floor(Math.log10(Math.abs(floatValue))));
  const scaled = floatValue * scale;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  const rounded =
    Math.abs(fraction - 0.5) < 1e-7 ? lower + (lower % 2) : Math.round(scaled);
  return rounded / scale;
}

function setCellStyle(
  sheet: XLSX.WorkSheet,
  row: number,
  column: number,
  style: object,
): void {
  const address = XLSX.utils.encode_cell({ r: row, c: column });
  if (!sheet[address]) sheet[address] = { t: "s", v: "" };
  sheet[address].s = style;
}

function styleRange(
  sheet: XLSX.WorkSheet,
  startRow: number,
  endRow: number,
  startColumn: number,
  endColumn: number,
  style: object,
): void {
  for (let row = startRow; row <= endRow; row += 1) {
    for (let column = startColumn; column <= endColumn; column += 1)
      setCellStyle(sheet, row, column, style);
  }
}

function safeSheetName(value: string): string {
  return (
    value
      .replace(/[\\/?*\[\]:]/g, " ")
      .trim()
      .slice(0, 31) || "Detail"
  );
}

function uniqueSheetName(value: string, usedNames: Set<string>): string {
  const base = safeSheetName(value);
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const ending = ` (${suffix})`;
    candidate = `${base.slice(0, 31 - ending.length)}${ending}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function groupedDetailDevices(
  detail: ReportSection | undefined,
): NonNullable<ReportSection["device"]> {
  const grouped = new Map<
    string,
    {
      monitor_object: string;
      total?: number;
      rows: Array<Record<string, unknown>>;
      rowKeys: Set<string>;
    }
  >();
  const columns = detail?.columns ?? [];

  for (const device of detail?.device ?? []) {
    const deviceName = device.monitor_object?.trim() || "Detail";
    const key = normalize(deviceName);
    let target = grouped.get(key);
    if (!target) {
      target = {
        monitor_object: deviceName,
        total: device.total,
        rows: [],
        rowKeys: new Set<string>(),
      };
      grouped.set(key, target);
    }

    for (const row of device.rows ?? []) {
      const rowKey = columns
        .map((column) => JSON.stringify(row[column.field] ?? ""))
        .join("\u001f");
      if (target.rowKeys.has(rowKey)) continue;
      target.rowKeys.add(rowKey);
      target.rows.push(row);
    }
  }

  return [...grouped.values()].map(
    ({ rowKeys: _rowKeys, ...device }) => device,
  );
}

function uniqueDeviceSummaryRows(
  part: ReportSection | undefined,
): Array<Record<string, unknown>> {
  const rows = part?.rows ?? [];
  const columns = part?.columns ?? [];
  const deviceColumn =
    columns.find((column) => {
      const text = normalize(column.text);
      const field = normalize(column.field);
      return (
        text === "device" ||
        text.includes("device") ||
        field.includes("device") ||
        field.includes("monitor object")
      );
    }) ?? columns[0];
  if (!deviceColumn) return rows;

  const seen = new Set<string>();
  return rows.filter((row) => {
    const deviceName = normalize(String(row[deviceColumn.field] ?? ""));
    if (!deviceName || seen.has(deviceName)) return false;
    seen.add(deviceName);
    return true;
  });
}

function writeWorkbook(
  file: string,
  _institution: string,
  _reportName: string,
  _start: string,
  _end: string,
  sections: ReportSection[],
): void {
  const workbook = XLSX.utils.book_new();
  const sum = section(sections, "Trip.Sum");
  const sumDetail = section(sections, "Trip.SumDetail");
  const detail = section(sections, "Trip.Detail");

  const summaryHeaders = sectionHeaders(sum);
  const summaryRows = sectionRows(sum, sum?.rows ?? []);
  const deviceHeaders = sectionHeaders(sumDetail);
  const deviceRows = sectionRows(sumDetail, uniqueDeviceSummaryRows(sumDetail));
  const totalData: unknown[][] = [
    [sum?.type ?? "Trip.Sum"],
    summaryHeaders,
    ...summaryRows,
    [],
    [sumDetail?.type ?? "Trip.SumDetail"],
    deviceHeaders,
    ...deviceRows,
  ];
  const totalSheet = XLSX.utils.aoa_to_sheet(totalData);
  const summaryLastColumn = Math.max(0, summaryHeaders.length - 1);
  const deviceLastColumn = Math.max(0, deviceHeaders.length - 1);
  totalSheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: summaryLastColumn } },
    { s: { r: 4, c: 0 }, e: { r: 4, c: deviceLastColumn } },
  ];
  totalSheet["!cols"] = [18, 11, 23, 17, 20, 16, 31, 10, 46, 25, 25].map(
    (width) => ({ width }),
  );
  totalSheet["!rows"] = totalData.map((_, index) => ({
    hpt: index === 0 || index === 4 ? 25 : 15,
  }));
  setCellStyle(totalSheet, 0, 0, titleStyle);
  styleRange(totalSheet, 1, 1, 0, summaryLastColumn, headerStyle);
  if (summaryRows.length) {
    styleRange(
      totalSheet,
      2,
      2 + summaryRows.length - 1,
      0,
      summaryLastColumn,
      textStyle,
    );
    for (const column of [0, 2])
      setCellStyle(totalSheet, 2, column, integerStyle);
    for (const column of [3, 5, 6, 7, 8, 9, 10])
      setCellStyle(totalSheet, 2, column, decimalStyle);
  }
  setCellStyle(totalSheet, 4, 0, titleStyle);
  styleRange(totalSheet, 5, 5, 0, deviceLastColumn, headerStyle);
  for (let row = 6; row < 6 + deviceRows.length; row += 1) {
    styleRange(totalSheet, row, row, 0, deviceLastColumn, textStyle);
    setCellStyle(totalSheet, row, 1, integerStyle);
    for (const column of [2, 4, 5, 6, 7, 8, 9])
      setCellStyle(totalSheet, row, column, decimalStyle);
  }
  XLSX.utils.book_append_sheet(workbook, totalSheet, "Total");

  const detailHeaders = sectionHeaders(detail);
  const usedSheetNames = new Set(["total"]);
  for (const device of groupedDetailDevices(detail)) {
    const deviceName = device.monitor_object?.trim() || "Detail";
    const rows = sectionRows(detail, device.rows ?? []).map((row) =>
      row.map((value, column) =>
        column === 10 ? sevenSignificantDigits(value) : value,
      ),
    );
    const data: unknown[][] = [
      [`${deviceName}(Detail)`],
      detailHeaders,
      ...rows,
    ];
    const sheet = XLSX.utils.aoa_to_sheet(data);
    const lastColumn = Math.max(0, detailHeaders.length - 1);
    sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: lastColumn } }];
    sheet["!cols"] = [
      18, 20, 20, 20, 16, 17, 18, 20, 20, 17, 31, 10, 46, 25,
    ].map((width) => ({ width }));
    sheet["!rows"] = data.map((_, index) => ({ hpt: index === 0 ? 25 : 15 }));
    setCellStyle(sheet, 0, 0, titleStyle);
    styleRange(sheet, 1, 1, 0, lastColumn, headerStyle);
    for (let row = 2; row < data.length; row += 1) {
      styleRange(sheet, row, row, 0, lastColumn, textStyle);
      for (const column of [3, 4, 5, 6, 10, 11])
        setCellStyle(sheet, row, column, decimalStyle);
    }
    XLSX.utils.book_append_sheet(
      workbook,
      sheet,
      uniqueSheetName(deviceName, usedSheetNames),
    );
  }

  XLSX.writeFile(workbook, file, { compression: true });
}

async function main(): Promise<void> {
  const account = process.env.GPS_ACCOUNT;
  const password = process.env.GPS_PASSWORD;
  if (!account || !password)
    throw new Error("Plotëso GPS_ACCOUNT dhe GPS_PASSWORD në .env.");

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
      multipart: {
        language: "en-us",
        timezone: "120",
        useraccount: account,
        password,
      },
    });
    if (!loginResponse.ok())
      throw new Error(`Login API dështoi me HTTP ${loginResponse.status()}.`);
    const loginText = await loginResponse.text();
    if (!loginText.trim())
      throw new Error(
        "Login API ktheu përgjigje bosh edhe pasi u dërgua header-i language.",
      );
    let loginBody: ApiEnvelope<LoginValue>;
    try {
      loginBody = JSON.parse(loginText) as ApiEnvelope<LoginValue>;
    } catch {
      throw new Error("Login API ktheu përgjigje që nuk është JSON.");
    }
    const loginValue = assertEnvelope(loginBody, "Login API");
    if (!loginValue.userToken)
      throw new Error("Login API nuk ktheu userToken.");
    const accountCode =
      process.env.GPS_API_ACCOUNT_CODE ||
      loginValue.sssid ||
      (await findAccountCode());
    const authHeaders = {
      Authorization: `Bearer ${loginValue.userToken}`,
      language: "en-us",
      "accept-language": "en-us",
    };

    const requestTripSections = async (
      batchImeis: string[],
      prefix: string,
      resultLimit: number,
    ): Promise<ReportSection[]> => {
      let lastTripError = "Trip API dështoi.";
      for (let attempt = 1; attempt <= TRIP_API_ATTEMPTS; attempt += 1) {
        let tripResponse;
        try {
          tripResponse = await api.get("/Report/Base/Trip", {
            headers: authHeaders,
            timeout: API_TIMEOUT,
            params: {
              imeis: batchImeis.join(","),
              startTime: start,
              endTime: end,
              offset: 0,
              limit: resultLimit,
              total: true,
              oil100km: 15,
            },
          });
          if (tripResponse.ok()) {
            return assertEnvelope(
              (await tripResponse.json()) as ApiEnvelope<ReportSection[]>,
              "Trip",
            );
          }

          lastTripError = `Trip API dështoi me HTTP ${tripResponse.status()}.`;
          const retryable = [408, 429, 500, 502, 503, 504].includes(
            tripResponse.status(),
          );
          if (!retryable || attempt === TRIP_API_ATTEMPTS) break;
          await tripResponse.dispose();
        } catch (error) {
          lastTripError =
            error instanceof Error
              ? `Trip API: ${error.message}`
              : String(error);
          if (attempt === TRIP_API_ATTEMPTS) break;
        }

        const waitMilliseconds = TRIP_API_RETRY_DELAY * attempt;
        console.log(
          `${prefix} - serveri GPS nuk u përgjigj; riprovimi ${attempt + 1}/${TRIP_API_ATTEMPTS} pas ${Math.round(waitMilliseconds / 1000)} sekondash...`,
        );
        await sleep(waitMilliseconds);
      }

      throw new Error(lastTripError);
    };

    const fetchTripSections = async (
      batchImeis: string[],
      prefix: string,
    ): Promise<ReportSection[]> => {
      let parts: ReportSection[];
      try {
        parts = await requestTripSections(
          batchImeis,
          prefix,
          TRIP_RESULT_LIMIT,
        );
      } catch (error) {
        if (batchImeis.length === 1) throw error;
        console.log(
          `${prefix} - grupi me ${batchImeis.length} ambulanca dështoi; po provohen një nga një...`,
        );
        let separated: ReportSection[] = [];
        for (const imei of batchImeis) {
          separated = mergeSections(
            separated,
            await fetchTripSections([imei], prefix),
          );
        }
        return separated;
      }

      const incomplete = incompleteTripDevices(parts);
      if (incomplete.length === 0) return parts;

      if (batchImeis.length > 1) {
        console.log(
          `${prefix} - grupi doli i paplotë; po rimerren ambulancat një nga një...`,
        );
        let separated: ReportSection[] = [];
        for (const imei of batchImeis) {
          separated = mergeSections(
            separated,
            await fetchTripSections([imei], prefix),
          );
        }
        return separated;
      }

      const requiredLimit = Math.max(
        TRIP_RESULT_LIMIT * 2,
        ...incomplete.map((item) => item.total),
      );
      console.log(
        `${prefix} - ${incomplete[0].name}: u morën ${incomplete[0].rows}/${incomplete[0].total} udhëtime; ` +
          `po riprovohet me limit ${requiredLimit}...`,
      );
      const completeParts = await requestTripSections(
        batchImeis,
        prefix,
        requiredLimit,
      );
      const stillIncomplete = incompleteTripDevices(completeParts);
      if (stillIncomplete.length > 0) {
        const item = stillIncomplete[0];
        throw new Error(
          `Raporti është i paplotë për ${item.name}: API ktheu ${item.rows} nga ${item.total} udhëtime.`,
        );
      }
      return completeParts;
    };

    const listResponse = await api.get("/ReportCustom/GetList", {
      headers: authHeaders,
      params: { sAccount: accountCode },
    });
    if (!listResponse.ok())
      throw new Error(
        `GetList dështoi me HTTP ${listResponse.status()}; sesioni API nuk u pranua.`,
      );
    const listText = await listResponse.text();
    if (!listText.trim())
      throw new Error(
        "GetList ktheu përgjigje bosh; sesioni API nuk u pranua.",
      );
    const customReports = assertEnvelope(
      JSON.parse(listText) as ApiEnvelope<CustomReport[]>,
      "GetList",
    );
    console.log(`U gjetën ${customReports.length} raporte në GPS.\n`);

    const missingOnly = process.argv.includes("--missing");
    const requestedInstitution = optionValue("--only");
    const allReports = (reports as ReportConfig[]).map(
      (config, reportIndex) => ({ config, reportIndex }),
    );
    let selectedReports = allReports;
    if (requestedInstitution) {
      const wanted = normalize(requestedInstitution);
      const exact = allReports.filter(
        ({ config }) => normalize(config.institution) === wanted,
      );
      const matches = exact.length
        ? exact
        : allReports.filter(
            ({ config }) =>
              normalize(config.institution).includes(wanted) ||
              config.aliases.some((alias) => normalize(alias).includes(wanted)),
          );
      if (matches.length === 0)
        throw new Error(
          `Nuk u gjet spital që përputhet me "${requestedInstitution}".`,
        );
      if (matches.length > 1)
        throw new Error(
          `"${requestedInstitution}" përputhet me: ${matches.map(({ config }) => config.institution).join(", ")}.`,
        );
      selectedReports = matches;
      console.log(
        `Ekzekutimi është kufizuar vetëm për: ${matches[0].config.institution}\n`,
      );
    }

    for (const [
      selectedIndex,
      { config, reportIndex },
    ] of selectedReports.entries()) {
      const prefix = `[${selectedIndex + 1}/${selectedReports.length}] ${config.institution}`;
      const file = path.join(
        outputDir,
        `${String(reportIndex + 1).padStart(2, "0")}_${safeFileName(config.institution)}_${month}.xlsx`,
      );
      try {
        if (missingOnly) {
          const exists = await fs
            .access(file)
            .then(() => true)
            .catch(() => false);
          if (exists) {
            results.push({
              institution: config.institution,
              status: "SKIPPED",
              file,
            });
            console.log(`${prefix} - ekziston, u anashkalua.\n`);
            continue;
          }
        }
        const customReport = findCustomReport(customReports, config);
        if (!customReport)
          throw new Error("Nuk u gjet raporti përkatës në GetList.");
        console.log(`${prefix} - ${customReport.name}, duke marrë pajisjet...`);

        const modelResponse = await api.get("/ReportCustom/GetModel", {
          headers: authHeaders,
          params: { sAccount: accountCode, sKey: customReport.custom_id },
        });
        const model = assertEnvelope(
          (await modelResponse.json()) as ApiEnvelope<{ trackers: Tracker[] }>,
          "GetModel",
        );
        const trackers = model.trackers ?? [];
        if (!trackers.length) throw new Error("Raporti nuk ka pajisje.");
        const imeis = [
          ...new Set(
            trackers.map((tracker) => tracker.sn_imei_id).filter(Boolean),
          ),
        ];

        let merged: ReportSection[] = [];
        for (
          let batchStart = 0;
          batchStart < imeis.length;
          batchStart += PAGE_SIZE
        ) {
          const batchImeis = imeis.slice(batchStart, batchStart + PAGE_SIZE);
          console.log(
            `${prefix} - të dhënat ${batchStart + 1}-${batchStart + batchImeis.length} nga ${imeis.length}...`,
          );
          merged = mergeSections(
            merged,
            await fetchTripSections(batchImeis, prefix),
          );
        }

        writeWorkbook(
          file,
          config.institution,
          customReport.name,
          start,
          end,
          merged,
        );
        results.push({
          institution: config.institution,
          report: customReport.name,
          status: "OK",
          file,
        });
        console.log(`${prefix} - OK\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          institution: config.institution,
          status: "FAILED",
          error: message,
        });
        console.error(`${prefix} - DËSHTOI: ${message}\n`);
      }
    }
  } finally {
    await api.dispose();
  }

  const summaryFile = path.join(outputDir, `rezultati_api_${month}.json`);
  await fs.writeFile(
    summaryFile,
    JSON.stringify({ month, start, end, results }, null, 2),
    "utf8",
  );
  const ok = results.filter((item) => item.status === "OK").length;
  const skipped = results.filter((item) => item.status === "SKIPPED").length;
  const failed = results.filter((item) => item.status === "FAILED").length;
  console.log(
    `Përfundoi: ${ok} me sukses, ${skipped} të anashkaluara, ${failed} me gabim.`,
  );
  console.log(`Dosja: ${outputDir}`);
  if (failed > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(
    "\nGabim fatal:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});

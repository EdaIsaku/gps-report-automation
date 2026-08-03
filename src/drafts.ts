import "dotenv/config";
import { PublicClientApplication } from "@azure/msal-node";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import reports from "../reports.json" with { type: "json" };
import recipients from "../email-recipients.json" with { type: "json" };

type Recipient = { institution: string; email: string };
type DraftResult = {
  institution: string;
  email: string;
  file?: string;
  subject?: string;
  status: "READY" | "CREATED" | "SKIPPED" | "MISSING_REPORT" | "FAILED";
  draftId?: string;
  webLink?: string;
  error?: string;
};
type GraphDraft = { id: string; webLink?: string };
type UploadSession = { uploadUrl: string };

const GRAPH_URL = "https://graph.microsoft.com/v1.0";
const DOWNLOAD_ROOT = process.env.GPS_DOWNLOAD_ROOT ?? "downloads";
const EXPECTED_ACCOUNT = (process.env.MS_EXPECTED_ACCOUNT ?? "info@urgjenca.gov.al").toLowerCase();
const SMALL_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
const LARGE_ATTACHMENT_LIMIT = 150 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 10 * 320 * 1024;
const MONTH_NAMES = ["Janar", "Shkurt", "Mars", "Prill", "Maj", "Qershor", "Korrik", "Gusht", "Shtator", "Tetor", "Nëntor", "Dhjetor"];

function safeFileName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[<>:"/\\|?*]+/g, "").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function monthLabel(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Muaji duhet të jetë YYYY-MM, p.sh. 2026-07.");
  const [year, monthNumber] = month.split("-").map(Number);
  return `${MONTH_NAMES[monthNumber - 1]} ${year}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function messageFor(institution: string, label: string): { subject: string; body: string } {
  return {
    subject: `Raporti GPS – ${label} – ${institution}`,
    body: `<p>Përshëndetje,</p><p>Bashkëlidhur po ju përcjellim raportin GPS për muajin <strong>${escapeHtml(label)}</strong>, për ${escapeHtml(institution)}.</p><p>Faleminderit,<br>Qendra Kombëtare e Urgjencës Mjekësore</p>`,
  };
}

async function graphRequest(accessToken: string, endpoint: string, init: RequestInit): Promise<Response> {
  let lastError = "Microsoft Graph nuk u përgjigj.";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`${GRAPH_URL}${endpoint}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (response.ok) return response;
    const details = await response.text();
    lastError = `Microsoft Graph: HTTP ${response.status}${details ? ` – ${details.slice(0, 500)}` : ""}`;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 4) break;
    const retryAfter = Number(response.headers.get("retry-after") ?? attempt * 5);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
  }
  throw new Error(lastError);
}

async function addAttachment(accessToken: string, draftId: string, file: string): Promise<void> {
  const content = await fs.readFile(file);
  const name = path.basename(file);
  if (content.length >= LARGE_ATTACHMENT_LIMIT) throw new Error(`Bashkëngjitja ${name} është mbi kufirin 150 MB të Microsoft Graph.`);

  const encodedId = encodeURIComponent(draftId);
  if (content.length < SMALL_ATTACHMENT_LIMIT) {
    await graphRequest(accessToken, `/me/messages/${encodedId}/attachments`, {
      method: "POST",
      body: JSON.stringify({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        contentBytes: content.toString("base64"),
      }),
    });
    return;
  }

  const sessionResponse = await graphRequest(accessToken, `/me/messages/${encodedId}/attachments/createUploadSession`, {
    method: "POST",
    body: JSON.stringify({ AttachmentItem: { attachmentType: "file", name, size: content.length } }),
  });
  const session = await sessionResponse.json() as UploadSession;
  if (!session.uploadUrl) throw new Error("Microsoft Graph nuk ktheu uploadUrl për bashkëngjitjen.");

  for (let start = 0; start < content.length; start += UPLOAD_CHUNK_SIZE) {
    const end = Math.min(start + UPLOAD_CHUNK_SIZE, content.length);
    const response = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(end - start),
        "Content-Range": `bytes ${start}-${end - 1}/${content.length}`,
      },
      body: content.subarray(start, end),
    });
    if (!response.ok) throw new Error(`Ngarkimi i bashkëngjitjes dështoi me HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
}

async function main(): Promise<void> {
  const month = process.argv.find((argument) => /^\d{4}-\d{2}$/.test(argument));
  if (!month) throw new Error("Jep muajin, p.sh. npm run drafts -- 2026-07 --preview");
  const previewOnly = process.argv.includes("--preview");
  const force = process.argv.includes("--force");
  const label = monthLabel(month);
  const outputDir = path.resolve(DOWNLOAD_ROOT, month);
  const resultFile = path.join(outputDir, `drafts_${month}.json`);
  await fs.mkdir(outputDir, { recursive: true });

  const recipientMap = new Map((recipients as Recipient[]).map((item) => [item.institution, item.email]));
  const institutions = (reports as Array<{ institution: string }>).map((item) => item.institution);
  const missingRecipients = institutions.filter((institution) => !recipientMap.has(institution));
  if (missingRecipients.length) throw new Error(`Mungojnë email-et për: ${missingRecipients.join(", ")}`);

  const previous = await fs.readFile(resultFile, "utf8")
    .then((text) => JSON.parse(text) as { results?: DraftResult[] })
    .catch(() => ({ results: [] }));
  const alreadyCreated = new Set((previous.results ?? []).filter((item) => item.status === "CREATED").map((item) => item.institution));

  const plans = await Promise.all(institutions.map(async (institution, index) => {
    const email = recipientMap.get(institution)!;
    const file = path.join(outputDir, `${String(index + 1).padStart(2, "0")}_${safeFileName(institution)}_${month}.xlsx`);
    const exists = await fs.access(file).then(() => true).catch(() => false);
    const message = messageFor(institution, label);
    return { institution, email, file, exists, ...message };
  }));

  if (previewOnly) {
    const results: DraftResult[] = plans.map((plan) => ({
      institution: plan.institution,
      email: plan.email,
      file: plan.file,
      subject: plan.subject,
      status: plan.exists ? "READY" : "MISSING_REPORT",
    }));
    await fs.writeFile(resultFile, JSON.stringify({ month, mode: "PREVIEW", results }, null, 2), "utf8");
    for (const result of results) console.log(`${result.institution} → ${result.email}: ${result.status}`);
    console.log(`\nParapamja përfundoi: ${results.filter((item) => item.status === "READY").length} gati, ${results.filter((item) => item.status === "MISSING_REPORT").length} pa raport.`);
    console.log(`Përmbledhja: ${resultFile}`);
    return;
  }

  const clientId = process.env.MS_CLIENT_ID;
  const tenantId = process.env.MS_TENANT_ID;
  if (!clientId || !tenantId) throw new Error("Plotëso MS_CLIENT_ID dhe MS_TENANT_ID në .env. Mund të përdorësh --preview pa autentikim.");

  const application = new PublicClientApplication({
    auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` },
  });
  const authentication = await application.acquireTokenByDeviceCode({
    scopes: ["https://graph.microsoft.com/Mail.ReadWrite"],
    deviceCodeCallback: (response) => console.log(`\n${response.message}\n`),
  });
  if (!authentication?.accessToken) throw new Error("Microsoft nuk ktheu token autentikimi.");
  const signedInAccount = authentication.account?.username?.toLowerCase();
  if (signedInAccount !== EXPECTED_ACCOUNT) {
    throw new Error(`U bë hyrja me ${signedInAccount || "llogari të panjohur"}; kërkohet ${EXPECTED_ACCOUNT}. Asnjë draft nuk u krijua.`);
  }

  const results: DraftResult[] = [];
  for (const [index, plan] of plans.entries()) {
    const prefix = `[${index + 1}/${plans.length}] ${plan.institution}`;
    if (!plan.exists) {
      results.push({ institution: plan.institution, email: plan.email, file: plan.file, subject: plan.subject, status: "MISSING_REPORT" });
      console.log(`${prefix} - mungon raporti, u anashkalua.`);
      continue;
    }
    if (!force && alreadyCreated.has(plan.institution)) {
      results.push({ institution: plan.institution, email: plan.email, file: plan.file, subject: plan.subject, status: "SKIPPED" });
      console.log(`${prefix} - drafti figuron i krijuar, u anashkalua.`);
      continue;
    }

    let draftId: string | undefined;
    try {
      const draftResponse = await graphRequest(authentication.accessToken, "/me/messages", {
        method: "POST",
        body: JSON.stringify({
          subject: plan.subject,
          importance: "Normal",
          body: { contentType: "HTML", content: plan.body },
          toRecipients: [{ emailAddress: { address: plan.email } }],
        }),
      });
      const draft = await draftResponse.json() as GraphDraft;
      draftId = draft.id;
      if (!draftId) throw new Error("Microsoft Graph nuk ktheu ID-në e draftit.");
      await addAttachment(authentication.accessToken, draftId, plan.file);
      results.push({ institution: plan.institution, email: plan.email, file: plan.file, subject: plan.subject, status: "CREATED", draftId, webLink: draft.webLink });
      console.log(`${prefix} - DRAFT U KRIJUA.`);
    } catch (error) {
      if (draftId) {
        await graphRequest(authentication.accessToken, `/me/messages/${encodeURIComponent(draftId)}`, { method: "DELETE" }).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : String(error);
      results.push({ institution: plan.institution, email: plan.email, file: plan.file, subject: plan.subject, status: "FAILED", error: message });
      console.error(`${prefix} - DËSHTOI: ${message}`);
    }
  }

  await fs.writeFile(resultFile, JSON.stringify({ month, mode: "CREATE_DRAFTS", account: EXPECTED_ACCOUNT, results }, null, 2), "utf8");
  console.log(`\nPërfundoi: ${results.filter((item) => item.status === "CREATED").length} drafte të krijuara, ${results.filter((item) => item.status === "SKIPPED").length} të anashkaluara, ${results.filter((item) => item.status === "MISSING_REPORT").length} pa raport, ${results.filter((item) => item.status === "FAILED").length} me gabim.`);
  console.log(`Përmbledhja: ${resultFile}`);
}

main().catch((error) => {
  console.error("\nGabim fatal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

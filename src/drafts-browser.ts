import "dotenv/config";
import { chromium, type Locator, type Page } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import reports from "../reports.json" with { type: "json" };
import recipients from "../email-recipients.json" with { type: "json" };

type Recipient = { institution: string; email: string };

const DOWNLOAD_ROOT = process.env.GPS_DOWNLOAD_ROOT ?? "downloads";
const PROFILE_DIR = path.resolve(process.env.OUTLOOK_PROFILE_DIR ?? ".outlook-browser-profile");
const MONTH_NAMES = ["Janar", "Shkurt", "Mars", "Prill", "Maj", "Qershor", "Korrik", "Gusht", "Shtator", "Tetor", "Nëntor", "Dhjetor"];

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, " ").trim().toLowerCase();
}

function safeFileName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[<>:"/\\|?*]+/g, "").replace(/\s+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function monthLabel(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Muaji duhet të jetë YYYY-MM, p.sh. 2026-07.");
  const [year, monthNumber] = month.split("-").map(Number);
  return `${MONTH_NAMES[monthNumber - 1]} ${year}`;
}

function optionValue(name: string): string | undefined {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Pas ${name} duhet të vendosësh një vlerë.`);
  return value.trim();
}

async function firstVisible(candidates: Locator[], timeout = 30_000): Promise<Locator> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      const locator = candidate.first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Nuk u gjet elementi i nevojshëm në Outlook Web.");
}

function toInputCandidates(page: Page): Locator[] {
  return [
    page.locator('input[aria-label*="To" i]'),
    page.locator('[role="textbox"][aria-label*="To" i]'),
    page.locator('[data-automation-id="toField"] input, [data-testid="to-field"] input'),
    page.getByRole("textbox", { name: /to|marrës|marres/i }),
  ];
}

function subjectCandidates(page: Page): Locator[] {
  return [
    page.locator('input[placeholder*="subject" i]'),
    page.locator('input[aria-label*="subject" i]'),
    page.locator('[data-automation-id="subjectLine"] input'),
    page.getByRole("textbox", { name: /subject|subjekt/i }),
  ];
}

function bodyCandidates(page: Page): Locator[] {
  return [
    page.locator('div[contenteditable="true"][aria-label*="message body" i]'),
    page.locator('[data-automation-id="messageBody"] div[contenteditable="true"]'),
    page.locator('div[contenteditable="true"][role="textbox"]').last(),
  ];
}

function composeUrl(to: string, subject: string, body: string): string {
  const url = new URL("https://outlook.office.com/mail/deeplink/compose");
  url.searchParams.set("to", to);
  url.searchParams.set("subject", subject);
  url.searchParams.set("body", body);
  return url.toString();
}

async function openCompose(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await firstVisible(subjectCandidates(page), 30_000);
}

async function saveDebug(page: Page): Promise<{ screenshot: string; html: string }> {
  const debugDir = path.resolve("debug");
  await fs.mkdir(debugDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshot = path.join(debugDir, `${stamp}_outlook-browser-error.png`);
  const html = path.join(debugDir, `${stamp}_outlook-browser-error.html`);
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
  await fs.writeFile(html, await page.content(), "utf8").catch(() => undefined);
  return { screenshot, html };
}

async function attachFile(page: Page, file: string): Promise<void> {
  const attach = await firstVisible([
    page.getByRole("button", { name: /attach|bashkëngjit|bashkengjit/i }),
    page.locator('button[aria-label*="Attach" i]'),
  ]);
  await attach.click();

  const existingInput = page.locator('input[type="file"]');
  if (await existingInput.count()) {
    await existingInput.last().setInputFiles(file);
  } else {
    const fromComputer = await firstVisible([
      page.getByRole("menuitem", { name: /browse this computer|upload from this device|browse|computer|pajisj/i }),
      page.getByText(/browse this computer|upload from this device|browse|computer|pajisj/i),
    ]);
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 30_000 });
    await fromComputer.click();
    const chooser = await chooserPromise;
    await chooser.setFiles(file);
  }

  await page.getByText(path.basename(file), { exact: false }).first().waitFor({ state: "visible", timeout: 120_000 });
}

async function main(): Promise<void> {
  const month = process.argv.find((argument) => /^\d{4}-\d{2}$/.test(argument));
  if (!month) throw new Error('Jep muajin, p.sh. npm run drafts-browser -- 2026-07 --only "Bulqize".');
  const requested = optionValue("--only");
  if (!requested) throw new Error('Për provën përdor --only, p.sh. --only "Bulqize".');

  const allReports = reports as Array<{ institution: string }>;
  const wanted = normalize(requested);
  const exact = allReports.map((item, index) => ({ ...item, index })).filter((item) => normalize(item.institution) === wanted);
  const matches = exact.length ? exact : allReports.map((item, index) => ({ ...item, index })).filter((item) => normalize(item.institution).includes(wanted));
  if (matches.length === 0) throw new Error(`Nuk u gjet spital që përputhet me "${requested}".`);
  if (matches.length > 1) throw new Error(`"${requested}" përputhet me: ${matches.map((item) => item.institution).join(", ")}. Jep emër më të plotë.`);

  const selected = matches[0];
  const recipient = (recipients as Recipient[]).find((item) => item.institution === selected.institution);
  if (!recipient?.email) throw new Error(`Mungon email-i për ${selected.institution}.`);
  const file = path.resolve(DOWNLOAD_ROOT, month, `${String(selected.index + 1).padStart(2, "0")}_${safeFileName(selected.institution)}_${month}.xlsx`);
  await fs.access(file).catch(() => { throw new Error(`Nuk u gjet raporti: ${file}`); });

  const label = monthLabel(month);
  const subject = `Raporti GPS – ${label} – ${selected.institution}`;
  const body = `Përshëndetje,\n\nBashkëlidhur po ju përcjellim raportin GPS për muajin ${label}, për ${selected.institution}.\n\nFaleminderit,\nQendra Kombëtare e Urgjencës Mjekësore`;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    const draftUrl = composeUrl(recipient.email, subject, body);
    try {
      await openCompose(page, draftUrl);
    } catch {
      console.log("\nHyr manualisht në Outlook me info@urgjenca.gov.al dhe përfundo MFA-në.");
      await rl.question("Kur të jetë hapur Inbox, shtyp ENTER këtu...");
      try {
        await openCompose(page, draftUrl);
      } catch {
        const debug = await saveDebug(page);
        throw new Error(
          `Nuk u hap formulari i draftit në Outlook Web. U ruajtën për kontroll: ${debug.screenshot} dhe ${debug.html}`,
        );
      }
    }

    console.log(`Po krijohet drafti vetëm për ${selected.institution} → ${recipient.email}`);

    const recipientVisible = await page.getByText(recipient.email, { exact: false }).first().isVisible().catch(() => false);
    if (!recipientVisible) {
      const to = await firstVisible(toInputCandidates(page));
      await to.fill(recipient.email);
      await to.press("Enter");
    }

    const subjectInput = await firstVisible(subjectCandidates(page));
    if ((await subjectInput.inputValue().catch(() => "")) !== subject) await subjectInput.fill(subject);

    const bodyInput = await firstVisible(bodyCandidates(page));
    const currentBody = (await bodyInput.innerText().catch(() => "")).trim();
    if (!currentBody.includes("Bashkëlidhur po ju përcjellim raportin GPS")) await bodyInput.fill(body);
    await attachFile(page, file);
    await page.waitForTimeout(8_000);

    console.log("\nDRAFTI U PLOTËSUA. Script-i nuk do të klikojë Send.");
    console.log("Kontrolloje në browser dhe lëre si draft.");
    await rl.question("Pasi ta kesh kontrolluar, shtyp ENTER për të mbyllur browser-in e automatizimit...");
  } finally {
    rl.close();
    await context.close();
  }
}

main().catch((error) => {
  console.error("\nGabim fatal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

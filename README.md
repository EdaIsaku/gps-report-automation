# GPS Report Automation

A Node.js and TypeScript application that automates monthly GPS travel-report retrieval and generates structured Excel workbooks for multiple institutions.

The application communicates directly with the GPS platform API, retrieves the configured reports and associated devices, collects monthly trip data, handles paginated results, and creates a separate Excel file for each institution.

## Features

- Direct API authentication using bearer tokens
- Automatic calculation of monthly date ranges
- Retrieval of configured institutional reports
- Automatic report matching using aliases
- Retrieval of GPS devices associated with each report
- Monthly trip-data collection
- Pagination support
- Separate Excel workbook for each institution
- Summary, device-level summary, and trip-detail worksheets
- Automatic continuation when an individual report fails
- Final JSON execution report with successful and failed exports
- Optional browser-based diagnostic mode

## Generated Excel Structure

Each workbook can contain the following worksheets:

- `Information`
- `Summary`
- `Device Summary`
- `Trip Details`

Files are saved under:

```text
downloads/YYYY-MM/
```

Example:

```text
downloads/2026-07/01_Spitali_Berat_2026-07.xlsx
```

## Technologies

- Node.js
- TypeScript
- Playwright APIRequestContext
- SheetJS (`xlsx`)
- dotenv

Playwright is also used in diagnostic mode to inspect browser requests when API changes need to be investigated.

## Requirements

- Node.js 20 or later
- npm
- Valid credentials for the authorized GPS platform account

## Installation

Clone the repository:

```bash
git clone https://github.com/YOUR-USERNAME/gps-report-automation.git
cd gps-report-automation
```

Install the dependencies:

```bash
npm install
```

If browser-based diagnostics are required, install Chromium:

```bash
npm run install-browser
```

## Environment Configuration

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

On Windows, you can copy the file manually or run:

```powershell
Copy-Item .env.example .env
```

Configure the required values:

```env
GPS_ACCOUNT=
GPS_PASSWORD=

GPS_BASE_URL=
GPS_API_URL=

GPS_DOWNLOAD_ROOT=downloads
GPS_API_TIMEOUT_MS=600000
GPS_API_PAGE_SIZE=100
```

Never commit the `.env` file.

## Run the API Version

Run the automation for a specific month:

```bash
npm run api -- 2026-07
```

If no month is supplied, the application asks for one and suggests the previous month.

On Windows, you can also open:

```text
run-api.bat
```

## Diagnostic Mode

Diagnostic mode is only intended for investigating changes to the platform API or user interface.

```bash
npm run discover-api -- 2026-07
```

Diagnostic files are stored in:

```text
debug/
```

These files may contain institutional report data or device identifiers and must never be committed or shared publicly.

## Project Structure

```text
gps-report-automation/
├── src/
│   ├── api.ts
│   └── index.ts
├── reports.json
├── .env.example
├── .gitignore
├── package.json
├── run-api.bat
├── run.bat
├── setup.bat
└── README.md
```

## Report Configuration

Institution names and their aliases are configured in:

```text
reports.json
```

Example:

```json
{
  "institution": "Institution Name",
  "aliases": ["GPS Report Name", "Alternative Name"]
}
```

Aliases allow official institution names to be matched with shorter report names used by the GPS platform.

## Error Handling

If one report fails, the application records the error and continues processing the remaining institutions.

A final execution summary is generated at:

```text
downloads/YYYY-MM/rezultati_api_YYYY-MM.json
```

The summary includes:

- institution name
- matched GPS report
- execution status
- generated file path
- error details, when applicable

## Security

The following files and directories must not be committed:

```text
.env
debug/
downloads/
playwright-profile/
node_modules/
```

Do not place passwords, bearer tokens, cookies, API traces, device identifiers, or downloaded institutional reports in the repository.

Rotate credentials immediately if they are accidentally exposed.

## License

This project is intended for authorized internal use. Add an open-source license only if publication and redistribution have been formally approved.

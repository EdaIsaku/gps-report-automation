# Dokumentacioni teknik i API-së GPS

## 1. Qëllimi dhe statusi i dokumentit

Ky dokument përshkruan API-në që përdor projekti `gps-reports-automation` për të lexuar raportet mujore të udhëtimeve nga platforma GPS Elektrosek dhe për t'i kthyer ato në skedarë Excel.

> **E rëndësishme:** endpoint-et janë identifikuar nga trafiku i aplikacionit web dhe nga sjellja e verifikuar e sistemit. Ky nuk është dokumentacion zyrtar i publikuar nga furnitori dhe nuk përbën kontratë API. Emrat, portat, parametrat dhe formatet e përgjigjeve mund të ndryshojnë nga administratori ose furnitori i platformës.

Dokumenti pasqyron implementimin e projektit në gusht 2026.

## 2. Adresat bazë

| Qëllimi | Vlera standarde | Variabla `.env` |
|---|---|---|
| Aplikacioni web | `https://gpstracker.elektrosek.com` | `GPS_BASE_URL` |
| API | `https://gpstracker.elektrosek.com:18889` | `GPS_API_URL` |

Të gjitha endpoint-et e mëposhtme janë relative ndaj `GPS_API_URL`.

## 3. Rrjedha e plotë

1. Autentikimi me `POST /Login/UserLogin`.
2. Marrja e `userToken` dhe kodit të llogarisë `sssid`.
3. Leximi i raporteve të personalizuara me `GET /ReportCustom/GetList`.
4. Përzgjedhja e raportit `Travel Report` për institucionin.
5. Leximi i ambulancave/IMEI-ve të raportit me `GET /ReportCustom/GetModel`.
6. Marrja e të dhënave të udhëtimeve me `GET /Report/Base/Trip`.
7. Bashkimi i grupeve të ambulancave dhe krijimi i Excel-it.

## 4. Header-at e përbashkët

### Para autentikimit

```http
Accept: application/json, text/plain, */*
language: en-us
Referer: https://gpstracker.elektrosek.com/
```

### Pas autentikimit

```http
Authorization: Bearer <userToken>
Accept: application/json, text/plain, */*
language: en-us
accept-language: en-us
Referer: https://gpstracker.elektrosek.com/
```

`userToken` merret nga endpoint-i i hyrjes. Token-i nuk duhet të ruhet në Git, dokumentacion, log publik ose skedar të shpërndarë.

## 5. Formati i përgjigjes

Endpoint-et kryesore kthejnë një envelope JSON të kësaj forme:

```ts
type ApiEnvelope<T> = {
  state: boolean;
  message?: string;
  code?: number;
  errorMessage?: string | null;
  value: T;
};
```

Një përgjigje konsiderohet e suksesshme vetëm kur:

- statusi HTTP është `2xx`; dhe
- `state === true`.

Nëse `state` është `false`, aplikacioni përdor `errorMessage` ose `message` si përshkrim gabimi.

---

## 6. Endpoint-et

### 6.1 Autentikimi

```http
POST /Login/UserLogin
Content-Type: multipart/form-data
```

#### Fushat multipart

| Fusha | Tipi | Kërkohet | Përshkrimi |
|---|---|---:|---|
| `language` | string | Po | Aktualisht `en-us` |
| `timezone` | string | Po | Diferenca në minuta nga UTC; projekti përdor `120` |
| `useraccount` | string | Po | Llogaria GPS |
| `password` | string | Po | Fjalëkalimi GPS |

#### Shembull

```bash
curl -X POST "$GPS_API_URL/Login/UserLogin" \
  -H "language: en-us" \
  -H "Referer: https://gpstracker.elektrosek.com/" \
  -F "language=en-us" \
  -F "timezone=120" \
  -F "useraccount=$GPS_ACCOUNT" \
  -F "password=$GPS_PASSWORD"
```

#### Fushat e përdorura nga përgjigjja

```json
{
  "state": true,
  "value": {
    "sssid": "<account-code>",
    "userToken": "<bearer-token>"
  }
}
```

| Fusha | Përdorimi |
|---|---|
| `value.userToken` | Vendoset në header-in `Authorization: Bearer ...` |
| `value.sssid` | Përdoret si parametri `sAccount` |

#### Gabime të njohura

| Gjendja | Interpretimi |
|---|---|
| HTTP `401` | Kredenciale të pasakta ose sesion i papranuar |
| Përgjigje bosh | Header-i `language` mungon ose serveri nuk dha përgjigje të vlefshme |
| JSON jo i vlefshëm | Problem i përkohshëm në server/proxy |

---

### 6.2 Lista e raporteve të personalizuara

```http
GET /ReportCustom/GetList?sAccount=<accountCode>
```

#### Query parameters

| Parametri | Tipi | Kërkohet | Përshkrimi |
|---|---|---:|---|
| `sAccount` | string | Po | Kodi `sssid` i marrë gjatë autentikimit |

#### Modeli minimal i elementit

```ts
type CustomReport = {
  custom_id: number;
  name: string;
  report_type: number;
  start_time?: string;
  end_time?: string;
  show_sum?: boolean;
  show_sum_detail?: boolean;
  show_detail?: boolean;
};
```

#### Shembull i sanitizuar

```json
{
  "state": true,
  "value": [
    {
      "custom_id": 3363,
      "report_type": 3,
      "name": "Shkoder",
      "show_sum": true,
      "show_sum_detail": true
    }
  ]
}
```

Projekti pranon vetëm elementet me `report_type === 3` dhe i përputh emrat me alias-et në `reports.json`. Krahasimi:

- nuk dallon shkronja të mëdha/vogla;
- heq diakritikat, p.sh. `Shkodër` → `shkoder`;
- kërkon që emri i raportit të fillojë me alias-in e konfiguruar.

---

### 6.3 Modeli i raportit dhe ambulancat

```http
GET /ReportCustom/GetModel?sAccount=<accountCode>&sKey=<customId>
```

#### Query parameters

| Parametri | Tipi | Kërkohet | Përshkrimi |
|---|---|---:|---|
| `sAccount` | string | Po | Kodi i llogarisë |
| `sKey` | number | Po | `custom_id` i raportit të zgjedhur |

#### Modeli i ambulancës

```ts
type Tracker = {
  tracker_name: string;
  sn_imei_id: string;
  custom_id?: number;
  bind_id?: number;
};
```

#### Shembull i sanitizuar

```json
{
  "state": true,
  "value": {
    "custom_id": 3363,
    "name": "Shkoder",
    "trackers": [
      {
        "tracker_name": "AA 000 XX SHEMBULL",
        "sn_imei_id": "000000000000000"
      }
    ]
  }
}
```

`sn_imei_id` përdoret te parametri `imeis` i endpoint-it `Trip`. Nëse `trackers` është bosh, projekti e shënon raportin me gabimin `Raporti nuk ka pajisje.`

---

### 6.4 Raporti i udhëtimeve

```http
GET /Report/Base/Trip
```

#### Query parameters

| Parametri | Tipi | Kërkohet | Shembull | Përshkrimi |
|---|---|---:|---|---|
| `imeis` | string | Po | `imei1,imei2,imei3` | IMEI-t e ndarë me presje |
| `startTime` | datetime | Po | `2026-07-01 00:00:00` | Fillimi i periudhës |
| `endTime` | datetime | Po | `2026-07-31 23:59:59` | Fundi i periudhës |
| `offset` | integer | Po | `0` | Pozicioni fillestar |
| `limit` | integer | Po | `3` | Numri maksimal i pajisjeve në grup |
| `total` | boolean | Po | `true` | Kërkon totalet e raportit |
| `oil100km` | number | Po | `15` | Koeficienti i llogaritjes së karburantit |

#### Shembull

```bash
curl --get "$GPS_API_URL/Report/Base/Trip" \
  -H "Authorization: Bearer $GPS_TOKEN" \
  -H "language: en-us" \
  --data-urlencode "imeis=000000000000001,000000000000002" \
  --data-urlencode "startTime=2026-07-01 00:00:00" \
  --data-urlencode "endTime=2026-07-31 23:59:59" \
  --data-urlencode "offset=0" \
  --data-urlencode "limit=2" \
  --data-urlencode "total=true" \
  --data-urlencode "oil100km=15"
```

#### Seksionet e përgjigjes

`value` është një array me tre seksione:

| `type` | Përmbajtja |
|---|---|
| `Trip.Sum` | Totali i të gjithë grupit të pajisjeve |
| `Trip.SumDetail` | Një rresht për çdo ambulancë |
| `Trip.Detail` | Lista e udhëtimeve, e grupuar sipas ambulancës |

##### `Trip.Sum`

| Fusha | Përshkrimi |
|---|---|
| `device_num` | Numri i pajisjeve |
| `time_interval` | Periudha e raportit |
| `trip_num` | Numri i udhëtimeve |
| `trip_mileage_sum` | Kilometrat totale të udhëtimeve |
| `trip_time` | Kohëzgjatja totale, formati `H+:MM:SS` |
| `ave_speed` | Shpejtësia mesatare në km/h |
| `max_speed` | Shpejtësia maksimale në km/h |
| `oil_consumption` | Konsumi i llogaritur i karburantit në litra |
| `trip_cost` | Kostoja e udhëtimeve |
| `oil_consumption_sensor` | Konsumi sipas sensorit |
| `trip_cost_sensor` | Kostoja sipas sensorit |

##### `Trip.SumDetail`

Ka të njëjtat fusha agreguese si `Trip.Sum`, por përdor `monitor_object` si emrin e ambulancës dhe nuk përmban `device_num`/`time_interval`.

##### `Trip.Detail`

| Fusha | Përshkrimi |
|---|---|
| `monitor_object` | Emri/targa e ambulancës |
| `start_time` | Data dhe ora e nisjes |
| `end_time` | Data dhe ora e përfundimit |
| `ave_speed` | Shpejtësia mesatare |
| `max_speed` | Shpejtësia maksimale |
| `trip_mileage` | Kilometrat e udhëtimit |
| `mileage_total` | Kilometrazhi total i pajisjes |
| `start_address` | Adresa ose koordinatat e nisjes |
| `stop_address` | Adresa ose koordinatat e mbërritjes |
| `trip_time` | Kohëzgjatja e udhëtimit |
| `oil_consumption` | Konsumi i llogaritur |
| `trip_cost` | Kostoja e udhëtimit |
| `oil_consumption_sensor` | Konsumi sipas sensorit |
| `trip_cost_sensor` | Kostoja sipas sensorit |

`Trip.Detail.device` ka këtë formë:

```ts
type TripDeviceDetail = {
  monitor_object: string;
  total: number;
  rows: Array<Record<string, unknown>>;
};
```

## 7. Strategjia e ngarkesës dhe e gabimeve `502`

Raportet mujore me shumë ambulanca ose shumë udhëtime mund të tejkalojnë kohën e përpunimit të serverit dhe të kthejnë HTTP `502`.

Implementimi aktual:

1. Ndan listën në grupe me `GPS_API_PAGE_SIZE` pajisje; parazgjedhja është `3`.
2. Për çdo grup provon deri në `GPS_TRIP_API_ATTEMPTS`; parazgjedhja është `4` tentativa.
3. Për statuset `408`, `429`, `500`, `502`, `503`, `504`, pret në mënyrë progresive.
4. Me `GPS_TRIP_API_RETRY_DELAY_MS=30000`, pritjet janë 30, 60 dhe 90 sekonda.
5. Nëse grupi vazhdon të dështojë, i provon IMEI-t një nga një.
6. Bashkon totalet dhe detajet e përgjigjeve në një raport të vetëm.

Timeout-i i një kërkese kontrollohet nga `GPS_API_TIMEOUT_MS` dhe është 600 000 ms (10 minuta) si parazgjedhje.

## 8. Bashkimi i rezultateve

Kur një institucion ndahet në disa kërkesa:

- `device_num`, `trip_num`, kilometrat, kohëzgjatja, konsumi dhe kostot mblidhen;
- `max_speed` merr vlerën maksimale;
- `ave_speed` bashkohet si mesatare e ponderuar sipas numrit të pajisjeve;
- rreshtat e `Trip.SumDetail` bashkohen;
- rreshtat identikë të një ambulance në `Trip.Detail` hiqen;
- emrat e ambulancave normalizohen që të mos krijohen fletë Excel të dyfishta.

## 9. Variablat e konfigurimit

| Variabla | Parazgjedhja | Përshkrimi |
|---|---|---|
| `GPS_ACCOUNT` | — | Llogaria e hyrjes në GPS |
| `GPS_PASSWORD` | — | Fjalëkalimi i hyrjes |
| `GPS_BASE_URL` | `https://gpstracker.elektrosek.com` | Adresa e faqes web |
| `GPS_API_URL` | `<GPS_BASE_URL>:18889` | Adresa e API-së |
| `GPS_API_ACCOUNT_CODE` | Nga `sssid` | Mbishkrim manual i `sAccount` |
| `GPS_DOWNLOAD_ROOT` | `downloads` | Dosja e rezultateve |
| `GPS_API_TIMEOUT_MS` | `600000` | Timeout për kërkesë API |
| `GPS_API_PAGE_SIZE` | `3` | Pajisje për kërkesë |
| `GPS_TRIP_RESULT_LIMIT` | `1000` | Numri maksimal fillestar i udhëtimeve që kërkohen për çdo ambulancë; rritet automatikisht nëse API raporton më shumë |
| `GPS_TRIP_API_ATTEMPTS` | `4` | Numri i tentativave |
| `GPS_TRIP_API_RETRY_DELAY_MS` | `30000` | Pritja bazë ndërmjet tentativave |

## 10. Gabimet e pritshme

| Gabimi | Shkaku i mundshëm | Veprimi |
|---|---|---|
| Login HTTP `401` | Kredenciale të pasakta | Verifiko `.env` |
| GetList HTTP `401` | Token ose `sAccount` i papranuar | Ri-autentikohu; kontrollo `sssid` |
| Raporti nuk u gjet | Alias-i nuk përputhet | Përditëso `reports.json` |
| Raporti nuk ka pajisje | `trackers` është bosh | Lidh pajisjet me raportin në GPS |
| Trip HTTP `502` | Raport shumë i rëndë | Retry dhe ndarje sipas IMEI-ve |
| Përgjigje bosh/JSON jo i vlefshëm | Problem i përkohshëm i serverit | Retry; kontrollo statusin e platformës |

## 11. Siguria dhe privatësia

- `.env` nuk duhet të ngarkohet në GitHub.
- Mos vendos kredenciale, token, `sssid`, IMEI reale ose cookie në dokumentacion.
- Skedarët `api-requests_*.json` mund të përmbajnë IMEI, targa, koordinata, adresa dhe të dhëna operacionale; trajtoji si konfidencialë.
- Excel-et e raporteve përmbajnë lëvizje dhe vendndodhje të ambulancave; aksesin duhet ta kenë vetëm personat/institucionet e autorizuara.
- Mos çaktivizo validimin TLS në klientë të rinj pa një arsye të dokumentuar dhe miratim teknik.
- API-ja duhet përdorur vetëm me llogari dhe autorizim institucional.

## 12. Skedarët përkatës të projektit

| Skedari | Roli |
|---|---|
| `src/api.ts` | Autentikimi, kërkesat API, retry, bashkimi dhe Excel-i |
| `reports.json` | Institucionet dhe alias-et e emrave të raporteve |
| `.env.example` | Parametrat e konfigurimit pa sekrete |
| `downloads/YYYY-MM/` | Excel-et dhe përmbledhja e ekzekutimit |

## 13. Kufizime të njohura

- API-ja nuk ka versionim të dukshëm në URL.
- Nuk është identifikuar dokumentacion OpenAPI/Swagger publik.
- Kohëzgjatja e token-it nuk është e dokumentuar; projekti autentikohet në fillim të çdo ekzekutimi.
- `oil100km=15` është vlera që përdor aplikacioni aktual; kuptimi kontraktual dhe përshtatshmëria për çdo ambulancë duhet konfirmuar me administratorin/furnitorin.
- Serveri mund të kthejë `message: "falied"` edhe brenda një envelope me `state: true`; projekti përdor `state` si treguesin funksional të suksesit.

---

Dokumenti është ndërtuar nga implementimi `src/api.ts` dhe nga përgjigje reale të sanitizuara të platformës. Çdo ndryshim i API-së duhet verifikuar në një ambient të autorizuar përpara përdorimit në prodhim.

# Editor guide: updating MPP data

The live tracker reads from **Google Sheets**. Edit the sheet — the website updates automatically (within about an hour, or sooner if someone runs sync manually).

## Spreadsheet

**Edit (team):** https://docs.google.com/spreadsheets/d/1AirsQoXck1db6c1ibgjEii-qRbm-vQXr/edit

Keep the sheet shared as **Anyone with the link can view** so the website can download it. Editors need edit access separately.

### Tabs

1. **Current Ontarios MPPs** — name, roles, party, riding, email, phone  
2. **How They Voted** — salary, benefits, party, and Aye / Nay / No Show / N/A for each bill  
3. **How OAC Score Works** — notes only (not shown on the site)  
4. **Display Settings** — turn site fields **and featured bills** on/off without deleting data

### Show or hide fields / bills on the website

Add a tab named **Display Settings**, **Site Display**, or any title containing “Display” + “Settings” (e.g. **OAC · Display Settings**). Columns: **Field | Show | Notes**:

| Field | Show | Notes |
| --- | --- | --- |
| salary | No | MPP salary on cards and tables |
| benefits | No | Benefits amount on cards and tables |
| votingAlignment | No | Party voting alignment % |
| expenses | Yes | OLA expense disclosure totals (travel, meals, hospitality) |
| Bill 5 | Yes | Featured filter / campaign chip |
| Bill 17 | Yes | Featured filter / campaign chip |
| Bill 24 | Yes | Featured filter / campaign chip |
| Bill 48 | Yes | Featured filter / campaign chip |
| Bill 60 | Yes | Featured filter / campaign chip |
| Bill 68 | Yes | Featured filter / campaign chip |
| Bill 97 | Yes | Featured filter / campaign chip |

Use **Yes** or **No** in the Show column.

- **salary / benefits / votingAlignment / expenses** — hide or show those numbers on cards and tables. Sheet salary/benefits are verified against the official [Ontario Public Sector Salary Disclosure](https://www.ontario.ca/page/public-sector-salary-disclosure) (Sunshine List); when a match exists, the live site uses the official figures. Expenses are scraped from ola.org.
- **Bill N** — controls which bills appear in the campaign vote filters and as “featured” on the tracker. Set a bill to **No** to remove it from the public filters without deleting its vote column. Set **Yes** on a bill that already has a vote column to feature it.

A starter workbook you can copy from: `Display-Settings-for-Google-Sheets.xlsx` in this repo.

Accepted field names: `salary`, `benefits`, `votingAlignment`, `expenses` (also: `alignment`, `expense disclosure`), and `Bill 5`, `Bill 17`, … (spacing optional: `bill5` works).

### Add a new MPP

1. Add a row on **Current Ontarios MPPs**  
2. Add a matching row on **How They Voted** (same person; fill votes)  
3. Save — done. No WordPress or GitHub steps.

### Change a vote or salary

Edit the cell on **How They Voted** → save. For salary/benefits, the hourly sync also pulls the official Sunshine List and will prefer those numbers if they differ (useful for catching typos). Raise % is recomputed from year-over-year disclosure when both years exist.

### Add a new bill

1. On **How They Voted**, add a new column (e.g. `Bill 120`)  
2. In **row 1** of that column, paste the ola.org bill URL  
3. Fill Aye/Nay/N/A for each MPP  
4. On **Display Settings**, add a row `Bill 120` | **Yes** if you want it in the public filters  

### Photos

Pulled automatically from ola.org when we refresh photo cache. New MPPs usually get a photo once OLA publishes one. Until then, initials show.

### Expense disclosure

Pulled from [OLA Members’ expense disclosure](https://www.ola.org/en/members/expense-disclosure/list) (travel, accommodation, meals, hospitality over the past ~2 years). Cards show category breakdown, rank vs the House / party median, and an **Expense spotlight** bar (top spenders, $50k/$100k+, hospitality-/travel-heavy, above/below party). Detail view links to the official OLA page. Refresh happens with the hourly sheet sync.

### Sunshine List (salary)

Pulled from the official [Public sector salary disclosure](https://www.ontario.ca/page/public-sector-salary-disclosure) Compendium CSV (Legislative Assembly employer). Matches MPPs by name (including known legal/preferred-name aliases), stores salary, taxable benefits, disclosed job title, and YoY raise %. Used to verify and fill gaps in the sheet’s Salary / Benefits / Raise % columns.

### Accountability watch (separate page)

Public page: **`watch.html`** — not part of the WordPress iframe tracker.

**Auto-refresh:** the hourly Sheets sync also runs `scripts/fetch_accountability_news.py --publish`, which pulls Google News RSS (accountability keywords), merges into **`data/accountability.json`**, and **dedupes by article URL**. Same story → one card; all named MPPs are unioned, preferring the version that already listed more people.

Hand-edit the same file anytime (add a `summary` and `"curated": true` so your copy is preserved on merge):

| Field | Example |
| --- | --- |
| `mppNames` | `["Jill Dunlop", "Mike Harris"]` |
| `title` | Short headline |
| `summary` | 1–2 sentences |
| `url` | Link to the source story or complaint |
| `source` | Outlet name |
| `date` | `YYYY-MM-DD` |
| `type` | `news` · `integrity` · `expenses` · `investigation` |
| `status` | `reported` · `under_review` · `resolved` (optional) |
| `curated` | `true` to preserve your summary across auto-refresh |

Only add sourced items. Do **not** frame unproven allegations as facts.

Manual refresh: `python3 scripts/fetch_accountability_news.py --publish`

## WordPress page

Editors only change intro text on the WP page. The tracker itself is an embed — **do not** paste spreadsheet data into WordPress. The accountability watch lives on its own URL and is not embedded with the tracker.

Embed URL (V1 cards):

```html
<iframe
  src="https://nomadbuilder.github.io/ontario-mpp-tracker/?embed=1"
  title="Ontario MPP Voting Tracker"
  width="100%"
  height="1400"
  style="border:none; min-height:80vh; display:block;"
  loading="lazy"
></iframe>
```

## How auto-update works

- GitHub checks the Google Sheet about **every hour**  
- If anything changed, it rebuilds the site and publishes  
- To force an update now: GitHub → Actions → **Sync from Google Sheets** → **Run workflow**

## Who should edit the Sheet

Limit edit access to **1–2 people**. Everyone else uses the public website. That avoids conflicting edits.

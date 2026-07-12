# Editor guide: updating MPP data

The live tracker reads from **Google Sheets**. Edit the sheet — the website updates automatically (within about an hour, or sooner if someone runs sync manually).

## Spreadsheet

**Edit (team):** https://docs.google.com/spreadsheets/d/1AirsQoXck1db6c1ibgjEii-qRbm-vQXr/edit

Keep the sheet shared as **Anyone with the link can view** so the website can download it. Editors need edit access separately.

### Tabs

1. **Current Ontarios MPPs** — name, roles, party, riding, email, phone  
2. **How They Voted** — salary, benefits, party, and Aye / Nay / No Show / N/A for each bill  
3. **How OAC Score Works** — notes only (not shown on the site)

### Add a new MPP

1. Add a row on **Current Ontarios MPPs**  
2. Add a matching row on **How They Voted** (same person; fill votes)  
3. Save — done. No WordPress or GitHub steps.

### Change a vote or salary

Edit the cell on **How They Voted** → save.

### Add a new bill

1. On **How They Voted**, add a new column (e.g. `Bill 120`)  
2. In **row 1** of that column, paste the ola.org bill URL  
3. Fill Aye/Nay/N/A for each MPP  

### Photos

Pulled automatically from ola.org when we refresh photo cache. New MPPs usually get a photo once OLA publishes one. Until then, initials show.

## WordPress page

Editors only change intro text on the WP page. The tracker itself is an embed — **do not** paste spreadsheet data into WordPress.

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

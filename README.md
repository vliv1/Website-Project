

This website is is being created as a software inventory system that could be used. 

Administrator sections have separate protected HTML pages:

| Page | URL | File |
| --- | --- | --- |
| Dashboard | `/admin` | `private/admin.html` |
| Software Inventory | `/admin/inventory` | `private/admin-inventory.html` |
| Add Software | `/admin/add-software` | `private/admin-add-software.html` |
| Import CSV | `/admin/import` | `private/admin-import.html` |
| Audit History | `/admin/audit` | `private/admin-audit.html` |
| Settings | `/admin/settings` | `private/admin-settings.html` |

All pages share the admin navigation, theme preference, and sign-out controls.
Direct HTML filename URLs also require login. Old `/admin#...` section bookmarks
redirect to their new pages. Restart `npm start` after changes to server routes.

The public `/inventory.html` and admin `/admin/inventory` pages share a sortable
inventory table. Each row represents one version; software without versions has
an explicit empty row. Click Software, Publisher, Version, or Status to toggle
ascending/descending sorting. Version sorting uses natural numeric ordering
(for example, 1.9 before 1.10), not semantic-version precedence.
Pagination offers 25, 50, or 100 records per page. Search and status filters apply
before pagination and reset to page 1. Public CSV exports include all matching
versions in the chosen order, across all pages. Admin Manage panels retain
version editing and deletion, as well as software-group editing and deletion.
Pagination currently runs in the browser over the existing inventory API result.

CSV import is available on the authenticated `/admin/import` page.
Download the template, replace its sample row, select your UTF-8 CSV, review the
preview, and click Import. Required columns are `name,publisher,version`; optional
`status` defaults to `Pending` and accepts `Pending`, `Approved`, or `Denied`.
Headers are case-insensitive; `Software Name` and `Approval Status` also work.
The limit is 500 data rows / 1 MB. All rows must pass validation before import.

Imports use the existing authenticated software API and its audit records.
Matching name, publisher, and version (case-insensitive) are skipped without
updating their status. The first occurrence of a new version in a CSV wins.
Versions save individually: keep the page open, and if a request fails, use
Retry to continue with the remaining rows. After signing in again, you can
reselect the original CSV; existing versions will be skipped.

Run the admin-page, CSV parsing, and import-flow tests with `npm test`.

Approval / denial notes are optional and belong to an individual software version,
so decisions for different releases can have different explanations. Administrators
can add them on Add Software or Inventory → Manage → Edit. Everyone can read saved
notes using View notes below the status in the inventory. Notes are plain text,
limited to 2,000 characters, and changes are recorded with the administrator and
timestamp in Audit History. Clearing the field removes the current note while
retaining its audit history. Existing CSV imports continue to work without notes.

Before starting a checkout with this feature for the first time, run `npm run migrate`
with the usual `DATABASE_URL` configured, then restart `npm start`. The migration
adds the notes and audit columns without changing existing versions or statuses;
it can safely be run again. Use `npm test` for the complete test suite.

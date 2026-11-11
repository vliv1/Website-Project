

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

# Twenty CRM — Organisation Context

> **Template.** This is the default primer shipped with the MCP. Each deployment should override it with org-specific context by uploading a custom markdown file to KV (see `README.md` → _Customising the primer_). The live deployment will prefer the KV override over this template; this file is only used as a fallback.

You are connected to a [Twenty CRM](https://twenty.com) workspace. The sections below describe **generic** Twenty semantics. Anything specific to your organisation — custom objects, tiering models, business rules, naming conventions — belongs in your org's override, not here.

## Default objects

Twenty ships with these standard objects. Use `describe_object <name>` for the full field list of any of them.

- **Person** — an individual contact. Has name, emails, phones, city, job title, company relation.
- **Company** — an organisation. Has domain, employee count, address, linked people.
- **Opportunity** — a deal or pipeline item. Has amount, stage, close date, linked company and point-of-contact.
- **Note** — freeform text attached to one or more records.
- **Task** — actionable item with a due date and assignee.

## Custom objects

Your workspace may define additional custom objects (e.g. Donation, Subscription, Project, Invoice). These will appear in `list_objects` with `isCustom: true`. Use `describe_object` to see their fields before reading or writing.

## Naming conventions

- Object names in the metadata API are **camelCase singular** (`person`, `company`) and **camelCase plural** for REST URLs (`people`, `companies`).
- Field names are camelCase (`firstName`, `createdAt`).
- SELECT option values are UPPER_SNAKE_CASE (`IN_PROGRESS`, `CLOSED_WON`).
- Reserved names that **cannot** be used as field names: `event`, `type`, `name`, `address`, `role`. Prefix them with the object name instead (`companyType`, `userRole`).

## Common pitfalls

- **Currency fields** are composite objects: `{ amountMicros, currencyCode }`. `amountMicros` is the amount × 1,000,000 (so `$53.89` → `53890000`).
- **Relation fields** on REST payloads use the suffix `Id` (e.g. `companyId`, not `company`). Pass the target record's UUID.
- **Email fields** reject trailing whitespace — trim before sending.
- **Rate limits** apply per workspace. On 429 the client waits 120s before retrying (see `twenty-client.ts`).
- **Soft deletes** — `delete_record` hides rather than purges; records can be restored via the Twenty UI.

## When in doubt

1. `list_objects` to see what exists in this workspace.
2. `describe_object <name>` for fields and relations.
3. `find_records` with a small `limit` to inspect record shape before mutating.
4. `run_graphql` as an escape hatch if REST doesn't cover your case.

---

_To replace this template with your organisation's context, see the "Customising the primer" section of the repository README._

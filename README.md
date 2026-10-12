# Promographe

## Products and purchase orders

Authenticated administrators and department managers can create and maintain a
product catalogue in which every product belongs to one department.
Administrators choose the department and see every product; managers see,
edit, and order only their own department's products. Administrators also
maintain a supplier list (name, contact, email, phone) and can attach an
optional supplier to each product. The administrator home tab is a dashboard
with an annual budget per department, approved spending (by order date),
pending amounts, remaining budget, and approved spending per supplier for a
selected year. Prices are recorded in
Canadian cents. Department managers can submit purchase requests containing
multiple products and quantities; each request preserves the product names and prices used when it
was submitted. Managers see only requests for their own department.
Administrators can review every request and approve or refuse pending requests
with an optional decision note. Product deactivation prevents new requests
without changing the historical details on existing requests.

The additive schema migration creates the product, purchase-order, and order
item tables. It runs automatically when the application starts, or can be
applied separately with `npm run db:migrate`.

## Azure SQL authentication and invitations

Promographe stores accounts, department invitations, Express sessions,
products, and purchase orders in Azure SQL. Application passwords are never
sent by email or stored in plain text: invited users choose their password on
the HTTPS activation page, and the server stores an Argon2id hash.

Configure `DB_SERVER` and `DB_NAME` in the local `.env` file for development.
The application connects with Microsoft Entra ID through Tedious'
`DefaultAzureCredential`; it does not use a SQL username or password. For local
VS Code development, install the Azure Resources extension and sign into Azure
using the same Microsoft Entra account configured as a SQL server administrator.
The VS Code identity broker plugin is registered by the application.
Alternatively, developers can sign in with Azure CLI (`az login`). In Azure
hosting, use a managed identity and set `DB_AUTH_CLIENT_ID` only for a
user-assigned identity. Do not commit credentials or passwords to source
control. SQL connections use encryption and validate the server certificate.

Apply the additive, versioned Promographe schema migration with:

```sh
npm run db:migrate
```

This creates Promographe-prefixed tables and does not alter Azure resources or
existing application tables. The application also checks and applies pending
Promographe migrations during startup.

Create the first administrator from an interactive terminal. The email is an
argument; the password is prompted twice without echo and only its Argon2id
hash is inserted into Azure SQL:

```sh
npm run admin:create -- admin@company.example
```

This provisioning command only works when no Promographe administrator exists.
There is no public registration endpoint. Administrators can add departments
and send manager invitations after SMTP has been configured with
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`.
`APP_BASE_URL` must be the public HTTPS application URL in production.
Invitation links expire after 24 hours; only a hash of each random token is
stored, and successful activation invalidates the token.

Signed-in users can change their password from the "Mot de passe" button
(current password required). Users who forgot their password request a reset
link from the login page; the link is emailed with the same SMTP settings,
expires after 1 hour, works once, and the response never reveals whether an
account exists. Any password change or reset signs out the account's other
sessions.

## Sign in with Microsoft (optional)

The login page shows "Se connecter avec Microsoft" next to the password form
once these settings are present:

1. In the Azure portal, open Microsoft Entra ID › App registrations › New
   registration. Choose "Accounts in this organizational directory only"
   and add a **Web** redirect URI of
   `<APP_BASE_URL>/api/auth/microsoft/callback` (for local development,
   `http://localhost:3000/api/auth/microsoft/callback`).
2. From the overview page, copy the application (client) ID and the directory
   (tenant) ID into `AUTH_MICROSOFT_CLIENT_ID` and `AUTH_MICROSOFT_TENANT_ID`.
3. Under Certificates & secrets, create a client secret and put its value in
   `AUTH_MICROSOFT_CLIENT_SECRET`. Never commit it; renew it before it expires.

Only invited Promographe accounts can sign in this way: the Microsoft account
must belong to the configured tenant and its email must match a Promographe
user. A pending invitee who signs in with Microsoft is activated without
choosing a password. Departments and roles are still managed in Promographe.

Start the application with:

```sh
npm start
```

Run the test suite with:

```sh
npm test
```

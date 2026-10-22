const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const argon2 = require("argon2");
const session = require("express-session");
const { createApp } = require("../server");
const { createSqlConfig } = require("../src/database");
const { MemoryDatabase } = require("./support/memory-database");
const { createInvitationMailer } = require("../src/invitation-mailer");

const ADMIN_EMAIL = "admin@example.ca";
const ADMIN_PASSWORD = "a-unique-test-password";

test("Azure SQL uses Microsoft Entra authentication without SQL passwords", () => {
  assert.throws(() => createSqlConfig({}), /DB_SERVER, DB_NAME/);
  const config = createSqlConfig({
    DB_SERVER: "azure-example.database.windows.net",
    DB_NAME: "promographe"
  });
  assert.equal(config.authentication.type, "azure-active-directory-default");
  assert.deepEqual(config.authentication.options, {});
  assert.equal(config.options.encrypt, true);
  assert.equal(config.options.trustServerCertificate, false);
  assert.equal("user" in config, false);
  assert.equal("password" in config, false);
});

test("purchase orders are numbered PG-AAAA00001, counting again from 00001 each year", () => {
  const { nextPurchaseOrderNumber, purchaseOrderNumberBase } = require("../src/database");
  // 1 a.m. UTC on January 1st is still December 31st in Quebec.
  assert.equal(purchaseOrderNumberBase(new Date("2027-01-01T01:00:00Z")), "PG-2026");
  assert.equal(purchaseOrderNumberBase(new Date("2027-01-01T12:00:00Z")), "PG-2027");
  assert.equal(nextPurchaseOrderNumber("PG-2026", []), "PG-202600001");
  assert.equal(nextPurchaseOrderNumber("PG-2026", ["PG-202600009", "PG-202600002", "PO-2026-1021-30"]), "PG-202600010");
  assert.equal(nextPurchaseOrderNumber("PG-2027", ["PG-202600042"]), "PG-202700001");
  assert.equal(nextPurchaseOrderNumber("PG-2026", ["PG-202699999"]), "PG-2026100000");
});

async function startApp(t, options = {}) {
  const database = new MemoryDatabase();
  await database.createFirstAdmin(ADMIN_EMAIL, await argon2.hash(ADMIN_PASSWORD));
  const app = await createApp({
    database,
    sessionStore: new session.MemoryStore(),
    sessionSecret: "test-session-secret-with-sufficient-entropy",
    env: { NODE_ENV: "test" },
    ...options
  });
  const server = app.listen(0);
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => {
      Promise.resolve(app.locals.close()).then(() => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }, reject);
    });
  }));
  return { app, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function sessionCookie(response) {
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "Expected a session cookie");
  return cookie.split(";")[0];
}

async function getCsrfToken(baseUrl, cookie) {
  const response = await fetch(`${baseUrl}/api/auth/csrf`, {
    headers: cookie ? { Cookie: cookie } : {}
  });
  assert.equal(response.status, 200);
  const token = (await response.json()).csrfToken;
  return { token, cookie: cookie || sessionCookie(response) };
}

async function login(baseUrl, email, password) {
  const initial = await getCsrfToken(baseUrl);
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": initial.token,
      Cookie: initial.cookie
    },
    body: JSON.stringify({ email, password })
  });
  return { response, cookie: response.headers.get("set-cookie")
    ? sessionCookie(response)
    : initial.cookie };
}

async function postJson(baseUrl, cookie, csrfToken, url, body) {
  return fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify(body)
  });
}

async function patchJson(baseUrl, cookie, csrfToken, url, body) {
  return fetch(`${baseUrl}${url}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify(body)
  });
}

async function makeAdminSession(baseUrl) {
  const { response, cookie } = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(response.status, 200);
  const csrf = await getCsrfToken(baseUrl, cookie);
  return { cookie: csrf.cookie, csrfToken: csrf.token };
}

async function makeManagerSession(app, baseUrl, departmentId, email, password, fullName = "") {
  const passwordHash = await argon2.hash(password);
  const userId = await app.locals.database.createPendingManager(email, passwordHash, departmentId, fullName);
  app.locals.database.users.get(userId).is_active = true;
  const { response, cookie } = await login(baseUrl, email, password);
  assert.equal(response.status, 200);
  const csrf = await getCsrfToken(baseUrl, cookie);
  return { cookie: csrf.cookie, csrfToken: csrf.token };
}

test("requires authentication for the application and has no public registration", async (t) => {
  const { baseUrl } = await startApp(t);
  const pageResponse = await fetch(baseUrl, { redirect: "manual" });
  assert.equal(pageResponse.status, 302);
  assert.equal(pageResponse.headers.get("location"), "/login.html");

  const registrationResponse = await fetch(`${baseUrl}/api/auth/register`, { method: "POST" });
  assert.equal(registrationResponse.status, 404);

  const invitationPage = await fetch(`${baseUrl}/accept-invitation.html`);
  assert.equal(invitationPage.status, 200);
  assert.equal(invitationPage.headers.get("cache-control"), "no-store");
  assert.equal(invitationPage.headers.get("referrer-policy"), "no-referrer");
});

test("authenticates the provisioned administrator and persists an authenticated session", async (t) => {
  const { baseUrl } = await startApp(t);
  const { response, cookie } = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.user.email, ADMIN_EMAIL);
  assert.equal(payload.user.role, "admin");

  const identityResponse = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: cookie }
  });
  assert.equal(identityResponse.status, 200);

  const usersResponse = await fetch(`${baseUrl}/api/admin/users`, {
    headers: { Cookie: cookie }
  });
  assert.equal(usersResponse.status, 200);
  assert.equal((await usersResponse.json()).users.length, 1);

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie, "X-CSRF-Token": payload.csrfToken }
  });
  assert.equal(logoutResponse.status, 204);
});

test("rejects invalid credentials, missing CSRF tokens, and non-admin access", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const invalidLogin = await login(baseUrl, ADMIN_EMAIL, "wrong-password");
  assert.equal(invalidLogin.response.status, 401);

  const initial = await getCsrfToken(baseUrl);
  const noCsrfResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: initial.cookie },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });
  assert.equal(noCsrfResponse.status, 403);

  const departmentId = await app.locals.database.createDepartment("Finance");
  const managerHash = await argon2.hash("manager-test-password");
  const managerId = await app.locals.database.createPendingManager(
    "manager@example.ca", managerHash, departmentId
  );
  const managerUser = app.locals.database.users.get(managerId);
  managerUser.is_active = true;

  const managerLogin = await login(baseUrl, "manager@example.ca", "manager-test-password");
  assert.equal(managerLogin.response.status, 200);
  const usersResponse = await fetch(`${baseUrl}/api/admin/users`, {
    headers: { Cookie: managerLogin.cookie }
  });
  assert.equal(usersResponse.status, 403);
  const managerCsrf = await getCsrfToken(baseUrl, managerLogin.cookie);
  const forbiddenDepartments = await fetch(`${baseUrl}/api/admin/departments`, {
    headers: { Cookie: managerCsrf.cookie }
  });
  assert.equal(forbiddenDepartments.status, 403);
});

test("limits repeated login attempts", async (t) => {
  const { baseUrl } = await startApp(t);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await login(baseUrl, ADMIN_EMAIL, "wrong-password");
    assert.equal(result.response.status, 401);
  }
  const blocked = await login(baseUrl, ADMIN_EMAIL, "wrong-password");
  assert.equal(blocked.response.status, 429);
});

test("behind Azure, login attempts are limited per IP even when the port changes", async (t) => {
  const { baseUrl } = await startApp(t, {
    env: { NODE_ENV: "production", APP_BASE_URL: "https://promographe.example.ca" }
  });
  const attempt = async (index) => {
    // Azure App Service terminates HTTPS and appends the client port, which changes on every connection.
    const proxyHeaders = { "X-Forwarded-Proto": "https", "X-Forwarded-For": `203.0.113.7:${40000 + index}` };
    const csrfResponse = await fetch(`${baseUrl}/api/auth/csrf`, { headers: proxyHeaders });
    const { csrfToken } = await csrfResponse.json();
    return fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        ...proxyHeaders,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
        Cookie: sessionCookie(csrfResponse)
      },
      // A different account each time, so only the per-IP limit can block.
      body: JSON.stringify({ email: `user${index}@example.ca`, password: "wrong-password" })
    });
  };
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await attempt(index)).status, 401);
  }
  assert.equal((await attempt(10)).status, 429);
});

test("a database that is still waking up gives a clear message", async (t) => {
  const { app, baseUrl } = await startApp(t);
  app.locals.database.getUserByEmail = async () => {
    throw Object.assign(new Error("operation timed out for an unknown reason"), { name: "TimeoutError" });
  };
  const { response } = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /se réveille/);
});

test("the session cookie ends when the browser closes", async (t) => {
  const { baseUrl } = await startApp(t);
  const { response } = await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /promographe\.sid=/);
  assert.doesNotMatch(cookie, /Expires=|Max-Age=/i);
});

test("pages are served with browser security headers and no inline scripts", async (t) => {
  const { baseUrl } = await startApp(t);
  const fs = require("node:fs");
  const path = require("node:path");
  const response = await fetch(`${baseUrl}/login.html`);
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  // A strict script-src blocks inline scripts and handlers, so the pages must not use any.
  for (const file of fs.readdirSync(path.join(__dirname, "..", "public")).filter((name) => name.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", file), "utf8");
    assert.doesNotMatch(html, /<script>/, file);
    assert.doesNotMatch(html, /\son[a-z]+="/, file);
  }
});

test("admin can invite a department manager and invitation activates once", async (t) => {
  const sentMessages = [];
  const { app, baseUrl } = await startApp(t, {
    sendInvitationEmail: async (message) => sentMessages.push(message)
  });
  const admin = await makeAdminSession(baseUrl);
  const createDepartment = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/admin/departments", { name: "Finance" }
  );
  assert.equal(createDepartment.status, 201);
  const { department } = await createDepartment.json();

  const csrf = await getCsrfToken(baseUrl, admin.cookie);
  const unnamedInvite = await postJson(
    baseUrl, csrf.cookie, csrf.token, "/api/admin/invitations",
    { email: "manager@example.ca", departmentId: department.id }
  );
  assert.equal(unnamedInvite.status, 400);
  const inviteResponse = await postJson(
    baseUrl, csrf.cookie, csrf.token, "/api/admin/invitations",
    { email: "manager@example.ca", fullName: "Marie Tremblay", departmentId: department.id }
  );
  assert.equal(inviteResponse.status, 202);
  assert.equal(sentMessages.length, 1);
  const invitedUser = await app.locals.database.getUserByEmail("manager@example.ca");
  assert.equal(invitedUser.full_name, "Marie Tremblay");
  assert.equal(sentMessages[0].email, "manager@example.ca");
  assert.match(sentMessages[0].token, /^[a-f0-9]{96}$/);

  const savedInvitation = [...app.locals.database.invitations.values()][0];
  assert.notEqual(savedInvitation.token_hash, sentMessages[0].token);
  assert.ok(savedInvitation.expires_at > Date.now());
  assert.equal(savedInvitation.used_at, null);

  const validateResponse = await fetch(`${baseUrl}/api/invitations/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: sentMessages[0].token })
  });
  assert.equal(validateResponse.status, 200);
  assert.equal((await validateResponse.json()).departmentName, "Finance");

  const resendCsrf = await getCsrfToken(baseUrl, admin.cookie);
  const resendResponse = await postJson(
    baseUrl, resendCsrf.cookie, resendCsrf.token, "/api/admin/invitations",
    { email: "manager@example.ca", fullName: "Marie Tremblay", departmentId: department.id }
  );
  assert.equal(resendResponse.status, 202);
  assert.equal(sentMessages.length, 2);
  const oldLinkResponse = await fetch(`${baseUrl}/api/invitations/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: sentMessages[0].token })
  });
  assert.equal(oldLinkResponse.status, 400);

  const acceptCsrf = await getCsrfToken(baseUrl);
  const acceptResponse = await postJson(
    baseUrl, acceptCsrf.cookie, acceptCsrf.token, "/api/invitations/accept",
    { token: sentMessages[1].token, password: "a-new-manager-password" }
  );
  assert.equal(acceptResponse.status, 204);

  const managerLogin = await login(baseUrl, "manager@example.ca", "a-new-manager-password");
  assert.equal(managerLogin.response.status, 200);
  assert.equal((await managerLogin.response.json()).user.role, "employee");

  const replayResponse = await fetch(`${baseUrl}/api/invitations/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: sentMessages[1].token })
  });
  assert.equal(replayResponse.status, 400);
});

test("department managers submit private multi-product orders for admin approval", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const financeId = await app.locals.database.createDepartment("Finance");
  const operationsId = await app.locals.database.createDepartment("Operations");
  const financeManager = await makeManagerSession(
    app, baseUrl, financeId, "finance@example.ca", "finance-test-password", "Julie Gagnon"
  );
  const operationsManager = await makeManagerSession(
    app, baseUrl, operationsId, "operations@example.ca", "operations-test-password"
  );
  const admin = await makeAdminSession(baseUrl);

  // A plain employee cannot add products; the director does.
  const employeeProduct = await postJson(
    baseUrl,
    financeManager.cookie,
    financeManager.csrfToken,
    "/api/products",
    { name: "Papier", description: "Papier blanc format lettre", priceCents: 1250, supplierName: "Bureau Plus" }
  );
  assert.equal(employeeProduct.status, 403);
  const productResponse = await postJson(
    baseUrl,
    admin.cookie,
    admin.csrfToken,
    "/api/products",
    { name: "Papier", description: "Papier blanc format lettre", priceCents: 1250, departmentId: financeId, supplierName: "Bureau Plus" }
  );
  assert.equal(productResponse.status, 201);
  const productId = (await productResponse.json()).product.id;

  const missingDepartmentProduct = await postJson(
    baseUrl,
    admin.cookie,
    admin.csrfToken,
    "/api/products",
    { name: "Crayons", description: "", priceCents: 300, supplierName: "Bureau Plus" }
  );
  assert.equal(missingDepartmentProduct.status, 400);

  const secondProductResponse = await postJson(
    baseUrl,
    admin.cookie,
    admin.csrfToken,
    "/api/products",
    { name: "Crayons", description: "", priceCents: 300, departmentId: financeId, supplierName: "Bureau Plus" }
  );
  assert.equal(secondProductResponse.status, 201);
  const secondProductId = (await secondProductResponse.json()).product.id;

  const operationsProductResponse = await postJson(
    baseUrl,
    admin.cookie,
    admin.csrfToken,
    "/api/products",
    { name: "Gants", description: "", priceCents: 800, departmentId: operationsId, supplierName: "Uline" }
  );
  assert.equal(operationsProductResponse.status, 201);
  const operationsProductId = (await operationsProductResponse.json()).product.id;

  const operationsCatalogue = await fetch(`${baseUrl}/api/products`, {
    headers: { Cookie: operationsManager.cookie }
  });
  const operationsProducts = (await operationsCatalogue.json()).products;
  // The whole catalogue is visible to everyone (each product keeps its department).
  assert.deepEqual(operationsProducts.map((product) => product.name).sort(), ["Crayons", "Gants", "Papier"]);
  assert.equal(operationsProducts.find((product) => product.name === "Gants").department_name, "Operations");

  const adminCatalogue = await fetch(`${baseUrl}/api/products`, {
    headers: { Cookie: admin.cookie }
  });
  assert.equal((await adminCatalogue.json()).products.length, 3);

  const foreignProductEdit = await patchJson(
    baseUrl,
    operationsManager.cookie,
    operationsManager.csrfToken,
    `/api/products/${productId}`,
    { name: "Papier", description: "", priceCents: 1, isActive: true }
  );
  assert.equal(foreignProductEdit.status, 403);

  const orderResponse = await postJson(
    baseUrl,
    financeManager.cookie,
    financeManager.csrfToken,
    "/api/orders",
    {
      items: [
        { productId, quantity: 2 },
        { productId: secondProductId, quantity: 3 }
      ],
      notes: "Pour la salle de réunion."
    }
  );
  assert.equal(orderResponse.status, 201);
  const { orderId } = await orderResponse.json();

  const duplicateLineResponse = await postJson(
    baseUrl,
    financeManager.cookie,
    financeManager.csrfToken,
    "/api/orders",
    { items: [{ productId, quantity: 1 }, { productId, quantity: 2 }] }
  );
  assert.equal(duplicateLineResponse.status, 400);

  const adminCreateOrder = await postJson(
    baseUrl,
    admin.cookie,
    admin.csrfToken,
    "/api/orders",
    { items: [{ productId, quantity: 1 }] }
  );
  // The director may order, but must say for which department.
  assert.equal(adminCreateOrder.status, 400);

  const operationsOrder = await postJson(
    baseUrl,
    operationsManager.cookie,
    operationsManager.csrfToken,
    "/api/orders",
    { items: [{ productId: operationsProductId, quantity: 1 }] }
  );
  assert.equal(operationsOrder.status, 201);

  const financeOrdersResponse = await fetch(`${baseUrl}/api/orders`, {
    headers: { Cookie: financeManager.cookie }
  });
  const financeOrders = (await financeOrdersResponse.json()).orders;
  assert.equal(financeOrders.length, 1);
  assert.equal(financeOrders[0].departmentName, "Finance");
  assert.equal(financeOrders[0].createdByName, "Julie Gagnon");
  assert.equal(financeOrders[0].createdByEmail, "finance@example.ca");
  assert.equal(financeOrders[0].status, "pending");
  // The plain employee sees their lines, not the total (the director sees 34,00 $ below).
  assert.equal(financeOrders[0].totalCents, undefined);
  assert.equal(financeOrders[0].items.length, 2);

  const operationsOrdersResponse = await fetch(`${baseUrl}/api/orders`, {
    headers: { Cookie: operationsManager.cookie }
  });
  const operationsOrders = (await operationsOrdersResponse.json()).orders;
  assert.equal(operationsOrders.length, 1);
  assert.equal(operationsOrders[0].departmentName, "Operations");

  const managerCsrf = await getCsrfToken(baseUrl, financeManager.cookie);
  const forbiddenDecision = await patchJson(
    baseUrl,
    managerCsrf.cookie,
    managerCsrf.token,
    `/api/orders/${orderId}/decision`,
    { status: "approved" }
  );
  assert.equal(forbiddenDecision.status, 403);

  const adminOrdersResponse = await fetch(`${baseUrl}/api/orders`, {
    headers: { Cookie: admin.cookie }
  });
  assert.equal((await adminOrdersResponse.json()).orders.length, 2);
  const decisionCsrf = await getCsrfToken(baseUrl, admin.cookie);
  const approvalResponse = await patchJson(
    baseUrl,
    decisionCsrf.cookie,
    decisionCsrf.token,
    `/api/orders/${orderId}/decision`,
    { status: "approved", decisionNote: "Approuvée pour ce trimestre." }
  );
  assert.equal(approvalResponse.status, 200);

  const savedOrderResponse = await fetch(`${baseUrl}/api/orders`, {
    headers: { Cookie: financeManager.cookie }
  });
  const savedOrder = (await savedOrderResponse.json()).orders[0];
  assert.equal(savedOrder.status, "approved");
  assert.equal(savedOrder.totalCents, undefined);
  const directorView = await (await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: admin.cookie } })).json();
  assert.equal(directorView.orders.find((order) => order.id === savedOrder.id).totalCents, 3400);
  assert.equal(savedOrder.decisionNote, "Approuvée pour ce trimestre.");

  const duplicateDecisionCsrf = await getCsrfToken(baseUrl, admin.cookie);
  const duplicateDecision = await patchJson(
    baseUrl,
    duplicateDecisionCsrf.cookie,
    duplicateDecisionCsrf.token,
    `/api/orders/${orderId}/decision`,
    { status: "rejected" }
  );
  assert.equal(duplicateDecision.status, 409);

  const updateProductCsrf = await getCsrfToken(baseUrl, admin.cookie);
  const updateProduct = await patchJson(
    baseUrl,
    updateProductCsrf.cookie,
    updateProductCsrf.token,
    `/api/products/${productId}`,
    { name: "Papier recyclé", description: "", priceCents: 1500, isActive: false, departmentId: financeId, supplierName: "Bureau Plus" }
  );
  assert.equal(updateProduct.status, 200);

  const unavailableOrderCsrf = await getCsrfToken(baseUrl, financeManager.cookie);
  const unavailableOrder = await postJson(
    baseUrl,
    unavailableOrderCsrf.cookie,
    unavailableOrderCsrf.token,
    "/api/orders",
    { items: [{ productId, quantity: 1 }] }
  );
  assert.equal(unavailableOrder.status, 409);
});

test("invitation links expire and failed delivery leaves no orphan pending account", async (t) => {
  const sentMessages = [];
  let shouldFailDelivery = false;
  const { app, baseUrl } = await startApp(t, {
    sendInvitationEmail: async (message) => {
      if (shouldFailDelivery) {
        throw new Error("test mail failure");
      }
      sentMessages.push(message);
    }
  });
  const admin = await makeAdminSession(baseUrl);
  const departmentResponse = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/admin/departments", { name: "Operations" }
  );
  const departmentId = (await departmentResponse.json()).department.id;

  const csrf = await getCsrfToken(baseUrl, admin.cookie);
  const inviteResponse = await postJson(
    baseUrl, csrf.cookie, csrf.token, "/api/admin/invitations",
    { email: "expired@example.ca", fullName: "Expiré Test", departmentId }
  );
  assert.equal(inviteResponse.status, 202);
  const firstToken = sentMessages[0].token;
  const invitation = [...app.locals.database.invitations.values()][0];
  invitation.expires_at = Date.now() - 1;
  const expiredResponse = await fetch(`${baseUrl}/api/invitations/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: firstToken })
  });
  assert.equal(expiredResponse.status, 400);

  shouldFailDelivery = true;
  const retryCsrf = await getCsrfToken(baseUrl, admin.cookie);
  const failedResponse = await postJson(
    baseUrl, retryCsrf.cookie, retryCsrf.token, "/api/admin/invitations",
    { email: "failed@example.ca", fullName: "Échec Test", departmentId }
  );
  assert.equal(failedResponse.status, 502);
  assert.equal(await app.locals.database.getUserByEmail("failed@example.ca"), undefined);
});

test("invitation routes require an admin and SMTP must be configured", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const admin = await makeAdminSession(baseUrl);
  const departmentResponse = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/admin/departments", { name: "Legal" }
  );
  const departmentId = (await departmentResponse.json()).department.id;
  const csrf = await getCsrfToken(baseUrl, admin.cookie);
  const invalidInviteResponse = await postJson(
    baseUrl, csrf.cookie, csrf.token, "/api/admin/invitations", {}
  );
  assert.equal(invalidInviteResponse.status, 400);
  const retryCsrf = await getCsrfToken(baseUrl, admin.cookie);
  const inviteResponse = await postJson(
    baseUrl, retryCsrf.cookie, retryCsrf.token, "/api/admin/invitations",
    { email: "manager@example.ca", fullName: "Marie Tremblay", departmentId }
  );
  assert.equal(inviteResponse.status, 503);
  assert.equal(await app.locals.database.getUserByEmail("manager@example.ca"), undefined);
});

test("admins manage suppliers and attach them to products", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const financeId = await app.locals.database.createDepartment("Finance");
  const manager = await makeManagerSession(
    app, baseUrl, financeId, "finance@example.ca", "finance-test-password"
  );
  const admin = await makeAdminSession(baseUrl);

  const managerSupplier = await postJson(
    baseUrl, manager.cookie, manager.csrfToken, "/api/admin/suppliers", { name: "Bureau Plus" }
  );
  assert.equal(managerSupplier.status, 403);

  const invalidSupplier = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/admin/suppliers", { name: "Bureau Plus", email: "invalide" }
  );
  assert.equal(invalidSupplier.status, 400);

  const supplierResponse = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/admin/suppliers",
    { name: "Bureau Plus", contactName: "Julie", email: "Ventes@BureauPlus.ca", phone: "514-555-0100" }
  );
  assert.equal(supplierResponse.status, 201);
  const supplierId = (await supplierResponse.json()).supplier.id;

  const duplicateSupplier = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/admin/suppliers", { name: "Bureau Plus" }
  );
  assert.equal(duplicateSupplier.status, 409);

  const suppliers = await fetch(`${baseUrl}/api/admin/suppliers`, { headers: { Cookie: admin.cookie } });
  const supplierList = (await suppliers.json()).suppliers;
  assert.equal(supplierList.length, 1);
  assert.equal(supplierList[0].email, "ventes@bureauplus.ca");

  const unknownSupplierProduct = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/products",
    { name: "Papier", priceCents: 1000, departmentId: financeId, supplierId: 999 }
  );
  assert.equal(unknownSupplierProduct.status, 400);

  const productResponse = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/products",
    { name: "Papier", priceCents: 1000, departmentId: financeId, supplierId }
  );
  assert.equal(productResponse.status, 201);
  const productId = (await productResponse.json()).product.id;

  const managerEdit = await patchJson(
    baseUrl, manager.cookie, manager.csrfToken, `/api/products/${productId}`,
    { name: "Papier recyclé", priceCents: 1100, isActive: true, supplierId: null }
  );
  // A plain employee cannot edit products, and never receives prices.
  assert.equal(managerEdit.status, 403);
  const catalogue = await fetch(`${baseUrl}/api/products`, { headers: { Cookie: manager.cookie } });
  const [product] = (await catalogue.json()).products;
  assert.equal(product.name, "Papier");
  assert.equal(product.supplier_name, "Bureau Plus");
  assert.equal("price_cents" in product, false);
});

test("admin dashboard reports budgets and spending per department", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const financeId = await app.locals.database.createDepartment("Finance");
  const manager = await makeManagerSession(
    app, baseUrl, financeId, "finance@example.ca", "finance-test-password"
  );
  const admin = await makeAdminSession(baseUrl);

  const managerDashboard = await fetch(`${baseUrl}/api/admin/dashboard`, { headers: { Cookie: manager.cookie } });
  assert.equal(managerDashboard.status, 403);

  const invalidBudget = await patchJson(
    baseUrl, admin.cookie, admin.csrfToken, `/api/admin/departments/${financeId}/budget`, { budgetCents: -5 }
  );
  assert.equal(invalidBudget.status, 400);
  const budget = await patchJson(
    baseUrl, admin.cookie, admin.csrfToken, `/api/admin/departments/${financeId}/budget`, { budgetCents: 100000 }
  );
  assert.equal(budget.status, 200);

  const supplier = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/admin/suppliers", { name: "Bureau Plus" }
  );
  const supplierId = (await supplier.json()).supplier.id;
  const product = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/products",
    { name: "Papier", priceCents: 2500, departmentId: financeId, supplierId }
  );
  const productId = (await product.json()).product.id;

  const approvedOrder = await postJson(
    baseUrl, manager.cookie, manager.csrfToken, "/api/orders", { items: [{ productId, quantity: 4 }] }
  );
  const approvedOrderId = (await approvedOrder.json()).orderId;
  await postJson(
    baseUrl, manager.cookie, manager.csrfToken, "/api/orders", { items: [{ productId, quantity: 1 }] }
  );
  const approval = await patchJson(
    baseUrl, admin.cookie, admin.csrfToken, `/api/orders/${approvedOrderId}/decision`, { status: "approved" }
  );
  assert.equal(approval.status, 200);

  const response = await fetch(`${baseUrl}/api/admin/dashboard`, { headers: { Cookie: admin.cookie } });
  assert.equal(response.status, 200);
  const dashboard = await response.json();
  assert.equal(dashboard.year, new Date().getFullYear());
  assert.deepEqual(dashboard.departments, [{
    id: financeId,
    name: "Finance",
    budgetCents: 100000,
    approvedCents: 10000,
    pendingCents: 2500,
    pendingOrders: 1
  }]);
  assert.equal(dashboard.suppliers, undefined);
  assert.deepEqual(dashboard.orderCounts, { approved: 1, pending: 1 });
});

test("typing a supplier name on a product reuses or creates the supplier", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const financeId = await app.locals.database.createDepartment("Finance");
  const admin = await makeAdminSession(baseUrl);
  const existing = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/admin/suppliers", { name: "Bureau Plus" }
  );
  const existingId = (await existing.json()).supplier.id;

  const reused = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/products",
    { name: "Papier", priceCents: 1000, departmentId: financeId, supplierName: "  bureau plus " }
  );
  assert.equal(reused.status, 201);
  assert.equal((await reused.json()).product.supplier_id, existingId);

  const created = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/products",
    { name: "Encre", priceCents: 4500, departmentId: financeId, supplierName: "Encres Québec" }
  );
  assert.equal(created.status, 201);
  const createdSupplierId = (await created.json()).product.supplier_id;
  assert.notEqual(createdSupplierId, existingId);

  const cleared = await postJson(
    baseUrl, admin.cookie, admin.csrfToken, "/api/products",
    { name: "Gomme", priceCents: 100, departmentId: financeId, supplierName: "" }
  );
  // The supplier is required.
  assert.equal(cleared.status, 400);

  const suppliers = await fetch(`${baseUrl}/api/admin/suppliers`, { headers: { Cookie: admin.cookie } });
  assert.deepEqual(
    (await suppliers.json()).suppliers.map((supplier) => supplier.name).sort(),
    ["Bureau Plus", "Encres Québec"]
  );
});

test("users change their password and other sessions are signed out", async (t) => {
  const { baseUrl } = await startApp(t);
  const current = await makeAdminSession(baseUrl);
  const other = await makeAdminSession(baseUrl);
  const newPassword = "a-brand-new-admin-password";

  const wrongCurrent = await postJson(
    baseUrl, current.cookie, current.csrfToken, "/api/auth/change-password",
    { currentPassword: "not-the-password", newPassword }
  );
  assert.equal(wrongCurrent.status, 400);
  const tooShort = await postJson(
    baseUrl, current.cookie, current.csrfToken, "/api/auth/change-password",
    { currentPassword: ADMIN_PASSWORD, newPassword: "short" }
  );
  assert.equal(tooShort.status, 400);
  const samePassword = await postJson(
    baseUrl, current.cookie, current.csrfToken, "/api/auth/change-password",
    { currentPassword: ADMIN_PASSWORD, newPassword: ADMIN_PASSWORD }
  );
  assert.equal(samePassword.status, 400);

  const changed = await postJson(
    baseUrl, current.cookie, current.csrfToken, "/api/auth/change-password",
    { currentPassword: ADMIN_PASSWORD, newPassword }
  );
  assert.equal(changed.status, 204);

  const currentMe = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: current.cookie } });
  assert.equal(currentMe.status, 200);
  const otherMe = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: other.cookie } });
  assert.equal(otherMe.status, 401);

  assert.equal((await login(baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD)).response.status, 401);
  assert.equal((await login(baseUrl, ADMIN_EMAIL, newPassword)).response.status, 200);
});

test("forgotten passwords are reset through a single-use emailed link", async (t) => {
  const sentResets = [];
  const { baseUrl } = await startApp(t, {
    sendPasswordResetEmail: async (message) => sentResets.push(message)
  });
  const signedIn = await makeAdminSession(baseUrl);
  const requestReset = async (email) => {
    const csrf = await getCsrfToken(baseUrl);
    return postJson(baseUrl, csrf.cookie, csrf.token, "/api/auth/password-reset/request", { email });
  };

  const unknown = await requestReset("nobody@example.ca");
  assert.equal(unknown.status, 202);
  assert.equal(sentResets.length, 0);

  const known = await requestReset(ADMIN_EMAIL.toUpperCase());
  assert.equal(known.status, 202);
  assert.deepEqual(await known.json(), await unknown.json());
  assert.equal(sentResets.length, 1);
  assert.equal(sentResets[0].email, ADMIN_EMAIL);
  const { token } = sentResets[0];
  assert.match(token, /^[a-f0-9]{96}$/);

  const validate = await fetch(`${baseUrl}/api/auth/password-reset/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  assert.equal(validate.status, 200);
  assert.equal((await validate.json()).email, ADMIN_EMAIL);

  const newPassword = "reset-admin-password-123";
  const csrf = await getCsrfToken(baseUrl);
  const complete = await postJson(
    baseUrl, csrf.cookie, csrf.token, "/api/auth/password-reset/complete", { token, password: newPassword }
  );
  assert.equal(complete.status, 204);

  const reuseCsrf = await getCsrfToken(baseUrl);
  const reuse = await postJson(
    baseUrl, reuseCsrf.cookie, reuseCsrf.token, "/api/auth/password-reset/complete",
    { token, password: "another-password-456" }
  );
  assert.equal(reuse.status, 400);

  const oldSession = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: signedIn.cookie } });
  assert.equal(oldSession.status, 401);
  assert.equal((await login(baseUrl, ADMIN_EMAIL, newPassword)).response.status, 200);
});

test("password reset requires email delivery to be configured", async (t) => {
  const { baseUrl } = await startApp(t);
  const csrf = await getCsrfToken(baseUrl);
  const response = await postJson(
    baseUrl, csrf.cookie, csrf.token, "/api/auth/password-reset/request", { email: ADMIN_EMAIL }
  );
  assert.equal(response.status, 503);
});

test("admins delete products and suppliers while order history stays intact", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const financeId = await database.createDepartment("Finance");
  const manager = await makeManagerSession(
    app, baseUrl, financeId, "finance@example.ca", "finance-test-password"
  );
  const admin = await makeAdminSession(baseUrl);
  const supplierId = await database.createSupplier("Imprimerie ABC", "", "", "");
  const productId = await database.createProduct("Papier", "", 1250, financeId, supplierId, 1);
  const order = await postJson(baseUrl, manager.cookie, manager.csrfToken, "/api/orders", {
    items: [{ productId, quantity: 2 }]
  });
  assert.equal(order.status, 201);

  const deleteRequest = (session, url) => fetch(`${baseUrl}${url}`, {
    method: "DELETE",
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken }
  });
  assert.equal((await deleteRequest(manager, `/api/products/${productId}`)).status, 403);
  assert.equal((await deleteRequest(manager, `/api/admin/suppliers/${supplierId}`)).status, 403);

  const otherProductId = await database.createProduct("Crayons", "", 300, financeId, supplierId, 1);
  assert.equal((await deleteRequest(admin, `/api/admin/suppliers/${supplierId}`)).status, 204);
  assert.equal((await database.listSuppliers()).length, 0);
  assert.equal((await database.getProduct(otherProductId)).supplier_id, null);

  assert.equal((await deleteRequest(admin, `/api/products/${productId}`)).status, 204);
  assert.equal((await deleteRequest(admin, `/api/products/${productId}`)).status, 404);
  const catalogue = await fetch(`${baseUrl}/api/products`, { headers: { Cookie: manager.cookie } });
  assert.deepEqual((await catalogue.json()).products.map((product) => product.name), ["Crayons"]);
  const reorder = await postJson(baseUrl, manager.cookie, manager.csrfToken, "/api/orders", {
    items: [{ productId, quantity: 1 }]
  });
  assert.equal(reorder.status, 409);

  const orders = await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: admin.cookie } });
  assert.equal((await orders.json()).orders[0].items[0].productName, "Papier");
});

test("users see their profile and update their full name", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const financeId = await app.locals.database.createDepartment("Finance");
  const manager = await makeManagerSession(
    app, baseUrl, financeId, "finance@example.ca", "finance-test-password", "Julie Gagnon"
  );
  const me = async () => (await (await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: manager.cookie }
  })).json()).user;
  assert.deepEqual(
    (({ email, fullName, role, departmentName }) => ({ email, fullName, role, departmentName }))(await me()),
    { email: "finance@example.ca", fullName: "Julie Gagnon", role: "employee", departmentName: "Finance" }
  );

  const update = (fullName) => fetch(`${baseUrl}/api/auth/profile`, {
    method: "PATCH",
    headers: { Cookie: manager.cookie, "X-CSRF-Token": manager.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ fullName })
  });
  assert.equal((await update("  ")).status, 400);
  assert.equal((await update("Julie Tremblay")).status, 200);
  assert.equal((await me()).fullName, "Julie Tremblay");
});

test("admins edit and delete managers, departments and suppliers", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const financeId = await database.createDepartment("Finance");
  const salesId = await database.createDepartment("Ventes");
  const manager = await makeManagerSession(
    app, baseUrl, financeId, "finance@example.ca", "finance-test-password", "Julie Gagnon"
  );
  const admin = await makeAdminSession(baseUrl);
  const send = (session, method, url, body) => fetch(`${baseUrl}${url}`, {
    method,
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
    body: body && JSON.stringify(body)
  });

  // Managers cannot use the admin actions.
  assert.equal((await send(manager, "DELETE", `/api/admin/departments/${salesId}`)).status, 403);

  // Suppliers.
  const supplierId = await database.createSupplier("Bureau Plus", "", "", "");
  await database.createSupplier("Uline", "", "", "");
  assert.equal((await send(admin, "PATCH", `/api/admin/suppliers/${supplierId}`, { name: "Uline" })).status, 409);
  assert.equal((await send(admin, "PATCH", `/api/admin/suppliers/${supplierId}`, {
    name: "Bureau Plus Inc.", contactName: "Marc", email: "MARC@BUREAU.CA", phone: "514-555-0000"
  })).status, 200);
  assert.deepEqual(
    (await database.listSuppliers()).find((supplier) => supplier.id === supplierId),
    {
      id: supplierId, name: "Bureau Plus Inc.", contact_name: "Marc", email: "marc@bureau.ca", phone: "514-555-0000",
      website: "", order_method: "", phone_extension: "", note: "", reduced_threshold_cents: null, free_threshold_cents: null,
      account_number: "", currency: "CAD", payment_terms: "", is_authorized: true, category: ""
    }
  );

  // Departments: rename, and refuse deletion while a manager or a pending order remains.
  assert.equal((await send(admin, "PATCH", `/api/admin/departments/${salesId}`, { name: "Finance" })).status, 409);
  assert.equal((await send(admin, "PATCH", `/api/admin/departments/${salesId}`, { name: "Ventes Québec" })).status, 200);
  assert.equal((await database.getDepartment(salesId)).name, "Ventes Québec");
  assert.equal((await send(admin, "DELETE", `/api/admin/departments/${financeId}`)).status, 409);

  // Managers: edit, then delete. The deleted manager is signed out and hidden, the order stays.
  const productId = await database.createProduct("Papier", "", 100, financeId, null, 1);
  const order = await postJson(baseUrl, manager.cookie, manager.csrfToken, "/api/orders", {
    items: [{ productId, quantity: 1 }]
  });
  assert.equal(order.status, 201);
  const managerId = (await database.getUserByEmail("finance@example.ca")).id;
  assert.equal((await send(admin, "PATCH", `/api/admin/users/${managerId}`, {
    fullName: "Julie Tremblay", departmentId: salesId
  })).status, 200);
  assert.equal((await database.getUserById(managerId)).department_id, salesId);
  assert.equal((await send(admin, "DELETE", `/api/admin/users/${managerId}`)).status, 204);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: manager.cookie } })).status, 401);
  const users = await (await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: admin.cookie } })).json();
  assert.equal(users.users.some((user) => user.email === "finance@example.ca"), false);
  const orders = await (await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: admin.cookie } })).json();
  assert.equal(orders.orders.length, 1);

  // With its pending order decided and no manager left, Finance can be deleted.
  assert.equal((await send(admin, "DELETE", `/api/admin/departments/${financeId}`)).status, 409);
  assert.equal((await patchJson(baseUrl, admin.cookie, admin.csrfToken, `/api/orders/${orders.orders[0].id}/decision`, {
    status: "approved"
  })).status, 200);
  assert.equal((await send(admin, "DELETE", `/api/admin/departments/${financeId}`)).status, 204);
  assert.equal(await database.getDepartment(financeId), undefined);
  assert.equal(await database.getProduct(productId), false);
  const history = await (await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: admin.cookie } })).json();
  assert.equal(history.orders[0].departmentName, "Finance");
});

test("employees belong to a department, departments name a responsable, functions are assignable", async (t) => {
  const sentMessages = [];
  const { app, baseUrl } = await startApp(t, {
    sendInvitationEmail: async (message) => sentMessages.push(message)
  });
  const database = app.locals.database;
  const broderieId = await database.createDepartment("Broderie");
  const admin = await makeAdminSession(baseUrl);
  const send = (method, url, body) => fetch(`${baseUrl}${url}`, {
    method,
    headers: { Cookie: admin.cookie, "X-CSRF-Token": admin.csrfToken, "Content-Type": "application/json" },
    body: body && JSON.stringify(body)
  });

  // Invite an employee who is also a transmitter.
  assert.equal((await send("POST", "/api/admin/invitations", {
    fullName: "Josée Lapointe", email: "josee@example.ca", departmentId: broderieId, functions: ["bogus"]
  })).status, 400);
  assert.equal((await send("POST", "/api/admin/invitations", {
    fullName: "Josée Lapointe", email: "josee@example.ca", departmentId: broderieId, functions: ["transmitter_admin"]
  })).status, 202);
  const josee = await database.getUserByEmail("josee@example.ca");
  assert.equal(josee.role, "employee");
  assert.deepEqual(await database.getUserFunctions(josee.id), ["transmitter_admin"]);

  // A pending invitee cannot approve yet; once active, they can be named responsable.
  assert.equal((await send("PATCH", `/api/admin/departments/${broderieId}`, {
    name: "Broderie", managerUserId: josee.id
  })).status, 400);
  josee.is_active = true;
  assert.equal((await send("PATCH", `/api/admin/departments/${broderieId}`, {
    name: "Broderie", managerUserId: josee.id
  })).status, 200);

  // Employees need a department; functions can be changed.
  assert.equal((await send("PATCH", `/api/admin/users/${josee.id}`, {
    fullName: "Josée Lapointe", departmentId: null
  })).status, 400);
  assert.equal((await send("PATCH", `/api/admin/users/${josee.id}`, {
    fullName: "Josée Lapointe", departmentId: broderieId, functions: ["transmitter_admin", "reception"]
  })).status, 200);

  const listed = (await (await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: admin.cookie } })).json()).users;
  const listedJosee = listed.find((user) => user.email === "josee@example.ca");
  assert.deepEqual(listedJosee.functions.sort(), ["reception", "transmitter_admin"]);
  assert.equal((await database.getManagedDepartments(josee.id))[0].name, "Broderie");

  // Administrators can be edited (functions, optional department) but not deleted by an admin.
  const adminUser = await database.getUserByEmail(ADMIN_EMAIL);
  assert.equal((await send("PATCH", `/api/admin/users/${adminUser.id}`, {
    fullName: "Direction", departmentId: null, functions: ["general_management"]
  })).status, 200);
  assert.equal((await send("DELETE", `/api/admin/users/${adminUser.id}`)).status, 404);

  // Deleting the responsable leaves the department without one.
  assert.equal((await send("DELETE", `/api/admin/users/${josee.id}`)).status, 204);
  assert.equal((await database.listDepartments())[0].manager_user_id, null);
  assert.deepEqual(await database.getUserFunctions(josee.id), []);
});

test("a department responsable sees all staff and decides their department's requests, including their own", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const salesId = await database.createDepartment("Ventes");
  const responsable = await makeManagerSession(app, baseUrl, warehouseId, "resp@example.ca", "responsable-password", "Resp Test");
  const employee = await makeManagerSession(app, baseUrl, warehouseId, "emp@example.ca", "employee-password-1", "Emp Test");
  const salesEmployee = await makeManagerSession(app, baseUrl, salesId, "sales@example.ca", "sales-password-123");
  const responsableId = (await database.getUserByEmail("resp@example.ca")).id;
  await database.setDepartmentManager(warehouseId, responsableId);
  const warehouseProduct = await database.createProduct("Boîte", "", 500, warehouseId, null, 1);
  const salesProduct = await database.createProduct("Affiche", "", 900, salesId, null, 1);
  const order = async (session, productId) => (await (await postJson(baseUrl, session.cookie, session.csrfToken, "/api/orders", {
    items: [{ productId, quantity: 1 }]
  })).json()).orderId;
  const decide = (session, id) => patchJson(baseUrl, session.cookie, session.csrfToken, `/api/orders/${id}/decision`, { status: "approved" });
  const get = (session, url) => fetch(`${baseUrl}${url}`, { headers: { Cookie: session.cookie } });

  const employeeOrder = await order(employee, warehouseProduct);
  const ownOrder = await order(responsable, warehouseProduct);
  const salesOrder = await order(salesEmployee, salesProduct);

  // The responsable sees their department's requests, not other departments'.
  const visible = (await (await get(responsable, "/api/orders")).json()).orders.map((item) => item.id).sort();
  assert.deepEqual(visible, [employeeOrder, ownOrder].sort());

  // Their own request was approved automatically; they decide their employees' requests,
  // never another department's.
  const ownStatus = (await (await get(responsable, "/api/orders")).json()).orders
    .find((item) => item.id === ownOrder).status;
  assert.equal(ownStatus, "approved");
  assert.equal((await decide(responsable, ownOrder)).status, 409);
  assert.equal((await decide(responsable, salesOrder)).status, 403);
  assert.equal((await decide(responsable, employeeOrder)).status, 200);
  // A plain employee cannot decide.
  const anotherOrder = await order(employee, warehouseProduct);
  assert.equal((await decide(employee, anotherOrder)).status, 403);

  // Company directory: responsables yes, plain employees no.
  const staffResponse = await get(responsable, "/api/staff");
  assert.equal(staffResponse.status, 200);
  const staff = (await staffResponse.json()).staff;
  assert.ok(staff.some((member) => member.email === "sales@example.ca" && member.departmentName === "Ventes"));
  assert.deepEqual(staff.find((member) => member.email === "resp@example.ca").manages, ["Entrepôt"]);
  assert.equal((await get(employee, "/api/staff")).status, 403);
});

test("the director's requests are approved automatically and the accountant sees every request", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const salesId = await database.createDepartment("Ventes");
  const productId = await database.createProduct("Boîte", "", 500, warehouseId, null, 1);
  const salesProduct = await database.createProduct("Affiche", "", 900, salesId, null, 1);
  const employee = await makeManagerSession(app, baseUrl, salesId, "emp@example.ca", "employee-password-1");
  const accountant = await makeManagerSession(app, baseUrl, salesId, "compta@example.ca", "accountant-password");
  const accountantId = (await database.getUserByEmail("compta@example.ca")).id;
  const director = await makeAdminSession(baseUrl);

  // The director orders for a chosen department; the request is approved at once.
  const directorOrder = await postJson(baseUrl, director.cookie, director.csrfToken, "/api/orders", {
    departmentId: warehouseId, items: [{ productId, quantity: 2 }]
  });
  assert.equal(directorOrder.status, 201);
  assert.equal((await directorOrder.json()).status, "approved");

  // An employee's request still waits for a decision.
  const employeeOrder = await postJson(baseUrl, employee.cookie, employee.csrfToken, "/api/orders", {
    items: [{ productId: salesProduct, quantity: 1 }]
  });
  assert.equal((await employeeOrder.json()).status, "pending");

  // The director turns an employee into an accountant, who then sees every request, read only.
  assert.equal((await patchJson(baseUrl, director.cookie, director.csrfToken, `/api/admin/users/${accountantId}`, {
    fullName: "Comptable", departmentId: null, role: "accountant"
  })).status, 200);
  const orders = (await (await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: accountant.cookie } })).json()).orders;
  assert.equal(orders.length, 2);
  assert.equal((await patchJson(baseUrl, accountant.cookie, accountant.csrfToken, `/api/orders/${orders[0].id}/decision`, {
    status: "approved"
  })).status, 403);
  assert.equal((await postJson(baseUrl, accountant.cookie, accountant.csrfToken, "/api/products", {
    name: "X", description: "", priceCents: 100
  })).status, 403);
  // The director's own role is not changed from the company side.
  const directorId = (await database.getUserByEmail(ADMIN_EMAIL)).id;
  assert.equal((await patchJson(baseUrl, director.cookie, director.csrfToken, `/api/admin/users/${directorId}`, {
    fullName: "Direction", departmentId: null, role: "employee"
  })).status, 400);
});

test("the developer only invites and removes the company's administrators", async (t) => {
  const sentMessages = [];
  const { app, baseUrl } = await startApp(t, {
    sendInvitationEmail: async (message) => sentMessages.push(message)
  });
  const database = app.locals.database;
  const developerId = database.nextUserId++;
  database.users.set(developerId, {
    id: developerId,
    email: "dev@example.ca",
    password_hash: await argon2.hash("developer-test-password"),
    role: "developer",
    department_id: null,
    is_active: true
  });
  const { response, cookie } = await login(baseUrl, "dev@example.ca", "developer-test-password");
  assert.equal(response.status, 200);
  const csrf = await getCsrfToken(baseUrl, cookie);
  const developer = { cookie: csrf.cookie, csrfToken: csrf.token };
  const get = (session, url) => fetch(`${baseUrl}${url}`, { headers: { Cookie: session.cookie } });

  // No access to the company's data.
  for (const url of ["/api/orders", "/api/products", "/api/admin/users", "/api/admin/dashboard"]) {
    assert.equal((await get(developer, url)).status, 403, url);
  }
  assert.equal((await get(developer, "/api/auth/me")).status, 200);

  // Invite the company administrator, who chooses their own password.
  const invite = await postJson(baseUrl, developer.cookie, developer.csrfToken, "/api/developer/admins", {
    fullName: "Patron Promographe", email: "Patron@Example.ca"
  });
  assert.equal(invite.status, 202);
  assert.equal(sentMessages[0].role, "admin");
  const validate = await fetch(`${baseUrl}/api/invitations/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: sentMessages[0].token })
  });
  assert.deepEqual(await validate.json(), { email: "patron@example.ca", role: "admin", departmentName: "" });
  const acceptCsrf = await getCsrfToken(baseUrl);
  assert.equal((await postJson(baseUrl, acceptCsrf.cookie, acceptCsrf.token, "/api/invitations/accept", {
    token: sentMessages[0].token, password: "the-boss-password"
  })).status, 204);
  const bossLogin = await login(baseUrl, "patron@example.ca", "the-boss-password");
  assert.equal(bossLogin.response.status, 200);
  const boss = { cookie: bossLogin.cookie };
  assert.equal((await get(boss, "/api/admin/dashboard?year=2026")).status, 200);
  assert.equal((await get(boss, "/api/developer/admins")).status, 403);

  // An active account cannot be invited again; removing the administrator signs them out.
  assert.equal((await postJson(baseUrl, developer.cookie, developer.csrfToken, "/api/developer/admins", {
    fullName: "Patron", email: "patron@example.ca"
  })).status, 409);
  const admins = (await (await get(developer, "/api/developer/admins")).json()).admins;
  const bossId = admins.find((admin) => admin.email === "patron@example.ca").id;
  const removal = await fetch(`${baseUrl}/api/developer/admins/${bossId}`, {
    method: "DELETE",
    headers: { Cookie: developer.cookie, "X-CSRF-Token": developer.csrfToken }
  });
  assert.equal(removal.status, 204);
  assert.equal((await get(boss, "/api/auth/me")).status, 401);
});

test("an employee corrects their own department without gaining any right", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const salesId = await database.createDepartment("Ventes");
  await database.createProduct("Affiche", "", 900, salesId, null, 1);
  const employee = await makeManagerSession(app, baseUrl, warehouseId, "emp@example.ca", "employee-password-1", "Emp");
  const update = (body) => fetch(`${baseUrl}/api/auth/profile`, {
    method: "PATCH",
    headers: { Cookie: employee.cookie, "X-CSRF-Token": employee.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const departments = await (await fetch(`${baseUrl}/api/departments`, { headers: { Cookie: employee.cookie } })).json();
  assert.deepEqual(departments.departments.map((department) => department.name).sort(), ["Entrepôt", "Ventes"]);

  assert.equal((await update({ fullName: "Emp", departmentId: 999 })).status, 400);
  assert.equal((await update({ fullName: "Emp", departmentId: salesId, role: "admin" })).status, 200);
  const me = (await (await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: employee.cookie } })).json()).user;
  assert.equal(me.departmentName, "Ventes");
  assert.equal(me.role, "employee");
  const catalogue = (await (await fetch(`${baseUrl}/api/products`, { headers: { Cookie: employee.cookie } })).json()).products;
  assert.deepEqual(catalogue.map((product) => product.name), ["Affiche"]);
});

test("the responsable decides their employees' requests whatever the amount; the director, the responsable's own above $2,500", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const cheap = await database.createProduct("Ruban", "", 250000, warehouseId, null, 1);
  const expensive = await database.createProduct("Chariot", "", 250001, warehouseId, null, 1);
  const responsable = await makeManagerSession(app, baseUrl, warehouseId, "resp@example.ca", "responsable-password");
  const employee = await makeManagerSession(app, baseUrl, warehouseId, "emp@example.ca", "employee-password-1");
  await database.setDepartmentManager(warehouseId, (await database.getUserByEmail("resp@example.ca")).id);
  const director = await makeAdminSession(baseUrl);
  const order = async (session, productId) => (await postJson(baseUrl, session.cookie, session.csrfToken, "/api/orders", {
    items: [{ productId, quantity: 1 }]
  })).json();
  const decide = (session, id) => patchJson(baseUrl, session.cookie, session.csrfToken, `/api/orders/${id}/decision`, { status: "approved" });

  // The responsable's own request: exactly $2,500 is approved automatically; one cent more
  // goes to the director.
  assert.equal((await order(responsable, cheap)).status, "approved");
  const ownExpensive = await order(responsable, expensive);
  assert.equal(ownExpensive.status, "pending");
  assert.equal((await decide(responsable, ownExpensive.orderId)).status, 403);
  assert.equal((await decide(director, ownExpensive.orderId)).status, 200);

  // An employee's request goes to their responsable whatever the amount, not to the director.
  const employeeCheap = await order(employee, cheap);
  const employeeExpensive = await order(employee, expensive);
  assert.equal((await decide(director, employeeCheap.orderId)).status, 403);
  assert.equal((await decide(director, employeeExpensive.orderId)).status, 403);
  assert.equal((await decide(responsable, employeeCheap.orderId)).status, 200);
  assert.equal((await decide(responsable, employeeExpensive.orderId)).status, 200);

  // A department without a responsable: the director decides its small requests too.
  const salesId = await database.createDepartment("Ventes");
  const poster = await database.createProduct("Affiche", "", 1000, salesId, null, 1);
  const salesEmployee = await makeManagerSession(app, baseUrl, salesId, "sales@example.ca", "sales-password-123");
  const salesOrder = await order(salesEmployee, poster);
  assert.equal((await decide(director, salesOrder.orderId)).status, 200);
});

test("deleting an account removes it for good while its requests stay in the history", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const salesId = await database.createDepartment("Ventes");
  const productId = await database.createProduct("Affiche", "", 900, salesId, null, 1);
  const employee = await makeManagerSession(app, baseUrl, salesId, "gmail.user@example.ca", "employee-password-1", "Paul Gmail");
  const created = await postJson(baseUrl, employee.cookie, employee.csrfToken, "/api/orders", {
    items: [{ productId, quantity: 3 }]
  });
  assert.equal(created.status, 201);
  const director = await makeAdminSession(baseUrl);
  const userId = (await database.getUserByEmail("gmail.user@example.ca")).id;
  const removal = await fetch(`${baseUrl}/api/admin/users/${userId}`, {
    method: "DELETE",
    headers: { Cookie: director.cookie, "X-CSRF-Token": director.csrfToken }
  });
  assert.equal(removal.status, 204);

  // The account is gone: no row, no sign-in, not listed anywhere.
  assert.equal(await database.getUserByEmail("gmail.user@example.ca"), undefined);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: employee.cookie } })).status, 401);
  assert.equal((await login(baseUrl, "gmail.user@example.ca", "employee-password-1")).response.status, 401);
  // The request stays in the history, still showing who made it.
  const orders = (await (await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: director.cookie } })).json()).orders;
  assert.equal(orders.length, 1);
  assert.equal(orders[0].createdByEmail, "gmail.user@example.ca");
  assert.equal(orders[0].createdByName, "Paul Gmail");
});

test("approved requests are merged into one purchase order per supplier", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const uline = await database.createSupplier("Uline", "", "", "");
  const grand = await database.createSupplier("Grand & Toy", "", "", "");
  const box = await database.createProduct("Boîte", "", 500, warehouseId, uline, 1);
  const tape = await database.createProduct("Ruban", "", 200, warehouseId, uline, 1);
  const pen = await database.createProduct("Stylo", "", 100, warehouseId, grand, 1);
  const responsable = await makeManagerSession(app, baseUrl, warehouseId, "resp@example.ca", "responsable-password");
  const employee = await makeManagerSession(app, baseUrl, warehouseId, "emp@example.ca", "employee-password-1");
  const accountant = await makeManagerSession(app, baseUrl, warehouseId, "compta@example.ca", "accountant-password");
  await database.updateStaffRole((await database.getUserByEmail("compta@example.ca")).id, "accountant");
  await database.setDepartmentManager(warehouseId, (await database.getUserByEmail("resp@example.ca")).id);
  const send = async (session, method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
      body: body && JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const purchaseOrders = async () => (await send(accountant, "GET", "/api/purchase-orders")).body.purchaseOrders;

  // Two requests (one auto-approved, one approved by the responsable), plus one still pending.
  const first = (await send(employee, "POST", "/api/orders", { items: [{ productId: box, quantity: 2 }, { productId: pen, quantity: 1 }] })).body;
  await send(responsable, "POST", "/api/orders", { urgent: true, items: [{ productId: box, quantity: 3 }, { productId: tape, quantity: 1 }] });
  await send(employee, "POST", "/api/orders", { items: [{ productId: box, quantity: 9 }] });
  assert.equal((await purchaseOrders()).length, 1);
  // Counter of the day: DEM-AAAA-MMJJ-1, -2, -3.
  const { orderNumberBase } = require("../src/database");
  const today = orderNumberBase(new Date());
  const numbers = (await send(accountant, "GET", "/api/orders")).body.orders.map((order) => order.number);
  assert.equal(first.orderNumber, `${today}-1`);
  assert.deepEqual(numbers.sort(), [`${today}-1`, `${today}-2`, `${today}-3`]);
  await send(responsable, "PATCH", `/api/orders/${first.orderId}/decision`, { status: "approved" });

  let list = await purchaseOrders();
  assert.equal(list.length, 2);
  const ulineOrder = list.find((purchaseOrder) => purchaseOrder.supplierName === "Uline");
  const grandOrder = list.find((purchaseOrder) => purchaseOrder.supplierName === "Grand & Toy");
  // Counter of the year on five digits: PG-AAAA00001, PG-AAAA00002.
  const year = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric" }).format(new Date());
  assert.equal(ulineOrder.number, `PG-${year}00001`);
  assert.equal(grandOrder.number, `PG-${year}00002`);
  assert.equal(ulineOrder.isUrgent, true);
  assert.equal(ulineOrder.orders.length, 2);
  assert.deepEqual(ulineOrder.lines.map((line) => [line.productName, line.quantity]), [["Boîte", 5], ["Ruban", 1]]);
  assert.equal(ulineOrder.totalCents, 5 * 500 + 200);
  assert.equal(grandOrder.totalCents, 100);
  const approval = ulineOrder.orders.find((order) => order.id === first.orderId);
  assert.ok(approval.approvedBy);
  assert.equal(approval.approvedByDirector, false);

  // Buying Uline closes that order; the request with a Grand & Toy line is bought only once both are.
  assert.equal((await send(accountant, "PATCH", `/api/purchase-orders/${ulineOrder.id}/purchased`)).status, 200);
  let orders = (await send(accountant, "GET", "/api/orders")).body.orders;
  assert.equal(orders.find((order) => order.id === first.orderId).purchasedAt, null);
  assert.ok(orders.find((order) => order.isUrgent).purchasedAt);
  assert.equal((await send(accountant, "PATCH", `/api/purchase-orders/${grandOrder.id}/purchased`)).status, 200);
  orders = (await send(accountant, "GET", "/api/orders")).body.orders;
  const bought = orders.find((order) => order.id === first.orderId);
  assert.ok(bought.purchasedAt);
  assert.deepEqual(bought.items.map((item) => [item.supplierName, item.purchaseOrderNumber]), [
    ["Uline", ulineOrder.number], ["Grand & Toy", grandOrder.number]
  ]);

  // A later approval opens a new Uline purchase order.
  const pending = orders.find((order) => order.status === "pending");
  await send(responsable, "PATCH", `/api/orders/${pending.id}/decision`, { status: "approved" });
  list = await purchaseOrders();
  const reopened = list.find((purchaseOrder) => purchaseOrder.status === "open");
  assert.equal(reopened.number, `PG-${year}00003`);
  assert.equal(reopened.supplierName, "Uline");
  assert.equal(reopened.lines[0].quantity, 9);

  // Accountant dashboard: purchase orders, most ordered product, price increases.
  assert.equal((await send(employee, "GET", "/api/accounting/dashboard")).status, 403);
  await database.updateProduct(box, "Boîte", "", 650, warehouseId, uline, true);
  const { dashboard } = (await send(accountant, "GET", "/api/accounting/dashboard")).body;
  assert.equal(dashboard.purchaseOrders.purchasedCount, 2);
  assert.equal(dashboard.purchaseOrders.purchasedCents, 5 * 500 + 200 + 100);
  assert.equal(dashboard.purchaseOrders.openCount, 1);
  assert.equal(dashboard.purchaseOrders.openCents, 9 * 500);
  assert.equal(dashboard.requests.approvedCount, 3);
  assert.deepEqual([dashboard.topProducts[0].productName, dashboard.topProducts[0].quantity], ["Boîte", 14]);
  assert.deepEqual(dashboard.priceIncreases.map((entry) => [entry.productName, entry.firstPriceCents, entry.currentPriceCents, entry.changePercent]), [
    ["Boîte", 500, 650, 30]
  ]);
});

test("the director transmits a purchase order to its supplier, then the accountant buys it", async (t) => {
  const sentEmails = [];
  const { app, baseUrl } = await startApp(t, { sendPurchaseOrderEmail: async (message) => sentEmails.push(message) });
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const director = await makeAdminSession(baseUrl);
  const accountant = await makeManagerSession(app, baseUrl, warehouseId, "compta@example.ca", "accountant-password");
  await database.updateStaffRole((await database.getUserByEmail("compta@example.ca")).id, "accountant");
  const send = async (session, method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
      body: body && JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  // Supplier details: website and preferred way to receive orders.
  assert.equal((await send(director, "POST", "/api/admin/suppliers", { name: "Uline", website: "ftp://x", orderMethod: "email" })).status, 400);
  assert.equal((await send(director, "POST", "/api/admin/suppliers", {
    name: "Uline", reducedThresholdCents: 50000, freeThresholdCents: 30000
  })).status, 400);
  const created = await send(director, "POST", "/api/admin/suppliers", {
    name: "Uline", contactName: "Julie", email: "ventes@uline.example", phone: "514-555-0100", phoneExtension: "204",
    website: "uline.ca", orderMethod: "email", note: "Compte client 4471", reducedThresholdCents: 15000, freeThresholdCents: 30000,
    accountNumber: "C-88120", currency: "usd", paymentTerms: "Net 30", category: "Emballage"
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.supplier.website, "https://uline.ca");
  const uline = created.body.supplier.id;
  const box = await database.createProduct("Boîte", "Code : S-100", 500, warehouseId, uline, 1);
  await send(director, "POST", "/api/orders", { departmentId: warehouseId, items: [{ productId: box, quantity: 4 }] });

  let [purchaseOrder] = (await send(director, "GET", "/api/purchase-orders")).body.purchaseOrders;
  assert.equal(purchaseOrder.status, "open");
  assert.deepEqual(purchaseOrder.supplier, {
    contactName: "Julie", email: "ventes@uline.example", phone: "514-555-0100", website: "https://uline.ca", orderMethod: "email",
    phoneExtension: "204", note: "Compte client 4471", reducedThresholdCents: 15000, freeThresholdCents: 30000,
    accountNumber: "C-88120", currency: "USD", paymentTerms: "Net 30", isAuthorized: true, category: "Emballage"
  });
  const { document } = (await send(director, "GET", `/api/purchase-orders/${purchaseOrder.id}/document`)).body;
  assert.match(document.text, new RegExp(purchaseOrder.number));
  assert.ok(document.text.includes("4 unités – Boîte (Code : S-100)"));
  assert.ok(document.text.includes("N° de compte client : C-88120"));
  assert.ok(document.text.includes("Conditions de paiement : Net 30"));
  assert.ok(document.text.includes("Devise : USD"));
  assert.match(document.text, /Total : 20,00\s\$\sUS/);
  assert.doesNotMatch(document.text, /compta|Entrepôt|4471/);

  // Only the director transmits; by email the site sends it, replies go to the director.
  assert.equal((await send(accountant, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/sent`, { method: "email" })).status, 403);
  assert.equal((await send(director, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/sent`, { method: "pigeon" })).status, 400);
  // No text message, phone or other way.
  for (const method of ["sms", "phone", "other"]) {
    assert.equal((await send(director, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/sent`, { method })).status, 400);
  }
  assert.equal((await send(director, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/sent`, { method: "email", note: "Livrer au quai 2" })).status, 200);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, "ventes@uline.example");
  assert.equal(sentEmails[0].replyTo, ADMIN_EMAIL);
  assert.match(sentEmails[0].text, /Livrer au quai 2/);
  assert.equal((await send(director, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/sent`, { method: "website" })).status, 409);
  [purchaseOrder] = (await send(accountant, "GET", "/api/purchase-orders")).body.purchaseOrders;
  // Transmitted = bought: it goes straight to the history.
  assert.equal(purchaseOrder.status, "purchased");
  assert.ok(purchaseOrder.purchasedAt);
  assert.equal(purchaseOrder.sentMethod, "email");
  assert.equal(purchaseOrder.sentByEmail, ADMIN_EMAIL);

  // A transmitted order takes no more lines; it cannot be bought twice.
  await send(director, "POST", "/api/orders", { departmentId: warehouseId, items: [{ productId: box, quantity: 1 }] });
  const list = (await send(accountant, "GET", "/api/purchase-orders")).body.purchaseOrders;
  assert.equal(list.length, 2);
  assert.equal(list.find((candidate) => candidate.id === purchaseOrder.id).lines[0].quantity, 4);
  assert.equal((await send(accountant, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/purchased`)).status, 409);
  const [request] = (await send(accountant, "GET", "/api/orders")).body.orders.filter((order) => order.items[0].quantity === 4);
  assert.ok(request.purchasedAt);

  // Without an email address, the director records another way of sending it.
  assert.equal((await send(director, "PATCH", `/api/admin/suppliers/${uline}`, { name: "Uline", orderMethod: "sms" })).status, 400);
  assert.equal((await send(director, "PATCH", `/api/admin/suppliers/${uline}`, {
    name: "Uline", phone: "514-555-0100", contactName: "Julie", orderMethod: "representative"
  })).status, 200);
  const second = list.find((candidate) => candidate.id !== purchaseOrder.id);
  assert.equal((await send(director, "PATCH", `/api/purchase-orders/${second.id}/sent`, { method: "email" })).status, 400);
  assert.equal((await send(director, "PATCH", `/api/purchase-orders/${second.id}/sent`, { method: "representative" })).status, 200);
  assert.equal(sentEmails.length, 1);
});

test("responsables see each supplier's free shipping threshold, plain employees do not", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const uline = await database.createSupplier("Uline", "", "", "", "", "", { freeThresholdCents: 30000, note: "secret" });
  const box = await database.createProduct("Boîte", "", 5000, warehouseId, uline, 1);
  const responsable = await makeManagerSession(app, baseUrl, warehouseId, "resp@example.ca", "responsable-password");
  const employee = await makeManagerSession(app, baseUrl, warehouseId, "emp@example.ca", "employee-password-1");
  await database.setDepartmentManager(warehouseId, (await database.getUserByEmail("resp@example.ca")).id);
  const get = async (session, url) => {
    const response = await fetch(`${baseUrl}${url}`, { headers: { Cookie: session.cookie } });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await get(employee, "/api/suppliers/shipping")).status, 403);
  const other = await database.createSupplier("Hors entente", "", "", "", "", "", { isAuthorized: false, category: "Divers" });
  const blockedProduct = await database.createProduct("Ruban", "", 100, warehouseId, other, 1);
  const refused = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { Cookie: responsable.cookie, "X-CSRF-Token": responsable.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ productId: blockedProduct, quantity: 1 }] })
  });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /Hors entente/);
  const director = await makeAdminSession(baseUrl);
  const allowed = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { Cookie: director.cookie, "X-CSRF-Token": director.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ departmentId: warehouseId, items: [{ productId: blockedProduct, quantity: 1 }] })
  });
  assert.equal(allowed.status, 201);
  const dashboard = (await get(director, "/api/accounting/dashboard")).body.dashboard;
  assert.deepEqual(dashboard.categories, [{ category: "Divers", quantity: 1, totalCents: 100 }]);
  // The responsable's own request is approved and joins Uline's open purchase order.
  await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { Cookie: responsable.cookie, "X-CSRF-Token": responsable.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ productId: box, quantity: 2 }] })
  });
  const { body } = await get(responsable, "/api/suppliers/shipping");
  assert.deepEqual(body.suppliers.find((supplier) => supplier.id === uline), { id: uline, name: "Uline", freeThresholdCents: 30000, openCents: 10000 });
});

test("requests show their number in advance and client requests stay out of the budgets", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  await database.updateDepartmentBudget(warehouseId, 100000);
  const box = await database.createProduct("Boîte", "", 1000, warehouseId, null, 1);
  const director = await makeAdminSession(baseUrl);
  const employee = await makeManagerSession(app, baseUrl, warehouseId, "emp@example.ca", "employee-password-1");
  const call = async (session, method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
      body: body && JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const { orderNumberBase } = require("../src/database");
  const today = orderNumberBase(new Date());

  // The employee's form shows the number the request will receive.
  assert.equal((await call(employee, "GET", "/api/orders/next-number")).body.number, `${today}-1`);
  assert.equal((await call(employee, "POST", "/api/orders", { external: true, clientName: " ", items: [{ productId: box, quantity: 1 }] })).status, 400);
  const clientOrder = (await call(employee, "POST", "/api/orders", {
    external: true, clientName: "Restaurant Chez Lise", clientReference: "SOUM-221", items: [{ productId: box, quantity: 3 }]
  })).body;
  assert.equal(clientOrder.orderNumber, `${today}-1`);
  assert.equal((await call(employee, "GET", "/api/orders/next-number")).body.number, `${today}-2`);
  await call(director, "POST", "/api/orders", { departmentId: warehouseId, items: [{ productId: box, quantity: 2 }] });
  await call(director, "PATCH", `/api/orders/${clientOrder.orderId}/decision`, { status: "approved" });

  const [order] = (await call(employee, "GET", "/api/orders")).body.orders;
  assert.equal(order.isExternal, true);
  assert.equal(order.clientName, "Restaurant Chez Lise");
  assert.equal(order.clientReference, "SOUM-221");

  // Budget: only the company request; the client request is counted apart.
  const year = new Date().getFullYear();
  const dashboard = (await call(director, "GET", `/api/admin/dashboard?year=${year}`)).body;
  assert.equal(dashboard.departments[0].approvedCents, 2000);
  assert.deepEqual(dashboard.external, { approvedCents: 3000, pendingCents: 0, orders: 1 });
});

test("products have a unit of measure, kept on requests and purchase orders", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const director = await makeAdminSession(baseUrl);
  const call = async (method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { Cookie: director.cookie, "X-CSRF-Token": director.csrfToken, "Content-Type": "application/json" },
      body: body && JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const base = { name: "Film vinyle", description: "", priceCents: 250, departmentId: warehouseId, supplierName: "Uline" };
  assert.equal((await call("POST", "/api/products", { ...base, unit: "tonne" })).status, 400);
  const created = await call("POST", "/api/products", { ...base, unit: "verge" });
  assert.equal(created.status, 201);
  assert.equal(created.body.product.unit, "verge");
  const ink = (await call("POST", "/api/products", { ...base, name: "Encre", unit: "gallon" })).body.product.id;
  assert.equal((await call("GET", "/api/products")).body.products.find((product) => product.id === ink).unit, "gallon");

  assert.equal((await call("POST", "/api/orders", { departmentId: warehouseId, items: [{ productId: ink, quantity: 1, unit: "tonne" }] })).status, 400);
  await call("POST", "/api/orders", { departmentId: warehouseId, items: [{ productId: created.body.product.id, quantity: 12 }, { productId: ink, quantity: 1 }] });
  // The unit of a request line stays as it was, even if the catalogue changes later.
  await call("PATCH", `/api/products/${ink}`, { ...base, name: "Encre", unit: "litre", isActive: true });
  const [order] = (await call("GET", "/api/orders")).body.orders;
  assert.deepEqual(order.items.map((item) => [item.productName, item.quantity, item.unit]), [["Film vinyle", 12, "verge"], ["Encre", 1, "gallon"]]);
  const [purchaseOrder] = (await call("GET", "/api/purchase-orders")).body.purchaseOrders;
  assert.deepEqual(purchaseOrder.lines.map((line) => [line.productName, line.unit]), [["Encre", "gallon"], ["Film vinyle", "verge"]]);
  const { document } = (await call("GET", `/api/purchase-orders/${purchaseOrder.id}/document`)).body;
  assert.ok(document.text.includes("12 verges – Film vinyle"));
  assert.ok(document.text.includes("1 gallon – Encre"));

  // The person may choose another unit on a line; it is kept as chosen.
  await call("POST", "/api/orders", { departmentId: warehouseId, items: [{ productId: created.body.product.id, quantity: 3, unit: "mètre" }] });
  const [chosen] = (await call("GET", "/api/orders")).body.orders;
  assert.deepEqual([chosen.items[0].quantity, chosen.items[0].unit], [3, "mètre"]);
});

test("products have a SKU, kept on requests and shown on purchase orders", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const director = await makeAdminSession(baseUrl);
  const call = async (method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { Cookie: director.cookie, "X-CSRF-Token": director.csrfToken, "Content-Type": "application/json" },
      body: body && JSON.stringify(body)
    });
    const isJson = response.headers.get("content-type")?.includes("json");
    return { status: response.status, body: isJson ? await response.json() : null };
  };
  const base = { name: "Boîte", description: "24 × 18 × 12 po", priceCents: 1250, departmentId: warehouseId, supplierName: "Uline" };
  assert.equal((await call("POST", "/api/products", { ...base, sku: "S".repeat(51) })).status, 400);
  const created = await call("POST", "/api/products", { ...base, sku: " S-4002 " });
  assert.equal(created.status, 201);
  const boxId = created.body.product.id;
  assert.equal((await call("GET", "/api/products")).body.products.find((product) => product.id === boxId).sku, "S-4002");
  const tape = (await call("POST", "/api/products", { ...base, name: "Ruban", description: "", sku: "" })).body.product.id;

  await call("POST", "/api/orders", { departmentId: warehouseId, items: [{ productId: boxId, quantity: 2 }, { productId: tape, quantity: 1 }] });
  // The SKU of a request line stays as it was, even if the catalogue changes later.
  await call("PATCH", `/api/products/${boxId}`, { ...base, sku: "S-9999", isActive: true });
  const [order] = (await call("GET", "/api/orders")).body.orders;
  assert.deepEqual(order.items.map((item) => [item.productName, item.sku]), [["Boîte", "S-4002"], ["Ruban", ""]]);
  const [purchaseOrder] = (await call("GET", "/api/purchase-orders")).body.purchaseOrders;
  assert.deepEqual(purchaseOrder.lines.map((line) => [line.productName, line.sku]), [["Boîte", "S-4002"], ["Ruban", ""]]);

  const { document } = (await call("GET", `/api/purchase-orders/${purchaseOrder.id}/document`)).body;
  assert.ok(document.text.includes("2 unités – SKU S-4002 – Boîte (24 × 18 × 12 po)"));
  assert.ok(document.text.includes("1 unité – Ruban"));
  assert.match(document.html, /<th[^>]*>SKU<\/th>/);
  assert.match(document.html, />S-4002</);
  assert.equal((await call("GET", `/api/purchase-orders/${purchaseOrder.id}/pdf`)).status, 200);
});

test("the purchasing administration transmits purchase orders and keeps supplier cards", async (t) => {
  const sentEmails = [];
  const { app, baseUrl } = await startApp(t, { sendPurchaseOrderEmail: async (message) => sentEmails.push(message) });
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const salesId = await database.createDepartment("Ventes");
  const uline = await database.createSupplier("Uline", "", "ventes@uline.example", "", "", "email");
  const box = await database.createProduct("Boîte", "", 500, warehouseId, uline, 1);
  await database.createProduct("Stylo", "", 100, salesId, uline, 1);
  const director = await makeAdminSession(baseUrl);
  const purchaser = await makeManagerSession(app, baseUrl, salesId, "achats@example.ca", "purchaser-password");
  const purchaserId = (await database.getUserByEmail("achats@example.ca")).id;
  const call = async (session, method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
      body: body && JSON.stringify(body)
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };

  // Before: a plain employee has none of these rights.
  assert.equal((await call(purchaser, "GET", "/api/purchase-orders")).status, 403);
  // The director gives the role (the department stays optional).
  assert.equal((await call(director, "PATCH", `/api/admin/users/${purchaserId}`, {
    fullName: "Achats", departmentId: null, role: "purchaser"
  })).status, 200);
  assert.equal((await database.getUserByEmail("achats@example.ca")).role, "purchaser");

  await call(director, "POST", "/api/orders", { departmentId: warehouseId, items: [{ productId: box, quantity: 2 }] });
  const [purchaseOrder] = (await call(purchaser, "GET", "/api/purchase-orders")).body.purchaseOrders;
  assert.equal(purchaseOrder.supplier.email, "ventes@uline.example");
  assert.equal((await call(purchaser, "GET", `/api/purchase-orders/${purchaseOrder.id}/document`)).status, 200);
  assert.equal((await call(purchaser, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/sent`, { method: "email" })).status, 200);
  assert.equal(sentEmails[0].replyTo, "achats@example.ca");
  // Only the accountant (or the director) marks it bought.
  assert.equal((await call(purchaser, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/purchased`)).status, 403);

  // Supplier cards: list, add, edit and delete.
  assert.equal((await call(purchaser, "GET", "/api/admin/suppliers")).status, 200);
  const created = await call(purchaser, "POST", "/api/admin/suppliers", { name: "Grand & Toy", paymentTerms: "Net 30" });
  assert.equal(created.status, 201);
  assert.equal((await call(purchaser, "PATCH", `/api/admin/suppliers/${created.body.supplier.id}`, { name: "Grand & Toy", phone: "514-555-0199" })).status, 200);
  assert.equal((await call(purchaser, "DELETE", `/api/admin/suppliers/${created.body.supplier.id}`)).status, 204);

  // Whole catalogue with prices, but no staff management, budgets or other people's requests.
  const products = (await call(purchaser, "GET", "/api/products")).body.products;
  assert.equal(products.length, 2);
  assert.ok(products.every((product) => typeof product.price_cents === "number"));
  assert.equal((await call(purchaser, "GET", "/api/admin/users")).status, 403);
  assert.equal((await call(purchaser, "GET", "/api/accounting/dashboard")).status, 403);
  assert.equal((await call(purchaser, "GET", "/api/orders")).body.orders.length, 0);
  // No requests of their own; the staff directory instead.
  assert.equal((await call(purchaser, "POST", "/api/orders", { items: [{ productId: box, quantity: 1 }] })).status, 403);
  const staff = (await call(purchaser, "GET", "/api/staff")).body.staff;
  assert.ok(staff.some((member) => member.email === "achats@example.ca"));
  assert.equal((await call(purchaser, "POST", "/api/products", { name: "X", priceCents: 1, supplierName: "Uline" })).status, 403);
  // It edits and deletes products of every department.
  const pen = products.find((product) => product.name === "Stylo");
  assert.equal((await call(purchaser, "PATCH", `/api/products/${pen.id}`, {
    name: "Stylo bleu", description: "", priceCents: 150, departmentId: salesId, supplierName: "Uline", isActive: true, unit: "paquet"
  })).status, 200);
  assert.equal((await database.listProducts({ role: "admin" })).find((product) => product.id === pen.id).name, "Stylo bleu");
  assert.equal((await call(purchaser, "DELETE", `/api/products/${pen.id}`)).status, 204);
});

test("department responsables keep the supplier cards, but never decide which are authorized", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const blocked = await database.createSupplier("Hors entente", "", "", "", "", "", { isAuthorized: false });
  const responsable = await makeManagerSession(app, baseUrl, warehouseId, "resp@example.ca", "responsable-password");
  const employee = await makeManagerSession(app, baseUrl, warehouseId, "emp@example.ca", "employee-password-1");
  await database.setDepartmentManager(warehouseId, (await database.getUserByEmail("resp@example.ca")).id);
  const call = async (session, method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
      body: body && JSON.stringify(body)
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  const supplierNamed = async (name) => (await database.listSuppliers()).find((supplier) => supplier.name === name);

  // A plain employee has no access to the supplier cards.
  assert.equal((await call(employee, "GET", "/api/admin/suppliers")).status, 403);
  assert.equal((await call(employee, "POST", "/api/admin/suppliers", { name: "Uline" })).status, 403);

  // The responsable lists, adds, edits and deletes them.
  assert.equal((await call(responsable, "GET", "/api/admin/suppliers")).body.suppliers.length, 1);
  const created = await call(responsable, "POST", "/api/admin/suppliers", { name: "Uline", isAuthorized: false });
  assert.equal(created.status, 201);
  assert.equal(created.body.supplier.is_authorized, true);
  const uline = created.body.supplier.id;
  assert.equal((await call(responsable, "PATCH", `/api/admin/suppliers/${uline}`, {
    name: "Uline Canada", phone: "514-555-0100", isAuthorized: false
  })).status, 200);
  assert.equal((await supplierNamed("Uline Canada")).phone, "514-555-0100");
  assert.equal((await supplierNamed("Uline Canada")).is_authorized, true);
  // A supplier the director blocked stays blocked.
  assert.equal((await call(responsable, "PATCH", `/api/admin/suppliers/${blocked}`, {
    name: "Hors entente", isAuthorized: true
  })).status, 200);
  assert.equal((await supplierNamed("Hors entente")).is_authorized, false);
  assert.equal((await call(responsable, "DELETE", `/api/admin/suppliers/${blocked}`)).status, 403);
  assert.equal((await call(responsable, "DELETE", `/api/admin/suppliers/${uline}`)).status, 204);
  assert.equal((await call(responsable, "PATCH", `/api/admin/suppliers/${uline}`, { name: "Uline" })).status, 404);
});

test("a department responsable edits the people of their department and changes their access", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const salesId = await database.createDepartment("Ventes");
  const responsable = await makeManagerSession(app, baseUrl, warehouseId, "resp@example.ca", "responsable-password");
  const employee = await makeManagerSession(app, baseUrl, warehouseId, "emp@example.ca", "employee-password-1");
  await makeManagerSession(app, baseUrl, salesId, "sales@example.ca", "sales-password-123");
  const responsableId = (await database.getUserByEmail("resp@example.ca")).id;
  const employeeId = (await database.getUserByEmail("emp@example.ca")).id;
  const salesEmployeeId = (await database.getUserByEmail("sales@example.ca")).id;
  await database.setDepartmentManager(warehouseId, responsableId);
  await database.setUserFunctions(employeeId, ["reception"]);
  const edit = (session, userId, body) => fetch(`${baseUrl}/api/team/${userId}`, {
    method: "PATCH",
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  // New name and access; the procedure functions stay with the director.
  assert.equal((await edit(responsable, employeeId, { fullName: "Émile Roy", departmentId: warehouseId, role: "accountant" })).status, 200);
  assert.equal((await database.getUserByEmail("emp@example.ca")).role, "accountant");
  assert.equal((await database.getUserByEmail("emp@example.ca")).full_name, "Émile Roy");
  assert.deepEqual(await database.getUserFunctions(employeeId), ["reception"]);
  assert.equal((await edit(responsable, employeeId, { fullName: "Émile Roy", departmentId: warehouseId, role: "employee" })).status, 200);
  assert.equal((await database.getUserByEmail("emp@example.ca")).role, "employee");

  // Only within the departments they lead, never the director's role, themselves or other departments.
  assert.equal((await edit(responsable, employeeId, { fullName: "Émile Roy", departmentId: salesId, role: "employee" })).status, 403);
  assert.equal((await edit(responsable, employeeId, { fullName: "Émile Roy", departmentId: warehouseId, role: "admin" })).status, 400);
  assert.equal((await edit(responsable, salesEmployeeId, { fullName: "Vendeur", departmentId: warehouseId, role: "employee" })).status, 403);
  assert.equal((await edit(responsable, responsableId, { fullName: "Moi", departmentId: warehouseId, role: "accountant" })).status, 403);
  // A plain employee edits no one.
  const plain = await makeManagerSession(app, baseUrl, warehouseId, "plain@example.ca", "plain-password-12");
  assert.equal((await edit(plain, employeeId, { fullName: "X", departmentId: warehouseId, role: "accountant" })).status, 403);
  assert.equal((await database.getUserByEmail("emp@example.ca")).role, "employee");
});

test("a department responsable sees and sets their department's budget and renames it", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const salesId = await database.createDepartment("Ventes");
  const box = await database.createProduct("Boîte", "", 5000, warehouseId, null, 1);
  const responsable = await makeManagerSession(app, baseUrl, warehouseId, "resp@example.ca", "responsable-password");
  const employee = await makeManagerSession(app, baseUrl, warehouseId, "emp@example.ca", "employee-password-1");
  const responsableId = (await database.getUserByEmail("resp@example.ca")).id;
  await database.setDepartmentManager(warehouseId, responsableId);
  const call = async (session, method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
      body: body && JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  await call(employee, "POST", "/api/orders", { items: [{ productId: box, quantity: 2 }] });

  // Only their department, without the company's totals.
  assert.equal((await call(responsable, "PATCH", `/api/admin/departments/${warehouseId}/budget`, { budgetCents: 500000 })).status, 200);
  const dashboard = (await call(responsable, "GET", "/api/admin/dashboard")).body;
  assert.deepEqual(dashboard.departments.map((department) => [department.name, department.budgetCents, department.pendingCents]), [
    ["Entrepôt", 500000, 10000]
  ]);
  assert.equal(dashboard.orderCounts.pending, 1);
  assert.equal(dashboard.external, undefined);
  assert.equal((await call(responsable, "PATCH", `/api/admin/departments/${salesId}/budget`, { budgetCents: 1 })).status, 403);

  // Renaming keeps the responsable; another department, creating or deleting stays with the director.
  assert.equal((await call(responsable, "PATCH", `/api/admin/departments/${warehouseId}`, { name: "Entrepôt central", managerUserId: null })).status, 200);
  assert.equal((await database.getDepartment(warehouseId)).name, "Entrepôt central");
  assert.deepEqual((await database.getManagedDepartments(responsableId)).map((department) => Number(department.id)), [warehouseId]);
  assert.equal((await call(responsable, "PATCH", `/api/admin/departments/${salesId}`, { name: "Ventes 2" })).status, 403);
  assert.equal((await call(responsable, "POST", "/api/admin/departments", { name: "Nouveau" })).status, 403);
  assert.equal((await call(responsable, "DELETE", `/api/admin/departments/${salesId}`)).status, 403);

  // A plain employee sees no budget.
  assert.equal((await call(employee, "GET", "/api/admin/dashboard")).status, 403);
  assert.equal((await call(employee, "PATCH", `/api/admin/departments/${warehouseId}/budget`, { budgetCents: 1 })).status, 403);
});

test("a department responsable sees and manages only their department's suppliers", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const officeId = await database.createDepartment("Papeterie");
  const uline = await database.createSupplier("Uline", "", "", "", "", "", { freeThresholdCents: 30000 });
  const bgm = await database.createSupplier("BGM", "", "", "");
  const megaburo = await database.createSupplier("Mégaburo", "", "", "", "", "", { freeThresholdCents: 20000 });
  const fresh = await database.createSupplier("Nouveau fournisseur", "", "", "");
  await database.createProduct("Boîte", "", 500, warehouseId, uline, 1);
  await database.createProduct("Étiquettes", "", 900, warehouseId, bgm, 1);
  await database.createProduct("Ruban", "", 300, officeId, uline, 1);
  await database.createProduct("Agrafes", "", 700, officeId, megaburo, 1);
  const responsable = await makeManagerSession(app, baseUrl, warehouseId, "resp@example.ca", "responsable-password");
  await database.setDepartmentManager(warehouseId, (await database.getUserByEmail("resp@example.ca")).id);
  const director = await makeAdminSession(baseUrl);
  const call = async (session, method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
      body: body && JSON.stringify(body)
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  const names = async (session, url = "/api/admin/suppliers") => (await call(session, "GET", url)).body.suppliers
    .map((supplier) => supplier.name).sort();

  // The suppliers of the warehouse's products, plus one no product uses yet; the director sees all.
  assert.deepEqual(await names(responsable), ["BGM", "Nouveau fournisseur", "Uline"]);
  assert.deepEqual(await names(director), ["BGM", "Mégaburo", "Nouveau fournisseur", "Uline"]);
  assert.deepEqual(await names(responsable, "/api/suppliers/shipping"), ["BGM", "Nouveau fournisseur", "Uline"]);

  assert.equal((await call(responsable, "PATCH", `/api/admin/suppliers/${megaburo}`, { name: "Mégaburo" })).status, 403);
  assert.equal((await call(responsable, "PATCH", `/api/admin/suppliers/${bgm}`, { name: "BGM", phone: "514-555-0101" })).status, 200);
  assert.equal((await call(responsable, "DELETE", `/api/admin/suppliers/${megaburo}`)).status, 403);
  // Uline also serves the stationery department: only the director deletes it.
  const shared = await call(responsable, "DELETE", `/api/admin/suppliers/${uline}`);
  assert.equal(shared.status, 403);
  assert.match(shared.body.error, /d’autres départements/);
  assert.equal((await call(responsable, "DELETE", `/api/admin/suppliers/${bgm}`)).status, 204);
  assert.equal((await call(responsable, "DELETE", `/api/admin/suppliers/${fresh}`)).status, 204);
  assert.deepEqual(await names(director), ["Mégaburo", "Uline"]);
});

test("a department responsable's purchase dashboard covers only their department's share", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const salesId = await database.createDepartment("Ventes");
  const uline = await database.createSupplier("Uline", "", "", "");
  const box = await database.createProduct("Boîte", "", 5000, warehouseId, uline, 1);
  const pen = await database.createProduct("Stylo", "", 300, salesId, uline, 1);
  const director = await makeAdminSession(baseUrl);
  const responsable = await makeManagerSession(app, baseUrl, warehouseId, "resp@example.ca", "responsable-password");
  const employee = await makeManagerSession(app, baseUrl, warehouseId, "emp@example.ca", "employee-password-1");
  await database.setDepartmentManager(warehouseId, (await database.getUserByEmail("resp@example.ca")).id);
  const call = async (session, method, url, body) => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
      body: body && JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  // One Uline purchase order with a warehouse request (10 000 ¢) and a sales request (1 500 ¢).
  const created = (await call(employee, "POST", "/api/orders", { items: [{ productId: box, quantity: 2 }] })).body;
  assert.equal((await call(responsable, "PATCH", `/api/orders/${created.orderId}/decision`, { status: "approved" })).status, 200);
  await call(director, "POST", "/api/orders", { departmentId: salesId, items: [{ productId: pen, quantity: 5 }] });

  const year = new Date().getFullYear();
  const mine = (await call(responsable, "GET", `/api/accounting/dashboard?year=${year}`)).body.dashboard;
  assert.equal(mine.requests.approvedCount, 1);
  assert.equal(mine.requests.approvedCents, 10000);
  assert.equal(mine.purchaseOrders.openCount, 1);
  assert.equal(mine.purchaseOrders.openCents, 10000);
  assert.deepEqual(mine.topProducts.map((product) => product.productName), ["Boîte"]);
  const company = (await call(director, "GET", `/api/accounting/dashboard?year=${year}`)).body.dashboard;
  assert.equal(company.purchaseOrders.openCents, 11500);

  // Once the director transmits it, their share counts as bought.
  const [purchaseOrder] = (await call(director, "GET", "/api/purchase-orders")).body.purchaseOrders;
  assert.equal((await call(director, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/sent`, { method: "website" })).status, 200);
  const bought = (await call(responsable, "GET", `/api/accounting/dashboard?year=${year}`)).body.dashboard;
  assert.equal(bought.purchaseOrders.purchasedCents, 10000);
  assert.equal(bought.months.reduce((total, month) => total + month.purchasedCents, 0), 10000);

  assert.equal((await call(employee, "GET", `/api/accounting/dashboard?year=${year}`)).status, 403);
});

test("purchase orders download as PDF; a responsable only receives their department's part, without transmitting", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const salesId = await database.createDepartment("Ventes");
  const uline = await database.createSupplier("Uline", "", "ventes@uline.example", "", "", "email", { accountNumber: "C-42" });
  const box = await database.createProduct("Boîte", "Code B-12", 1250, warehouseId, uline, 1);
  const pen = await database.createProduct("Stylo", "", 300, salesId, uline, 1);
  const director = await makeAdminSession(baseUrl);
  const responsable = await makeManagerSession(app, baseUrl, warehouseId, "resp@example.ca", "responsable-password");
  const employee = await makeManagerSession(app, baseUrl, warehouseId, "emp@example.ca", "employee-password-1");
  await database.setDepartmentManager(warehouseId, (await database.getUserByEmail("resp@example.ca")).id);
  const call = (session, method, url, body) => fetch(`${baseUrl}${url}`, {
    method,
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
    body: body && JSON.stringify(body)
  });
  // One Uline purchase order: 3 boxes for the warehouse, 5 pens for sales.
  await call(director, "POST", "/api/orders", { departmentId: warehouseId, items: [{ productId: box, quantity: 3 }] });
  await call(director, "POST", "/api/orders", { departmentId: salesId, items: [{ productId: pen, quantity: 5 }] });

  const [purchaseOrder] = (await (await call(director, "GET", "/api/purchase-orders")).json()).purchaseOrders;
  assert.equal(purchaseOrder.totalCents, 3 * 1250 + 5 * 300);
  const pdf = await call(director, "GET", `/api/purchase-orders/${purchaseOrder.id}/pdf?note=${encodeURIComponent("Livrer au quai 2")}`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-disposition"), new RegExp(`attachment; filename="bon-de-commande-${purchaseOrder.number}\\.pdf"`));
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  assert.equal((await call(director, "GET", "/api/purchase-orders/999/pdf")).status, 404);

  // The responsable's report receives only the warehouse's part of the purchase order.
  const [part] = (await (await call(responsable, "GET", "/api/purchase-orders")).json()).purchaseOrders;
  assert.deepEqual(part.lines.map((line) => [line.productName, line.quantity]), [["Boîte", 3]]);
  assert.deepEqual(part.orders.map((order) => order.departmentName), ["Entrepôt"]);
  assert.equal(part.totalCents, 3 * 1250);
  // No "Achats" tab: neither the document, the PDF nor the transmission.
  assert.equal((await call(responsable, "GET", `/api/purchase-orders/${purchaseOrder.id}/document`)).status, 403);
  assert.equal((await call(responsable, "GET", `/api/purchase-orders/${purchaseOrder.id}/pdf`)).status, 403);
  assert.equal((await call(responsable, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/sent`, { method: "representative" })).status, 403);

  // A plain employee sees none of it.
  assert.equal((await call(employee, "GET", "/api/purchase-orders")).status, 403);
  assert.equal((await call(employee, "GET", `/api/purchase-orders/${purchaseOrder.id}/pdf`)).status, 403);
  assert.equal((await call(employee, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/sent`, { method: "representative" })).status, 403);
});

test("everyone orders from the whole catalogue; the request stays in their department", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const papeterie = await database.createDepartment("Papeterie");
  const broderie = await database.createDepartment("Broderie");
  const pens = await database.createProduct("Stylos", "", 99, papeterie, null, 1);
  const employee = await makeManagerSession(app, baseUrl, broderie, "brodeur@example.ca", "employee-password-1");
  const products = (await (await fetch(`${baseUrl}/api/products`, { headers: { Cookie: employee.cookie } })).json()).products;
  assert.deepEqual(products.map((product) => [product.name, product.department_name, "price_cents" in product]), [["Stylos", "Papeterie", false]]);
  const created = await postJson(baseUrl, employee.cookie, employee.csrfToken, "/api/orders", { items: [{ productId: pens, quantity: 10 }] });
  assert.equal(created.status, 201);
  const [order] = (await (await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: employee.cookie } })).json()).orders;
  assert.equal(order.departmentName, "Broderie");
});

test("a department responsable sees and orders only their department's products", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const papeterie = await database.createDepartment("Papeterie");
  const broderie = await database.createDepartment("Broderie");
  const pens = await database.createProduct("Stylos", "", 99, papeterie, null, 1);
  const thread = await database.createProduct("Fil", "", 450, broderie, null, 1);
  const responsable = await makeManagerSession(app, baseUrl, broderie, "resp@example.ca", "responsable-password");
  const employee = await makeManagerSession(app, baseUrl, broderie, "brodeur@example.ca", "employee-password-1");
  await database.setDepartmentManager(broderie, (await database.getUserByEmail("resp@example.ca")).id);
  const names = async (session) => (await (await fetch(`${baseUrl}/api/products`, { headers: { Cookie: session.cookie } })).json())
    .products.map((product) => product.name).sort();

  assert.deepEqual(await names(responsable), ["Fil"]);
  const refused = await postJson(baseUrl, responsable.cookie, responsable.csrfToken, "/api/orders", { items: [{ productId: pens, quantity: 1 }] });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /Stylos/);
  assert.equal((await postJson(baseUrl, responsable.cookie, responsable.csrfToken, "/api/orders", { items: [{ productId: thread, quantity: 2 }] })).status, 201);
  // A plain employee still sees the whole catalogue; the director too.
  assert.deepEqual(await names(employee), ["Fil", "Stylos"]);
  assert.deepEqual(await names(await makeAdminSession(baseUrl)), ["Fil", "Stylos"]);

  // The responsable deletes the products of their department only; a plain employee none.
  const remove = (session, id) => fetch(`${baseUrl}/api/products/${id}`, {
    method: "DELETE",
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken }
  });
  assert.equal((await remove(employee, thread)).status, 403);
  assert.equal((await remove(responsable, pens)).status, 403);
  assert.equal((await remove(responsable, thread)).status, 204);
  assert.deepEqual(await names(responsable), []);
  assert.deepEqual(await names(employee), ["Stylos"]);
});

test("urgent requests, the accountant's purchases, and a responsable managing their team", async (t) => {
  const sentMessages = [];
  const { app, baseUrl } = await startApp(t, { sendInvitationEmail: async (message) => sentMessages.push(message) });
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const salesId = await database.createDepartment("Ventes");
  const productId = await database.createProduct("Boîte", "", 500, warehouseId, null, 1);
  const responsable = await makeManagerSession(app, baseUrl, warehouseId, "resp@example.ca", "responsable-password");
  const employee = await makeManagerSession(app, baseUrl, warehouseId, "emp@example.ca", "employee-password-1");
  await makeManagerSession(app, baseUrl, salesId, "sales@example.ca", "sales-password-123");
  const accountant = await makeManagerSession(app, baseUrl, salesId, "compta@example.ca", "accountant-password");
  const accountantId = (await database.getUserByEmail("compta@example.ca")).id;
  await database.updateStaffRole(accountantId, "accountant");
  await database.setDepartmentManager(warehouseId, (await database.getUserByEmail("resp@example.ca")).id);
  const send = (session, method, url, body) => fetch(`${baseUrl}${url}`, {
    method,
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" },
    body: body && JSON.stringify(body)
  });

  // Urgent request, approved by the responsable, then bought by the accountant.
  const created = await (await send(employee, "POST", "/api/orders", { urgent: true, items: [{ productId, quantity: 1 }] })).json();
  assert.equal((await send(responsable, "PATCH", `/api/orders/${created.orderId}/decision`, { status: "approved" })).status, 200);
  assert.equal((await send(employee, "GET", "/api/purchase-orders")).status, 403);
  const [purchaseOrder] = (await (await send(accountant, "GET", "/api/purchase-orders")).json()).purchaseOrders;
  assert.equal((await send(employee, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/purchased`)).status, 403);
  assert.equal((await send(accountant, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/purchased`)).status, 200);
  assert.equal((await send(accountant, "PATCH", `/api/purchase-orders/${purchaseOrder.id}/purchased`)).status, 409);
  const seen = (await (await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: accountant.cookie } })).json()).orders[0];
  assert.equal(seen.isUrgent, true);
  assert.ok(seen.purchasedAt);
  assert.equal(seen.purchasedByEmail, "compta@example.ca");

  // The responsable invites into their department only; employees cannot.
  assert.equal((await send(employee, "POST", "/api/team/invitations", { fullName: "X", email: "x@example.ca" })).status, 403);
  assert.equal((await send(responsable, "POST", "/api/team/invitations", {
    fullName: "Nouveau", email: "nouveau@example.ca", departmentId: salesId
  })).status, 403);
  assert.equal((await send(responsable, "POST", "/api/team/invitations", {
    fullName: "Nouveau", email: "nouveau@example.ca", functions: ["accounting"]
  })).status, 202);
  const invited = await database.getUserByEmail("nouveau@example.ca");
  assert.equal(invited.department_id, warehouseId);
  assert.deepEqual(await database.getUserFunctions(invited.id), []);
  assert.equal(sentMessages.length, 1);

  // The responsable removes employees of their department, nobody else.
  const salesUserId = (await database.getUserByEmail("sales@example.ca")).id;
  const responsableId = (await database.getUserByEmail("resp@example.ca")).id;
  const employeeId = (await database.getUserByEmail("emp@example.ca")).id;
  assert.equal((await send(responsable, "DELETE", `/api/team/${salesUserId}`)).status, 403);
  assert.equal((await send(responsable, "DELETE", `/api/team/${responsableId}`)).status, 403);
  assert.equal((await send(responsable, "DELETE", `/api/team/${accountantId}`)).status, 403);
  assert.equal((await send(employee, "DELETE", `/api/team/${employeeId}`)).status, 403);
  assert.equal((await send(responsable, "DELETE", `/api/team/${employeeId}`)).status, 204);
  assert.equal(await database.getUserByEmail("emp@example.ca"), undefined);

  // The director deletes any employee or accountant account.
  const director = await makeAdminSession(baseUrl);
  assert.equal((await send(director, "DELETE", `/api/admin/users/${accountantId}`)).status, 204);
  assert.equal(await database.getUserByEmail("compta@example.ca"), undefined);
  assert.equal((await send(director, "DELETE", `/api/admin/users/${salesUserId}`)).status, 204);
});

test("a plain employee never receives prices, their responsable does", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const productId = await database.createProduct("Boîte", "", 1999, warehouseId, null, 1);
  const employee = await makeManagerSession(app, baseUrl, warehouseId, "emp@example.ca", "employee-password-1");
  const responsable = await makeManagerSession(app, baseUrl, warehouseId, "resp@example.ca", "responsable-password");
  await database.setDepartmentManager(warehouseId, (await database.getUserByEmail("resp@example.ca")).id);
  assert.equal((await postJson(baseUrl, employee.cookie, employee.csrfToken, "/api/orders", {
    items: [{ productId, quantity: 2 }]
  })).status, 201);
  const get = async (session, url) => (await fetch(`${baseUrl}${url}`, { headers: { Cookie: session.cookie } })).json();

  const [employeeOrder] = (await get(employee, "/api/orders")).orders;
  assert.equal("totalCents" in employeeOrder, false);
  assert.equal("priceCents" in employeeOrder.items[0], false);
  assert.equal(employeeOrder.items[0].quantity, 2);
  const [employeeProduct] = (await get(employee, "/api/products")).products;
  assert.equal("price_cents" in employeeProduct, false);

  const [responsableOrder] = (await get(responsable, "/api/orders")).orders;
  assert.equal(responsableOrder.totalCents, 3998);
  const [responsableProduct] = (await get(responsable, "/api/products")).products;
  assert.equal(responsableProduct.price_cents, 1999);
});

test("each employee sees only their own requests, the responsable sees the whole department", async (t) => {
  const { app, baseUrl } = await startApp(t);
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const productId = await database.createProduct("Boîte", "", 500, warehouseId, null, 1);
  const first = await makeManagerSession(app, baseUrl, warehouseId, "emp1@example.ca", "employee-password-1");
  const second = await makeManagerSession(app, baseUrl, warehouseId, "emp2@example.ca", "employee-password-2");
  const responsable = await makeManagerSession(app, baseUrl, warehouseId, "resp@example.ca", "responsable-password");
  await database.setDepartmentManager(warehouseId, (await database.getUserByEmail("resp@example.ca")).id);
  const order = async (session) => (await (await postJson(baseUrl, session.cookie, session.csrfToken, "/api/orders", {
    items: [{ productId, quantity: 1 }]
  })).json()).orderId;
  const visible = async (session) => (await (await fetch(`${baseUrl}/api/orders`, { headers: { Cookie: session.cookie } })).json())
    .orders.map((item) => item.id).sort();

  const firstOrder = await order(first);
  const secondOrder = await order(second);
  assert.deepEqual(await visible(first), [firstOrder]);
  assert.deepEqual(await visible(second), [secondOrder]);
  assert.deepEqual(await visible(responsable), [firstOrder, secondOrder].sort());
  // Another employee's request cannot be decided either, of course.
  assert.equal((await patchJson(baseUrl, first.cookie, first.csrfToken, `/api/orders/${secondOrder}/decision`, {
    status: "approved"
  })).status, 403);
});

test("email delivery can use Azure Communication Services instead of SMTP", () => {
  assert.equal(createInvitationMailer({}).configured, false);
  assert.equal(createInvitationMailer({ ACS_EMAIL_ENDPOINT: "https://acs.example" }).configured, false);
  assert.equal(createInvitationMailer({
    ACS_EMAIL_FROM: "DoNotReply@example.azurecomm.net",
    ACS_EMAIL_ENDPOINT: "https://acs.example.communication.azure.com"
  }).configured, true);
  assert.equal(createInvitationMailer({
    ACS_EMAIL_FROM: "DoNotReply@example.azurecomm.net",
    ACS_EMAIL_CONNECTION_STRING: "endpoint=https://acs.example.communication.azure.com/;accesskey=dGVzdA=="
  }).configured, true);
});

function fakeMicrosoftAuth(claimsByCode) {
  return {
    tenantId: "tenant-123",
    generatePkceCodes: async () => ({ verifier: "test-verifier", challenge: "test-challenge" }),
    getAuthCodeUrl: async ({ state, loginHint }) =>
      `https://login.example/authorize?state=${state}${loginHint ? `&login_hint=${loginHint}` : ""}`,
    exchangeCode: async ({ code, codeVerifier }) => {
      assert.equal(codeVerifier, "test-verifier");
      if (!claimsByCode[code]) {
        throw Object.assign(new Error("invalid_grant"), { errorCode: "invalid_grant" });
      }
      return claimsByCode[code];
    }
  };
}

async function microsoftSignIn(baseUrl, code, stateOverride) {
  const start = await fetch(`${baseUrl}/api/auth/microsoft/login`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const cookie = sessionCookie(start);
  const state = stateOverride ?? new URL(start.headers.get("location")).searchParams.get("state");
  const callback = await fetch(
    `${baseUrl}/api/auth/microsoft/callback?code=${code}&state=${state}`,
    { headers: { Cookie: cookie }, redirect: "manual" }
  );
  return {
    location: callback.headers.get("location"),
    cookie: callback.headers.get("set-cookie") ? sessionCookie(callback) : cookie
  };
}

test("Microsoft sign-in is hidden when it is not configured", async (t) => {
  const { baseUrl } = await startApp(t);
  const providers = await fetch(`${baseUrl}/api/auth/providers`);
  assert.deepEqual(await providers.json(), { microsoft: false, microsoftDomains: [] });
  const start = await fetch(`${baseUrl}/api/auth/microsoft/login`, { redirect: "manual" });
  assert.equal(start.headers.get("location"), "/login.html?error=microsoft_unavailable");
});

test("Microsoft sign-in only admits invited accounts from the configured tenant", async (t) => {
  const { app, baseUrl } = await startApp(t, {
    microsoftAuth: fakeMicrosoftAuth({
      admin: { tid: "TENANT-123", preferred_username: ADMIN_EMAIL.toUpperCase() },
      stranger: { tid: "tenant-123", preferred_username: "stranger@example.ca" },
      otherTenant: { tid: "tenant-999", preferred_username: ADMIN_EMAIL },
      invited: { tid: "tenant-123", preferred_username: "invited@example.ca" }
    })
  });
  assert.deepEqual(
    await (await fetch(`${baseUrl}/api/auth/providers`)).json(),
    { microsoft: true, microsoftDomains: [] }
  );

  const admin = await microsoftSignIn(baseUrl, "admin");
  assert.equal(admin.location, "/");
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: admin.cookie } });
  assert.equal((await me.json()).user.email, ADMIN_EMAIL);

  assert.equal((await microsoftSignIn(baseUrl, "stranger")).location, "/login.html?error=microsoft_not_invited");
  assert.equal((await microsoftSignIn(baseUrl, "otherTenant")).location, "/login.html?error=microsoft_not_invited");
  assert.equal((await microsoftSignIn(baseUrl, "bad-code")).location, "/login.html?error=microsoft_failed");
  assert.equal((await microsoftSignIn(baseUrl, "admin", "forged")).location, "/login.html?error=microsoft_expired");

  const departmentId = await app.locals.database.createDepartment("Finance");
  const invitedId = await app.locals.database.createPendingManager(
    "invited@example.ca", await argon2.hash("unused-password"), departmentId, "Invitée Test"
  );
  await app.locals.database.createInvitation(invitedId, "a".repeat(64), Date.now() + 60000);
  const invited = await microsoftSignIn(baseUrl, "invited");
  assert.equal(invited.location, "/");
  assert.equal((await app.locals.database.getUserById(invitedId)).is_active, true);
});

test("Company email domains must sign in with Microsoft instead of a password", async (t) => {
  const { baseUrl } = await startApp(t, {
    env: { NODE_ENV: "test", AUTH_MICROSOFT_DOMAINS: " @Example.ca , other.example " },
    microsoftAuth: fakeMicrosoftAuth({})
  });
  assert.deepEqual(
    await (await fetch(`${baseUrl}/api/auth/providers`)).json(),
    { microsoft: true, microsoftDomains: ["example.ca", "other.example"] }
  );

  const csrf = await getCsrfToken(baseUrl);
  const response = await postJson(baseUrl, csrf.cookie, csrf.token, "/api/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).microsoft, true);

  const start = await fetch(
    `${baseUrl}/api/auth/microsoft/login?login_hint=${encodeURIComponent(ADMIN_EMAIL.toUpperCase())}`,
    { redirect: "manual" }
  );
  assert.equal(new URL(start.headers.get("location")).searchParams.get("login_hint"), ADMIN_EMAIL);
  const invalidHint = await fetch(`${baseUrl}/api/auth/microsoft/login?login_hint=nope`, { redirect: "manual" });
  assert.equal(new URL(invalidHint.headers.get("location")).searchParams.get("login_hint"), null);
});

test("a company Microsoft account signs in without an invitation and picks its department", async (t) => {
  const { app, baseUrl } = await startApp(t, {
    env: { NODE_ENV: "test", AUTH_MICROSOFT_DOMAINS: "promographe.example" },
    microsoftAuth: fakeMicrosoftAuth({
      newcomer: { tid: "tenant-123", preferred_username: "Julie@Promographe.example", name: "Julie Gagnon" },
      outsider: { tid: "tenant-123", preferred_username: "guest@gmail.example", name: "Invité" },
      otherTenant: { tid: "tenant-999", preferred_username: "x@promographe.example" }
    })
  });
  const database = app.locals.database;
  const broderieId = await database.createDepartment("Broderie");

  // Other domains and other directories still need an invitation.
  assert.equal((await microsoftSignIn(baseUrl, "outsider")).location, "/login.html?error=microsoft_not_invited");
  assert.equal((await microsoftSignIn(baseUrl, "otherTenant")).location, "/login.html?error=microsoft_not_invited");

  const first = await microsoftSignIn(baseUrl, "newcomer");
  assert.equal(first.location, "/welcome.html");
  const onboarding = await (await fetch(`${baseUrl}/api/auth/onboarding`, { headers: { Cookie: first.cookie } })).json();
  assert.equal(onboarding.email, "julie@promographe.example");
  assert.deepEqual(onboarding.departments, [{ id: broderieId, name: "Broderie" }]);
  assert.equal((await fetch(`${baseUrl}/api/auth/onboarding`)).status, 401);

  const csrf = await getCsrfToken(baseUrl, first.cookie);
  assert.equal((await postJson(baseUrl, csrf.cookie, csrf.token, "/api/auth/onboarding", { departmentId: 999 })).status, 400);
  const created = await postJson(baseUrl, csrf.cookie, csrf.token, "/api/auth/onboarding", { departmentId: broderieId });
  assert.equal(created.status, 201);
  const sessionCookieAfter = sessionCookie(created);
  const me = (await (await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: sessionCookieAfter } })).json()).user;
  assert.deepEqual(
    { email: me.email, fullName: me.fullName, role: me.role, departmentName: me.departmentName },
    { email: "julie@promographe.example", fullName: "Julie Gagnon", role: "employee", departmentName: "Broderie" }
  );

  // Next visits sign in directly. A deleted account leaves no trace in the database, so the
  // same company account starts over as a brand-new employee (block it in Microsoft 365).
  assert.equal((await microsoftSignIn(baseUrl, "newcomer")).location, "/");
  await database.deleteEmployee(me.id);
  assert.equal(await database.getUserByEmail("julie@promographe.example"), undefined);
  assert.equal((await microsoftSignIn(baseUrl, "newcomer")).location, "/welcome.html");
});

test("a newcomer who says they lead a department waits for an administrator's approval", async (t) => {
  const { app, baseUrl } = await startApp(t, {
    env: { NODE_ENV: "test", AUTH_MICROSOFT_DOMAINS: "promographe.example" },
    microsoftAuth: fakeMicrosoftAuth({
      boss: { tid: "tenant-123", preferred_username: "chef@promographe.example", name: "Chef Entrepôt" },
      other: { tid: "tenant-123", preferred_username: "autre@promographe.example", name: "Autre" }
    })
  });
  const database = app.locals.database;
  const warehouseId = await database.createDepartment("Entrepôt");
  const onboard = async (code, requestManager) => {
    const signIn = await microsoftSignIn(baseUrl, code);
    const csrf = await getCsrfToken(baseUrl, signIn.cookie);
    const response = await postJson(baseUrl, csrf.cookie, csrf.token, "/api/auth/onboarding", {
      departmentId: warehouseId, requestManager
    });
    assert.equal(response.status, 201);
    return sessionCookie(response);
  };
  const me = async (cookie) => (await (await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } })).json()).user;

  const bossCookie = await onboard("boss", true);
  const otherCookie = await onboard("other", true);
  // The request alone grants nothing.
  let boss = await me(bossCookie);
  assert.deepEqual(boss.managedDepartments, []);
  assert.deepEqual(boss.managerRequest, { id: warehouseId, name: "Entrepôt" });
  assert.equal((await fetch(`${baseUrl}/api/staff`, { headers: { Cookie: bossCookie } })).status, 403);

  const admin = await makeAdminSession(baseUrl);
  const decide = (email, decision) => database.getUserByEmail(email).then((user) => postJson(
    baseUrl, admin.cookie, admin.csrfToken, `/api/admin/manager-requests/${user.id}`, { decision }
  ));
  assert.equal((await decide("chef@promographe.example", "accept")).status, 200);
  assert.equal((await decide("autre@promographe.example", "reject")).status, 200);
  assert.equal((await decide("autre@promographe.example", "accept")).status, 404);

  boss = await me(bossCookie);
  assert.deepEqual(boss.managedDepartments.map((department) => department.name), ["Entrepôt"]);
  assert.equal(boss.managerRequest, null);
  assert.equal((await fetch(`${baseUrl}/api/staff`, { headers: { Cookie: bossCookie } })).status, 200);
  const other = await me(otherCookie);
  assert.deepEqual(other.managedDepartments, []);
  assert.equal(other.managerRequest, null);
});

test("Microsoft domains are ignored when Microsoft sign-in is not configured", async (t) => {
  const { baseUrl } = await startApp(t, { env: { NODE_ENV: "test", AUTH_MICROSOFT_DOMAINS: "example.ca" } });
  const csrf = await getCsrfToken(baseUrl);
  const response = await postJson(baseUrl, csrf.cookie, csrf.token, "/api/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD
  });
  assert.equal(response.status, 200);
});

const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const argon2 = require("argon2");
const session = require("express-session");
const { createApp } = require("../server");
const { createSqlConfig } = require("../src/database");
const { MemoryDatabase } = require("./support/memory-database");

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
  assert.equal((await managerLogin.response.json()).user.role, "department_manager");

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

  const productResponse = await postJson(
    baseUrl,
    financeManager.cookie,
    financeManager.csrfToken,
    "/api/products",
    { name: "Papier", description: "Papier blanc format lettre", priceCents: 1250 }
  );
  assert.equal(productResponse.status, 201);
  const productId = (await productResponse.json()).product.id;

  const missingDepartmentProduct = await postJson(
    baseUrl,
    admin.cookie,
    admin.csrfToken,
    "/api/products",
    { name: "Crayons", description: "", priceCents: 300 }
  );
  assert.equal(missingDepartmentProduct.status, 400);

  const secondProductResponse = await postJson(
    baseUrl,
    admin.cookie,
    admin.csrfToken,
    "/api/products",
    { name: "Crayons", description: "", priceCents: 300, departmentId: financeId }
  );
  assert.equal(secondProductResponse.status, 201);
  const secondProductId = (await secondProductResponse.json()).product.id;

  const operationsProductResponse = await postJson(
    baseUrl,
    admin.cookie,
    admin.csrfToken,
    "/api/products",
    { name: "Gants", description: "", priceCents: 800, departmentId: operationsId }
  );
  assert.equal(operationsProductResponse.status, 201);
  const operationsProductId = (await operationsProductResponse.json()).product.id;

  const operationsCatalogue = await fetch(`${baseUrl}/api/products`, {
    headers: { Cookie: operationsManager.cookie }
  });
  const operationsProducts = (await operationsCatalogue.json()).products;
  assert.deepEqual(operationsProducts.map((product) => product.name), ["Gants"]);
  assert.equal(operationsProducts[0].department_name, "Operations");

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
  assert.equal(foreignProductEdit.status, 404);

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
  assert.equal(adminCreateOrder.status, 403);

  const otherDepartmentOrder = await postJson(
    baseUrl,
    operationsManager.cookie,
    operationsManager.csrfToken,
    "/api/orders",
    { items: [{ productId, quantity: 1 }] }
  );
  assert.equal(otherDepartmentOrder.status, 409);

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
  assert.equal(financeOrders[0].totalCents, 3400);
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
    `/api/admin/orders/${orderId}`,
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
    `/api/admin/orders/${orderId}`,
    { status: "approved", decisionNote: "Approuvée pour ce trimestre." }
  );
  assert.equal(approvalResponse.status, 200);

  const savedOrderResponse = await fetch(`${baseUrl}/api/orders`, {
    headers: { Cookie: financeManager.cookie }
  });
  const savedOrder = (await savedOrderResponse.json()).orders[0];
  assert.equal(savedOrder.status, "approved");
  assert.equal(savedOrder.totalCents, 3400);
  assert.equal(savedOrder.decisionNote, "Approuvée pour ce trimestre.");

  const duplicateDecisionCsrf = await getCsrfToken(baseUrl, admin.cookie);
  const duplicateDecision = await patchJson(
    baseUrl,
    duplicateDecisionCsrf.cookie,
    duplicateDecisionCsrf.token,
    `/api/admin/orders/${orderId}`,
    { status: "rejected" }
  );
  assert.equal(duplicateDecision.status, 409);

  const updateProductCsrf = await getCsrfToken(baseUrl, financeManager.cookie);
  const updateProduct = await patchJson(
    baseUrl,
    updateProductCsrf.cookie,
    updateProductCsrf.token,
    `/api/products/${productId}`,
    { name: "Papier recyclé", description: "", priceCents: 1500, isActive: false }
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
  assert.equal(managerEdit.status, 200);

  const catalogue = await fetch(`${baseUrl}/api/products`, { headers: { Cookie: manager.cookie } });
  const [product] = (await catalogue.json()).products;
  assert.equal(product.name, "Papier recyclé");
  assert.equal(product.supplier_name, "Bureau Plus");
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
    baseUrl, admin.cookie, admin.csrfToken, `/api/admin/orders/${approvedOrderId}`, { status: "approved" }
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
  assert.deepEqual(dashboard.suppliers, [{ name: "Bureau Plus", approvedCents: 10000 }]);
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
  assert.equal((await cleared.json()).product.supplier_id, null);

  const suppliers = await fetch(`${baseUrl}/api/admin/suppliers`, { headers: { Cookie: admin.cookie } });
  assert.deepEqual(
    (await suppliers.json()).suppliers.map((supplier) => supplier.name).sort(),
    ["Bureau Plus", "Encres Québec"]
  );
});

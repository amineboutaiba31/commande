const crypto = require("crypto");
const path = require("path");
const express = require("express");
const session = require("express-session");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const argon2 = require("argon2");
require("dotenv").config();
const { AzureDatabase } = require("./src/database");
const { buildAccountingDashboard, purchaseOrderShares } = require("./src/accounting");
const { purchaseOrderDocument, purchaseOrderPdf } = require("./src/purchase-order-document");
const { UNITS } = require("./src/units");
const { AzureSessionStore } = require("./src/azure-session-store");
const { createInvitationMailer } = require("./src/invitation-mailer");
const { createMicrosoftAuth } = require("./src/microsoft-auth");

const INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
// Purchasing procedure: a responsable's own request above $2,500 goes to the director
// (general management); their employees' requests stay with them whatever the amount.
const DIRECTOR_APPROVAL_THRESHOLD_CENTS = 250000;
const PASSWORD_RESET_LIFETIME_MS = 60 * 60 * 1000;
const PASSWORD_RESET_MESSAGE =
  "Si un compte actif correspond à cette adresse, un courriel de réinitialisation vient d’être envoyé.";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getSessionSecret(env) {
  if (env.SESSION_SECRET) {
    if (env.SESSION_SECRET.length < 32) {
      throw new Error("SESSION_SECRET must contain at least 32 characters.");
    }
    return env.SESSION_SECRET;
  }
  if (env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be configured in production.");
  }
  return crypto.randomBytes(48).toString("hex");
}

function safeTokenEqual(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") {
    return false;
  }
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name || "",
    role: user.role,
    departmentId: user.department_id
  };
}

function isUniqueConstraint(error) {
  return error.number === 2601 || error.number === 2627;
}

function validateProduct(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  // The supplier's product code, shown on requests and purchase orders.
  const sku = typeof body.sku === "string" ? body.sku.trim() : "";
  const priceCents = body.priceCents;
  if (!name || name.length > 150) {
    return { error: "Le nom du produit doit contenir de 1 à 150 caractères." };
  }
  if (typeof body.description !== "undefined" && typeof body.description !== "string") {
    return { error: "La description du produit est invalide." };
  }
  if (description.length > 500) {
    return { error: "La description ne peut pas dépasser 500 caractères." };
  }
  if ((typeof body.sku !== "undefined" && typeof body.sku !== "string") || sku.length > 50) {
    return { error: "Le SKU ne peut pas dépasser 50 caractères." };
  }
  if (!Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > 2147483647) {
    return { error: "Saisis un prix valide en dollars canadiens." };
  }
  const unit = body.unit === undefined || body.unit === "" ? "unité" : body.unit;
  if (!Object.hasOwn(UNITS, unit)) {
    return { error: "Choisis une unité de mesure de la liste." };
  }
  return { name, description, sku, priceCents, unit };
}

// Purchasing procedure functions an employee can hold (several per person).
const FUNCTION_CODES = [
  "transmitter_admin", "transmitter_production", "transmitter_sales",
  "transmitter_backup", "reception", "accounting", "general_management"
];

// Returns the de-duplicated list of function codes, or null if one is unknown.
function parseFunctions(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((code) => !FUNCTION_CODES.includes(code))) {
    return null;
  }
  return [...new Set(value)];
}

// Azure App Service forwards the client address with its port ("1.2.3.4:56238"); the port
// changes on every connection, so it must be removed or each attempt counts as a new client.
function clientIpKey(req) {
  const address = String(req.ip || "");
  const ipv4WithPort = address.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  const ipv6WithPort = address.match(/^\[([^\]]+)\]:\d+$/);
  return ipKeyGenerator(ipv4WithPort?.[1] || ipv6WithPort?.[1] || address);
}

function isDatabaseWakingUp(error) {
  return error?.name === "TimeoutError" || ["ETIMEOUT", "ESOCKET", "ELOGIN"].includes(error?.code);
}

// How a supplier receives purchase orders (no text message, phone or other way: company
// decision, 2026-10-21; older purchase orders keep the way they were sent).
const ORDER_METHODS = ["email", "website", "representative"];
const CURRENCIES = ["CAD", "USD", "EUR"];

function validateSupplier(body = {}) {
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const supplier = {
    name: text(body.name),
    contactName: text(body.contactName),
    email: text(body.email).toLowerCase(),
    phone: text(body.phone),
    website: text(body.website),
    orderMethod: text(body.orderMethod),
    phoneExtension: text(body.phoneExtension),
    note: text(body.note),
    reducedThresholdCents: body.reducedThresholdCents ?? null,
    freeThresholdCents: body.freeThresholdCents ?? null,
    accountNumber: text(body.accountNumber),
    currency: text(body.currency).toUpperCase() || "CAD",
    paymentTerms: text(body.paymentTerms),
    isAuthorized: body.isAuthorized !== false,
    category: text(body.category)
  };
  if (supplier.accountNumber.length > 50) {
    return { error: "Le numéro de compte client ne peut pas dépasser 50 caractères." };
  }
  if (!CURRENCIES.includes(supplier.currency)) {
    return { error: "Choisis une devise valide (CAD, USD ou EUR)." };
  }
  if (supplier.paymentTerms.length > 50) {
    return { error: "Les conditions de paiement ne peuvent pas dépasser 50 caractères." };
  }
  if (supplier.category.length > 100) {
    return { error: "La catégorie ne peut pas dépasser 100 caractères." };
  }
  if (supplier.phoneExtension.length > 20) {
    return { error: "Le poste ne peut pas dépasser 20 caractères." };
  }
  if (supplier.note.length > 1000) {
    return { error: "La note ne peut pas dépasser 1 000 caractères." };
  }
  for (const key of ["reducedThresholdCents", "freeThresholdCents"]) {
    const value = supplier[key];
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 2147483647)) {
      return { error: "Saisis des seuils de livraison valides en dollars." };
    }
  }
  if (supplier.reducedThresholdCents !== null && supplier.freeThresholdCents !== null &&
      supplier.reducedThresholdCents > supplier.freeThresholdCents) {
    return { error: "Le seuil de livraison réduite doit être plus bas que le seuil de livraison gratuite." };
  }
  if (supplier.website) {
    // "uline.ca" becomes "https://uline.ca"; other schemes (ftp:, javascript:…) are refused.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(supplier.website)) {
      supplier.website = `https://${supplier.website}`;
    }
    let url;
    try {
      url = new URL(supplier.website);
    } catch {
      url = null;
    }
    if (!url || !["http:", "https:"].includes(url.protocol) || supplier.website.length > 300) {
      return { error: "Saisis une adresse de site web valide pour le fournisseur." };
    }
  }
  if (supplier.orderMethod && !ORDER_METHODS.includes(supplier.orderMethod)) {
    return { error: "Choisis un mode de commande valide." };
  }
  if (!supplier.name || supplier.name.length > 150) {
    return { error: "Le nom du fournisseur doit contenir de 1 à 150 caractères." };
  }
  if (supplier.contactName.length > 150) {
    return { error: "Le nom du contact ne peut pas dépasser 150 caractères." };
  }
  if (supplier.email && (supplier.email.length > 254 || !EMAIL_PATTERN.test(supplier.email))) {
    return { error: "Saisis une adresse courriel valide pour le fournisseur." };
  }
  if (supplier.phone.length > 50) {
    return { error: "Le téléphone ne peut pas dépasser 50 caractères." };
  }
  return supplier;
}

async function createApp(options = {}) {
  const env = options.env || process.env;
  const sessionSecret = options.sessionSecret || getSessionSecret(env);
  const invitationMailer = createInvitationMailer(env);
  const database = options.database || await AzureDatabase.connect(env);
  const sessionStore = options.sessionStore || new AzureSessionStore(database);
  const sendInvitationEmail = options.sendInvitationEmail ||
    ((message) => invitationMailer.send(message));
  const sendPurchaseOrderEmail = options.sendPurchaseOrderEmail ||
    ((message) => invitationMailer.sendPurchaseOrder(message));
  const sendPasswordResetEmail = options.sendPasswordResetEmail ||
    ((message) => invitationMailer.sendPasswordReset(message));
  const microsoftAuth = options.microsoftAuth !== undefined
    ? options.microsoftAuth
    : createMicrosoftAuth(env);
  // Email domains that must sign in with Microsoft instead of a Promographe password.
  const microsoftDomains = microsoftAuth
    ? String(env.AUTH_MICROSOFT_DOMAINS || "").split(",")
      .map((domain) => domain.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)
    : [];
  const requiresMicrosoft = (email) => microsoftDomains.includes(email.split("@").pop());

  let dummyPasswordHash;
  try {
    dummyPasswordHash = await argon2.hash(crypto.randomBytes(32), { type: argon2.argon2id });
  } catch (error) {
    sessionStore.close?.();
    if (!options.database) {
      await database.close();
    }
    throw error;
  }

  const app = express();
  app.disable("x-powered-by");
  // Browser protections: no inline or third-party scripts, no framing (clickjacking), HTTPS only.
  app.use((req, res, next) => {
    res.set({
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'"
      ].join("; "),
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()"
    });
    if (env.NODE_ENV === "production") {
      res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });
  if (env.NODE_ENV === "production") {
    // Azure App Service terminates HTTPS at its front end; trust it so secure cookies are issued.
    app.set("trust proxy", 1);
  }
  app.use(express.json({ limit: "10kb" }));
  app.use(express.urlencoded({ extended: false, limit: "10kb" }));
  app.use(session({
    name: "promographe.sid",
    secret: sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    // No expiry date: the browser drops the cookie when it closes. The session store still ends
    // the session after 8 hours without activity.
    cookie: {
      httpOnly: true,
      // Lax so the session survives the redirect back from Microsoft sign-in; CSRF tokens guard writes.
      sameSite: "lax",
      secure: env.NODE_ENV === "production"
    }
  }));
  app.use("/api/auth", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  const loginRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIpKey,
    handler: (req, res) => {
      res.status(429).json({ error: "Trop de tentatives. Réessaie dans 15 minutes." });
    }
  });
  // Also limits guesses on one account spread across many IP addresses.
  const loginAccountRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `account:${String(req.body?.email || "").trim().toLowerCase().slice(0, 254)}`,
    handler: (req, res) => {
      res.status(429).json({ error: "Trop de tentatives sur ce compte. Réessaie dans 15 minutes." });
    }
  });
  const invitationAttemptLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIpKey,
    handler: (req, res) => {
      res.status(429).json({ error: "Trop de tentatives. Réessaie plus tard." });
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({ application: "Promographe", status: "running" });
  });

  app.get("/api/auth/csrf", (req, res, next) => {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    req.session.save((error) => {
      if (error) {
        return next(error);
      }
      res.json({ csrfToken: req.session.csrfToken });
    });
  });

  app.post("/api/auth/login", loginRateLimit, loginAccountRateLimit, async (req, res, next) => {
    try {
      if (!safeTokenEqual(req.session.csrfToken, req.get("x-csrf-token"))) {
        return res.status(403).json({ error: "Session expirée. Recharge la page et réessaie." });
      }

      const body = req.body || {};
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!email || !password) {
        return res.status(400).json({ error: "Adresse courriel et mot de passe requis." });
      }
      if (email.length > 254 || password.length > 256) {
        return res.status(400).json({ error: "Adresse courriel invalide ou mot de passe trop long." });
      }
      if (requiresMicrosoft(email)) {
        return res.status(403).json({ error: "Cette adresse doit se connecter avec Microsoft.", microsoft: true });
      }

      const user = await database.getUserByEmail(email);
      const passwordMatches = await argon2.verify(
        user ? user.password_hash : dummyPasswordHash,
        password
      );
      if (!user || !user.is_active || !passwordMatches) {
        return res.status(401).json({ error: "Adresse courriel ou mot de passe invalide." });
      }

      startSession(req, user, next, () => {
        res.json({ user: publicUser(user), csrfToken: req.session.csrfToken });
      });
    } catch (error) {
      next(error);
    }
  });

  function startSession(req, user, next, done) {
    req.session.regenerate((error) => {
      if (error) {
        return next(error);
      }
      req.session.userId = user.id;
      req.session.sessionVersion = Number(user.session_version || 0);
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
      req.session.save((saveError) => (saveError ? next(saveError) : done()));
    });
  }

  app.get("/api/auth/providers", (req, res) => {
    res.json({ microsoft: Boolean(microsoftAuth), microsoftDomains });
  });

  app.get("/api/auth/microsoft/login", async (req, res, next) => {
    if (!microsoftAuth) {
      return res.redirect("/login.html?error=microsoft_unavailable");
    }
    try {
      const { verifier, challenge } = await microsoftAuth.generatePkceCodes();
      const state = crypto.randomBytes(32).toString("hex");
      req.session.microsoftSignIn = { state, verifier, startedAt: Date.now() };
      const loginHint = typeof req.query.login_hint === "string" ? req.query.login_hint.trim().toLowerCase() : "";
      const authorizationUrl = await microsoftAuth.getAuthCodeUrl({
        state,
        codeChallenge: challenge,
        loginHint: loginHint.length <= 254 && EMAIL_PATTERN.test(loginHint) ? loginHint : undefined
      });
      req.session.save((error) => (error ? next(error) : res.redirect(authorizationUrl)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/auth/microsoft/callback", loginRateLimit, async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const pending = req.session.microsoftSignIn;
    delete req.session.microsoftSignIn;
    const fail = (reason) => res.redirect(`/login.html?error=${reason}`);
    const { state, code, error } = req.query;
    if (!microsoftAuth || !pending || Date.now() - pending.startedAt > 10 * 60 * 1000 ||
        !safeTokenEqual(pending.state, typeof state === "string" ? state : "")) {
      return fail("microsoft_expired");
    }
    if (error || typeof code !== "string" || !code) {
      return fail("microsoft_cancelled");
    }

    let claims;
    try {
      claims = await microsoftAuth.exchangeCode({ code, codeVerifier: pending.verifier });
    } catch (exchangeError) {
      console.error("Promographe Microsoft sign-in failed:", exchangeError.errorCode || exchangeError.name);
      return fail("microsoft_failed");
    }

    try {
      // Only accounts from the configured tenant: invited users, or company accounts
      // (configured email domains) that sign in for the first time.
      const email = String(claims.preferred_username || claims.email || claims.upn || "")
        .trim().toLowerCase();
      const sameTenant = String(claims.tid || "").toLowerCase() === microsoftAuth.tenantId.toLowerCase();
      let user = sameTenant && EMAIL_PATTERN.test(email) ? await database.getUserByEmail(email) : null;
      if (!user && sameTenant && EMAIL_PATTERN.test(email) && requiresMicrosoft(email)) {
        // First visit: the employee picks their department before the account is created.
        req.session.microsoftOnboarding = {
          email,
          fullName: String(claims.name || "").trim().slice(0, 150),
          startedAt: Date.now()
        };
        return req.session.save((error) => (error ? next(error) : res.redirect("/welcome.html")));
      }
      if (user && !user.is_active) {
        user = await database.activateInvitedUser(user.id, Date.now())
          ? await database.getUserById(user.id)
          : null;
      }
      if (!user || !user.is_active) {
        return fail("microsoft_not_invited");
      }
      startSession(req, user, next, () => res.redirect("/"));
    } catch (signInError) {
      next(signInError);
    }
  });

  // A company account seen for the first time, waiting for its department (15 minutes).
  function pendingOnboarding(req) {
    const pending = req.session.microsoftOnboarding;
    return pending && Date.now() - pending.startedAt < 15 * 60 * 1000 ? pending : null;
  }

  app.get("/api/auth/onboarding", async (req, res, next) => {
    const pending = pendingOnboarding(req);
    if (!pending) {
      return res.status(401).json({ error: "Reconnecte-toi avec Microsoft pour continuer." });
    }
    try {
      const departments = await database.listDepartments();
      res.json({
        email: pending.email,
        fullName: pending.fullName,
        departments: departments.map((department) => ({ id: Number(department.id), name: department.name }))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/onboarding", requireCsrf, async (req, res, next) => {
    const pending = pendingOnboarding(req);
    if (!pending) {
      return res.status(401).json({ error: "Reconnecte-toi avec Microsoft pour continuer." });
    }
    const departmentId = Number(req.body?.departmentId);
    const requestManager = req.body?.requestManager === true;
    try {
      if (!Number.isSafeInteger(departmentId) || !await database.getDepartment(departmentId)) {
        return res.status(400).json({ error: "Choisis ton département." });
      }
      let userId;
      try {
        userId = await database.createMicrosoftEmployee(
          pending.email,
          await argon2.hash(crypto.randomBytes(32), { type: argon2.argon2id }),
          departmentId,
          pending.fullName
        );
      } catch (error) {
        if (isUniqueConstraint(error)) {
          delete req.session.microsoftOnboarding;
          return res.status(409).json({ error: "Ce compte existe déjà. Reconnecte-toi avec Microsoft." });
        }
        throw error;
      }
      if (requestManager) {
        // Only a request: an administrator must accept it before any approval right is granted.
        await database.setManagerRequest(userId, departmentId);
      }
      delete req.session.microsoftOnboarding;
      startSession(req, await database.getUserById(userId), next, () => res.status(201).json({ ok: true }));
    } catch (error) {
      next(error);
    }
  });

  async function resolveAuthenticatedUser(req, res, next, pageRequest) {
    if (!req.session.userId) {
      return pageRequest
        ? res.redirect("/login.html")
        : res.status(401).json({ error: "Authentification requise." });
    }
    try {
      const user = await database.getUserById(req.session.userId);
      const sessionIsCurrent = user &&
        Number(req.session.sessionVersion || 0) === Number(user.session_version || 0);
      if (!user || !user.is_active || !sessionIsCurrent) {
        return req.session.destroy((error) => {
          if (error) {
            return next(error);
          }
          res.clearCookie("promographe.sid", { httpOnly: true, sameSite: "lax" });
          if (pageRequest) {
            res.redirect("/login.html");
          } else {
            res.status(401).json({ error: "Authentification requise." });
          }
        });
      }
      // The developer account only manages the company's administrators: no orders,
      // catalogue or employee data.
      if (user.role === "developer" && !pageRequest &&
          !req.path.startsWith("/api/auth/") && !req.path.startsWith("/api/developer/")) {
        return res.status(403).json({ error: "Accès refusé." });
      }
      req.authenticatedUser = user;
      next();
    } catch (error) {
      next(error);
    }
  }

  function requireAuthenticated(req, res, next) {
    return resolveAuthenticatedUser(req, res, next, false);
  }

  function requirePageAuthentication(req, res, next) {
    return resolveAuthenticatedUser(req, res, next, true);
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      if (!roles.includes(req.authenticatedUser.role)) {
        return res.status(403).json({ error: "Accès refusé." });
      }
      next();
    };
  }

  async function isStaffMember(userId) {
    const user = (await database.listUsers()).find((candidate) => Number(candidate.id) === userId);
    return Boolean(user && ["employee", "admin", "accountant", "purchaser"].includes(user.role) && user.is_active);
  }

  function requireCsrf(req, res, next) {
    if (!safeTokenEqual(req.session.csrfToken, req.get("x-csrf-token"))) {
      return res.status(403).json({ error: "Session expirée. Recharge la page et réessaie." });
    }
    next();
  }

  app.get("/api/auth/me", requireAuthenticated, async (req, res, next) => {
    try {
      const user = req.authenticatedUser;
      const [department, functions, managedDepartments, managerRequest] = await Promise.all([
        user.department_id ? database.getDepartment(user.department_id) : null,
        database.getUserFunctions(user.id),
        database.getManagedDepartments(user.id),
        database.getManagerRequest(user.id)
      ]);
      res.json({
        user: {
          ...publicUser(user),
          departmentName: department ? department.name : "",
          functions,
          managedDepartments,
          managerRequest,
          directorApprovalThresholdCents: DIRECTOR_APPROVAL_THRESHOLD_CENTS
        }
      });
    } catch (error) {
      next(error);
    }
  });

  // Department names, so each staff member can correct their own department.
  app.get("/api/departments", requireAuthenticated, requireRole("admin", "employee", "accountant", "purchaser"), async (req, res, next) => {
    try {
      const departments = await database.listDepartments();
      res.json({ departments: departments.map((department) => ({ id: Number(department.id), name: department.name })) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/auth/profile", requireAuthenticated, requireCsrf, async (req, res, next) => {
    const user = req.authenticatedUser;
    const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
    if (!fullName || fullName.length > 150) {
      return res.status(400).json({ error: "Le nom complet doit contenir de 1 à 150 caractères." });
    }
    try {
      // Staff correct their own department themselves: it changes no rights, only which
      // catalogue they see and which responsable decides their next requests.
      if (req.body?.departmentId !== undefined && user.role !== "developer") {
        const departmentId = Number(req.body.departmentId);
        if (!Number.isSafeInteger(departmentId) || !await database.getDepartment(departmentId)) {
          return res.status(400).json({ error: "Choisis un département valide." });
        }
        await database.updateUserDetails(user.id, fullName, departmentId);
        return res.json({ fullName, departmentId });
      }
      await database.updateUserFullName(user.id, fullName);
      res.json({ fullName });
    } catch (error) {
      next(error);
    }
  });

  function validNewPassword(password) {
    return typeof password === "string" && password.length >= 12 && password.length <= 256;
  }

  app.post(
    "/api/auth/change-password",
    loginRateLimit,
    requireAuthenticated,
    requireCsrf,
    async (req, res, next) => {
      const body = req.body || {};
      const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
      const newPassword = body.newPassword;
      if (!validNewPassword(newPassword)) {
        return res.status(400).json({ error: "Le nouveau mot de passe doit contenir de 12 à 256 caractères." });
      }
      try {
        const user = req.authenticatedUser;
        if (currentPassword.length > 256 || !await argon2.verify(user.password_hash, currentPassword)) {
          return res.status(400).json({ error: "Le mot de passe actuel est incorrect." });
        }
        if (await argon2.verify(user.password_hash, newPassword)) {
          return res.status(400).json({ error: "Choisis un mot de passe différent de l’actuel." });
        }
        const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
        const sessionVersion = await database.updatePassword(user.id, passwordHash);
        if (sessionVersion === null) {
          return res.status(401).json({ error: "Authentification requise." });
        }
        // Keep this session signed in; every other session of the account is now stale.
        req.session.sessionVersion = sessionVersion;
        req.session.save((error) => {
          if (error) {
            return next(error);
          }
          res.status(204).end();
        });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post("/api/auth/password-reset/request", invitationAttemptLimit, requireCsrf, async (req, res, next) => {
    const body = req.body || {};
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: "Saisis une adresse courriel valide." });
    }
    if (!invitationMailer.configured && !options.sendPasswordResetEmail) {
      return res.status(503).json({
        error: "L’envoi de courriel n’est pas configuré. Contacte ton administrateur."
      });
    }
    try {
      // Same answer whether or not the account exists, so emails cannot be probed.
      const user = await database.getUserByEmail(email);
      if (user && user.is_active) {
        const token = crypto.randomBytes(48).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const now = Date.now();
        await database.createPasswordReset(user.id, tokenHash, now + PASSWORD_RESET_LIFETIME_MS, now);
        try {
          await sendPasswordResetEmail({ email: user.email, token });
        } catch (error) {
          console.error("Promographe password reset email delivery failed:", error.code || error.name);
        }
      }
      res.status(202).json({ message: PASSWORD_RESET_MESSAGE });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/password-reset/validate", invitationAttemptLimit, async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const token = typeof (req.body || {}).token === "string" ? req.body.token : "";
    if (!/^[a-f0-9]{96}$/.test(token)) {
      return res.status(400).json({ error: "Ce lien de réinitialisation est invalide ou expiré." });
    }
    try {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const reset = await database.getPasswordReset(tokenHash, Date.now());
      if (!reset) {
        return res.status(400).json({ error: "Ce lien de réinitialisation est invalide ou expiré." });
      }
      res.json({ email: reset.email });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/password-reset/complete", invitationAttemptLimit, requireCsrf, async (req, res, next) => {
    const body = req.body || {};
    const token = typeof body.token === "string" ? body.token : "";
    if (!/^[a-f0-9]{96}$/.test(token)) {
      return res.status(400).json({ error: "Ce lien de réinitialisation est invalide ou expiré." });
    }
    if (!validNewPassword(body.password)) {
      return res.status(400).json({ error: "Le mot de passe doit contenir de 12 à 256 caractères." });
    }
    try {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
      if (!await database.completePasswordReset(tokenHash, passwordHash, Date.now())) {
        return res.status(400).json({ error: "Ce lien de réinitialisation est invalide ou expiré." });
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/logout", requireCsrf, (req, res, next) => {
    req.session.destroy((error) => {
      if (error) {
        return next(error);
      }
      res.clearCookie("promographe.sid", { httpOnly: true, sameSite: "lax" });
      res.status(204).end();
    });
  });

  // Admins choose the product's department; managers can only use their own.
  async function resolveProductDepartment(user, body) {
    if (!["admin", "purchaser"].includes(user.role)) {
      return { departmentId: Number(user.department_id) };
    }
    const departmentId = Number(body.departmentId);
    if (!Number.isSafeInteger(departmentId) || departmentId < 1) {
      return { error: "Choisis le département du produit." };
    }
    if (!await database.getDepartment(departmentId)) {
      return { error: "Le département sélectionné n’existe pas." };
    }
    return { departmentId };
  }

  // Only admins assign suppliers; a manager's save keeps the current supplier.
  // Every product added or edited names its supplier (director, responsable or employee).
  // A typed supplier name reuses the matching supplier or creates it.
  async function resolveProductSupplier(user, body) {
    if (typeof body.supplierName === "string") {
      const name = body.supplierName.trim();
      if (!name) {
        return { error: "Indique le fournisseur du produit." };
      }
      if (name.length > 150) {
        return { error: "Le nom du fournisseur ne peut pas dépasser 150 caractères." };
      }
      const existing = await database.getSupplierByName(name);
      if (existing) {
        return { supplierId: existing.id };
      }
      try {
        return { supplierId: await database.createSupplier(name, "", "", "") };
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return { supplierId: (await database.getSupplierByName(name)).id };
        }
        throw error;
      }
    }
    if (body.supplierId === undefined || body.supplierId === null || body.supplierId === "") {
      return { error: "Indique le fournisseur du produit." };
    }
    const supplierId = Number(body.supplierId);
    if (!Number.isSafeInteger(supplierId) || supplierId < 1 || !await database.getSupplier(supplierId)) {
      return { error: "Le fournisseur sélectionné n’existe pas." };
    }
    return { supplierId };
  }

  // A plain employee (not a department responsable) neither sees prices nor manages products.
  async function isPlainEmployee(user) {
    return user.role === "employee" && !(await database.getManagedDepartments(user.id)).length;
  }

  async function requireProductManager(req, res, next) {
    try {
      if (await isPlainEmployee(req.authenticatedUser)) {
        return res.status(403).json({ error: "Seul un responsable de département peut gérer les produits." });
      }
      next();
    } catch (error) {
      next(error);
    }
  }

  // The given roles, plus the department responsables (never a plain employee).
  function requireRoleOrResponsable(...roles) {
    return async (req, res, next) => {
      try {
        const user = req.authenticatedUser;
        if (!roles.includes(user.role) && (user.role !== "employee" || await isPlainEmployee(user))) {
          return res.status(403).json({ error: "Accès refusé." });
        }
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  // Supplier cards: the director, the purchasing administration and the department responsables.
  const requireSupplierManager = requireRoleOrResponsable("admin", "purchaser");
  // The list of purchase orders: the director, the accountant, the purchasing administration,
  // and the department responsables for their report (their department's part only).
  const requirePurchaseOrderReader = requireRoleOrResponsable("admin", "accountant", "purchaser");

  // A department responsable works only with the products of their department(s): the ones
  // they lead and their own (asked 2026-10-21). Null for everyone else: the whole catalogue.
  async function responsableDepartmentIds(user) {
    if (user.role !== "employee") {
      return null;
    }
    const managed = await database.getManagedDepartments(user.id);
    return managed.length
      ? [...new Set([Number(user.department_id), ...managed.map((department) => Number(department.id))])]
      : null;
  }

  // A responsable's suppliers (asked 2026-10-21): those of their department's products, and those
  // no product uses yet (just added). Null for everyone else, who sees every supplier.
  async function responsableSupplierScope(user) {
    const ownDepartments = await responsableDepartmentIds(user);
    if (!ownDepartments) {
      return null;
    }
    const [products, suppliers] = await Promise.all([database.listProducts(user), database.listSuppliers()]);
    const supplied = products.filter((product) => product.supplier_id !== null && product.supplier_id !== undefined);
    const ours = (product) => ownDepartments.includes(Number(product.department_id));
    const used = new Set(supplied.map((product) => Number(product.supplier_id)));
    const theirs = new Set(supplied.filter(ours).map((product) => Number(product.supplier_id)));
    return {
      ids: new Set(suppliers.map((supplier) => Number(supplier.id)).filter((id) => theirs.has(id) || !used.has(id))),
      // Also used by another department's products: only the director deletes it.
      sharedWithOthers: (supplierId) => supplied.some((product) => Number(product.supplier_id) === supplierId && !ours(product))
    };
  }

  app.get("/api/products", requireAuthenticated, async (req, res, next) => {
    try {
      const user = req.authenticatedUser;
      const ownDepartments = await responsableDepartmentIds(user);
      const products = (await database.listProducts(user))
        .filter((product) => !ownDepartments || ownDepartments.includes(Number(product.department_id)));
      res.json({
        products: await isPlainEmployee(user)
          ? products.map(({ price_cents: priceCents, ...product }) => product)
          : products
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/products", requireAuthenticated, requireRole("admin", "employee"), requireProductManager, requireCsrf, async (req, res, next) => {
    const body = req.body || {};
    const product = validateProduct(body);
    if (product.error) {
      return res.status(400).json({ error: product.error });
    }
    if (typeof body.isActive !== "undefined" && typeof body.isActive !== "boolean") {
      return res.status(400).json({ error: "L’état du produit est invalide." });
    }
    try {
      const department = await resolveProductDepartment(req.authenticatedUser, body);
      if (department.error) {
        return res.status(400).json({ error: department.error });
      }
      const supplier = await resolveProductSupplier(req.authenticatedUser, body);
      if (supplier.error) {
        return res.status(400).json({ error: supplier.error });
      }
      const id = await database.createProduct(
        product.name,
        product.description,
        product.priceCents,
        department.departmentId,
        supplier.supplierId,
        req.authenticatedUser.id,
        typeof body.isActive === "boolean" ? body.isActive : true,
        product.unit,
        product.sku
      );
      res.status(201).json({
        product: {
          id,
          ...product,
          department_id: department.departmentId,
          supplier_id: supplier.supplierId,
          is_active: typeof body.isActive === "boolean" ? body.isActive : true
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/products/:id", requireAuthenticated, requireRole("admin", "purchaser", "employee"), requireProductManager, requireCsrf, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: "Produit invalide." });
    }
    const body = req.body || {};
    const product = validateProduct(body);
    if (product.error) {
      return res.status(400).json({ error: product.error });
    }
    if (typeof body.isActive !== "boolean") {
      return res.status(400).json({ error: "L’état du produit est invalide." });
    }
    try {
      const user = req.authenticatedUser;
      const existing = await database.getProduct(id);
      if (!existing ||
          (!["admin", "purchaser"].includes(user.role) && existing.department_id !== Number(user.department_id))) {
        return res.status(404).json({ error: "Produit introuvable." });
      }
      const department = await resolveProductDepartment(user, body);
      if (department.error) {
        return res.status(400).json({ error: department.error });
      }
      const supplier = await resolveProductSupplier(user, body, existing.supplier_id);
      if (supplier.error) {
        return res.status(400).json({ error: supplier.error });
      }
      const updated = await database.updateProduct(
        id,
        product.name,
        product.description,
        product.priceCents,
        department.departmentId,
        supplier.supplierId,
        body.isActive,
        product.unit,
        product.sku
      );
      if (!updated) {
        return res.status(404).json({ error: "Produit introuvable." });
      }
      res.json({
        product: {
          id,
          ...product,
          department_id: department.departmentId,
          supplier_id: supplier.supplierId,
          is_active: body.isActive
        }
      });
    } catch (error) {
      next(error);
    }
  });

  // The director and the purchasing administration delete any product; a responsable, the
  // products of their department(s).
  app.delete(
    "/api/products/:id",
    requireAuthenticated,
    requireRoleOrResponsable("admin", "purchaser"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Produit invalide." });
      }
      try {
        const ownDepartments = await responsableDepartmentIds(req.authenticatedUser);
        if (ownDepartments) {
          const existing = await database.getProduct(id);
          if (existing && !ownDepartments.includes(existing.department_id)) {
            return res.status(403).json({ error: "Tu ne peux supprimer que les produits de ton département." });
          }
        }
        if (!await database.deleteProduct(id)) {
          return res.status(404).json({ error: "Produit introuvable." });
        }
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );

  app.get("/api/orders", requireAuthenticated, async (req, res, next) => {
    try {
      const user = req.authenticatedUser;
      const managed = await database.getManagedDepartments(user.id);
      const orders = await database.listOrders(user, managed.map((department) => department.id));
      // Plain employees see quantities, never prices or totals.
      res.json({
        orders: user.role === "employee" && !managed.length
          ? orders.map(({ totalCents, ...order }) => ({
            ...order,
            items: order.items.map(({ priceCents, ...item }) => item)
          }))
          : orders
      });
    } catch (error) {
      next(error);
    }
  });

  // Number the next request will most likely receive, shown while it is being prepared.
  app.get("/api/orders/next-number", requireAuthenticated, async (req, res, next) => {
    try {
      res.json({ number: await database.peekNextOrderNumber() });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/orders",
    requireAuthenticated,
    requireRole("admin", "employee", "accountant"),
    requireCsrf,
    async (req, res, next) => {
      const body = req.body || {};
      const notes = typeof body.notes === "string" ? body.notes.trim() : "";
      if (typeof body.notes !== "undefined" &&
          (typeof body.notes !== "string" || body.notes.length > 1000)) {
        return res.status(400).json({ error: "Les notes ne peuvent pas dépasser 1 000 caractères." });
      }
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
        return res.status(400).json({ error: "Une demande doit contenir de 1 à 50 produits." });
      }
      // A request for a client stays out of the company's budgets.
      let client = null;
      if (body.external === true) {
        const name = typeof body.clientName === "string" ? body.clientName.trim() : "";
        const reference = typeof body.clientReference === "string" ? body.clientReference.trim() : "";
        if (!name || name.length > 150) {
          return res.status(400).json({ error: "Indique le nom du client (150 caractères au maximum)." });
        }
        if (reference.length > 100) {
          return res.status(400).json({ error: "La référence du client ne peut pas dépasser 100 caractères." });
        }
        client = { name, reference };
      }
      const items = [];
      const productIds = new Set();
      for (const item of body.items) {
        if (!item || !Number.isSafeInteger(item.productId) || item.productId < 1 ||
            !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000 ||
            productIds.has(item.productId) ||
            (item.unit !== undefined && !Object.hasOwn(UNITS, item.unit))) {
          return res.status(400).json({ error: "Vérifie les produits, les quantités et les unités de la demande." });
        }
        productIds.add(item.productId);
        items.push({ productId: item.productId, quantity: item.quantity, ...(item.unit ? { unit: item.unit } : {}) });
      }
      try {
        const user = req.authenticatedUser;
        // The director orders for any department; everyone else for their own.
        const departmentId = user.role === "admin" && body.departmentId !== undefined
          ? Number(body.departmentId)
          : Number(user.department_id);
        if (!Number.isSafeInteger(departmentId) || departmentId < 1 || !await database.getDepartment(departmentId)) {
          return res.status(400).json({
            error: user.role === "admin"
              ? "Choisis le département de la demande."
              : "Ton compte n’est rattaché à aucun département. Demande à la direction de t’en attribuer un."
          });
        }
        if (user.role !== "admin") {
          const catalogue = await database.listProducts(user);
          const ordered = items.map((item) => catalogue.find((product) => Number(product.id) === item.productId));
          const ownDepartments = await responsableDepartmentIds(user);
          const elsewhere = ownDepartments &&
            ordered.find((product) => product && !ownDepartments.includes(Number(product.department_id)));
          if (elsewhere) {
            return res.status(403).json({
              error: `« ${elsewhere.name} » n’appartient pas à ton département : tu ne peux commander que ses produits.`
            });
          }
          const blocked = ordered.find((product) => product && product.supplier_authorized === false);
          if (blocked) {
            return res.status(409).json({
              error: `Le fournisseur « ${blocked.supplier_name} » n’est pas autorisé : seule la direction peut y commander.`
            });
          }
        }
        const id = await database.createOrder(departmentId, user.id, notes || null, items, body.urgent === true, client);
        if (id === null) {
          return res.status(409).json({
            error: "Un produit n’est plus disponible. Actualise le catalogue et réessaie."
          });
        }
        // The director's requests, and a responsable's requests for a department they lead,
        // need no one else's approval (company decision, 2026-10-13).
        const managed = await database.getManagedDepartments(user.id);
        const { total_cents: totalCents, order_number: orderNumber } = await database.getOrderOwner(id);
        const autoApproved = user.role === "admin" ||
          (managed.some((department) => department.id === departmentId) && totalCents <= DIRECTOR_APPROVAL_THRESHOLD_CENTS);
        if (autoApproved) {
          await database.decideOrder(id, "approved", "Approuvée automatiquement.", user.id);
          await database.assignApprovedItemsToPurchaseOrders();
        }
        res.status(201).json({ orderId: id, orderNumber, status: autoApproved ? "approved" : "pending" });
      } catch (error) {
        next(error);
      }
    }
  );

  // Purchase orders: approved request lines merged into one order per supplier, for the accountant.
  // Free shipping per supplier, with what the supplier's open purchase order already holds:
  // responsables, the director and the accountant (people who see prices).
  app.get("/api/suppliers/shipping", requireAuthenticated, requireRole("admin", "accountant", "purchaser", "employee"), async (req, res, next) => {
    try {
      if (await isPlainEmployee(req.authenticatedUser)) {
        return res.status(403).json({ error: "Accès refusé." });
      }
      await database.assignApprovedItemsToPurchaseOrders();
      const [suppliers, purchaseOrders, scope] = await Promise.all([
        database.listSuppliers(), database.listPurchaseOrders(), responsableSupplierScope(req.authenticatedUser)
      ]);
      res.json({
        // A responsable sees their department's suppliers; the open purchase order stays whole
        // (free shipping depends on the whole order).
        suppliers: suppliers.filter((supplier) => !scope || scope.ids.has(Number(supplier.id))).map((supplier) => ({
          id: supplier.id,
          name: supplier.name,
          freeThresholdCents: supplier.free_threshold_cents ?? null,
          openCents: purchaseOrders
            .filter((purchaseOrder) => purchaseOrder.status === "open" && purchaseOrder.supplierName === supplier.name)
            .reduce((total, purchaseOrder) => total + purchaseOrder.totalCents, 0)
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  // Accountant dashboard: purchase orders, spending, most ordered products, price increases.
  // A responsable sees the purchases of the departments they lead (their part of each purchase order).
  app.get("/api/accounting/dashboard", requireAuthenticated, requireRoleOrResponsable("admin", "accountant"), async (req, res, next) => {
    const year = req.query.year === undefined ? new Date().getFullYear() : Number(req.query.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ error: "Année invalide." });
    }
    try {
      const user = req.authenticatedUser;
      await database.assignApprovedItemsToPurchaseOrders();
      const managed = await database.getManagedDepartments(user.id);
      const [orders, allPurchaseOrders, products, suppliers] = await Promise.all([
        database.listOrders(user, managed.map((department) => department.id)),
        database.listPurchaseOrders(),
        database.listProducts(user),
        database.listSuppliers()
      ]);
      const purchaseOrders = user.role === "employee" ? purchaseOrderShares(allPurchaseOrders, orders) : allPurchaseOrders;
      res.json({ dashboard: buildAccountingDashboard({ orders, purchaseOrders, products, suppliers, year }) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/purchase-orders", requireAuthenticated, requirePurchaseOrderReader, async (req, res, next) => {
    try {
      const user = req.authenticatedUser;
      // Catches up any approved line not yet attached (safe to repeat).
      await database.assignApprovedItemsToPurchaseOrders();
      const purchaseOrders = await database.listPurchaseOrders();
      if (user.role !== "employee") {
        return res.json({ purchaseOrders });
      }
      // A responsable (no "Achats" tab since 2026-10-21) receives only their department's part.
      const managed = await database.getManagedDepartments(user.id);
      const orders = await database.listOrders(user, managed.map((department) => department.id));
      res.json({ purchaseOrders: purchaseOrderShares(purchaseOrders, orders) });
    } catch (error) {
      next(error);
    }
  });

  // The purchase order as the supplier receives it (preview, print, text message, copy).
  app.get("/api/purchase-orders/:id/document", requireAuthenticated, requireRole("admin", "accountant", "purchaser"), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: "Bon de commande invalide." });
    }
    try {
      const purchaseOrder = (await database.listPurchaseOrders()).find((candidate) => candidate.id === id);
      if (!purchaseOrder) {
        return res.status(404).json({ error: "Bon de commande introuvable." });
      }
      const note = typeof req.query.note === "string" ? req.query.note.slice(0, 1000) : "";
      const user = req.authenticatedUser;
      res.json({ document: purchaseOrderDocument(purchaseOrder, { note, sender: { name: user.full_name, email: user.email } }) });
    } catch (error) {
      next(error);
    }
  });

  // The same purchase order as a PDF file to download.
  app.get("/api/purchase-orders/:id/pdf", requireAuthenticated, requireRole("admin", "accountant", "purchaser"), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: "Bon de commande invalide." });
    }
    try {
      const purchaseOrder = (await database.listPurchaseOrders()).find((candidate) => candidate.id === id);
      if (!purchaseOrder) {
        return res.status(404).json({ error: "Bon de commande introuvable." });
      }
      const note = typeof req.query.note === "string" ? req.query.note.slice(0, 1000) : "";
      const user = req.authenticatedUser;
      const pdf = await purchaseOrderPdf(purchaseOrder, { note, sender: { name: user.full_name, email: user.email } });
      const fileName = `bon-de-commande-${String(purchaseOrder.number).replace(/[^\w-]/g, "")}.pdf`;
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `attachment; filename="${fileName}"`);
      res.send(pdf);
    } catch (error) {
      next(error);
    }
  });

  // The purchasing administration (or the director) transmits the purchase order to the
  // supplier. By email, the site sends it (replies go to the sender); by website or
  // representative, the sender sends it and the site records it.
  app.patch(
    "/api/purchase-orders/:id/sent",
    requireAuthenticated,
    requireRole("admin", "purchaser"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      const { method, note = "" } = req.body || {};
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Bon de commande invalide." });
      }
      if (!ORDER_METHODS.includes(method)) {
        return res.status(400).json({ error: "Choisis comment le bon a été transmis." });
      }
      if (typeof note !== "string" || note.length > 1000) {
        return res.status(400).json({ error: "La note ne peut pas dépasser 1 000 caractères." });
      }
      try {
        const purchaseOrder = (await database.listPurchaseOrders()).find((candidate) => candidate.id === id);
        if (!purchaseOrder || purchaseOrder.status !== "open") {
          return res.status(409).json({ error: "Ce bon de commande est introuvable ou a déjà été transmis." });
        }
        const user = req.authenticatedUser;
        if (method === "email") {
          if (!purchaseOrder.supplier.email) {
            return res.status(400).json({
              error: "Ce fournisseur n’a pas de courriel. Ajoutez-le dans la section Fournisseurs."
            });
          }
          if (!invitationMailer.configured && !options.sendPurchaseOrderEmail) {
            return res.status(503).json({ error: "L’envoi de courriels n’est pas configuré." });
          }
          const document = purchaseOrderDocument(purchaseOrder, {
            note: note.trim(),
            sender: { name: user.full_name, email: user.email }
          });
          await sendPurchaseOrderEmail({ to: purchaseOrder.supplier.email, replyTo: user.email, ...document });
        }
        if (!await database.markPurchaseOrderSent(id, user.id, method, note.trim())) {
          return res.status(409).json({ error: "Ce bon de commande a déjà été transmis." });
        }
        // Transmitted = bought (company decision, 2026-10-16): it goes straight to the history.
        await database.markPurchaseOrderPurchased(id, user.id);
        res.json({ sent: true, purchased: true, method });
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch(
    "/api/purchase-orders/:id/purchased",
    requireAuthenticated,
    requireRole("admin", "accountant"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Bon de commande invalide." });
      }
      try {
        if (!await database.markPurchaseOrderPurchased(id, req.authenticatedUser.id)) {
          return res.status(409).json({ error: "Ce bon de commande est introuvable ou a déjà été acheté." });
        }
        res.json({ purchased: true });
      } catch (error) {
        next(error);
      }
    }
  );

  // A department's responsable decides every request of their department's employees, whatever
  // the amount (asked 2026-10-21), and their own up to $2,500. The director decides the
  // responsable's own requests above $2,500, and the requests of a department without a
  // responsable (otherwise they would wait forever).
  app.patch(
    "/api/orders/:id/decision",
    requireAuthenticated,
    requireRole("admin", "employee"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      const { status, decisionNote } = req.body || {};
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Demande invalide." });
      }
      if (status !== "approved" && status !== "rejected") {
        return res.status(400).json({ error: "Choisis une décision valide." });
      }
      if (typeof decisionNote !== "undefined" &&
          (typeof decisionNote !== "string" || decisionNote.length > 1000)) {
        return res.status(400).json({ error: "La note de décision ne peut pas dépasser 1 000 caractères." });
      }
      try {
        const user = req.authenticatedUser;
        const order = await database.getOrderOwner(id);
        if (user.role === "admin") {
          const department = order && (await database.listDepartments())
            .find((candidate) => Number(candidate.id) === order.department_id);
          const responsableId = department?.manager_user_id ? Number(department.manager_user_id) : null;
          const responsableOwnAboveThreshold = order && Number(order.created_by_user_id) === responsableId &&
            order.total_cents > DIRECTOR_APPROVAL_THRESHOLD_CENTS;
          if (order && responsableId && !responsableOwnAboveThreshold) {
            return res.status(403).json({
              error: "C’est le responsable du département qui décide de cette demande."
            });
          }
        } else {
          const managed = await database.getManagedDepartments(user.id);
          if (!order || !managed.some((department) => department.id === order.department_id)) {
            return res.status(403).json({ error: "Seul le responsable de ce département peut décider de cette demande." });
          }
          if (Number(order.created_by_user_id) === Number(user.id) && order.total_cents > DIRECTOR_APPROVAL_THRESHOLD_CENTS) {
            return res.status(403).json({ error: "Au-delà de 2 500 $, c’est la direction qui approuve ta propre demande." });
          }
        }
        const decided = await database.decideOrder(
          id,
          status,
          typeof decisionNote === "string" ? decisionNote.trim() || null : null,
          req.authenticatedUser.id
        );
        if (!decided) {
          return res.status(409).json({
            error: "Cette demande est introuvable ou a déjà été traitée."
          });
        }
        if (status === "approved") {
          await database.assignApprovedItemsToPurchaseOrders();
        }
        res.json({ status });
      } catch (error) {
        next(error);
      }
    }
  );

  // Company directory, read only: administrators and department responsables.
  app.get("/api/staff", requireAuthenticated, requireRole("admin", "purchaser", "employee"), async (req, res, next) => {
    try {
      const user = req.authenticatedUser;
      if (user.role === "employee" && !(await database.getManagedDepartments(user.id)).length) {
        return res.status(403).json({ error: "Accès refusé." });
      }
      const [users, departments] = await Promise.all([database.listUsers(), database.listDepartments()]);
      res.json({
        staff: users
          .filter((member) => ["employee", "admin", "accountant", "purchaser"].includes(member.role) && member.is_active)
          .map((member) => ({
            id: Number(member.id),
            fullName: member.full_name || "",
            email: member.email,
            role: member.role,
            departmentId: member.department_id === null ? null : Number(member.department_id),
            departmentName: departments.find((department) => Number(department.id) === Number(member.department_id))?.name || "",
            manages: departments
              .filter((department) => department.manager_user_id === Number(member.id))
              .map((department) => department.name),
            functions: member.functions || []
          }))
      });
    } catch (error) {
      next(error);
    }
  });

  // An administrator accepts or refuses an employee's request to lead a department.
  app.post(
    "/api/admin/manager-requests/:userId",
    requireAuthenticated,
    requireRole("admin"),
    requireCsrf,
    async (req, res, next) => {
      const userId = Number(req.params.userId);
      const decision = req.body?.decision;
      if (!Number.isSafeInteger(userId) || !["accept", "reject"].includes(decision)) {
        return res.status(400).json({ error: "Décision invalide." });
      }
      try {
        const request = await database.getManagerRequest(userId);
        if (!request) {
          return res.status(404).json({ error: "Cette demande n’existe plus." });
        }
        if (decision === "accept") {
          await database.setDepartmentManager(request.id, userId);
        }
        await database.setManagerRequest(userId, null);
        res.json({ decision, departmentId: request.id });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get("/api/admin/users", requireAuthenticated, requireRole("admin"), async (req, res, next) => {
    try {
      // The developer account is not part of the company's staff.
      const users = (await database.listUsers()).filter((user) => user.role !== "developer");
      res.json({ users: users.map((user) => ({
        ...user,
        is_active: Boolean(user.is_active),
        departmentId: user.department_id
      })) });
    } catch (error) {
      next(error);
    }
  });

  app.get(
    "/api/admin/departments",
    requireAuthenticated,
    requireRole("admin"),
    async (req, res, next) => {
      try {
        res.json({ departments: await database.listDepartments() });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/admin/departments",
    requireAuthenticated,
    requireRole("admin"),
    requireCsrf,
    async (req, res, next) => {
      const body = req.body || {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 100) {
        return res.status(400).json({ error: "Le nom du département doit contenir de 1 à 100 caractères." });
      }
      try {
        const id = await database.createDepartment(name);
        res.status(201).json({ department: { id, name } });
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return res.status(409).json({ error: "Ce département existe déjà." });
        }
        next(error);
      }
    }
  );

  app.get(
    "/api/admin/suppliers",
    requireAuthenticated,
    requireSupplierManager,
    async (req, res, next) => {
      try {
        const [suppliers, scope] = await Promise.all([database.listSuppliers(), responsableSupplierScope(req.authenticatedUser)]);
        res.json({ suppliers: suppliers.filter((supplier) => !scope || scope.ids.has(Number(supplier.id))) });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/admin/suppliers",
    requireAuthenticated,
    requireSupplierManager,
    requireCsrf,
    async (req, res, next) => {
      const supplier = validateSupplier(req.body);
      if (supplier.error) {
        return res.status(400).json({ error: supplier.error });
      }
      // Only the director and the purchasing administration decide which suppliers are authorized.
      if (req.authenticatedUser.role === "employee") {
        supplier.isAuthorized = true;
      }
      try {
        const id = await database.createSupplier(
          supplier.name, supplier.contactName, supplier.email, supplier.phone, supplier.website, supplier.orderMethod, supplier
        );
        res.status(201).json({
          supplier: {
            id,
            name: supplier.name,
            contact_name: supplier.contactName,
            email: supplier.email,
            phone: supplier.phone,
            website: supplier.website,
            order_method: supplier.orderMethod,
            phone_extension: supplier.phoneExtension,
            note: supplier.note,
            reduced_threshold_cents: supplier.reducedThresholdCents,
            free_threshold_cents: supplier.freeThresholdCents,
            account_number: supplier.accountNumber,
            currency: supplier.currency,
            payment_terms: supplier.paymentTerms,
            is_authorized: supplier.isAuthorized,
            category: supplier.category
          }
        });
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return res.status(409).json({ error: "Ce fournisseur existe déjà." });
        }
        next(error);
      }
    }
  );

  app.patch(
    "/api/admin/suppliers/:id",
    requireAuthenticated,
    requireSupplierManager,
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Fournisseur invalide." });
      }
      const supplier = validateSupplier(req.body);
      if (supplier.error) {
        return res.status(400).json({ error: supplier.error });
      }
      try {
        // A responsable edits their department's suppliers, and keeps the authorization as it is.
        if (req.authenticatedUser.role === "employee") {
          const current = (await database.listSuppliers()).find((candidate) => Number(candidate.id) === id);
          if (!current) {
            return res.status(404).json({ error: "Fournisseur introuvable." });
          }
          const scope = await responsableSupplierScope(req.authenticatedUser);
          if (scope && !scope.ids.has(id)) {
            return res.status(403).json({ error: "Ce fournisseur n’est pas un fournisseur de ton département." });
          }
          supplier.isAuthorized = current.is_authorized !== false;
        }
        const updated = await database.updateSupplier(
          id, supplier.name, supplier.contactName, supplier.email, supplier.phone, supplier.website, supplier.orderMethod, supplier
        );
        if (!updated) {
          return res.status(404).json({ error: "Fournisseur introuvable." });
        }
        res.json({ supplier: { id, name: supplier.name } });
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return res.status(409).json({ error: "Un autre fournisseur porte déjà ce nom." });
        }
        next(error);
      }
    }
  );

  // The director manages every department; a responsable, the departments they lead.
  async function canManageDepartment(user, departmentId) {
    return user.role === "admin" ||
      (await database.getManagedDepartments(user.id)).some((department) => Number(department.id) === departmentId);
  }

  // Renames a department; only the director chooses who leads it.
  app.patch(
    "/api/admin/departments/:id",
    requireAuthenticated,
    requireRoleOrResponsable("admin"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const managerUserId = req.body?.managerUserId === null || req.body?.managerUserId === undefined
        ? null
        : Number(req.body.managerUserId);
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Département invalide." });
      }
      if (!name || name.length > 100) {
        return res.status(400).json({ error: "Le nom du département doit contenir de 1 à 100 caractères." });
      }
      try {
        const user = req.authenticatedUser;
        if (!await canManageDepartment(user, id)) {
          return res.status(403).json({ error: "Tu ne peux modifier que le département que tu diriges." });
        }
        const choosesManager = user.role === "admin";
        if (choosesManager && managerUserId !== null && !await isStaffMember(managerUserId)) {
          return res.status(400).json({ error: "Choisis un responsable parmi les employés actifs." });
        }
        if (!await database.renameDepartment(id, name)) {
          return res.status(404).json({ error: "Département introuvable." });
        }
        if (choosesManager) {
          await database.setDepartmentManager(id, managerUserId);
        }
        res.json({ department: { id, name, ...(choosesManager ? { managerUserId } : {}) } });
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return res.status(409).json({ error: "Ce nom de département est déjà utilisé." });
        }
        next(error);
      }
    }
  );

  app.delete(
    "/api/admin/departments/:id",
    requireAuthenticated,
    requireRole("admin"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Département invalide." });
      }
      try {
        const outcome = await database.deleteDepartment(id);
        if (outcome === "not_found") {
          return res.status(404).json({ error: "Département introuvable." });
        }
        if (outcome === "has_managers") {
          return res.status(409).json({
            error: "Ce département a encore des employés. Déplacez-les ou supprimez-les d’abord."
          });
        }
        if (outcome === "has_pending_orders") {
          return res.status(409).json({
            error: "Ce département a des demandes en attente. Approuvez-les ou refusez-les d’abord."
          });
        }
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );

  // Edits a staff member's name, department and access: by the director (anyone but another
  // director, with functions) or by a responsable (only the people of a department they lead,
  // never themselves or another responsable, without procedure functions).
  async function editStaffMember(req, res, next, scope = {}) {
    const id = Number(req.params.id);
    const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
    const rawDepartmentId = req.body?.departmentId;
    const departmentId = rawDepartmentId === null || rawDepartmentId === "" || rawDepartmentId === undefined
      ? null
      : Number(rawDepartmentId);
    const functions = scope.departmentIds ? null : parseFunctions(req.body?.functions);
    const requestedRole = req.body?.role;
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: "Employé invalide." });
    }
    if (requestedRole !== undefined && !["employee", "accountant", "purchaser"].includes(requestedRole)) {
      return res.status(400).json({ error: "Accès invalide." });
    }
    if (!fullName || fullName.length > 150) {
      return res.status(400).json({ error: "Saisis le nom complet (150 caractères maximum)." });
    }
    if (!scope.departmentIds && !functions) {
      return res.status(400).json({ error: "Une fonction choisie est invalide." });
    }
    try {
      const user = (await database.listUsers()).find((candidate) => Number(candidate.id) === id);
      if (!user || !["employee", "admin", "accountant", "purchaser"].includes(user.role)) {
        return res.status(404).json({ error: "Employé introuvable." });
      }
      if (scope.departmentIds) {
        if (user.role === "admin" || !scope.departmentIds.includes(Number(user.department_id))) {
          return res.status(403).json({ error: "Tu ne peux modifier que les employés de ton département." });
        }
        if (id === Number(req.authenticatedUser.id) || (await database.getManagedDepartments(id)).length) {
          return res.status(403).json({ error: "Un responsable ne peut pas être modifié ici." });
        }
        if (!scope.departmentIds.includes(departmentId)) {
          return res.status(403).json({ error: "Choisis un département que tu diriges." });
        }
      }
      if (requestedRole !== undefined && user.role === "admin") {
        return res.status(400).json({ error: "Le rôle de Directeur se gère depuis le compte Développeur." });
      }
      const role = requestedRole ?? user.role;
      // Every employee belongs to a department; the director, the accountant and the
      // purchasing administration may have none.
      const departmentRequired = role === "employee";
      if ((departmentId === null && departmentRequired) ||
          (departmentId !== null && (!Number.isSafeInteger(departmentId) || !await database.getDepartment(departmentId)))) {
        return res.status(400).json({ error: "Choisis un département valide." });
      }
      // The database requires a department for employees: leave the employee role before
      // removing the department, and set the department before switching back to employee.
      if (role !== user.role && role !== "employee") {
        await database.updateStaffRole(id, role);
      }
      await database.updateUserDetails(id, fullName, departmentId);
      if (role !== user.role && role === "employee") {
        await database.updateStaffRole(id, role);
      }
      if (functions) {
        await database.setUserFunctions(id, functions);
      }
      res.json({ user: { id, fullName, departmentId, role, functions: functions || user.functions || [] } });
    } catch (error) {
      next(error);
    }
  }

  app.patch(
    "/api/admin/users/:id",
    requireAuthenticated,
    requireRole("admin"),
    requireCsrf,
    (req, res, next) => editStaffMember(req, res, next)
  );

  app.delete(
    "/api/admin/users/:id",
    requireAuthenticated,
    requireRole("admin"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Employé invalide." });
      }
      try {
        // The director deletes employees, accountants and purchasing administration accounts
        // (directors are removed by the developer).
        if (!await database.deleteEmployee(id) && !await database.deleteUserWithRole(id, "accountant") &&
            !await database.deleteUserWithRole(id, "purchaser")) {
          return res.status(404).json({ error: "Responsable introuvable." });
        }
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );

  app.delete(
    "/api/admin/suppliers/:id",
    requireAuthenticated,
    requireSupplierManager,
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Fournisseur invalide." });
      }
      try {
        // A responsable deletes only a supplier of their department that no other department uses.
        // Deleting one that is not authorized would free its products: not for a responsable either.
        if (req.authenticatedUser.role === "employee") {
          const current = (await database.listSuppliers()).find((candidate) => Number(candidate.id) === id);
          const scope = current && await responsableSupplierScope(req.authenticatedUser);
          if (scope && !scope.ids.has(id)) {
            return res.status(403).json({ error: "Ce fournisseur n’est pas un fournisseur de ton département." });
          }
          if (current && current.is_authorized === false) {
            return res.status(403).json({
              error: "Ce fournisseur n’est pas autorisé : seules la direction et l’administration peuvent le supprimer."
            });
          }
          if (scope && scope.sharedWithOthers(id)) {
            return res.status(403).json({
              error: "Ce fournisseur sert aussi d’autres départements : seule la direction peut le supprimer."
            });
          }
        }
        if (!await database.deleteSupplier(id)) {
          return res.status(404).json({ error: "Fournisseur introuvable." });
        }
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch(
    "/api/admin/departments/:id/budget",
    requireAuthenticated,
    requireRoleOrResponsable("admin"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Département invalide." });
      }
      const budgetCents = (req.body || {}).budgetCents;
      if (budgetCents !== null &&
          (!Number.isSafeInteger(budgetCents) || budgetCents < 0 || budgetCents > 99999999999)) {
        return res.status(400).json({ error: "Saisis un budget valide en dollars canadiens." });
      }
      try {
        if (!await canManageDepartment(req.authenticatedUser, id)) {
          return res.status(403).json({ error: "Tu ne peux modifier que le budget du département que tu diriges." });
        }
        if (!await database.updateDepartmentBudget(id, budgetCents)) {
          return res.status(404).json({ error: "Département introuvable." });
        }
        res.json({ department: { id, budgetCents } });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/admin/dashboard",
    requireAuthenticated,
    requireRoleOrResponsable("admin"),
    async (req, res, next) => {
      const currentYear = new Date().getFullYear();
      const year = req.query.year === undefined ? currentYear : Number(req.query.year);
      if (!Number.isSafeInteger(year) || year < 2000 || year > currentYear + 1) {
        return res.status(400).json({ error: "Année invalide." });
      }
      try {
        const dashboard = await database.getDashboard(year);
        if (req.authenticatedUser.role === "admin") {
          return res.json({ year, ...dashboard });
        }
        // A responsable sees only the departments they lead, without the company's totals.
        const managed = (await database.getManagedDepartments(req.authenticatedUser.id)).map((department) => Number(department.id));
        const departments = dashboard.departments.filter((department) => managed.includes(department.id));
        res.json({
          year,
          departments,
          orderCounts: { pending: departments.reduce((sum, department) => sum + department.pendingOrders, 0) }
        });
      } catch (error) {
        next(error);
      }
    }
  );

  // Invites an employee into a department: by the director (any department, with functions)
  // or by a responsable (only into a department they lead).
  async function inviteEmployee(req, res, next, scope = {}) {
    const body = req.body || {};
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    // A responsable invites only into a department they lead, without procedure functions.
    const departmentId = scope.departmentIds && body.departmentId === undefined && scope.departmentIds.length === 1
      ? scope.departmentIds[0]
      : Number(body.departmentId);
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    const functions = scope.departmentIds ? [] : parseFunctions(body.functions);
    if (!fullName || fullName.length > 150) {
      return res.status(400).json({ error: "Saisis le nom complet de l’employé (150 caractères maximum)." });
    }
    if (!functions) {
      return res.status(400).json({ error: "Une fonction choisie est invalide." });
    }
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: "Saisis une adresse courriel valide." });
    }
    if (!Number.isSafeInteger(departmentId) || departmentId < 1) {
      return res.status(400).json({ error: "Choisis un département valide." });
    }
    if (scope.departmentIds && !scope.departmentIds.includes(departmentId)) {
      return res.status(403).json({ error: "Tu ne peux inviter que dans le département que tu diriges." });
    }

    try {
      const department = await database.getDepartment(departmentId);
      if (!department) {
        return res.status(400).json({ error: "Le département sélectionné n’existe pas." });
      }
      const existingUser = await database.getInviteUser(email);
      if (existingUser && (existingUser.role !== "employee" || existingUser.is_active)) {
        return res.status(409).json({ error: "Cette adresse est déjà associée à un compte actif." });
      }
      if (!invitationMailer.configured && !options.sendInvitationEmail) {
        return res.status(503).json({
          error: "L’envoi de courriel n’est pas configuré. Configure les paramètres SMTP avant d’envoyer des invitations."
        });
      }

      const token = crypto.randomBytes(48).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const expiresAt = Date.now() + INVITATION_LIFETIME_MS;
      const userId = existingUser
        ? existingUser.id
        : await database.createPendingManager(email, dummyPasswordHash, department.id, fullName);
      const createdUser = !existingUser;
      let invitationId;
      try {
        await database.updatePendingManagerDepartment(userId, department.id, fullName);
        await database.setUserFunctions(userId, functions);
        invitationId = await database.createInvitation(userId, tokenHash, expiresAt);
        await database.invalidateInvitations(userId, invitationId, Date.now());
      } catch (error) {
        if (invitationId) {
          await database.rollbackInvitation(invitationId, userId, createdUser);
        } else if (createdUser) {
          await database.deletePendingManager(userId);
        }
        if (isUniqueConstraint(error)) {
          return res.status(409).json({ error: "Cette adresse est déjà associée à un compte." });
        }
        throw error;
      }
      try {
        await sendInvitationEmail({ email, token, departmentName: department.name });
      } catch (error) {
        await database.rollbackInvitation(invitationId, userId, createdUser);
        console.error("Promographe invitation email delivery failed:", error.code || error.name);
        return res.status(502).json({
          error: "Le courriel d’invitation n’a pas pu être envoyé. Vérifie les paramètres SMTP et réessaie."
        });
      }

      res.status(202).json({ message: "Invitation envoyée." });
    } catch (error) {
      next(error);
    }
  }

  app.post(
    "/api/team/invitations",
    requireAuthenticated,
    requireRole("employee"),
    requireCsrf,
    async (req, res, next) => {
      try {
        const managed = await database.getManagedDepartments(req.authenticatedUser.id);
        if (!managed.length) {
          return res.status(403).json({ error: "Accès refusé." });
        }
        await inviteEmployee(req, res, next, { departmentIds: managed.map((department) => department.id) });
      } catch (error) {
        next(error);
      }
    }
  );

  // A responsable edits the people of a department they lead: name, department, access.
  app.patch(
    "/api/team/:id",
    requireAuthenticated,
    requireRole("employee"),
    requireCsrf,
    async (req, res, next) => {
      try {
        const managed = await database.getManagedDepartments(req.authenticatedUser.id);
        if (!managed.length) {
          return res.status(403).json({ error: "Accès refusé." });
        }
        await editStaffMember(req, res, next, { departmentIds: managed.map((department) => Number(department.id)) });
      } catch (error) {
        next(error);
      }
    }
  );

  // A responsable removes an employee of a department they lead (never themselves, never
  // another responsable, the director or the accountant).
  app.delete(
    "/api/team/:userId",
    requireAuthenticated,
    requireRole("employee"),
    requireCsrf,
    async (req, res, next) => {
      const userId = Number(req.params.userId);
      try {
        const managed = (await database.getManagedDepartments(req.authenticatedUser.id)).map((department) => department.id);
        const target = (await database.listUsers()).find((user) => Number(user.id) === userId);
        if (!managed.length || !target || target.role !== "employee" ||
            !managed.includes(Number(target.department_id))) {
          return res.status(403).json({ error: "Tu ne peux retirer que les employés de ton département." });
        }
        if (userId === Number(req.authenticatedUser.id) || (await database.getManagedDepartments(userId)).length) {
          return res.status(403).json({ error: "Un responsable ne peut pas être retiré ici." });
        }
        await database.deleteEmployee(userId);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/admin/invitations",
    requireAuthenticated,
    requireRole("admin"),
    requireCsrf,
    (req, res, next) => inviteEmployee(req, res, next)
  );

  app.get(
    "/api/developer/admins",
    requireAuthenticated,
    requireRole("developer"),
    async (req, res, next) => {
      try {
        res.json({ admins: await database.listAdmins() });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/developer/admins",
    invitationAttemptLimit,
    requireAuthenticated,
    requireRole("developer"),
    requireCsrf,
    async (req, res, next) => {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
      if (!fullName || fullName.length > 150) {
        return res.status(400).json({ error: "Saisis le nom complet de l’administrateur (150 caractères maximum)." });
      }
      if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
        return res.status(400).json({ error: "Saisis une adresse courriel valide." });
      }
      if (!invitationMailer.configured && !options.sendInvitationEmail) {
        return res.status(503).json({ error: "L’envoi de courriel n’est pas configuré." });
      }
      try {
        const existingUser = await database.getInviteUser(email);
        if (existingUser && (existingUser.role !== "admin" || existingUser.is_active)) {
          return res.status(409).json({ error: "Cette adresse est déjà associée à un compte actif." });
        }
        const token = crypto.randomBytes(48).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const createdUser = !existingUser;
        const userId = existingUser
          ? existingUser.id
          : await database.createPendingAdmin(email, dummyPasswordHash, fullName);
        let invitationId;
        try {
          await database.updatePendingAdmin(userId, fullName);
          invitationId = await database.createInvitation(userId, tokenHash, Date.now() + INVITATION_LIFETIME_MS);
          await database.invalidateInvitations(userId, invitationId, Date.now());
        } catch (error) {
          if (invitationId) {
            await database.rollbackInvitation(invitationId, userId, createdUser);
          } else if (createdUser) {
            await database.deletePendingManager(userId);
          }
          throw error;
        }
        try {
          await sendInvitationEmail({ email, token, role: "admin" });
        } catch (error) {
          await database.rollbackInvitation(invitationId, userId, createdUser);
          console.error("Promographe invitation email delivery failed:", error.code || error.name);
          return res.status(502).json({ error: "Le courriel d’invitation n’a pas pu être envoyé. Réessaie." });
        }
        res.status(202).json({ message: "Invitation envoyée." });
      } catch (error) {
        next(error);
      }
    }
  );

  app.delete(
    "/api/developer/admins/:id",
    requireAuthenticated,
    requireRole("developer"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Administrateur invalide." });
      }
      try {
        if (!await database.deleteAdmin(id)) {
          return res.status(404).json({ error: "Administrateur introuvable." });
        }
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );

  app.post("/api/invitations/validate", invitationAttemptLimit, async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const body = req.body || {};
    const token = typeof body.token === "string" ? body.token : "";
    if (!/^[a-f0-9]{96}$/.test(token)) {
      return res.status(400).json({ error: "Ce lien d’invitation est invalide ou expiré." });
    }
    try {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const invitation = await database.getInvitation(tokenHash);
      if (!invitation || invitation.used_at || Number(invitation.expires_at) <= Date.now()) {
        return res.status(400).json({ error: "Ce lien d’invitation est invalide ou expiré." });
      }
      res.json({
        email: invitation.email,
        role: invitation.role,
        departmentName: invitation.department_name || ""
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/invitations/accept",
    invitationAttemptLimit,
    requireCsrf,
    async (req, res, next) => {
      const body = req.body || {};
      const token = typeof body.token === "string" ? body.token : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!/^[a-f0-9]{96}$/.test(token)) {
        return res.status(400).json({ error: "Ce lien d’invitation est invalide ou expiré." });
      }
      if (password.length < 12 || password.length > 256) {
        return res.status(400).json({ error: "Le mot de passe doit contenir de 12 à 256 caractères." });
      }

      try {
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
        const accepted = await database.acceptInvitation(tokenHash, passwordHash, Date.now());
        if (!accepted) {
          return res.status(400).json({ error: "Ce lien d’invitation est invalide ou expiré." });
        }
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(["/accept-invitation.html", "/reset-password.html"], (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.sendFile(path.join(__dirname, "public", path.basename(req.path)));
  });

  app.get(["/", "/index.html"], requirePageAuthentication, (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });
  app.use(express.static(path.join(__dirname, "public"), { index: false }));

  app.use((error, req, res, next) => {
    console.error("Promographe request failed:", error);
    if (res.headersSent) {
      return next(error);
    }
    if (isDatabaseWakingUp(error)) {
      return res.status(503).json({
        error: "La base de données se réveille après une période d’inactivité. Réessaie dans une minute."
      });
    }
    res.status(500).json({ error: "Une erreur interne est survenue." });
  });

  app.locals.database = database;
  app.locals.close = async () => {
    sessionStore.close?.();
    if (!options.database) {
      await database.close();
    }
  };
  return app;
}

if (require.main === module) {
  createApp().then((app) => {
    const port = process.env.PORT || 3000;
    const server = app.listen(port, () => {
      console.log(`Promographe disponible sur le port ${port}`);
    });
    server.on("close", () => {
      app.locals.close().catch((error) => {
        console.error("Promographe shutdown failed:", error.message);
      });
    });
  }).catch((error) => {
    console.error("Promographe could not start:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { createApp };

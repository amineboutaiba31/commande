const crypto = require("crypto");
const path = require("path");
const express = require("express");
const session = require("express-session");
const { rateLimit } = require("express-rate-limit");
const argon2 = require("argon2");
require("dotenv").config();
const { AzureDatabase } = require("./src/database");
const { AzureSessionStore } = require("./src/azure-session-store");
const { createInvitationMailer } = require("./src/invitation-mailer");
const { createMicrosoftAuth } = require("./src/microsoft-auth");

const INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
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
  if (!Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > 2147483647) {
    return { error: "Saisis un prix valide en dollars canadiens." };
  }
  return { name, description, priceCents };
}

function validateSupplier(body = {}) {
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const supplier = {
    name: text(body.name),
    contactName: text(body.contactName),
    email: text(body.email).toLowerCase(),
    phone: text(body.phone)
  };
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
      // Only accounts from the configured tenant whose email was invited into Promographe.
      const email = String(claims.preferred_username || claims.email || claims.upn || "")
        .trim().toLowerCase();
      const sameTenant = String(claims.tid || "").toLowerCase() === microsoftAuth.tenantId.toLowerCase();
      let user = sameTenant && EMAIL_PATTERN.test(email) ? await database.getUserByEmail(email) : null;
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

  function requireCsrf(req, res, next) {
    if (!safeTokenEqual(req.session.csrfToken, req.get("x-csrf-token"))) {
      return res.status(403).json({ error: "Session expirée. Recharge la page et réessaie." });
    }
    next();
  }

  app.get("/api/auth/me", requireAuthenticated, async (req, res, next) => {
    try {
      const user = req.authenticatedUser;
      const department = user.department_id ? await database.getDepartment(user.department_id) : null;
      res.json({ user: { ...publicUser(user), departmentName: department ? department.name : "" } });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/auth/profile", requireAuthenticated, requireCsrf, async (req, res, next) => {
    const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
    if (!fullName || fullName.length > 150) {
      return res.status(400).json({ error: "Le nom complet doit contenir de 1 à 150 caractères." });
    }
    try {
      await database.updateUserFullName(req.authenticatedUser.id, fullName);
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
    if (user.role !== "admin") {
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
  async function resolveProductSupplier(user, body, currentSupplierId = null) {
    if (user.role !== "admin") {
      return { supplierId: currentSupplierId };
    }
    // A typed supplier name reuses the matching supplier or creates it.
    if (typeof body.supplierName === "string") {
      const name = body.supplierName.trim();
      if (!name) {
        return { supplierId: null };
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
      return { supplierId: null };
    }
    const supplierId = Number(body.supplierId);
    if (!Number.isSafeInteger(supplierId) || supplierId < 1 || !await database.getSupplier(supplierId)) {
      return { error: "Le fournisseur sélectionné n’existe pas." };
    }
    return { supplierId };
  }

  app.get("/api/products", requireAuthenticated, async (req, res, next) => {
    try {
      res.json({ products: await database.listProducts(req.authenticatedUser) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/products", requireAuthenticated, requireCsrf, async (req, res, next) => {
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
        typeof body.isActive === "boolean" ? body.isActive : true
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

  app.patch("/api/products/:id", requireAuthenticated, requireCsrf, async (req, res, next) => {
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
          (user.role !== "admin" && existing.department_id !== Number(user.department_id))) {
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
        body.isActive
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

  app.delete(
    "/api/products/:id",
    requireAuthenticated,
    requireRole("admin"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Produit invalide." });
      }
      try {
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
      res.json({ orders: await database.listOrders(req.authenticatedUser) });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/orders",
    requireAuthenticated,
    requireRole("department_manager"),
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
      const items = [];
      const productIds = new Set();
      for (const item of body.items) {
        if (!item || !Number.isSafeInteger(item.productId) || item.productId < 1 ||
            !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000 ||
            productIds.has(item.productId)) {
          return res.status(400).json({ error: "Vérifie les produits et les quantités de la demande." });
        }
        productIds.add(item.productId);
        items.push({ productId: item.productId, quantity: item.quantity });
      }
      try {
        const id = await database.createOrder(
          req.authenticatedUser.department_id,
          req.authenticatedUser.id,
          notes || null,
          items
        );
        if (id === null) {
          return res.status(409).json({
            error: "Un produit n’est plus disponible. Actualise le catalogue et réessaie."
          });
        }
        res.status(201).json({ orderId: id });
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch(
    "/api/admin/orders/:id",
    requireAuthenticated,
    requireRole("admin"),
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
        res.json({ status });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get("/api/admin/users", requireAuthenticated, requireRole("admin"), async (req, res, next) => {
    try {
      const users = await database.listUsers();
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
    requireRole("admin"),
    async (req, res, next) => {
      try {
        res.json({ suppliers: await database.listSuppliers() });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/admin/suppliers",
    requireAuthenticated,
    requireRole("admin"),
    requireCsrf,
    async (req, res, next) => {
      const supplier = validateSupplier(req.body);
      if (supplier.error) {
        return res.status(400).json({ error: supplier.error });
      }
      try {
        const id = await database.createSupplier(
          supplier.name, supplier.contactName, supplier.email, supplier.phone
        );
        res.status(201).json({
          supplier: {
            id,
            name: supplier.name,
            contact_name: supplier.contactName,
            email: supplier.email,
            phone: supplier.phone
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
    requireRole("admin"),
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
        const updated = await database.updateSupplier(
          id, supplier.name, supplier.contactName, supplier.email, supplier.phone
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

  app.patch(
    "/api/admin/departments/:id",
    requireAuthenticated,
    requireRole("admin"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Département invalide." });
      }
      if (!name || name.length > 100) {
        return res.status(400).json({ error: "Le nom du département doit contenir de 1 à 100 caractères." });
      }
      try {
        if (!await database.renameDepartment(id, name)) {
          return res.status(404).json({ error: "Département introuvable." });
        }
        res.json({ department: { id, name } });
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
            error: "Ce département a encore des responsables. Déplacez-les ou supprimez-les d’abord."
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

  app.patch(
    "/api/admin/users/:id",
    requireAuthenticated,
    requireRole("admin"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
      const departmentId = Number(req.body?.departmentId);
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Responsable invalide." });
      }
      if (!fullName || fullName.length > 150) {
        return res.status(400).json({ error: "Saisis le nom complet du responsable (150 caractères maximum)." });
      }
      try {
        if (!Number.isSafeInteger(departmentId) || !await database.getDepartment(departmentId)) {
          return res.status(400).json({ error: "Choisis un département valide." });
        }
        if (!await database.updateManager(id, fullName, departmentId)) {
          return res.status(404).json({ error: "Responsable introuvable." });
        }
        res.json({ user: { id, fullName, departmentId } });
      } catch (error) {
        next(error);
      }
    }
  );

  app.delete(
    "/api/admin/users/:id",
    requireAuthenticated,
    requireRole("admin"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Responsable invalide." });
      }
      try {
        if (!await database.deleteManager(id)) {
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
    requireRole("admin"),
    requireCsrf,
    async (req, res, next) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({ error: "Fournisseur invalide." });
      }
      try {
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
    requireRole("admin"),
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
    requireRole("admin"),
    async (req, res, next) => {
      const currentYear = new Date().getFullYear();
      const year = req.query.year === undefined ? currentYear : Number(req.query.year);
      if (!Number.isSafeInteger(year) || year < 2000 || year > currentYear + 1) {
        return res.status(400).json({ error: "Année invalide." });
      }
      try {
        res.json({ year, ...await database.getDashboard(year) });
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
    async (req, res, next) => {
      const body = req.body || {};
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const departmentId = Number(body.departmentId);
      const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
      if (!fullName || fullName.length > 150) {
        return res.status(400).json({ error: "Saisis le nom complet du responsable (150 caractères maximum)." });
      }
      if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
        return res.status(400).json({ error: "Saisis une adresse courriel valide." });
      }
      if (!Number.isSafeInteger(departmentId) || departmentId < 1) {
        return res.status(400).json({ error: "Choisis un département valide." });
      }

      try {
        const department = await database.getDepartment(departmentId);
        if (!department) {
          return res.status(400).json({ error: "Le département sélectionné n’existe pas." });
        }
        const existingUser = await database.getInviteUser(email);
        if (existingUser && (existingUser.role !== "department_manager" || existingUser.is_active)) {
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

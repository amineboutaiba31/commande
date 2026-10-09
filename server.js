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

const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
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

async function createApp(options = {}) {
  const env = options.env || process.env;
  const sessionSecret = options.sessionSecret || getSessionSecret(env);
  const invitationMailer = createInvitationMailer(env);
  const database = options.database || await AzureDatabase.connect(env);
  const sessionStore = options.sessionStore || new AzureSessionStore(database);
  const sendInvitationEmail = options.sendInvitationEmail ||
    ((message) => invitationMailer.send(message));

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
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: env.NODE_ENV === "production",
      maxAge: SESSION_LIFETIME_MS
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

  app.post("/api/auth/login", loginRateLimit, async (req, res, next) => {
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

      const user = await database.getUserByEmail(email);
      const passwordMatches = await argon2.verify(
        user ? user.password_hash : dummyPasswordHash,
        password
      );
      if (!user || !user.is_active || !passwordMatches) {
        return res.status(401).json({ error: "Adresse courriel ou mot de passe invalide." });
      }

      req.session.regenerate((error) => {
        if (error) {
          return next(error);
        }
        req.session.userId = user.id;
        req.session.csrfToken = crypto.randomBytes(32).toString("hex");
        req.session.save((saveError) => {
          if (saveError) {
            return next(saveError);
          }
          res.json({ user: publicUser(user), csrfToken: req.session.csrfToken });
        });
      });
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
      if (!user || !user.is_active) {
        return req.session.destroy((error) => {
          if (error) {
            return next(error);
          }
          res.clearCookie("promographe.sid", { httpOnly: true, sameSite: "strict" });
          if (pageRequest) {
            res.redirect("/login.html");
          } else {
            res.status(401).json({ error: "Authentification requise." });
          }
        });
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

  app.get("/api/auth/me", requireAuthenticated, (req, res) => {
    res.json({ user: publicUser(req.authenticatedUser) });
  });

  app.post("/api/auth/logout", requireCsrf, (req, res, next) => {
    req.session.destroy((error) => {
      if (error) {
        return next(error);
      }
      res.clearCookie("promographe.sid", { httpOnly: true, sameSite: "strict" });
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
      const body = req.body || {};
      const text = (value) => (typeof value === "string" ? value.trim() : "");
      const supplier = {
        name: text(body.name),
        contactName: text(body.contactName),
        email: text(body.email).toLowerCase(),
        phone: text(body.phone)
      };
      if (!supplier.name || supplier.name.length > 150) {
        return res.status(400).json({ error: "Le nom du fournisseur doit contenir de 1 à 150 caractères." });
      }
      if (supplier.contactName.length > 150) {
        return res.status(400).json({ error: "Le nom du contact ne peut pas dépasser 150 caractères." });
      }
      if (supplier.email && (supplier.email.length > 254 || !EMAIL_PATTERN.test(supplier.email))) {
        return res.status(400).json({ error: "Saisis une adresse courriel valide pour le fournisseur." });
      }
      if (supplier.phone.length > 50) {
        return res.status(400).json({ error: "Le téléphone ne peut pas dépasser 50 caractères." });
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
      res.json({ email: invitation.email, departmentName: invitation.department_name });
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

  app.get("/accept-invitation.html", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.sendFile(path.join(__dirname, "public", "accept-invitation.html"));
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

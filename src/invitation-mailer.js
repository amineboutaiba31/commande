const nodemailer = require("nodemailer");

function createInvitationMailer(env) {
  const required = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"];
  const configured = required.every((key) => typeof env[key] === "string" && env[key].trim());
  const port = Number(env.SMTP_PORT || 587);
  const baseUrl = env.APP_BASE_URL || `http://localhost:${env.PORT || 3000}`;
  if (env.NODE_ENV === "production" && !env.APP_BASE_URL) {
    throw new Error("APP_BASE_URL must be configured in production.");
  }

  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error("APP_BASE_URL must be a valid absolute URL.");
  }
  if (env.NODE_ENV === "production" && parsedBaseUrl.protocol !== "https:") {
    throw new Error("APP_BASE_URL must use HTTPS in production.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be a valid port number.");
  }

  const transport = configured
    ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure: env.SMTP_SECURE === "true" || port === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
    })
    : null;

  return {
    configured,
    async send({ email, token, departmentName }) {
      if (!transport) {
        throw new Error("SMTP is not configured.");
      }
      const invitationUrl = new URL("/accept-invitation.html", parsedBaseUrl);
      invitationUrl.hash = new URLSearchParams({ token }).toString();
      await transport.sendMail({
        from: env.SMTP_FROM,
        to: email,
        subject: "Invitation à Promographe",
        text: [
          "Bonjour,",
          "",
          `Vous avez été invité(e) à rejoindre Promographe comme responsable du département ${departmentName}.`,
          "Utilisez ce lien pour définir votre mot de passe. Il expirera dans 24 heures :",
          invitationUrl.toString(),
          "",
          "Si vous n'attendiez pas cette invitation, vous pouvez ignorer ce message."
        ].join("\n"),
        html: `<p>Bonjour,</p><p>Vous avez été invité(e) à rejoindre Promographe comme responsable du département <strong>${escapeHtml(departmentName)}</strong>.</p><p><a href="${escapeHtml(invitationUrl.toString())}">Définir mon mot de passe</a></p><p>Ce lien expirera dans 24 heures. Si vous n'attendiez pas cette invitation, vous pouvez ignorer ce message.</p>`
      });
    }
  };
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

module.exports = { createInvitationMailer };

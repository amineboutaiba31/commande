const nodemailer = require("nodemailer");
const { EmailClient } = require("@azure/communication-email");
const { DefaultAzureCredential } = require("@azure/identity");

const hasValue = (value) => typeof value === "string" && value.trim() !== "";

// Azure Communication Services Email: a connection string, or an endpoint reached with the
// app's managed identity. Returns null when it is not configured.
function createAzureTransport(env) {
  if (!hasValue(env.ACS_EMAIL_FROM) ||
      (!hasValue(env.ACS_EMAIL_CONNECTION_STRING) && !hasValue(env.ACS_EMAIL_ENDPOINT))) {
    return null;
  }
  const client = hasValue(env.ACS_EMAIL_CONNECTION_STRING)
    ? new EmailClient(env.ACS_EMAIL_CONNECTION_STRING.trim())
    : new EmailClient(env.ACS_EMAIL_ENDPOINT.trim(), new DefaultAzureCredential());
  return {
    async sendMail({ to, subject, text, html }) {
      const poller = await client.beginSend({
        senderAddress: env.ACS_EMAIL_FROM.trim(),
        recipients: { to: [{ address: to }] },
        content: { subject, plainText: text, html }
      });
      const result = await poller.pollUntilDone();
      if (result.status !== "Succeeded") {
        throw new Error(`Azure email delivery ${result.status}: ${result.error?.message || "unknown error"}`);
      }
    }
  };
}

function createInvitationMailer(env) {
  const smtpConfigured = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"]
    .every((key) => hasValue(env[key]));
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

  const transport = smtpConfigured
    ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure: env.SMTP_SECURE === "true" || port === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
    })
    : createAzureTransport(env);

  return {
    configured: Boolean(transport),
    async send({ email, token, departmentName, role }) {
      if (!transport) {
        throw new Error("Email delivery is not configured.");
      }
      const invitationUrl = new URL("/accept-invitation.html", parsedBaseUrl);
      invitationUrl.hash = new URLSearchParams({ token }).toString();
      const roleText = role === "admin"
        ? "administrateur(trice)"
        : `responsable du département ${departmentName}`;
      const roleHtml = role === "admin"
        ? "<strong>administrateur(trice)</strong>"
        : `responsable du département <strong>${escapeHtml(departmentName)}</strong>`;
      await transport.sendMail({
        from: env.SMTP_FROM,
        to: email,
        subject: "Invitation à Promographe",
        text: [
          "Bonjour,",
          "",
          `Vous avez été invité(e) à rejoindre Promographe comme ${roleText}.`,
          "Utilisez ce lien pour définir votre mot de passe. Il expirera dans 24 heures :",
          invitationUrl.toString(),
          "",
          "Si vous n'attendiez pas cette invitation, vous pouvez ignorer ce message."
        ].join("\n"),
        html: `<p>Bonjour,</p><p>Vous avez été invité(e) à rejoindre Promographe comme ${roleHtml}.</p><p><a href="${escapeHtml(invitationUrl.toString())}">Définir mon mot de passe</a></p><p>Ce lien expirera dans 24 heures. Si vous n'attendiez pas cette invitation, vous pouvez ignorer ce message.</p>`
      });
    },
    async sendPasswordReset({ email, token }) {
      if (!transport) {
        throw new Error("Email delivery is not configured.");
      }
      const resetUrl = new URL("/reset-password.html", parsedBaseUrl);
      resetUrl.hash = new URLSearchParams({ token }).toString();
      await transport.sendMail({
        from: env.SMTP_FROM,
        to: email,
        subject: "Réinitialisation de votre mot de passe Promographe",
        text: [
          "Bonjour,",
          "",
          "Une demande de réinitialisation du mot de passe de votre compte Promographe a été faite.",
          "Utilisez ce lien pour choisir un nouveau mot de passe. Il expirera dans 1 heure :",
          resetUrl.toString(),
          "",
          "Si vous n'avez pas fait cette demande, ignorez ce message : votre mot de passe reste inchangé."
        ].join("\n"),
        html: `<p>Bonjour,</p><p>Une demande de réinitialisation du mot de passe de votre compte Promographe a été faite.</p><p><a href="${escapeHtml(resetUrl.toString())}">Choisir un nouveau mot de passe</a></p><p>Ce lien expirera dans 1 heure. Si vous n'avez pas fait cette demande, ignorez ce message : votre mot de passe reste inchangé.</p>`
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

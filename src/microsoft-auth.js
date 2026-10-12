const { ConfidentialClientApplication, CryptoProvider } = require("@azure/msal-node");

const SCOPES = ["openid", "profile", "email"];
const CALLBACK_PATH = "/api/auth/microsoft/callback";

// Returns null when "Se connecter avec Microsoft" is not configured.
function createMicrosoftAuth(env) {
  const clientId = env.AUTH_MICROSOFT_CLIENT_ID;
  const clientSecret = env.AUTH_MICROSOFT_CLIENT_SECRET;
  const tenantId = env.AUTH_MICROSOFT_TENANT_ID;
  if (![clientId, clientSecret, tenantId].every((value) => typeof value === "string" && value.trim())) {
    return null;
  }

  const baseUrl = env.APP_BASE_URL || `http://localhost:${env.PORT || 3000}`;
  const redirectUri = new URL(CALLBACK_PATH, baseUrl).toString();
  const client = new ConfidentialClientApplication({
    auth: {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      authority: `https://login.microsoftonline.com/${tenantId.trim()}`
    }
  });
  const crypto = new CryptoProvider();

  return {
    tenantId: tenantId.trim(),
    generatePkceCodes: () => crypto.generatePkceCodes(),
    // With a login hint, Microsoft goes straight to that account instead of the account picker.
    getAuthCodeUrl: ({ state, codeChallenge, loginHint }) => client.getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri,
      state,
      codeChallenge,
      codeChallengeMethod: "S256",
      ...(loginHint ? { loginHint } : { prompt: "select_account" })
    }),
    // Resolves to the validated ID token claims of the signed-in Microsoft account.
    async exchangeCode({ code, codeVerifier }) {
      const result = await client.acquireTokenByCode({ code, scopes: SCOPES, redirectUri, codeVerifier });
      return result.idTokenClaims || {};
    }
  };
}

module.exports = { createMicrosoftAuth, CALLBACK_PATH };

const form = document.getElementById("acceptForm");
const info = document.getElementById("invitationInfo");
const message = document.getElementById("message");
const submitButton = document.getElementById("submitButton");
const invitationToken = new URLSearchParams(window.location.hash.slice(1)).get("token");
window.history.replaceState(null, "", window.location.pathname);

async function readJson(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Une erreur est survenue.");
  }
  return data;
}

async function initialize() {
  if (!invitationToken) {
    throw new Error("Ce lien d’invitation est invalide ou expiré.");
  }
  const response = await fetch("/api/invitations/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: invitationToken })
  });
  const invitation = await readJson(response);
  info.textContent = invitation.role === "admin"
    ? `Invitation pour ${invitation.email} · Administrateur`
    : `Invitation pour ${invitation.email} · Département ${invitation.departmentName}`;
  form.hidden = false;
}

initialize().catch(error => {
  info.textContent = "";
  message.textContent = error.message;
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  const password = form.elements.password.value;
  if (password !== form.elements.passwordConfirmation.value) {
    message.textContent = "Les deux mots de passe ne correspondent pas.";
    return;
  }

  submitButton.disabled = true;
  message.textContent = "";
  try {
    const csrfResponse = await fetch("/api/auth/csrf");
    const { csrfToken } = await readJson(csrfResponse);
    const response = await fetch("/api/invitations/accept", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({ token: invitationToken, password })
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "L’activation a échoué.");
    }
    form.hidden = true;
    info.textContent = "Votre compte est activé. Vous pouvez maintenant vous connecter.";
    const loginLink = document.createElement("a");
    loginLink.href = "/login.html";
    loginLink.textContent = "Aller à la connexion";
    message.replaceChildren(loginLink);
  } catch (error) {
    message.textContent = error.message;
    submitButton.disabled = false;
  }
});

const form = document.getElementById("resetForm");
const info = document.getElementById("resetInfo");
const message = document.getElementById("message");
const submitButton = document.getElementById("submitButton");
const resetToken = new URLSearchParams(window.location.hash.slice(1)).get("token");
window.history.replaceState(null, "", window.location.pathname);

async function readJson(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Une erreur est survenue.");
  }
  return data;
}

function showLoginLink(text) {
  const loginLink = document.createElement("a");
  loginLink.href = text === "forgot" ? "/forgot-password.html" : "/login.html";
  loginLink.textContent = text === "forgot" ? "Demander un nouveau lien" : "Aller à la connexion";
  message.append(" ", loginLink);
}

async function initialize() {
  if (!resetToken) {
    throw new Error("Ce lien de réinitialisation est invalide ou expiré.");
  }
  const reset = await readJson(await fetch("/api/auth/password-reset/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: resetToken })
  }));
  info.textContent = `Compte : ${reset.email}`;
  form.hidden = false;
}

initialize().catch(error => {
  info.textContent = "";
  message.textContent = error.message;
  showLoginLink("forgot");
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
    const { csrfToken } = await readJson(await fetch("/api/auth/csrf"));
    const response = await fetch("/api/auth/password-reset/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({ token: resetToken, password })
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "La réinitialisation a échoué.");
    }
    form.hidden = true;
    info.textContent = "Votre mot de passe a été changé. Vous pouvez maintenant vous connecter.";
    showLoginLink("login");
  } catch (error) {
    message.textContent = error.message;
    submitButton.disabled = false;
  }
});
